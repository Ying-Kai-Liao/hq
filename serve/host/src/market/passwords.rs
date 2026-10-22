//! Optional 1Password references. On macOS the service token lives in the Keychain item `kith/1password/default`
//! (account `OP_SERVICE_ACCOUNT_TOKEN`), the same one kith-auth reads, always through /usr/bin/security so the
//! Keychain's per-app access rule treats both alike. Elsewhere it stays encrypted in the vault. References resolve
//! only at the execution boundary and never enter transcripts.
use crate::store::Store;
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

const SLOT: &str = "credential.1password";
const KEYCHAIN_SERVICE: &str = "kith/1password/default";
const KEYCHAIN_ACCOUNT: &str = "OP_SERVICE_ACCOUNT_TOKEN";
/// `security` exits 44 when the item does not exist.
const NOT_FOUND: i32 = 44;

/// The Keychain through /usr/bin/security. Every call is a child process with a deadline, killed on drop, so a locked
/// Keychain sitting on an access prompt nobody sees answers "unavailable" instead of parking the host.
struct Keychain {
    enabled: bool,
    security: PathBuf,
    wait: Duration,
}

impl Keychain {
    fn system() -> Self {
        Self { enabled: cfg!(target_os = "macos"), security: "/usr/bin/security".into(), wait: Duration::from_secs(10) }
    }

    async fn run(&self, args: &[&str]) -> Result<std::process::Output> {
        let child = tokio::process::Command::new(&self.security)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output();
        tokio::time::timeout(self.wait, child)
            .await
            .map_err(|_| anyhow!("Keychain is not answering. Unlock it, or approve its access prompt."))?
            .map_err(|_| anyhow!("Could not run the Keychain tool"))
    }

