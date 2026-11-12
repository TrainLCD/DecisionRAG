use crate::{answer, cursor, github, runtime::*, storage, sync};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use subtle::ConstantTimeEq;
fn secure_equal(a: &str, b: &str) -> bool {
    bool::from(Sha256::digest(a.as_bytes()).ct_eq(&Sha256::digest(b.as_bytes())))
}
fn require_token(c: &Config, request: &Value) -> Result<()> {
    if c.api_token.is_empty() {
        return Err(Error::new(503, "authentication_not_configured"));
    }
    if !secure_equal(
        s(&request["headers"], "authorization"),
        &format!("Bearer {}", c.api_token),
    ) {
        return Err(Error::new(401, "unauthorized"));
    }
    Ok(())
}
async fn body(h: &impl Host, request: &Value) -> Result<Value> {
    if !s(&request["headers"], "content-type").starts_with("application/json") {
        return Err(Error::new(415, "json_required"));
    }
    let text = h.call("request_text", json!(256000)).await?;
    let value: Value = serde_json::from_str(text.as_str().unwrap_or(""))
        .map_err(|_| Error::new(400, "invalid_json"))?;
    if !value.is_object() {
        return Err(Error::new(400, "invalid_json"));
    }
    Ok(value)
}
pub async fn handle(h: &impl Host, c: &Config, request: Value) -> Result<Value> {
    let path = s(&request, "path");
    let method = s(&request, "method");
    if c.preview
        && !((method == "GET" && ["/health", "/sync/status"].contains(&path))
            || (method == "POST" && ["/search", "/answer"].contains(&path)))
    {
        return Err(Error::new(403, "preview_read_only"));
    }
    let result = if path == "/health" && method == "GET" {
        json_response(json!({"ok":true}), 200)
    } else if path == "/webhooks/github" && method == "POST" {
        webhook(h, c, &request).await?
    } else if method == "POST" && ["/search", "/answer"].contains(&path) {
        search(h, c, &request, path).await?
    } else {
        require_token(c, &request)?;
        match (method, path) {
            ("POST", "/sync") => {
                enqueue(h, json!({"type":"org","page":1})).await?;
                json_response(json!({"status":"queued"}), 202)
            }
            ("GET", "/sync/status") => {
                let jobs = db(
                    h,
                    "SELECT status,count(*) AS count FROM sync_jobs GROUP BY status",
                    vec![],
                )
                .await?;
                let sources=db(h,"SELECT repo,kind,count(*) AS count,max(updated_at) AS latest_source_update FROM sources GROUP BY repo,kind",vec![]).await?;
                let repositories =
                    db(h, "SELECT * FROM repositories ORDER BY repo", vec![]).await?;
                let errors=db(h,"SELECT id,job,status,error,updated_at FROM sync_jobs WHERE status IN ('failed','retrying') ORDER BY updated_at DESC LIMIT 20",vec![]).await?;
                json_response(
                    json!({"jobs":jobs,"sources":sources,"repositories":repositories,"errors":errors}),
                    200,
                )
            }
            ("POST", "/admin/purge") => {
                let b = body(h, &request).await?;
                let repo = b["repo"]
                    .as_str()
                    .ok_or_else(|| Error::new(400, "repository_required"))?;
                github::assert_repo(c, repo)?;
                storage::purge(h, repo).await?;
                json_response(json!({"purged":repo}), 200)
            }
            _ => return Err(Error::new(404, "not_found")),
        }
    };
    let mut result = result;
    if c.preview {
        result["headers"]["X-Robots-Tag"] = json!("noindex");
    }
    Ok(result)
}
fn html(text: &str) -> String {
    let parser = pulldown_cmark::Parser::new_ext(
        text,
        pulldown_cmark::Options::ENABLE_TABLES
            | pulldown_cmark::Options::ENABLE_STRIKETHROUGH
            | pulldown_cmark::Options::ENABLE_TASKLISTS,
    )
    .filter(|event| {
        !matches!(
            event,
            pulldown_cmark::Event::Html(_) | pulldown_cmark::Event::InlineHtml(_)
        )
    });
    let mut output = String::new();
    pulldown_cmark::html::push_html(&mut output, parser);
    output.trim().to_string()
}
async fn search(h: &impl Host, c: &Config, request: &Value, path: &str) -> Result<Value> {
    let b = body(h, request).await?;
    let object = b.as_object().unwrap();
    let query = b["query"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 1500)
        .ok_or_else(|| Error::new(400, "query_must_be_1_to_1500_characters"))?
        .trim();
    if object.contains_key("include_feedback") && !b["include_feedback"].is_boolean() {
        return Err(Error::new(400, "invalid_feedback_scope"));
    }
    if object.contains_key("paginated") && !b["paginated"].is_boolean() {
        return Err(Error::new(400, "invalid_pagination"));
    }
    if object.contains_key("cursor") && (!b["cursor"].is_string() || b["paginated"] != true) {
        return Err(Error::new(400, "invalid_search_cursor"));
    }
    let has_token = request["headers"].get("authorization").is_some();
    if has_token || b["include_feedback"] == true {
        require_token(c, request)?;
    }
    let start = now();
    if !has_token {
        let ip = s(&request["headers"], "cf-connecting-ip");
        let limited = h
            .call(
                "rate_limit",
                json!(if ip.is_empty() { "unknown" } else { ip }),
            )
            .await?;
        if limited["success"] != true {
            return Err(Error::new(429, "public_search_rate_limited"));
        }
    }
    let max = bounded(c.max_screened_documents.as_deref(), 20000., 1., 100000.)?.floor() as usize;
    let scope_key = json!([has_token, b["include_feedback"]]);
    let previous = if let Some(token) = b["cursor"].as_str() {
        Some(cursor::decode(token, &c.api_token, query, &scope_key)?)
    } else {
        None
    };
    let scope_start = now();
    let scope = if has_token && !object.contains_key("include_feedback") {
        None
    } else {
        Some(storage::Scope {
            public: github::public_repositories(h, c).await?,
            feedback: (b["include_feedback"] == true)
                .then(|| format!("{}/issues", c.github_org.to_lowercase())),
        })
    };
    let scope_ms = if scope.is_some() {
        now() - scope_start
    } else {
        0.
    };
    let storage_start = now();
    let mut traces = Vec::new();
    let ids = if let Some(previous) = &previous {
        array(&previous["ids"])?
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    } else {
        storage::plan(h, query, scope.as_ref(), max, &mut traces).await?
    };
    let mut passages = storage::passages(h, &ids, scope.as_ref()).await?;
    let order: HashMap<_, _> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    passages.sort_by_key(|p| {
        (
            p["ordinal"].as_u64().unwrap_or(0),
            order.get(s(p, "source_id")).copied().unwrap_or(0),
        )
    });
    let revision = digest(serde_json::to_string(&passages).unwrap().as_bytes());
    if previous.as_ref().is_some_and(|p| p["revision"] != revision) {
        return Err(Error::new(409, "search_results_changed"));
    }
    let storage_ms = now()
        - storage_start
        - traces
            .iter()
            .map(|t| t["elapsed_ms"].as_f64().unwrap_or(0.))
            .sum::<f64>();
    let offset = previous
        .as_ref()
        .and_then(|p| p["offset"].as_u64())
        .unwrap_or(0) as usize;
    let paginated = b["paginated"] == true;
    let size = if paginated { 20 } else { 4000 };
    let page: Vec<_> = passages.iter().skip(offset).take(size).cloned().collect();
    let mut evidence = storage::rank(query, &passages, &page, &mut traces)?;
    let mut pagination = Value::Null;
    if paginated {
        let next = if offset + size < passages.len() {
            json!(cursor::encode(h,&json!({"query":query,"scope":scope_key,"ids":ids,"offset":offset+size,"revision":revision,"expires":previous.as_ref().map(|p|p["expires"].clone()).unwrap_or(json!(now()+15.*60000.))}),&c.api_token).await?)
        } else {
            Value::Null
        };
        pagination = json!({"page":offset/size+1,"total_pages":passages.len().div_ceil(size),"next_cursor":next});
    }
    for p in &mut evidence {
        p["highlight_terms"] = json!(decision_rag_core::highlight_terms(query, s(p, "text")));
        let markup = html(s(p, "text"));
        if !markup.is_empty() {
            p["text_html"] = json!(markup);
        }
    }
    let mut state = json!({"query":query,"evidence":evidence,"hit_count":evidence.len(),"pagination":pagination,"trace":traces,"start":start,"timings":{"scope_ms":scope_ms,"storage_ms":storage_ms.max(0.),"model_ms":0,"generation_ms":0,"retrieval_ms":now()-start}});
    if path == "/answer" && s(&request["headers"], "accept").contains("text/event-stream") {
        return Ok(
            json!({"stream":true,"state":state,"status":200,"headers":{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}}),
        );
    }
    let result = if path == "/answer" {
        answer::answer(h, c, query, &evidence, false, &mut traces).await?
    } else {
        json!({"status":if evidence.is_empty(){"empty"}else{"retrieved"}})
    };
    state["trace"] = json!(traces);
    Ok(json_response(finish(state, result), 200))
}
fn finish(mut state: Value, result: Value) -> Value {
    let mut model_ms = 0.;
    let mut generation_ms = 0.;
    for t in state["trace"].as_array().unwrap() {
        let elapsed = t["elapsed_ms"].as_f64().unwrap_or(0.);
        if t["stage"] == "generate_answer" {
            generation_ms += elapsed;
        } else {
            model_ms += elapsed;
        }
    }
    state["timings"]["model_ms"] = json!(model_ms);
    state["timings"]["generation_ms"] = json!(generation_ms);
    let mut out = result;
    for key in ["evidence", "hit_count", "trace", "timings"] {
        out[key] = state[key].clone();
    }
    if !state["pagination"].is_null() {
        out["pagination"] = state["pagination"].clone();
    }
    out["elapsed_ms"] = json!(now() - state["start"].as_f64().unwrap_or(now()));
    out["retrieval"] = json!("rust-rules-v1");
    out["release_inference"] = json!("github_release_commit_ancestry");
    out
}
pub async fn stream(h: &impl Host, c: &Config, mut state: Value) -> Result<()> {
    h.call("emit",json!({"event":"sources","data":{"evidence":state["evidence"],"hit_count":state["hit_count"],"pagination":state["pagination"],"elapsed_ms":now()-state["start"].as_f64().unwrap_or(now())}})).await?;
    let mut traces = array(&state["trace"])?.clone();
    let result = answer::answer(
        h,
        c,
        s(&state, "query"),
        array(&state["evidence"])?,
        true,
        &mut traces,
    )
    .await?;
    state["trace"] = json!(traces);
    h.call(
        "emit",
        json!({"event":"result","data":finish(state,result)}),
    )
    .await?;
    Ok(())
}
fn signature(secret: &str, body: &str, signature: &str) -> bool {
    if secret.is_empty() || signature.len() != 71 || !signature.starts_with("sha256=") {
        return false;
    }
    let decoded: Option<Vec<u8>> = signature.as_bytes()[7..]
        .chunks(2)
        .map(|pair| {
            if !pair
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
            {
                return None;
            }
            u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
        })
        .collect();
    let Some(decoded) = decoded else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(body.as_bytes());
    mac.verify_slice(&decoded).is_ok()
}
async fn webhook(h: &impl Host, c: &Config, request: &Value) -> Result<Value> {
    let text = h.call("request_text", json!(2_000_000)).await?;
    let text = text.as_str().unwrap_or("");
    if !signature(
        &c.webhook_secret,
        text,
        s(&request["headers"], "x-hub-signature-256"),
    ) {
        return Err(Error::new(401, "invalid_webhook_signature"));
    }
    let payload: Value = serde_json::from_str(text).map_err(|_| Error::new(400, "invalid_json"))?;
    let event = s(&request["headers"], "x-github-event");
    if event == "ping" {
        return Ok(json_response(json!({"ok":true}), 200));
    }
    let repo = s(&payload["repository"], "full_name");
    if repo.is_empty() {
        return Err(Error::new(400, "missing_repository"));
    }
    github::assert_repo(c, repo)?;
    let action = s(&payload, "action");
    match event {
        "repository" if ["deleted", "transferred"].contains(&action) => {
            storage::purge(h, repo).await?
        }
        "repository" | "push" => enqueue(h, json!({"type":"repo","repo":repo})).await?,
        "release" => enqueue(h, json!({"type":"releases","repo":repo})).await?,
        "issues"
        | "issue_comment"
        | "pull_request"
        | "pull_request_review"
        | "pull_request_review_comment" => {
            let number = payload["issue"]["number"]
                .as_u64()
                .or_else(|| payload["pull_request"]["number"].as_u64())
                .or_else(|| payload["number"].as_u64())
                .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
                .ok_or_else(|| Error::new(400, "invalid_issue_number"))?;
            if event == "issues" && ["deleted", "transferred"].contains(&action) {
                storage::delete_source(h, &format!("{repo}#{number}")).await?;
            } else {
                enqueue(h, json!({"type":"issue","repo":repo,"number":number})).await?;
            }
        }
        _ => {}
    }
    Ok(json_response(json!({"accepted":true}), 202))
}
pub async fn event(h: &impl Host, c: &Config, input: Value) -> Result<()> {
    if c.preview {
        return Err(Error::new(403, "preview_read_only"));
    }
    if input["type"] == "scheduled" {
        return enqueue(h, json!({"type":"org","page":1})).await;
    }
    for (index, message) in array(&input["messages"])?.iter().enumerate() {
        let id = message["id"].clone();
        db(h,"INSERT INTO sync_jobs(id,job,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(id) DO UPDATE SET status='running',updated_at=excluded.updated_at,error=NULL",vec![id.clone(),json!(message["body"].to_string()),json!(iso(now()))]).await?;
        match sync::run(h, c, &message["body"]).await {
            Ok(()) => {
                db(
                    h,
                    "UPDATE sync_jobs SET status='completed',updated_at=?,error=NULL WHERE id=?",
                    vec![json!(iso(now())), id],
                )
                .await?;
                h.call("ack", json!(index)).await?;
            }
            Err(e) => {
                let attempts = message["attempts"].as_u64().unwrap_or(1);
                db(
                    h,
                    "UPDATE sync_jobs SET status=?,updated_at=?,error=? WHERE id=?",
                    vec![
                        json!(if attempts >= 6 { "failed" } else { "retrying" }),
                        json!(iso(now())),
                        json!(e.code),
                        id,
                    ],
                )
                .await?;
                h.call("retry",json!({"index":index,"delaySeconds":(30*2u64.pow(attempts.min(6) as u32)).min(3600)})).await?;
            }
        }
    }
    db(
        h,
        "DELETE FROM sync_jobs WHERE status='completed' AND updated_at<datetime('now','-7 days')",
        vec![],
    )
    .await?;
    Ok(())
}
