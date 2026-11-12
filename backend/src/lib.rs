pub mod answer;
pub mod api;
pub mod cursor;
pub mod github;
pub mod runtime;
pub mod storage;
pub mod sync;

#[cfg(target_arch = "wasm32")]
mod bindings {
    use crate::runtime::*;
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::JsFuture;
    struct JsHost(js_sys::Function);
    impl Host for JsHost {
        async fn call(&self, op: &str, value: serde_json::Value) -> Result<serde_json::Value> {
            let promise = self
                .0
                .call2(
                    &JsValue::NULL,
                    &JsValue::from_str(op),
                    &JsValue::from_str(&value.to_string()),
                )
                .map_err(|_| Error::new(503, "host_call_failed"))?;
            let response = JsFuture::from(js_sys::Promise::resolve(&promise))
                .await
                .map_err(|_| Error::new(503, "host_call_failed"))?;
            let envelope: serde_json::Value = serde_json::from_str(
                &response
                    .as_string()
                    .ok_or_else(|| Error::new(503, "invalid_host_response"))?,
            )
            .map_err(|_| Error::new(503, "invalid_host_response"))?;
            if let Some(code) = envelope["error"].as_str() {
                return Err(Error::new(
                    envelope["status"].as_u64().unwrap_or(503) as u16,
                    code,
                ));
            }
            Ok(envelope["value"].clone())
        }
    }
    #[wasm_bindgen]
    pub async fn handle(input: String, config: String, host: js_sys::Function) -> String {
        let result = async {
            let request =
                serde_json::from_str(&input).map_err(|_| Error::new(400, "invalid_request"))?;
            let config = serde_json::from_str(&config)
                .map_err(|_| Error::new(503, "invalid_configuration"))?;
            crate::api::handle(&JsHost(host), &config, request).await
        }
        .await;
        result.unwrap_or_else(|e| e.response()).to_string()
    }
    #[wasm_bindgen]
    pub async fn stream(state: String, config: String, host: js_sys::Function) -> String {
        let host = JsHost(host);
        let result = async {
            let state =
                serde_json::from_str(&state).map_err(|_| Error::new(400, "invalid_request"))?;
            let config = serde_json::from_str(&config)
                .map_err(|_| Error::new(503, "invalid_configuration"))?;
            crate::api::stream(&host, &config, state).await
        }
        .await;
        if let Err(error) = result {
            let _ = host
                .call(
                    "emit",
                    serde_json::json!({"event":"error","data":{"error":error.code}}),
                )
                .await;
        }
        "null".into()
    }
    #[wasm_bindgen]
    pub async fn event(
        input: String,
        config: String,
        host: js_sys::Function,
    ) -> std::result::Result<(), JsValue> {
        let result = async {
            let input =
                serde_json::from_str(&input).map_err(|_| Error::new(400, "invalid_request"))?;
            let config = serde_json::from_str(&config)
                .map_err(|_| Error::new(503, "invalid_configuration"))?;
            crate::api::event(&JsHost(host), &config, input).await
        }
        .await;
        result.map_err(|e| JsValue::from_str(&e.code))
    }
}

pub mod vocabulary;
