//! The Kith account as a person's handle: the account that claimed this Mac is the owner person in kith-auth, so
//! `kith-auth who kith <clerk user id>` finds the same person who talks on Telegram. Only the kith-auth CLI writes
//! auth.json; this module never touches the file.

use crate::api::devices::Caller;
use crate::channels::hq::{self, Who};
use crate::hub::Hub;
use crate::store::{Store, now_ms};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The platform name of an account handle, next to telegram and discord.
const PLATFORM: &str = "kith";
/// The Clerk user id this host last bound (or found bound) to its owner person.
const APPLIED: &str = "account_handle";
/// The conflicting account id already warned about, so repeated pulls stay quiet.
static CONFLICT_WARNED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static NO_OWNER_LOGGED: AtomicBool = AtomicBool::new(false);
/// How long a `linkCode` stays good, in minutes.
const LINK_MINUTES: u32 = 15;

/// kith-auth for this host, or None when the host must not touch it. A throwaway `KITH_SERVE_HOME` shares the real
/// ~/.kith with the Mac's own kith, so it only gets in when the test points `KITH_AUTH` somewhere else.
fn auth_bin() -> Option<PathBuf> {
    let temporary = cfg!(test) || crate::service::data_dir() != crate::service::default_data_dir();
    if temporary && std::env::var_os("KITH_AUTH").is_none() {
        return None;
    }
    hq::Paths::discover().map(|p| p.auth_bin)
}

/// After a successful pull: makes the owner person's `kith` handle match the claiming account. Never fails the pull.
pub async fn sync(hub: &Hub, owner: Option<&str>) {
    if hub.store.kv_get(APPLIED).as_deref() == owner {
        return;
    }
    let Ok(Some(bin)) = tokio::task::spawn_blocking(auth_bin).await else { return };
    if let Err(e) = apply(&hub.store, &bin, owner).await {
        tracing::warn!(error = format!("{e:#}"), "couldn't update the account handle in kith-auth");
    }
}

async fn apply(store: &Store, bin: &Path, owner: Option<&str>) -> Result<()> {
    let Some(uid) = owner else {
        // Unclaimed (or the account was deleted): the handle goes with it.
        if let Some(old) = store.kv_get(APPLIED) {
            if let Some(person) = who(bin, &old).await.person {
                run(bin, &["handle", &person, PLATFORM, "--rm"]).await?;
                tracing::info!(person, "the Mac left its account; removed the person's kith handle");
            }
            store.kv_delete(APPLIED)?;
        }
        return Ok(());
    };
    let found = who(bin, uid).await;
    match (&found.person, &found.owner_id) {
        (Some(_), _) if found.owner => {}
        (Some(person), _) => {
            let mut last = CONFLICT_WARNED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if last.as_deref() != Some(uid) {
                tracing::warn!(
                    person,
                    uid,
                    "this Kith account is already another person's in kith-auth; not taking it over"
                );
                *last = Some(uid.to_owned());
            }
            return Ok(());
        }
        (None, Some(person)) => {
            // Replaces a handle bound to an earlier account of this Mac.
            run(bin, &["handle", person, PLATFORM, uid]).await?;
            tracing::info!(person, "bound the claiming account to the owner person");
        }
        (None, None) => {
            // Not cached: the owner person may be made later, and the next pull should then bind. Logged once.
            if !NO_OWNER_LOGGED.swap(true, Ordering::Relaxed) {
                tracing::warn!("kith-auth has no owner person; not binding the account (kith-auth person <you> owner)");
            }
            return Ok(());
        }
    }
    store.kv_set(APPLIED, uid)?;
    Ok(())
}

async fn who(bin: &Path, uid: &str) -> Who {
    let out = hq::output(bin, &["who", PLATFORM, uid]).await;
    out.and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()).map_or_else(Who::default, |v| Who::parse(&v))
}

