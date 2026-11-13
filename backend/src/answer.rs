use crate::{github, runtime::*};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::LazyLock};
const MODEL: &str = "@cf/google/gemma-4-26b-a4b-it";
fn fallback() -> Result<Value> {
    Ok(json!({"status":"generation_unavailable","answer":null,"citations":[]}))
}
fn schema(ids: &[Value]) -> Value {
    let text = json!({"type":"string"});
    let citations =
        json!({"type":"array","minItems":1,"maxItems":3,"items":{"type":"string","enum":ids}});
    json!({"type":"object","additionalProperties":false,"required":["claims"],"properties":{
 "claims":{"type":"array","maxItems":3,"items":{"type":"object","additionalProperties":false,"required":["text","citations"],"properties":{"text":text,"citations":citations}}}}})
}
pub fn preview(input: &str, valid: &HashSet<&str>) -> Value {
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut section = 1;
    let mut depth = 0usize;
    let mut arrays = 0usize;
    let mut claim_start = None;
    let mut completed = Vec::new();
    let mut parts = Vec::new();
    while i < bytes.len() {
        if bytes[i] != b'"' {
            match bytes[i] {
                b'{' => {
                    depth += 1;
                    if depth == 2 && arrays == 1 && section == 0 {
                        claim_start = Some((i, parts.len()));
                    }
                }
                b'}' => {
                    if depth == 2
                        && let Some((start, index)) = claim_start.take()
                        && let Ok(value) = serde_json::from_str::<Value>(&input[start..=i])
                        && let Some(claim) = read_claim(&value, valid)
                    {
                        completed.push((index, claim));
                    }
                    depth = depth.saturating_sub(1);
                }
                b'[' => arrays += 1,
                b']' => arrays = arrays.saturating_sub(1),
                _ => {}
            }
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
        if depth == 1 && key == "claims" {
            section = 0;
        }
        if depth == 1 && key != "claims" {
            section = 1;
        }
        if key != "text" || section != 0 || depth != 2 || arrays != 1 {
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
            parts.push(value);
        }
        if bytes.get(i) == Some(&b'"') {
            i += 1;
        }
    }
    // Only complete claim objects have an unambiguous text/citation pairing.
    // Keep partial prose streaming, but never guess an unfinished citation ID.
    for (index, claim) in completed {
        if let Some(text) = parts.get_mut(index) {
            *text = format_claim(&claim);
        }
    }
    let markup: Vec<_> = parts.iter().map(|text| crate::api::html(text)).collect();
    json!({"answer":parts,"answer_html":markup})
}
async fn collect(h: &impl Host, ids: &[Value]) -> Result<Value> {
    let valid: HashSet<_> = ids.iter().filter_map(Value::as_str).collect();
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
                    .call(
                        "emit",
                        json!({"event":"draft","data":preview(&content, &valid)}),
                    )
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
fn format_claim(claim: &Value) -> String {
    format!(
        "{} {}",
        s(claim, "text"),
        claim["citations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| format!("[{}]", id.as_str().unwrap()))
            .collect::<Vec<_>>()
            .join(" ")
    )
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
        return fallback();
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
   let result=collect(h, &ids).await;let _=h.call("stream_cancel",Value::Null).await;result
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
            return fallback();
        }
    };
    let draft = serde_json::from_str::<Value>(s(&generation["choices"][0]["message"], "content"))
        .unwrap_or(Value::Null);
    if draft["claims"].as_array().is_none_or(|v| v.len() > 3) {
        if external {
            return Err(Error::new(502, "invalid_generation_response"));
        }
        return fallback();
    }
    let valid: HashSet<_> = ids.iter().filter_map(Value::as_str).collect();
    let claims: Vec<_> = array(&draft["claims"])?
        .iter()
        .filter_map(|v| read_claim(v, &valid))
        .collect();
    let verify_start = now();
    let verification = decision(json!({"op":"verify","evidence":context,"claims":claims}))?;
    traces.push(trace("verify_answer", claims.len(), vec![], verify_start));
    let threshold = bounded(c.support_threshold.as_deref(), 0.85, 0., 1.)?;
    bounded(c.conflict_threshold.as_deref(), 0.7, 0., 1.)?;
    let supported = |i: usize| {
        // Unknown semantic entailment is not a contradiction. Keep a cited,
        // related paraphrase rather than deleting every natural-language answer.
        // The response explicitly reports semantic_status=unknown, not verified.
        verification["reasons"][i] == "semantic_support_unknown"
            || verification["claims"][i]
                .as_f64()
                .is_some_and(|s| s > 0. && s >= threshold)
    };
    let verified: Vec<_> = claims
        .iter()
        .enumerate()
        .filter(|(i, _)| supported(*i))
        .map(|(_, v)| v.clone())
        .collect();
    if verified.is_empty() {
        return fallback();
    }
    let text = verified
        .iter()
        .map(format_claim)
        .collect::<Vec<_>>()
        .join("\n");
    let mut seen = HashSet::new();
    let citations: Vec<_> = verified
        .iter()
        .flat_map(|v| v["citations"].as_array().unwrap())
        .filter(|v| seen.insert(v.as_str().unwrap()))
        .cloned()
        .collect();
    Ok(
        json!({"status":"summarized","answer":if text.is_empty(){Value::Null}else{json!(text)},"citations":citations,"verification":verification}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_answers_are_requested_and_streamed() {
        let schema = schema(&[json!("p1")]);
        assert_eq!(schema["required"], json!(["claims"]));
        assert!(schema["properties"]["summaries"].is_null());
        let input = r#"{"claims":[{"text":"answer"}],"summaries":[{"text":"removed"}]}"#;
        for end in 0..=input.len() {
            let draft = preview(&input[..end], &HashSet::new());
            assert!(draft["summaries"].is_null());
            assert!(!draft.to_string().contains("removed"));
        }
        assert_eq!(preview(input, &HashSet::new())["answer"], json!(["answer"]));
    }
    #[test]
    fn citations_stream_per_complete_claim_in_either_field_order() {
        let valid = HashSet::from(["p1", "p10"]);
        for input in [
            r#"{"claims":[{"text":"回答😀","citations":["p10","p10"]},{"text":"次の回答","citations":["p1"]}]}"#,
            r#"{"claims":[{"citations":["p10","p10"],"text":"回答😀"},{"citations":["p1"],"text":"次の回答"}]}"#,
        ] {
            let first_end = input.find("},").unwrap() + 1;
            for end in (0..=input.len()).filter(|i| input.is_char_boundary(*i)) {
                let draft = preview(&input[..end], &valid);
                let texts = draft["answer"].as_array().unwrap();
                if end < first_end {
                    assert!(texts.iter().all(|t| !t.as_str().unwrap().contains("[p")));
                } else {
                    assert_eq!(texts[0], "回答😀 [p10]");
                    assert!(draft["answer_html"][0].as_str().unwrap().contains("[p10]"));
                }
            }
            assert_eq!(
                preview(input, &valid)["answer"],
                json!(["回答😀 [p10]", "次の回答 [p1]"])
            );
        }
    }

    #[test]
    fn unknown_ids_and_other_objects_do_not_supply_draft_citations() {
        let valid = HashSet::from(["p1"]);
        let input = r#"{"other":[{"text":"ignored","citations":["p1"]}],"claims":[{"text":"first","citations":["p999"]},{"text":"second","citations":["p1"]}],"summaries":[{"text":"removed","citations":["p1"]}]}"#;
        assert_eq!(
            preview(input, &valid)["answer"],
            json!(["first", "second [p1]"])
        );
        let partial = r#"{"claims":[{"text":"literal \"citations\": [p10]","citations":["p1"#;
        assert_eq!(
            preview(partial, &valid)["answer"],
            json!(["literal \"citations\": [p10]"])
        );
    }
}
