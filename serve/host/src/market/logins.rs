//! Saved sign-ins for websites and apps. A bot asks for one with `request_login` (a
//! secure card the user fills in), then `type_login` types it into the focused field;
//! the password reaches the screen, never the bot. Stored encrypted in the vault.
use crate::store::Store;
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const SLOT: &str = "logins";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    pub id: String,
    /// A domain (`github.com`) or an app name (`Slack`).
    pub site: String,
    #[serde(default)]
    pub username: String,
    /// The password, or an `op://` reference resolved when it's typed.
    pub password: String,
}

impl Login {
    /// Everything but the password.
    pub fn public(&self) -> Value {
        json!({"id": self.id, "site": self.site, "username": self.username})
    }
}

pub fn all(store: &Store) -> Result<Vec<Login>> {
    Ok(match super::vault::read(store, SLOT)? {
        Some(s) if !s.is_empty() => serde_json::from_str(&s)?,
        _ => vec![],
    })
}

fn save_all(store: &Store, items: &[Login]) -> Result<()> {
    super::vault::write(store, SLOT, &serde_json::to_string(items)?)
}

pub fn get(store: &Store, id: &str) -> Result<Login> {
    all(store)?
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(|| anyhow!("No saved login `{id}`; ask for one with request_login"))
}

pub fn list(store: &Store) -> Result<Value> {
    Ok(json!({"items": all(store)?.iter().map(Login::public).collect::<Vec<_>>()}))
}

/// `https://www.GitHub.com/login` → `github.com`; an app name stays as typed.
pub fn normalize_site(site: &str) -> String {
    let s = site.trim();
    let s = s.split_once("://").map_or(s, |(_, rest)| rest);
    let s = s.split(['/', '?', '#']).next().unwrap_or(s);
    let s = s.rsplit_once('@').map_or(s, |(_, host)| host);
    s.strip_prefix("www.").unwrap_or(s).to_lowercase()
}

/// Saves a login, replacing the one for the same site and username.
pub fn save(store: &Store, site: &str, username: &str, password: &str) -> Result<Login> {
    let site = normalize_site(site);
    if site.is_empty() || site.len() > 200 {
        bail!("Give the website or app this login is for");
    }
    if password.is_empty() || password.len() > 4096 || username.len() > 512 {
        bail!("Invalid password");
    }
    let mut items = all(store)?;
    let username = username.trim().to_owned();
    let login = if let Some(l) = items.iter_mut().find(|l| l.site == site && l.username == username) {
        password.clone_into(&mut l.password);
        l.clone()
    } else {
        let taken: Vec<String> = items.iter().map(|l| l.id.clone()).collect();
        let l = Login { id: super::unique_id(&site, &taken), site, username, password: password.to_owned() };
        items.push(l.clone());
        l
    };
    save_all(store, &items)?;
    Ok(login)
}

pub fn remove(store: &Store, id: &str) -> Result<()> {
    let mut items = all(store)?;
    items.retain(|l| l.id != id);
    save_all(store, &items)
}

/// Whether the focused window belongs to the login's site: the page's host is the
/// site or one of its subdomains; without a page, the app's name is the site.
pub fn matches(site: &str, url: Option<&str>, app: &str) -> bool {
    match url.map(normalize_site).filter(|h| !h.is_empty()) {
        Some(host) => {
            let host = host.split(':').next().unwrap_or(&host).to_owned();
            host == site || host.ends_with(&format!(".{site}"))
        }
        None => !app.is_empty() && app.eq_ignore_ascii_case(site),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sites_normalize() {
        assert_eq!(normalize_site("https://www.GitHub.com/login?x=1"), "github.com");
        assert_eq!(normalize_site("Slack"), "slack");
        assert_eq!(normalize_site("https://user@accounts.google.com"), "accounts.google.com");
    }

    #[test]
    fn only_the_right_site_matches() {
        assert!(matches("github.com", Some("https://github.com/login"), "Safari"));
        assert!(matches("google.com", Some("https://accounts.google.com/signin"), "Chrome"));
        assert!(!matches("github.com", Some("https://github.com.evil.io/login"), "Safari"));
        assert!(!matches("github.com", Some("https://notgithub.com/"), "Safari"));
        assert!(matches("slack", None, "Slack"));
        assert!(!matches("github.com", None, "Terminal"));
        // A page URL wins over the app name.
        assert!(!matches("safari", Some("https://evil.io"), "Safari"));
    }
}
