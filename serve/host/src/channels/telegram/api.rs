//! The Telegram Bot API over HTTP: JSON calls, hand-built multipart uploads and file downloads. The bot token is in
//! every URL, so nothing here ever logs or returns a URL, and error text is scrubbed of the token.

use serde_json::Value;
use std::fmt;
use std::time::Duration;

/// How long a call may take (a long poll waits up to 50 s by itself).
pub const CALL: Duration = Duration::from_secs(70);
pub const UPLOAD: Duration = Duration::from_secs(120);

/// A 429 that asks for longer than this is not waited out inside a send.
const RETRY_AFTER_MAX: u64 = 60;

#[derive(Debug, Clone)]
pub enum TgError {
    /// Telegram answered with an error: its code, what it says, and how long to wait on a 429.
    Http { code: u16, description: String, retry_after: Option<u64> },
    /// The request did not get an answer (or not a Telegram one).
    Net(String),
}

impl fmt::Display for TgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { code, description, .. } => write!(f, "{code} {description}"),
            Self::Net(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for TgError {}

pub struct Api {
    /// `https://api.telegram.org`, or a fake in tests.
    base: String,
    token: String,
}

impl Api {
    pub fn new(base: &str, token: &str) -> Self {
        Self { base: base.trim_end_matches('/').to_owned(), token: token.to_owned() }
    }

    fn url(&self, method: &str) -> String {
        format!("{}/bot{}/{method}", self.base, self.token)
    }

    /// Text that may be logged: the token taken out.
    fn scrub(&self, text: &str) -> String {
        text.replace(&self.token, "<token>")
    }

    fn net(&self, e: reqwest::Error) -> TgError {
        TgError::Net(self.scrub(&e.without_url().to_string()))
    }

    /// One call -> its `result`.
    pub async fn call(&self, method: &str, params: &Value, timeout: Duration) -> Result<Value, TgError> {
        let sent = crate::http().post(self.url(method)).json(params).timeout(timeout).send().await;
        self.answer(sent).await
    }

    /// A call that waits out a short 429 (twice) instead of failing.
    pub async fn call_retry(&self, method: &str, params: &Value) -> Result<Value, TgError> {
        let mut tries = 0;
        loop {
            match self.call(method, params, CALL).await {
                Err(TgError::Http { code: 429, retry_after: Some(secs), .. })
                    if tries < 2 && secs <= RETRY_AFTER_MAX =>
                {
                    tries += 1;
                    tokio::time::sleep(Duration::from_secs(secs.max(1))).await;
                }
                other => return other,
            }
        }
    }

    /// A call with one file (`field`) read from `path`; the other parameters are form fields.
    pub async fn upload(&self, method: &str, params: &Value, field: &str, path: &str) -> Result<Value, TgError> {
        let data = tokio::fs::read(path).await.map_err(|e| TgError::Net(format!("can't read the file: {e}")))?;
        let boundary = uuid::Uuid::new_v4().simple().to_string();
        let mut body = Vec::new();
        for (k, v) in params.as_object().into_iter().flatten() {
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            body.extend(
                format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{text}\r\n").bytes(),
            );
        }
        let name =
            std::path::Path::new(path).file_name().map_or_else(String::new, |n| n.to_string_lossy().replace('"', ""));
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .bytes(),
        );
        body.extend(data);
        body.extend(format!("\r\n--{boundary}--\r\n").bytes());
        let sent = crate::http()
            .post(self.url(method))
            .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
            .body(body)
            .timeout(UPLOAD)
            .send()
            .await;
        self.answer(sent).await
    }

    /// A file Telegram holds (`file_path` from getFile).
    pub async fn download(&self, file_path: &str) -> Result<Vec<u8>, TgError> {
        let url = format!("{}/file/bot{}/{file_path}", self.base, self.token);
        let res = crate::http().get(url).timeout(UPLOAD).send().await.map_err(|e| self.net(e))?;
        if !res.status().is_success() {
            let code = res.status().as_u16();
            return Err(TgError::Http { code, description: "file not available".into(), retry_after: None });
        }
        res.bytes().await.map(|b| b.to_vec()).map_err(|e| self.net(e))
    }

    async fn answer(&self, sent: Result<reqwest::Response, reqwest::Error>) -> Result<Value, TgError> {
        let res = sent.map_err(|e| self.net(e))?;
        let status = res.status();
        let body: Option<Value> = res.json().await.ok();
        let Some(body) = body else {
            let description = "no JSON answer".to_owned();
            return Err(TgError::Http { code: status.as_u16(), description, retry_after: None });
        };
        if status.is_success() && body["ok"] == true {
            return Ok(body["result"].clone());
        }
        let code = body["error_code"].as_u64().and_then(|c| u16::try_from(c).ok()).unwrap_or(status.as_u16());
        Err(TgError::Http {
            code,
            description: self.scrub(body["description"].as_str().unwrap_or("")),
            retry_after: body["parameters"]["retry_after"].as_u64(),
        })
    }
}
