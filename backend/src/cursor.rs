use crate::runtime::*;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use sha2::{Digest, Sha256};
fn cipher(secret: &str) -> Result<Aes256Gcm> {
    if secret.is_empty() {
        return Err(Error::new(503, "authentication_not_configured"));
    }
    let key = Sha256::digest(format!("search-cursor-v1:{secret}"));
    Ok(Aes256Gcm::new_from_slice(&key).expect("SHA256 key length"))
}
pub async fn encode(h: &impl Host, value: &Value, secret: &str) -> Result<String> {
    let cipher = cipher(secret)?;
    let random = h.call("random", serde_json::json!(12)).await?;
    let nonce: Vec<u8> = array(&random)?
        .iter()
        .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
        .collect::<Option<_>>()
        .ok_or_else(|| Error::new(503, "invalid_random_bytes"))?;
    if nonce.len() != 12 {
        return Err(Error::new(503, "invalid_random_bytes"));
    }
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), value.to_string().as_bytes())
        .map_err(|_| Error::new(503, "cursor_encryption_failed"))?;
    let token = URL_SAFE_NO_PAD.encode([nonce, encrypted].concat());
    if token.len() > 200_000 {
        return Err(Error::new(422, "search_plan_too_large"));
    }
    Ok(token)
}
pub fn decode(token: &str, secret: &str, query: &str, scope: &Value) -> Result<Value> {
    let cipher = cipher(secret)?;
    let invalid = || Error::new(400, "invalid_search_cursor");
    if token.len() > 200_000 {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| invalid())?;
    if bytes.len() < 28 {
        return Err(invalid());
    }
    let plain = cipher
        .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
        .map_err(|_| invalid())?;
    let v: Value = serde_json::from_slice(&plain).map_err(|_| invalid())?;
    let offset = v["offset"].as_u64().ok_or_else(invalid)?;
    // Both old string scope keys and new structured keys are authenticated.
    let scope_matches = v["scope"] == *scope
        || v["scope"]
            .as_str()
            .is_some_and(|s| serde_json::from_str::<Value>(s).ok().as_ref() == Some(scope));
    if v["query"] != query
        || !scope_matches
        || v["expires"].as_f64().is_none_or(|e| e <= now())
        || offset > 9_007_199_254_740_991
        || offset % 20 != 0
        || !v["revision"].is_string()
        || v["ids"]
            .as_array()
            .is_none_or(|ids| ids.iter().any(|id| !id.is_string()))
    {
        return Err(invalid());
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    struct BadRandom(Value);
    impl Host for BadRandom {
        async fn call(&self, _: &str, _: Value) -> Result<Value> {
            Ok(self.0.clone())
        }
    }
    #[test]
    fn nonce_rejects_invalid_host_bytes() {
        for bad in [
            serde_json::json!(-1),
            serde_json::json!(256),
            serde_json::json!("0"),
            Value::Null,
        ] {
            let mut bytes = vec![serde_json::json!(0); 12];
            bytes[0] = bad;
            let host = BadRandom(serde_json::json!(bytes));
            let value = serde_json::json!({});
            let mut task = std::pin::pin!(encode(&host, &value, "secret"));
            let Poll::Ready(result) = task.as_mut().poll(&mut Context::from_waker(Waker::noop()))
            else {
                panic!("test host must complete immediately")
            };
            assert_eq!(result.unwrap_err().code, "invalid_random_bytes");
        }
    }
}
