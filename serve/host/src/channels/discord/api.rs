//! Discord's REST API: one request helper that respects rate limits, and the pieces a body is made of.
//! Nothing here puts a token or a webhook URL (which holds one) into an error.

use anyhow::{Result, anyhow};
use reqwest::Method;
use serde_json::Value;
use std::time::Duration;

/// Waits longer than this for one rate limit are given up on.
const MAX_WAIT: Duration = Duration::from_secs(60);
const MAX_TRIES: usize = 6;

/// A request body.
#[derive(Clone)]
pub enum Body {
    None,
    Json(Value),
    /// A multipart body made by [`multipart`]: its boundary and bytes.
    Multipart(String, Vec<u8>),
}

/// Discord said no. `code` is its JSON error code (10015: unknown webhook, 50083: thread archived).
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Discord answered {} (code {}): {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

/// The Discord error behind `e`, if it is one.
pub fn api_error(e: &anyhow::Error) -> Option<&ApiError> {
    e.downcast_ref::<ApiError>()
}

#[derive(Clone)]
pub struct Api {
    base: String,
    token: String,
}

impl Api {
    pub fn new(base: &str, token: &str) -> Self {
        Self { base: base.trim_end_matches('/').to_owned(), token: token.to_owned() }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// A call to a path of the API, as the bot.
    pub async fn bot(&self, method: Method, path: &str, body: Body) -> Result<Value> {
        self.call(method, &self.url(path), body, true).await
    }

    /// A call to any URL (a webhook's, an interaction's: their tokens are in the URL, so no bot header).
    pub async fn call(&self, method: Method, url: &str, body: Body, auth: bool) -> Result<Value> {
        for attempt in 1..=MAX_TRIES {
            let mut req = crate::http().request(method.clone(), url).timeout(Duration::from_secs(60));
            if auth {
                req = req.header("Authorization", format!("Bot {}", self.token));
            }
            req = match &body {
                Body::None => req,
                Body::Json(v) => req.json(v),
                Body::Multipart(boundary, bytes) => {
                    req.header("Content-Type", format!("multipart/form-data; boundary={boundary}")).body(bytes.clone())
                }
            };
            // reqwest's errors name the URL, which may hold a webhook token.
            let resp = req.send().await.map_err(|e| anyhow!("Discord request failed: {}", e.without_url()))?;
            let status = resp.status().as_u16();
            let retry_header = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()?.parse::<f64>().ok());
            let text = resp.text().await.map_err(|e| anyhow!("Discord response failed: {}", e.without_url()))?;
            let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if status == 429 && attempt < MAX_TRIES {
                let wait =
                    json["retry_after"].as_f64().or(retry_header).unwrap_or(1.0).clamp(0.0, MAX_WAIT.as_secs_f64());
                tracing::debug!("discord: rate limited; waiting {wait:.2}s");
                tokio::time::sleep(Duration::from_secs_f64(wait) + Duration::from_millis(20)).await;
                continue;
            }
            if (200..300).contains(&status) {
                return Ok(json);
            }
            return Err(ApiError {
                status,
                code: json["code"].as_i64().unwrap_or(0),
                message: json["message"].as_str().unwrap_or("").chars().take(200).collect(),
            }
            .into());
        }
        Err(anyhow!("Discord kept rate limiting this call"))
    }
}

/// A multipart body: `payload` as the `payload_json` part, then each (file name, bytes) as `files[n]`.
pub fn multipart(payload: &Value, files: &[(String, Vec<u8>)]) -> Body {
    let boundary = format!("hq{}", uuid::Uuid::new_v4().simple());
    let mut out = Vec::new();
    let mut part = |headers: &str, bytes: &[u8]| {
        out.extend_from_slice(format!("--{boundary}\r\n{headers}\r\n\r\n").as_bytes());
        out.extend_from_slice(bytes);
        out.extend_from_slice(b"\r\n");
    };
    part(
        "Content-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json",
        payload.to_string().as_bytes(),
    );
    for (i, (name, bytes)) in files.iter().enumerate() {
        let safe: String = name.chars().filter(|c| !matches!(c, '"' | '\r' | '\n' | '\\')).collect();
        part(
            &format!(
                "Content-Disposition: form-data; name=\"files[{i}]\"; filename=\"{safe}\"\r\nContent-Type: application/octet-stream"
            ),
            bytes,
        );
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Body::Multipart(boundary, out)
}

/// A snowflake as the number Python's state holds, or the text when it isn't one.
pub fn id_value(id: &str) -> Value {
    id.parse::<u64>().map_or_else(|_| Value::String(id.to_owned()), Value::from)
}

/// A snowflake out of JSON, whether it came as a number (the bridge's state) or text (Discord's API).
pub fn id_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// When a snowflake was made, in unix seconds.
#[allow(clippy::cast_precision_loss)]
pub fn snowflake_time(id: u64) -> f64 {
    ((id >> 22) + 1_420_070_400_000) as f64 / 1000.0
}

/// The first snowflake of a moment (unix milliseconds): what "since then" means to the messages call.
pub fn time_snowflake(unix_ms: u64) -> u64 {
    unix_ms.saturating_sub(1_420_070_400_000) << 22
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snowflakes_round_trip_through_time() {
        let id = time_snowflake(1_800_000_000_000);
        assert!((snowflake_time(id) - 1_800_000_000.0).abs() < 0.01);
        assert_eq!(id_of(&json!(123)), Some("123".into()));
        assert_eq!(id_of(&json!("123")), Some("123".into()));
        assert_eq!(id_of(&json!(null)), None);
        assert_eq!(id_value("42"), json!(42));
    }

    #[test]
    fn a_multipart_body_has_the_json_and_each_file() {
        let Body::Multipart(boundary, bytes) =
            multipart(&json!({"content": "hi"}), &[("a\"b.txt".into(), b"DATA".to_vec())])
        else {
            panic!("not multipart");
        };
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("name=\"payload_json\"") && text.contains("{\"content\":\"hi\"}"));
        assert!(text.contains("name=\"files[0]\"; filename=\"ab.txt\"") && text.contains("DATA"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }
}