    async fn read(&self) -> Result<Option<String>> {
        let out = self.run(&["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]).await?;
        match out.status.code() {
            Some(0) => {
                let token = String::from_utf8(out.stdout).map_err(|_| anyhow!("Invalid credential encoding"))?;
                let token = token.trim_end_matches(['\n', '\r']);
                Ok((!token.is_empty()).then(|| token.to_owned()))
            }
            Some(NOT_FOUND) => Ok(None),
            _ => bail!("Could not read the 1Password token from Keychain"),
        }
    }

    /// `security` only takes the password as an argument (`-w -` and a bare `-w` both prompt on the terminal), so the
    /// token is on this child's command line for the moment it runs, as with `kith-auth set`.
    async fn write(&self, token: &str) -> Result<()> {
        let out = self
            .run(&["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", token])
            .await?;
        if !out.status.success() {
            bail!("Could not save the 1Password token to Keychain");
        }
        Ok(())
    }

    async fn delete(&self) -> Result<()> {
        let out = self.run(&["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]).await?;
        match out.status.code() {
            Some(0) | Some(NOT_FOUND) => Ok(()),
            _ => bail!("Could not remove the 1Password token from Keychain"),
        }
    }
}

fn slot_token(store: &Store) -> Result<Option<String>> {
    Ok(super::vault::read(store, SLOT)?.filter(|s| !s.is_empty()))
}

fn clear_slot(store: &Store) {
    // Best effort: a failed clear only leaves a stale copy that the next read clears again.
    if matches!(super::vault::read(store, SLOT), Ok(Some(s)) if !s.is_empty()) {
        let _ = super::vault::write(store, SLOT, "");
    }
}

/// Keychain first. A token left in the old vault slot moves into the Keychain, and the slot is cleared only once
/// that write succeeded.
async fn token(store: &Store, kc: &Keychain) -> Result<Option<String>> {
    if !kc.enabled {
        return slot_token(store);
    }
    if let Some(t) = kc.read().await? {
        clear_slot(store);
        return Ok(Some(t));
    }
    let Some(old) = slot_token(store).ok().flatten() else { return Ok(None) };
    if kc.write(&old).await.is_ok() {
        clear_slot(store);
    }
    Ok(Some(old))
}

/// A thin launchd PATH does not include Homebrew, so look there too.
fn op_path() -> PathBuf {
    let found = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join("op"))
        .chain(["/opt/homebrew/bin/op", "/usr/local/bin/op"].map(PathBuf::from))
        .find(|p| p.is_file());
    found.unwrap_or_else(|| "op".into())
}

pub async fn status(store: &Store) -> Result<Value> {
    status_with(store, &Keychain::system()).await
}

async fn status_with(store: &Store, kc: &Keychain) -> Result<Value> {
    // A stuck or locked Keychain reads as not connected; the apps poll this.
    let connected = token(store, kc).await.ok().flatten().is_some();
    Ok(json!({"provider":if cfg!(target_os="macos") {"Keychain"} else {"Secret Service"},
        "onePasswordConnected":connected}))
}

pub async fn set_token(store: &Store, token: &str) -> Result<Value> {
    set_token_with(store, token, &Keychain::system(), &op_path()).await
}

async fn set_token_with(store: &Store, new: &str, kc: &Keychain, op: &Path) -> Result<Value> {
    if !new.is_empty() {
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            tokio::process::Command::new(op)
                .args(["vault", "list", "--format", "json"])
                .env("OP_SERVICE_ACCOUNT_TOKEN", new)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await;
        if !matches!(result, Ok(Ok(s)) if s.success()) {
            bail!(
                "Install the 1Password CLI on this computer and provide a service account token with access to your shared vault."
            );
        }
    }
    if kc.enabled {
        if new.is_empty() {
            kc.delete().await?;
        } else {
            kc.write(new).await?;
        }
        clear_slot(store);
    } else {
        super::vault::write(store, SLOT, new)?;
    }
    status_with(store, kc).await
}

pub async fn resolve(store: &Store, value: &str) -> Result<String> {
    resolve_with(store, value, &Keychain::system(), &op_path()).await
}

async fn resolve_with(store: &Store, value: &str, kc: &Keychain, op: &Path) -> Result<String> {
    if !value.starts_with("op://") {
        return Ok(value.to_owned());
    }
    if value.len() > 2048 || value.contains(['\n', '\r']) {
        bail!("Invalid 1Password reference");
    }
    let token = token(store, kc).await?.ok_or_else(|| anyhow!("Connect 1Password in Credentials first"))?;
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(op)
            .args(["read", "--no-newline", value])
            .env("OP_SERVICE_ACCOUNT_TOKEN", token)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("1Password timed out"))?
    .map_err(|_| anyhow!("Install the 1Password CLI on this computer"))?;
    if !result.status.success() {
        bail!("Could not read the 1Password reference. Check shared vault access.");
    }
    String::from_utf8(result.stdout).map_err(|_| anyhow!("Invalid credential encoding"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.secret_key.locked().replace(zeroize::Zeroizing::new(vec![7; 32]));
        store
    }

    #[tokio::test]
    async fn ordinary_values_are_unchanged_and_references_require_a_connected_vault() {
        let store = store();
        let kc = Keychain { enabled: false, ..Keychain::system() };
        let op = Path::new("op");
        assert_eq!(resolve_with(&store, " a secret with spaces ", &kc, op).await.unwrap(), " a secret with spaces ");
        assert!(resolve_with(&store, "op://shared/service/key", &kc, op).await.is_err());
        assert!(!status_with(&store, &kc).await.unwrap()["onePasswordConnected"].as_bool().unwrap());
        super::super::vault::write(&store, SLOT, "test-token").unwrap();
        assert!(status_with(&store, &kc).await.unwrap()["onePasswordConnected"].as_bool().unwrap());
        assert!(!status_with(&store, &kc).await.unwrap().to_string().contains("test-token"));
    }

    #[cfg(unix)]
    mod fake {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        pub struct Fake {
            pub dir: PathBuf,
            pub kc: Keychain,
        }

        impl Fake {
            /// A stand-in for /usr/bin/security keeping its one item in a file, so no test touches the real Keychain.
            pub fn new(name: &str, body: Option<&str>) -> Self {
                let dir = std::env::temp_dir().join(format!("kith-pw-{name}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                let script = dir.join("security");
                let body = body.map(str::to_owned).unwrap_or_else(|| {
                    format!(
                        r#"f="{}/item"
case "$1" in
add-generic-password) while [ "$1" != "-w" ]; do shift; done; printf %s "$2" > "$f" ;;
find-generic-password) [ -f "$f" ] && cat "$f" && echo || exit 44 ;;
delete-generic-password) [ -f "$f" ] && rm "$f" || exit 44 ;;
esac
"#,
                        dir.display()
                    )
                });
                std::fs::write(&script, format!("#!/bin/sh\n{body}")).unwrap();
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
                let kc = Keychain { enabled: true, security: script, wait: Duration::from_secs(5) };
                Self { dir, kc }
            }
            pub fn item(&self) -> Option<String> {
                std::fs::read_to_string(self.dir.join("item")).ok()
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_old_vault_slot_token_moves_to_the_keychain_and_the_slot_is_cleared() {
        let (store, fake) = (store(), fake::Fake::new("migrate", None));
        super::super::vault::write(&store, SLOT, "old-token").unwrap();
        assert!(status_with(&store, &fake.kc).await.unwrap()["onePasswordConnected"].as_bool().unwrap());
        assert_eq!(fake.item().as_deref(), Some("old-token"));
        assert_eq!(slot_token(&store).unwrap(), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_keychain_wins_over_a_leftover_slot_and_clears_it() {
        let (store, fake) = (store(), fake::Fake::new("wins", None));
        std::fs::write(fake.dir.join("item"), "kc-token").unwrap();
        super::super::vault::write(&store, SLOT, "stale").unwrap();
        assert_eq!(token(&store, &fake.kc).await.unwrap().as_deref(), Some("kc-token"));
        assert_eq!(slot_token(&store).unwrap(), None);
        assert_eq!(fake.item().as_deref(), Some("kc-token"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connect_writes_the_keychain_and_disconnect_deletes_it() {
        let (store, fake) = (store(), fake::Fake::new("connect", None));
        // `true` stands in for an `op` that accepts the token.
        let op = Path::new("/usr/bin/true");
        let on = set_token_with(&store, "new-token", &fake.kc, op).await.unwrap();
        assert!(on["onePasswordConnected"].as_bool().unwrap());
        assert!(!on.to_string().contains("new-token"));
        assert_eq!(fake.item().as_deref(), Some("new-token"));
        let off = set_token_with(&store, "", &fake.kc, op).await.unwrap();
        assert!(!off["onePasswordConnected"].as_bool().unwrap());
        assert_eq!(fake.item(), None);
        // A failed validation saves nothing.
        assert!(set_token_with(&store, "bad", &fake.kc, Path::new("/usr/bin/false")).await.is_err());
        assert_eq!(fake.item(), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hung_security_times_out_and_status_answers_not_connected() {
        let (store, mut fake) = (store(), fake::Fake::new("hung", Some("exec sleep 30\n")));
        fake.kc.wait = Duration::from_millis(200);
        let started = std::time::Instant::now();
        let status = status_with(&store, &fake.kc).await.unwrap();
        assert!(!status["onePasswordConnected"].as_bool().unwrap());
        assert!(resolve_with(&store, "op://v/i/f", &fake.kc, Path::new("op")).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
