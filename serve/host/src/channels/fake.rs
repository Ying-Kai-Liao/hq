//! An in-memory platform for the core's tests: it records everything the core asks of an adapter.

use super::adapter::{Adapter, Alive, Ended, Fut, Incoming, Reaction};
use crate::LockExt;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Reply(String),
    OpenThread { agent: String, title: String },
    Post { thread: String, agent: String, text: String, ctx: Option<f64> },
    Files { agent: String, files: Vec<String>, caption: String },
    Status { wid: String },
    StatusText(String),
    StatusEnd(Ended),
    React(Reaction),
    Ask { pid: String, agents: Vec<String> },
}

pub struct Fake {
    conn: String,
    alive: Alive,
    pub events: Mutex<Vec<Event>>,
    threads: AtomicUsize,
    /// `start()` calls so far.
    pub starts: AtomicUsize,
    /// What `start()` does: wait forever, or fail at once.
    pub fail_start: bool,
    pub quiet: Option<Duration>,
}

impl Fake {
    pub fn new(conn: &str) -> Self {
        Self {
            conn: conn.to_owned(),
            alive: Alive::default(),
            events: Mutex::new(Vec::new()),
            threads: AtomicUsize::new(0),
            starts: AtomicUsize::new(0),
            fail_start: false,
            quiet: None,
        }
    }

    pub fn events(&self) -> Vec<Event> {
        self.events.locked().clone()
    }

    fn push(&self, e: Event) {
        self.events.locked().push(e);
    }

    /// (agent, text) of every post, in order.
    pub fn posts(&self) -> Vec<(String, String)> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Event::Post { agent, text, .. } => Some((agent, text)),
                _ => None,
            })
            .collect()
    }

    pub fn replies(&self) -> Vec<String> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Event::Reply(t) => Some(t),
                _ => None,
            })
            .collect()
    }
}

impl Adapter for Fake {
    fn platform(&self) -> &str {
        self.conn.split('/').next().unwrap_or("fake")
    }

    fn conn(&self) -> &str {
        &self.conn
    }

    fn footer(&self) -> &'static str {
        "\n\nFOOTER"
    }

    fn quiet(&self) -> Option<Duration> {
        self.quiet
    }

    fn alive(&self) -> &Alive {
        &self.alive
    }

    fn start(&self) -> Fut<'_, Result<()>> {
        Box::pin(async move {
            self.starts.fetch_add(1, Ordering::SeqCst);
            if self.fail_start {
                bail!("the platform said no");
            }
            std::future::pending::<()>().await;
            Ok(())
        })
    }

    fn reply<'a>(&'a self, _m: &'a Incoming, text: &'a str) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            self.push(Event::Reply(text.to_owned()));
            Ok(())
        })
    }

    fn open_thread<'a>(&'a self, m: &'a Incoming, agent: &'a str, title: &'a str) -> Fut<'a, Result<(String, Value)>> {
        Box::pin(async move {
            self.push(Event::OpenThread { agent: agent.to_owned(), title: title.to_owned() });
            let n = self.threads.fetch_add(1, Ordering::SeqCst) + 1;
            Ok((format!("{}:{n}", m.room), json!({"chat": m.room})))
        })
    }

    fn post<'a>(&'a self, conv: &'a Value, agent: &'a str, text: &'a str, ctx_pct: Option<f64>) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            let thread = conv["key"].as_str().unwrap_or("").to_owned();
            self.push(Event::Post { thread, agent: agent.to_owned(), text: text.to_owned(), ctx: ctx_pct });
            Ok(())
        })
    }

    fn send_files<'a>(
        &'a self,
        _conv: &'a Value,
        agent: &'a str,
        files: &'a [String],
        caption: &'a str,
    ) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            self.push(Event::Files { agent: agent.to_owned(), files: files.to_vec(), caption: caption.to_owned() });
            Ok(())
        })
    }

    fn status<'a>(&'a self, _conv: &'a Value, _agent: &'a str, wid: &'a str) -> Fut<'a, Result<Value>> {
        Box::pin(async move {
            self.push(Event::Status { wid: wid.to_owned() });
            Ok(json!({"line": wid}))
        })
    }

    fn status_text<'a>(&'a self, _handle: &'a Value, text: &'a str) -> Fut<'a, ()> {
        Box::pin(async move { self.push(Event::StatusText(text.to_owned())) })
    }

    fn status_end<'a>(&'a self, _conv: &'a Value, _agent: &'a str, _handle: &'a Value, ended: Ended) -> Fut<'a, ()> {
        Box::pin(async move { self.push(Event::StatusEnd(ended)) })
    }

    fn react<'a>(&'a self, _m: &'a Incoming, what: Reaction) -> Fut<'a, ()> {
        Box::pin(async move { self.push(Event::React(what)) })
    }

    fn ask<'a>(&'a self, _m: &'a Incoming, pid: &'a str, agents: &'a [String]) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            self.push(Event::Ask { pid: pid.to_owned(), agents: agents.to_vec() });
            Ok(())
        })
    }

    fn env(&self, _conv: &Value, _agent: &str) -> Vec<(String, String)> {
        vec![("FAKE_EXTRA".into(), "1".into())]
    }
}
