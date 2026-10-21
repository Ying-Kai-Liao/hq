//! The background tasks of one connection (setup, rescan, catch-up, button presses), which end with it.

use crate::LockExt;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

/// A handle to start tasks that [`Guard`] ends.
#[derive(Clone, Default)]
pub struct Tasks(Arc<Mutex<Vec<JoinHandle<()>>>>);

impl Tasks {
    pub fn spawn(&self, fut: impl Future<Output = ()> + Send + 'static) {
        let mut all = self.0.locked();
        all.retain(|t| !t.is_finished());
        all.push(tokio::spawn(fut));
    }
}

/// Aborts every task started through its [`Tasks`] when dropped (the connection ended or was aborted).
pub struct Guard(pub Tasks);

impl Drop for Guard {
    fn drop(&mut self) {
        for t in self.0.0.locked().drain(..) {
            t.abort();
        }
    }
}
