use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub code: String,
}
impl Error {
    pub fn new(status: u16, code: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
        }
    }
    pub fn response(&self) -> Value {
        let mut headers = json!({"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Type":"application/json"});
        if self.status == 429 {
            headers["Retry-After"] = json!(60);
        }
        json!({"status":self.status,"body":{"error":self.code},"headers":headers})
    }
}
#[allow(async_fn_in_trait)]
pub trait Host {
    async fn call(&self, op: &str, value: Value) -> Result<Value>;
}
/// Request-local measurement of D1 host calls, including binding/serialization overhead.
/// Calls in retrieval are sequential; this is elapsed wall time, not D1 server CPU time.
pub struct TimedDbHost<'a, H> {
    inner: &'a H,
    storage_ms: std::cell::Cell<f64>,
}
impl<'a, H: Host> TimedDbHost<'a, H> {
    pub fn new(inner: &'a H) -> Self {
        Self {
            inner,
            storage_ms: std::cell::Cell::new(0.),
        }
    }
    pub fn storage_ms(&self) -> f64 {
        self.storage_ms.get()
    }
}
impl<H: Host> Host for TimedDbHost<'_, H> {
    async fn call(&self, op: &str, value: Value) -> Result<Value> {
        let start = now();
        let result = self.inner.call(op, value).await;
        if matches!(op, "db" | "batch") {
            self.storage_ms
                .set(self.storage_ms.get() + (now() - start).max(0.));
        }
        result
    }
}
/// Preserve the stage total while separating D1 from local elapsed time.
pub fn with_storage_timing(mut step: Value, storage_ms: f64) -> Value {
    let elapsed = step["elapsed_ms"].as_f64().unwrap_or(0.).max(0.);
    let storage = storage_ms.max(0.).min(elapsed);
    step["storage_ms"] = json!(storage);
    step["local_ms"] = json!((elapsed - storage).max(0.));
    step
}
#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub struct Config {
    pub api_token: String,
    pub webhook_secret: String,
    pub github_token: String,
    pub github_org: String,
    pub answer_api_key: String,
    pub answer_model: String,
    pub answer_base_url: String,
    pub max_screened_documents: Option<String>,
    pub support_threshold: Option<String>,
    pub conflict_threshold: Option<String>,
    pub ai: bool,
    pub preview: bool,
}
pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn array(v: &Value) -> Result<&Vec<Value>> {
    v.as_array()
        .ok_or_else(|| Error::new(502, "invalid_upstream_json"))
}
pub fn bounded(v: Option<&str>, default: f64, min: f64, max: f64) -> Result<f64> {
    let n = match v {
        None => default,
        Some("") => 0.,
        Some(v) => v
            .parse()
            .map_err(|_| Error::new(503, "invalid_configuration"))?,
    };
    if !n.is_finite() || n < min || n > max {
        return Err(Error::new(503, "invalid_configuration"));
    }
    Ok(n)
}
pub fn now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.
    }
}
pub fn iso(ms: f64) -> String {
    let t = time::OffsetDateTime::from_unix_timestamp_nanos((ms as i128) * 1_000_000).unwrap();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn decision(value: Value) -> Result<Value> {
    let result: Value =
        serde_json::from_slice(&decision_rag_core::process(value.to_string().as_bytes()))
            .map_err(|_| Error::new(503, "local_decision_failed"))?;
    if let Some(error) = result["error"].as_str() {
        return Err(Error::new(422, error));
    }
    Ok(result)
}
pub fn json_response(body: Value, status: u16) -> Value {
    json!({"status":status,"body":body,"headers":{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Type":"application/json"}})
}
pub fn encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
pub async fn db(h: &impl Host, sql: &str, params: Vec<Value>) -> Result<Vec<Value>> {
    let result = h.call("db", json!({"sql":sql,"params":params})).await?;
    Ok(array(&result)?.clone())
}
pub fn statement(sql: impl Into<String>, params: Vec<Value>) -> Value {
    json!({"sql":sql.into(),"params":params})
}
pub async fn batch(h: &impl Host, statements: Vec<Value>) -> Result<Value> {
    h.call("batch", json!(statements)).await
}
pub async fn enqueue(h: &impl Host, job: Value) -> Result<()> {
    h.call("queue", job).await?;
    Ok(())
}
pub fn trace(stage: &str, count: usize, ids: Vec<Value>, start: f64) -> Value {
    json!({"stage":stage,"candidates":count,"selected":ids,"calls":0,"model":["rust-rules-v1"],"input_tokens":0,"output_tokens":0,"elapsed_ms":now()-start})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamps_match_javascript_iso_precision() {
        assert_eq!(iso(0.), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1234.), "1970-01-01T00:00:01.234Z");
    }
    #[test]
    fn configuration_rejects_non_finite_and_out_of_range() {
        for value in ["NaN", "inf", "-1", "101", "bad"] {
            assert!(bounded(Some(value), 10., 0., 100.).is_err());
        }
    }
}
