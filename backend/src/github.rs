use crate::runtime::*;
use serde_json::{Value, json};
use std::{cell::RefCell, collections::HashMap};
thread_local! {static PUBLIC_PAGES:RefCell<HashMap<String,(String,Value)>>=RefCell::new(HashMap::new());}
pub fn assert_repo(c: &Config, repo: &str) -> Result<()> {
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2
        || !parts[0].eq_ignore_ascii_case(&c.github_org)
        || parts[1].is_empty()
        || !parts[1]
            .chars()
            .all(|v| v.is_ascii_alphanumeric() || "_.-".contains(v))
    {
        return Err(Error::new(400, "repository_out_of_scope"));
    }
    Ok(())
}
pub async fn fetch(
    h: &impl Host,
    url: &str,
    method: &str,
    headers: Value,
    body: Value,
    max: usize,
) -> Result<Value> {
    h.call("fetch",json!({"url":url,"method":method,"headers":headers,"body":body,"max_bytes":max,"timeout_ms":25000})).await
}
pub fn parse_response(response: &Value) -> Result<Value> {
    let status = response["status"].as_u64().unwrap_or(502);
    if !(200..300).contains(&status) {
        return Err(Error::new(502, format!("upstream_http_{status}")));
    }
    serde_json::from_str(s(response, "body")).map_err(|_| Error::new(502, "invalid_upstream_json"))
}
fn headers(c: &Config) -> Result<Value> {
    if c.github_token.is_empty() {
        return Err(Error::new(503, "github_not_configured"));
    }
    Ok(
        json!({"Authorization":format!("Bearer {}",c.github_token),"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"TrainLCD-DecisionRAG"}),
    )
}
pub async fn get(h: &impl Host, c: &Config, path: &str) -> Result<Value> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains("..") {
        return Err(Error::new(400, "invalid_github_path"));
    }
    parse_response(
        &fetch(
            h,
            &format!("https://api.github.com{path}"),
            "GET",
            headers(c)?,
            Value::Null,
            8_000_000,
        )
        .await?,
    )
}
pub async fn all(h: &impl Host, c: &Config, path: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for page in 1..=100 {
        let rows = get(
            h,
            c,
            &format!(
                "{path}{}per_page=100&page={page}",
                if path.contains('?') { "&" } else { "?" }
            ),
        )
        .await?;
        let rows = array(&rows)?;
        out.extend(rows.iter().cloned());
        if rows.len() < 100 {
            return Ok(out);
        }
    }
    Err(Error::new(422, "github_pagination_budget_exceeded"))
}
pub async fn graph(h: &impl Host, c: &Config, query: &str, variables: Value) -> Result<Value> {
    let mut headers = headers(c)?;
    headers["Content-Type"] = json!("application/json");
    let value = parse_response(
        &fetch(
            h,
            "https://api.github.com/graphql",
            "POST",
            headers,
            json!({"query":query,"variables":variables}),
            2_000_000,
        )
        .await?,
    )?;
    if value["data"].is_null() || value["errors"].as_array().is_some_and(|v| !v.is_empty()) {
        return Err(Error::new(502, "github_graphql_failed"));
    }
    Ok(value["data"].clone())
}
pub async fn public_repositories(h: &impl Host, c: &Config) -> Result<Vec<String>> {
    let mut result = Vec::new();
    for page in 1..=100 {
        let path = format!(
            "/orgs/{}/repos?type=public&per_page=100&page={page}",
            encode(&c.github_org)
        );
        let key = digest(format!("{}:{}:{path}", c.github_org, c.github_token).as_bytes());
        let previous = PUBLIC_PAGES.with(|cache| cache.borrow().get(&key).cloned());
        let mut headers = headers(c)?;
        if let Some((etag, _)) = &previous {
            headers["If-None-Match"] = json!(etag);
        }
        let response = fetch(
            h,
            &format!("https://api.github.com{path}"),
            "GET",
            headers,
            Value::Null,
            8_000_000,
        )
        .await?;
        let rows = if response["status"] == 304 {
            previous
                .ok_or_else(|| Error::new(502, "invalid_github_response"))?
                .1
        } else {
            let rows = parse_response(&response)?;
            let rows:Value=json!(array(&rows)?.iter().map(|r|json!({"full_name":r["full_name"],"private":r["private"],"visibility":r["visibility"],"disabled":r["disabled"]})).collect::<Vec<_>>());
            let etag = s(&response["headers"], "etag");
            PUBLIC_PAGES.with(|cache| {
                let mut cache = cache.borrow_mut();
                if cache.len() > 200 {
                    cache.clear();
                }
                if !etag.is_empty() {
                    cache.insert(key.clone(), (etag.to_string(), rows.clone()));
                } else {
                    cache.remove(&key);
                }
            });
            rows
        };
        for row in array(&rows)? {
            if row["private"] == false && row["visibility"] == "public" && row["disabled"] != true {
                let repo = s(row, "full_name");
                assert_repo(c, repo)?;
                if !repo.eq_ignore_ascii_case(&format!("{}/Issues", c.github_org)) {
                    result.push(repo.to_lowercase());
                }
            }
        }
        if array(&rows)?.len() < 100 {
            return Ok(result);
        }
    }
    Err(Error::new(422, "github_pagination_budget_exceeded"))
}
pub fn is_document(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    if parts
        .iter()
        .any(|p| ["node_modules", "vendor", ".git", "dist", "build"].contains(p))
    {
        return false;
    }
    let name = parts.last().unwrap_or(&"");
    !["package-lock", "yarn.lock", "pnpm-lock"]
        .iter()
        .any(|p| name.starts_with(p))
        && name.rsplit('.').next().is_some_and(|ext| {
            ["md", "mdx", "rst", "adoc", "txt"].contains(&ext.to_lowercase().as_str())
        })
}
