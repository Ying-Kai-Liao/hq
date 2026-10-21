//! The Slack Web API over HTTP and the file transfers around it. Both tokens (the bot's `xoxb-`, the app's `xapp-`)
//! travel in headers, and Socket Mode's URL carries a ticket: nothing here logs a URL or an unscrubbed error.

use serde_json::Value;
use std::fmt;
use std::time::Duration;

/// How long a call may take.
pub const CALL: Duration = Duration::from_secs(30);
pub const TRANSFER: Duration = Duration::from_secs(120);

/// A 429 that asks for longer than this is not waited out inside a send.
const RETRY_AFTER_MAX: u64 = 60;

#[derive(Debug, Clone)]
pub enum SlackError {
    /// Slack answered with an error: the HTTP status, its `error` code, and how long to wait on a 429.
    Http { code: u16, description: String, retry_after: Option<u64> },
    /// The request did not get an answer (or not a Slack one).
    Net(String),
}

impl fmt::Display for SlackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { code, description, .. } => write!(f, "{code} {description}"),
            Self::Net(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for SlackError {}

/// Which token a call is made with.
#[derive(Clone, Copy)]
pub enum As {
    Bot,
    App,
}

/// Form-encoded: everything but unreserved characters as `%XX`.
fn encode(text: &str) -> String {
    use std::fmt::Write as _;
    text.bytes().fold(String::new(), |mut out, b| {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
        out
    })
}

pub struct Api {
    /// `https://slack.com/api`, or a fake in tests.
    base: String,
    bot: String,
    app: String,
}

impl Api {
    pub fn new(base: &str, bot: &str, app: &str) -> Self {
        Self { base: base.trim_end_matches('/').to_owned(), bot: bot.to_owned(), app: app.to_owned() }
    }

    /// Text that may be logged: the tokens taken out.
    pub fn scrub(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for secret in [&self.bot, &self.app].into_iter().filter(|s| !s.is_empty()) {
            text = text.replace(secret.as_str(), "<token>");
        }
        text
    }

    fn net(&self, e: reqwest::Error) -> SlackError {
        SlackError::Net(self.scrub(&e.without_url().to_string()))
    }

    fn token(&self, who: As) -> &str {
        match who {
            As::Bot => &self.bot,
            As::App => &self.app,
        }
    }

    /// One call with a JSON body -> Slack's answer (`ok` is true).
    pub async fn call(&self, method: &str, params: &Value, who: As) -> Result<Value, SlackError> {
        let sent = crate::http()
            .post(format!("{}/{method}", self.base))
            .bearer_auth(self.token(who))
            .json(params)
            .timeout(CALL)
            .send()
            .await;
        self.answer(sent).await
    }

    /// A bot call that waits out a short 429 (twice) instead of failing.
    pub async fn call_retry(&self, method: &str, params: &Value) -> Result<Value, SlackError> {
        self.waiting_out(|| self.call(method, params, As::Bot)).await
    }

    /// A call with form fields (the upload methods take no JSON), with the same patience.
    pub async fn form_retry(&self, method: &str, fields: &[(&str, String)]) -> Result<Value, SlackError> {
        let body = fields.iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect::<Vec<_>>().join("&");
        self.waiting_out(|| async {
            let sent = crate::http()
                .post(format!("{}/{method}", self.base))
                .bearer_auth(self.token(As::Bot))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(body.clone())
                .timeout(CALL)
                .send()
                .await;
            self.answer(sent).await
        })
        .await
    }

    async fn waiting_out<F, Fut>(&self, mut once: F) -> Result<Value, SlackError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Value, SlackError>>,
    {
        let mut tries = 0;
        loop {
            match once().await {
                Err(SlackError::Http { code: 429, retry_after: Some(secs), .. })
                    if tries < 2 && secs <= RETRY_AFTER_MAX =>
                {
                    tries += 1;
                    tokio::time::sleep(Duration::from_secs(secs.max(1))).await;
                }
                other => return other,
            }
        }
    }

    /// The bytes of a file, to the URL Slack gave for it (no token: the URL is the grant).
    pub async fn put(&self, url: &str, data: Vec<u8>) -> Result<(), SlackError> {
        let res = crate::http().post(url).body(data).timeout(TRANSFER).send().await.map_err(|e| self.net(e))?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(SlackError::Http {
                code: res.status().as_u16(),
                description: "upload refused".into(),
                retry_after: None,
            })
        }
    }

    /// A file Slack holds (`url_private`), streamed to `dest` with the bot token; more than `max` bytes is refused
    /// and nothing is left behind.
    pub async fn download(&self, url: &str, dest: &std::path::Path, max: u64) -> Result<(), SlackError> {
        use futures::StreamExt as _;
        use tokio::io::AsyncWriteExt as _;
        let sent = crate::http().get(url).bearer_auth(&self.bot).timeout(TRANSFER).send().await;
        let res = sent.map_err(|e| self.net(e))?;
        if !res.status().is_success() {
            let code = res.status().as_u16();
            return Err(SlackError::Http { code, description: "file not available".into(), retry_after: None });
        }
        let io = |e: std::io::Error| SlackError::Net(format!("can't write the file: {e}"));
        let mut out = tokio::fs::File::create(dest).await.map_err(io)?;
        let (mut stream, mut size) = (res.bytes_stream(), 0u64);
        let mut result = Ok(());
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    result = Err(self.net(e));
                    break;
                }
            };
            size += chunk.len() as u64;
            if size > max {
                result = Err(SlackError::Net("file too big".into()));
                break;
            }
            if let Err(e) = out.write_all(&chunk).await {
                result = Err(io(e));
                break;
            }
        }
        drop(out);
        if result.is_err() {
            let _ = tokio::fs::remove_file(dest).await;
        }
        result
    }

    async fn answer(&self, sent: Result<reqwest::Response, reqwest::Error>) -> Result<Value, SlackError> {
        let res = sent.map_err(|e| self.net(e))?;
        let status = res.status();
        let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
        let body: Option<Value> = res.json().await.ok();
        let Some(body) = body else {
            return Err(SlackError::Http { code: status.as_u16(), description: "no JSON answer".into(), retry_after });
        };
        if status.is_success() && body["ok"] == true {
            return Ok(body);
        }
        Err(SlackError::Http {
            code: status.as_u16(),
            description: self.scrub(body["error"].as_str().unwrap_or("")),
            retry_after,
        })
    }
}
