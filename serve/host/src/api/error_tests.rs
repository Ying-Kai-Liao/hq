//! What a failed call shows: the owner the full text, a guest only the words written for them.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::devices::{Forbidden, NotAllowed};
use super::hide_internals;
use anyhow::anyhow;

#[test]
fn internal_errors_are_replaced_for_guests_only() {
    let internal = || Err(anyhow!("No such file or directory").context("starting `npx kith-auth` in /Users/kai/x"));
    let owner = hide_internals(true, "m", internal()).unwrap_err();
    assert_eq!(format!("{owner:#}"), "starting `npx kith-auth` in /Users/kai/x: No such file or directory");
    let guest = hide_internals(false, "m", internal()).unwrap_err();
    let text = format!("{guest:#}");
    assert!(text.starts_with("Something went wrong on the host. (ref "), "{text}");
    assert!(!text.contains("/Users") && !text.contains("npx"), "{text}");
    // Each failure gets its own id, so a report can be matched to one log line.
    let other = format!("{:#}", hide_internals(false, "m", internal()).unwrap_err());
    assert_ne!(text, other);
}

#[test]
fn errors_written_for_the_person_keep_their_text() {
    let denied = hide_internals(false, "m", Err(NotAllowed("Not yours.".into()).into())).unwrap_err();
    assert_eq!(denied.to_string(), "Not yours.");
    let local = hide_internals(false, "m", Err(Forbidden.into())).unwrap_err();
    assert_eq!(local.to_string(), "This can only be done at the computer itself.");
    assert!(hide_internals(false, "m", Ok(serde_json::json!(1))).is_ok());
}