async fn run(bin: &Path, args: &[&str]) -> Result<String> {
    let out = hq::output(bin, args).await.ok_or_else(|| anyhow!("kith-auth didn't run"))?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Which person a call is for. Phase A: every paired or claimed device is the owner, so it is the owner person;
/// phase B maps `Caller::Device` keys to invited people here.
async fn caller_person(bin: &Path, _caller: &Caller) -> Result<String> {
    who(bin, "-")
        .await
        .owner_id
        .ok_or_else(|| anyhow!("kith-auth has no owner person yet (kith-auth person <you> owner)"))
}

/// `linkCode`: a one-time code the caller's person sends as `/link <code>` to the Kith bot on Telegram, Discord or Slack.
pub async fn link_code(caller: &Caller) -> Result<Value> {
    let bin = tokio::task::spawn_blocking(auth_bin)
        .await?
        .ok_or_else(|| anyhow!("Linking isn't available on this computer (kith-auth not found)."))?;
    let person = caller_person(&bin, caller).await?;
    let out = run(&bin, &["invite", &person, &LINK_MINUTES.to_string()]).await?;
    let code = out.lines().next().unwrap_or("").trim().to_owned();
    if code.is_empty() {
        bail!("kith-auth gave no code");
    }
    Ok(json!({"code": code, "expiresAt": now_ms() + i64::from(LINK_MINUTES) * 60_000}))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    /// A throwaway auth.json driven by the repo's own kith-auth.
    struct Rig {
        dir: PathBuf,
        bin: PathBuf,
        store: Store,
    }

    impl Rig {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("kith-account-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../kernel/bin/kith-auth");
            Self { store: Store::open(&dir.join("t.db")).unwrap(), dir, bin }
        }

        fn auth(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("python3")
                .arg(&self.bin)
                .args(args)
                .env("KITH_AUTH", self.dir.join("auth.json"))
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        fn point_env(&self) {
            // SAFETY: tests in this module hold ONE_AT_A_TIME, so nothing else reads or writes the environment meanwhile.
            unsafe { std::env::set_var("KITH_AUTH", self.dir.join("auth.json")) };
        }

        /// What the handle sync sees: the same CLI, pointed at the temp store.
        async fn apply(&self, owner: Option<&str>) {
            self.point_env();
            apply(&self.store, &self.bin, owner).await.unwrap();
        }

        fn who(&self, uid: &str) -> Value {
            serde_json::from_str(&self.auth(&["who", "kith", uid])).unwrap()
        }
    }

    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn claimed_binds_the_owner_and_unclaimed_removes_it() {
        let _g = ONE_AT_A_TIME.lock().await;
        let r = Rig::new();
        r.auth(&["person", "kai", "owner"]);
        r.apply(Some("user_2AbC")).await;
        assert_eq!(r.who("user_2AbC")["person"], "kai");
        assert_eq!(r.who("user_2AbC")["owner"], true);
        // A pull that sees the same account again changes nothing.
        r.apply(Some("user_2AbC")).await;
        assert_eq!(r.who("user_2AbC")["person"], "kai");
        // A second account replaces the first.
        r.apply(Some("user_2XyZ")).await;
        assert_eq!(r.who("user_2XyZ")["person"], "kai");
        assert!(r.who("user_2AbC")["person"].is_null());
        // Unclaimed: the handle goes, and the person stays.
        r.apply(None).await;
        assert!(r.who("user_2XyZ")["person"].is_null());
        assert_eq!(r.who("user_2XyZ")["owner_id"], "kai");
        assert!(r.store.kv_get(APPLIED).is_none());
    }

    #[tokio::test]
    async fn another_persons_handle_is_not_taken() {
        let _g = ONE_AT_A_TIME.lock().await;
        let r = Rig::new();
        r.auth(&["person", "kai", "owner"]);
        r.auth(&["person", "bob"]);
        r.auth(&["handle", "bob", "kith", "user_2Bob"]);
        r.apply(Some("user_2Bob")).await;
        assert_eq!(r.who("user_2Bob")["person"], "bob");
        assert!(r.store.kv_get(APPLIED).is_none());
    }

    #[tokio::test]
    async fn no_owner_person_creates_nobody() {
        let _g = ONE_AT_A_TIME.lock().await;
        let r = Rig::new();
        r.apply(Some("user_2AbC")).await;
        assert!(r.who("user_2AbC")["person"].is_null());
        assert!(r.store.kv_get(APPLIED).is_none());
        assert!(!r.dir.join("auth.json").exists() || r.auth(&["people"]).contains("no people"));
    }

    #[tokio::test]
    async fn link_code_is_the_owners_invite() {
        let _g = ONE_AT_A_TIME.lock().await;
        let r = Rig::new();
        r.auth(&["person", "kai", "owner"]);
        r.point_env();
        assert_eq!(caller_person(&r.bin, &Caller::Local).await.unwrap(), "kai");
        let out = run(&r.bin, &["invite", "kai", "15"]).await.unwrap();
        assert_eq!(out.lines().next().unwrap().len(), 6);
    }
}
