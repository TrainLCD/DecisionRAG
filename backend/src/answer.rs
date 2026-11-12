use crate::{github, runtime::*};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::LazyLock};
const MODEL: &str = "@cf/google/gemma-4-26b-a4b-it";
fn fallback(query: &str, evidence: &[Value]) -> Result<Value> {
    decision(json!({"op":"extract","query":query,"evidence":evidence}))
}
fn schema(ids: &[Value]) -> Value {
    let text = json!({"type":"string"});
    let citations =
        json!({"type":"array","minItems":1,"maxItems":3,"items":{"type":"string","enum":ids}});
    json!({"type":"object","additionalProperties":false,"required":["claims","summaries"],"properties":{
 "claims":{"type":"array","maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["text","citations"],"properties":{"text":text,"citations":citations}}},
 "summaries":{"type":"array","maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["source_id","text","citations"],"properties":{"source_id":{"type":"string"},"text":text,"citations":citations}}}}})
}
pub fn preview(input: &str) -> Value {
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut section = 0;
    let mut parts = [Vec::new(), Vec::new()];
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < bytes.len() {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                break;
            }
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let key = serde_json::from_str::<String>(&input[start..=i]).unwrap_or_default();
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) != Some(&b':') {
            continue;
        }
        i += 1;
        if key == "claims" {
            section = 0;
        }
        if key == "summaries" {
            section = 1;
        }
        if key != "text" {
            continue;
        }
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) != Some(&b'"') {
            continue;
        }
        let start = i;
        i += 1;
        let mut end = i;
        while i < bytes.len() && bytes[i] != b'"' {
            if bytes[i] == b'\\' {
                let size = if bytes.get(i + 1) == Some(&b'u') {
                    6
                } else {
                    2
                };
                if i + size > bytes.len() {
                    break;
                }
                i += size;
            } else {
                i += 1;
            }
            if input.is_char_boundary(i) {
                end = i;
            }
        }
        if let Ok(value) = serde_json::from_str::<String>(&format!("{}\"", &input[start..end])) {
            parts[section].push(value);
        }
        if bytes.get(i) == Some(&b'"') {
            i += 1;
        }
    }
    json!({"answer":parts[0],"summaries":parts[1]})
}
async fn collect(h: &impl Host) -> Result<Value> {
    let mut pending = String::new();
    let mut lines = Vec::new();
    let mut content = String::new();
    let mut done = false;
    let mut size = 0;
    let mut last = -1000.;
    let mut published = 0;
    let mut model = Value::Null;
    let mut usage = Value::Null;
    loop {
        let chunk = h.call("stream_read", Value::Null).await?;
        let eof = chunk["done"] == true;
        let part = s(&chunk, "text");
        size += part.len();
        if size > 2_000_000 {
            return Err(Error::new(502, "upstream_body_too_large"));
        }
        pending.push_str(part);
        if eof {
            pending.push_str("\n\n");
        }
        while let Some(at) = pending.find('\n') {
            let rest = pending.split_off(at + 1);
            let line = pending[..at].trim_end_matches('\r').to_string();
            pending = rest;
            if let Some(data) = line.strip_prefix("data:") {
                lines.push(data.strip_prefix(' ').unwrap_or(data).to_string());
            }
            if !line.is_empty() || lines.is_empty() {
                continue;
            }
            let data = std::mem::take(&mut lines).join("\n");
            if data == "[DONE]" {
                done = true;
            } else if !done {
                let value: Value = serde_json::from_str(&data)
                    .map_err(|_| Error::new(502, "invalid_generation_response"))?;
                if !value["error"].is_null() {
                    return Err(Error::new(502, "generation_unavailable"));
                }
                if !value["model"].is_null() {
                    model = value["model"].clone();
                }
                if !value["usage"].is_null() {
                    usage = value["usage"].clone();
                }
                if let Some(delta) = value["choices"][0]["delta"]["content"]
                    .as_str()
                    .or_else(|| value["response"].as_str())
                {
                    content.push_str(delta);
                }
            }
            if content.len() != published && (done || now() - last >= 100.) {
                last = now();
                published = content.len();
                let _ = h
                    .call("emit", json!({"event":"draft","data":preview(&content)}))
                    .await;
            }
            if done {
                break;
            }
        }
        if eof || done {
            break;
        }
    }
    if !done {
        return Err(Error::new(502, "incomplete_generation_stream"));
    }
    Ok(json!({"model":model,"usage":usage,"choices":[{"message":{"content":content}}]}))
}
fn read_claim(v: &Value, valid: &HashSet<&str>) -> Option<Value> {
    let text = v["text"].as_str()?;
    let ids = v["citations"].as_array()?;
    if ids.is_empty()
        || ids
            .iter()
            .any(|id| id.as_str().is_none_or(|id| !valid.contains(id)))
    {
        return None;
    }
    static INLINE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[ \t]*\[(p\d+(?:\s*[,、]\s*p\d+|\s+p\d+)*)\]").unwrap());
    for cap in INLINE.captures_iter(text) {
        if cap[1]
            .split(|c: char| c.is_whitespace() || c == ',' || c == '、')
            .filter(|s| !s.is_empty())
            .any(|id| !ids.iter().any(|v| v == id))
        {
            return None;
        }
    }
    let text = INLINE.replace_all(text, "").trim().to_string();
    if text.is_empty() {
        return None;
    }
    let mut seen = HashSet::new();
    let ids: Vec<_> = ids
        .iter()
        .filter(|id| seen.insert(id.as_str().unwrap()))
        .cloned()
        .collect();
    Some(json!({"text":text,"citations":ids}))
}
pub async fn answer(
    h: &impl Host,
    c: &Config,
    query: &str,
    all: &[Value],
    stream: bool,
    traces: &mut Vec<Value>,
) -> Result<Value> {
    if all.is_empty() {
        return Ok(json!({"status":"insufficient_evidence","answer":null,"citations":[]}));
    }
    let context:Vec<_>=all.iter().take(20).map(|p|json!({"citation":p["citation"],"source_id":p["source_id"],"repo":p["repo"],"title":p["title"],"text":p["text"],"kind":p["kind"],"metadata":p["metadata"]})).collect();
    let external = !c.answer_api_key.is_empty() && !c.answer_model.is_empty();
    if !external && !c.ai {
        return fallback(query, &context);
    }
    let ids: Vec<_> = context.iter().map(|p| p["citation"].clone()).collect();
    let messages = json!([{"role":"system","content":include_str!("instructions.txt")},{"role":"user","content":format!("{}\n\n{}",json!({"query":query,"evidence":context}),include_str!("writingGuide.txt"))}]);
    let base = if external {
        let parsed = url::Url::parse(if c.answer_base_url.is_empty() {
            "https://api.openai.com/v1"
        } else {
            &c.answer_base_url
        })
        .map_err(|_| Error::new(503, "invalid_answer_base_url"))?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(Error::new(503, "invalid_answer_base_url"));
        }
        Some(format!(
            "{}/chat/completions",
            parsed.as_str().trim_end_matches('/')
        ))
    } else {
        None
    };
    let start = now();
    let generated=async {
  let mut input=if external{json!({"model":c.answer_model,"max_completion_tokens":3000,"response_format":{"type":"json_object"},"messages":messages})}else{json!({"messages":messages,"max_completion_tokens":3000,"temperature":0,"response_format":{"type":"json_schema","json_schema":{"name":"cited_claims","strict":true,"schema":schema(&ids)}},"chat_template_kwargs":{"enable_thinking":false}})};
  if stream{
   input["stream"]=json!(true);if external{input["stream_options"]=json!({"include_usage":true});}
   if let Some(base)=base.as_ref(){let response=h.call("fetch_stream",json!({"url":base,"headers":{"Authorization":format!("Bearer {}",c.answer_api_key),"Content-Type":"application/json"},"body":input})).await?;
    let status=response["status"].as_u64().unwrap_or(502);if !(200..300).contains(&status){return Err(Error::new(502,format!("upstream_http_{status}")));}
   }else{h.call("ai_stream",json!({"model":MODEL,"input":input})).await?;}
   let result=collect(h).await;let _=h.call("stream_cancel",Value::Null).await;result
  }else if let Some(base)=base.as_ref(){github::parse_response(&github::fetch(h,base,"POST",json!({"Authorization":format!("Bearer {}",c.answer_api_key),"Content-Type":"application/json"}),input,2_000_000).await?)}
  else{h.call("ai",json!({"model":MODEL,"input":input})).await}
 }.await;
    let generation = generated.as_ref().ok();
    traces.push(json!({"stage":"generate_answer","candidates":context.len(),"selected":[],"calls":1,"model":[generation.and_then(|g|g["model"].as_str()).unwrap_or(if external{&c.answer_model}else{MODEL})],"input_tokens":generation.and_then(|g|g["usage"]["prompt_tokens"].as_u64()).unwrap_or(0),"output_tokens":generation.and_then(|g|g["usage"]["completion_tokens"].as_u64()).unwrap_or(0),"elapsed_ms":now()-start}));
    let generation = match generated {
        Ok(v) => v,
        Err(e) => {
            if external {
                return Err(e);
            }
            return fallback(query, &context);
        }
    };
    let draft = serde_json::from_str::<Value>(s(&generation["choices"][0]["message"], "content"))
        .unwrap_or(Value::Null);
    if draft["claims"].as_array().is_none_or(|v| v.len() > 3)
        || (!draft["summaries"].is_null()
            && draft["summaries"].as_array().is_none_or(|v| v.len() > 20))
    {
        if external {
            return Err(Error::new(502, "invalid_generation_response"));
        }
        return fallback(query, &context);
    }
    let valid: HashSet<_> = ids.iter().filter_map(Value::as_str).collect();
    let claims: Vec<_> = array(&draft["claims"])?
        .iter()
        .filter_map(|v| read_claim(v, &valid))
        .collect();
    let mut summaries = Vec::new();
    let mut seen = HashSet::new();
    for value in draft["summaries"].as_array().into_iter().flatten() {
        let Some(mut claim) = read_claim(value, &valid) else {
            continue;
        };
        let Some(source) = value["source_id"].as_str() else {
            continue;
        };
        if !seen.insert(source)
            || !array(&claim["citations"])?.iter().all(|id| {
                context
                    .iter()
                    .any(|p| p["citation"] == *id && p["source_id"] == source)
            })
        {
            continue;
        }
        claim["source_id"] = json!(source);
        summaries.push(claim);
    }
    let verify_start = now();
    let all_claims = [claims.clone(), summaries.clone()].concat();
    let verification = decision(json!({"op":"verify","evidence":context,"claims":all_claims}))?;
    traces.push(trace(
        "verify_answer",
        all_claims.len(),
        vec![],
        verify_start,
    ));
    let threshold = bounded(c.support_threshold.as_deref(), 0.85, 0., 1.)?;
    bounded(c.conflict_threshold.as_deref(), 0.7, 0., 1.)?;
    let supported = |i: usize| {
        verification["claims"][i]
            .as_f64()
            .is_some_and(|s| s > 0. && s >= threshold)
    };
    let verified: Vec<_> = claims
        .iter()
        .enumerate()
        .filter(|(i, _)| supported(*i))
        .map(|(_, v)| v.clone())
        .collect();
    let summaries: Vec<_> = summaries
        .iter()
        .enumerate()
        .filter(|(i, _)| supported(claims.len() + *i))
        .map(|(_, v)| v.clone())
        .collect();
    if verified.is_empty() && summaries.is_empty() {
        return fallback(query, &context);
    }
    let text = verified
        .iter()
        .map(|v| {
            format!(
                "{} {}",
                s(v, "text"),
                v["citations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| format!("[{}]", id.as_str().unwrap()))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut seen = HashSet::new();
    let citations: Vec<_> = verified
        .iter()
        .chain(&summaries)
        .flat_map(|v| v["citations"].as_array().unwrap())
        .filter(|v| seen.insert(v.as_str().unwrap()))
        .cloned()
        .collect();
    Ok(
        json!({"status":"summarized","answer":if text.is_empty(){Value::Null}else{json!(text)},"ticket_summaries":summaries,"citations":citations,"verification":verification}),
    )
}
