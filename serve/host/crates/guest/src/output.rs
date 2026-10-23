//! Where results and progress go (section 9.3): results on stdout, progress and warnings on stderr, and with `--json`
//! one JSON object per line on stdout and no JSON on stderr. A broken pipe never fails a command.

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::exit::CliError;

type Sink = Box<dyn Write + Send>;

pub struct Out {
    pub json: bool,
    stdout: Mutex<Sink>,
    stderr: Mutex<Sink>,
}

/// What a test captured.
#[derive(Clone, Default)]
pub struct Captured {
    pub stdout: Arc<Mutex<Vec<u8>>>,
    pub stderr: Arc<Mutex<Vec<u8>>>,
}

impl Captured {
    pub fn out(&self) -> String {
        String::from_utf8_lossy(&self.stdout.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).into_owned()
    }

    pub fn err(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).into_owned()
    }
}

struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Out {
    pub fn std(json: bool) -> Self {
        Self { json, stdout: Mutex::new(Box::new(std::io::stdout())), stderr: Mutex::new(Box::new(std::io::stderr())) }
    }

    pub fn capture(json: bool) -> (Self, Captured) {
        let cap = Captured::default();
        let out = Self {
            json,
            stdout: Mutex::new(Box::new(Shared(cap.stdout.clone()))),
            stderr: Mutex::new(Box::new(Shared(cap.stderr.clone()))),
        };
        (out, cap)
    }

    fn write(sink: &Mutex<Sink>, text: &str) {
        let mut s = sink.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // A closed pipe (`kith ask ... | head -1`) is the reader's choice, not an error.
        let _ = s.write_all(text.as_bytes());
        let _ = s.flush();
    }

    /// Result text, exactly as given (the caller adds the newline).
    pub fn stdout(&self, text: &str) {
        Self::write(&self.stdout, text);
    }

    /// A progress line or warning.
    pub fn info(&self, line: &str) {
        Self::write(&self.stderr, &format!("{line}\n"));
    }

    /// One `--json` event. Does nothing without `--json`, so callers print the plain form themselves.
    pub fn event(&self, value: &Value) {
        if self.json {
            Self::write(&self.stdout, &format!("{value}\n"));
        }
    }

    pub fn error(&self, e: &CliError) {
        self.event(&serde_json::json!({"type": "error", "code": e.code, "message": e.message, "exit": e.exit.code()}));
        self.info(&format!("kith: {}", e.message));
    }
}
