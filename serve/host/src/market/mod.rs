//! The marketplace behind the phone's Plugins screen:
//!
//! - **Connectors** are MCP servers, found in the official MCP Registry
//!   (<https://registry.modelcontextprotocol.io>) or added by hand. They're
//!   installed once per computer and handed to the agent as `mcpServers` when a
//!   bot that has them turned on starts or resumes its session.
//! - **Apps** are connected through Composio and listed as `composio-*`
//!   connectors; see `composio`.
//! - **Skills** are instruction folders (a `SKILL.md` plus any files it uses),
//!   from <https://github.com/anthropics/skills> or written by hand, kept in
//!   `~/.codync/skills/<id>`. A bot that has one turned on is told where it is
//!   and reads it when the task calls for it.
//! - **Agents** come from the ACP registry; see `backends`.
//!
//! Registry and GitHub JSON is untrusted input: names become ids and paths, so
//! they're reduced to a safe slug first. Secret values (API keys, tokens) stay
//! on this computer; listings only say which keys are set.

pub mod composio;
pub mod logins;
pub mod oauth;
pub mod passwords;
pub mod requests;
pub mod vault;
pub mod verify;

use crate::LockExt;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MCP_REGISTRY: &str = "https://registry.modelcontextprotocol.io/v0/servers";
const SKILLS_REPO: &str = "anthropics/skills";
const UA: &str = concat!("codync-host/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(15);
/// Registry search is slow (often 20-30 s); lookups by name are fast.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(45);

// MARK: stored items

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The MCP Registry name it was installed from, if any.
    #[serde(default)]
    pub registry_name: Option<String>,
    /// stdio servers: the command the agent spawns.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Remote (streamable HTTP) servers.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Remote servers that want sign-in; see `oauth`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<oauth::OAuth>,
}

impl Connector {
    /// ACP `McpServer`. Remote servers run through this host's `remote` proxy (`codync-host mcp remote`),
    /// which keeps sign-in tokens fresh and works with agents that only speak stdio.
    /// A remote server still waiting for sign-in is left out.
    pub fn acp(&self, exe: &std::path::Path, port: u16) -> Option<Value> {
        if self.command.is_some() {
            return Some(
                json!({"name":self.id,"command":exe,"args":["mcp","local","--connector",self.id,"--port",port.to_string()],"env":[]}),
            );
        }
        self.url.as_ref()?;
        if self.oauth.as_ref().is_some_and(|o| !o.signed_in()) {
            return None;
        }
        Some(json!({
            "name": self.id, "command": exe,
            "args": ["mcp", "remote", "--connector", self.id, "--port", port.to_string()],
            "env": [],
        }))
    }

    /// What clients see: everything but the secret values.
    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "registryName": self.registry_name,
            "kind": if self.command.is_some() { "local" } else { "remote" },
            "command": self.command.clone(),
            "url": self.url.as_deref().and_then(|raw| reqwest::Url::parse(raw).ok()).map(|mut url| {
                let _ = url.set_username(""); let _ = url.set_password(None);
                url.set_query(None); url.set_fragment(None); url.to_string()
            }),
            "keys": self.env.keys().chain(self.headers.keys()).collect::<Vec<_>>(),
            "auth": match &self.oauth {
                None => "none",
                Some(o) if o.signed_in() => "signedIn",
                Some(_) => "signedOut",
            },
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// "anthropics/skills" or "custom".
    #[serde(default)]
    pub source: String,
}

impl Skill {
    pub fn dir(&self) -> PathBuf {
        skills_dir().join(&self.id)
    }

    fn public(&self) -> Value {
        json!({"id": self.id, "name": self.name, "description": self.description, "source": self.source,
               "path": self.dir().join("SKILL.md").to_string_lossy()})
    }
}

fn skills_dir() -> PathBuf {
    crate::service::data_dir().join("skills")
}

/// Lowercase ASCII letters, digits and dashes; never empty, never a path.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').chars().take(48).collect::<String>();
    if out.is_empty() { "item".into() } else { out }
}

fn load<T: for<'de> Deserialize<'de>>(store: &crate::store::Store, key: &str) -> Vec<T> {
    store.kv_get(key).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn connectors(store: &crate::store::Store) -> Result<Vec<Connector>> {
    vault::read(store, "connectors")?.map_or_else(|| Ok(Vec::new()), |s| serde_json::from_str(&s).map_err(Into::into))
}

pub fn skills(store: &crate::store::Store) -> Vec<Skill> {
    load(store, "skills")
}

fn save<T: Serialize>(store: &crate::store::Store, key: &str, items: &[T]) -> Result<()> {
    store.kv_set(key, &serde_json::to_string(items)?)
}

pub fn save_connectors(store: &crate::store::Store, items: &[Connector]) -> Result<()> {
    vault::write(store, "connectors", &serde_json::to_string(items)?)
}

/// Serialize read/modify/write so OAuth refreshes and installations cannot replace each other.
pub fn update_connectors<T>(
    store: &crate::store::Store,
    change: impl FnOnce(&mut Vec<Connector>) -> Result<T>,
) -> Result<T> {
    let _guard = store.connector_lock.locked();
    let mut all = connectors(store)?;
    let result = change(&mut all)?;
    save_connectors(store, &all)?;
    Ok(result)
}

fn add_connector(store: &crate::store::Store, mut c: Connector) -> Result<Value> {
    update_connectors(store, |all| {
        if let Some(name) = c.registry_name.as_deref()
            && let Some(existing) = all.iter().find(|x| x.registry_name.as_deref() == Some(name))
        {
            return Ok(existing.public());
        }
        c.id = unique_id(&c.name, &all.iter().map(|c| c.id.clone()).collect::<Vec<_>>());
        let public = c.public();
        all.push(c);
        Ok(public)
    })
}

fn unique_id(base: &str, taken: &[String]) -> String {
    let base = slug(base);
    let mut id = base.clone();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

// MARK: connectors

/// Well-known connectors shown before you search, by MCP Registry name.
/// Names that aren't in the registry (yet) are simply skipped.
const FEATURED: &[&str] = &[
    "io.github.github/github-mcp-server",
    "app.linear/linear",
    "com.notion/mcp",
    "com.figma.mcp/mcp",
    "com.stripe/mcp",
    "com.vercel/vercel-mcp",
    "com.supabase/mcp",
    "com.cloudflare.mcp/mcp",
    "com.atlassian/atlassian-mcp-server",
    "io.github.upstash/context7",
    "io.github.microsoft/playwright-mcp",
];

async fn get_json(url: &str) -> Result<Value> {
    get_json_within(url, TIMEOUT).await
}

async fn get_json_within(url: &str, timeout: Duration) -> Result<Value> {
    let res = crate::http().get(url).header("user-agent", UA).timeout(timeout).send().await?;
    if !res.status().is_success() {
        bail!("{} answered {}", url.split('/').nth(2).unwrap_or(url), res.status());
    }
    Ok(res.json().await?)
}

/// One page of the registry (a search, or everything), with the cursor for the next page.
async fn registry_page(search: &str, cursor: &str, limit: usize) -> Result<(Vec<Value>, Option<String>)> {
    let mut url = reqwest::Url::parse(MCP_REGISTRY)?;
    url.query_pairs_mut().append_pair("version", "latest").append_pair("limit", &limit.to_string());
    if !search.is_empty() {
        url.query_pairs_mut().append_pair("search", search);
    }
    if !cursor.is_empty() {
        url.query_pairs_mut().append_pair("cursor", cursor);
    }
    let v = get_json_within(url.as_str(), SEARCH_TIMEOUT).await.context("searching the MCP Registry")?;
    let servers =
        v["servers"].as_array().cloned().unwrap_or_default().into_iter().map(|s| s["server"].clone()).collect();
    Ok((servers, v["metadata"]["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_owned)))
}

/// One registry server by exact name (its latest version).
async fn registry_server(name: &str) -> Result<Value> {
    let mut url = reqwest::Url::parse(MCP_REGISTRY)?;
    url.path_segments_mut().map_err(|()| anyhow!("bad registry URL"))?.extend([name, "versions", "latest"]);
    let v = get_json(url.as_str()).await.with_context(|| format!("{name} isn't in the MCP Registry"))?;
    Ok(v["server"].clone())
}

/// The ways a registry server can run here, each with what the user must fill in.
fn install_options(server: &Value) -> Vec<Value> {
    let mut out = vec![];
    for (i, p) in server["packages"].as_array().into_iter().flatten().enumerate() {
        let kind = p["registryType"].as_str().unwrap_or_default();
        if !matches!(kind, "npm" | "pypi" | "oci" | "nuget")
            || p["transport"]["type"].as_str().is_some_and(|t| t != "stdio")
        {
            continue;
        }
        let env = p["environmentVariables"].as_array().into_iter().flatten().map(|e| {
            json!({"name": e["name"], "description": e["description"], "secret": e["isSecret"].as_bool().unwrap_or(false),
                   "required": e["isRequired"].as_bool().unwrap_or(false), "default": e["default"]})
        });
        let args = ["runtimeArguments", "packageArguments"]
            .iter()
            .flat_map(|k| p[*k].as_array().into_iter().flatten())
            .filter_map(|a| {
                let key = argument_input(a)?;
                Some(json!({"name": key, "description": a["description"], "secret": a["isSecret"].as_bool().unwrap_or(false),
                            "required": a["isRequired"].as_bool().unwrap_or(false), "default": a["default"],
                            "placeholder": a["valueHint"]}))
            });
        let inputs: Vec<Value> = env.chain(args).collect();
        out.push(json!({"id": format!("package:{i}"), "kind": kind, "label": format!("{kind} · {}", p["identifier"].as_str().unwrap_or_default()), "inputs": inputs}));
    }
    for (i, r) in server["remotes"].as_array().into_iter().flatten().enumerate() {
        if !matches!(r["type"].as_str(), Some("streamable-http" | "sse")) || r["url"].as_str().is_none() {
            continue;
        }
        // `{name}` parts of the URL are the user's to fill in.
        let variables = r["variables"].as_object().into_iter().flatten().map(|(k, v)| {
            json!({"name": k, "description": v["description"], "secret": v["isSecret"].as_bool().unwrap_or(false),
                   "required": v["isRequired"].as_bool().unwrap_or(false), "default": v["default"]})
        });
        let headers = r["headers"].as_array().into_iter().flatten().map(|h| {
            json!({"name": h["name"], "description": h["description"], "secret": h["isSecret"].as_bool().unwrap_or(true),
                   "required": h["isRequired"].as_bool().unwrap_or(false), "placeholder": h["value"]})
        });
        let inputs: Vec<Value> = variables.chain(headers).collect();
        out.push(json!({"id": format!("remote:{i}"), "kind": "remote", "label": "Hosted", "inputs": inputs}));
    }
    // Some servers list a remote per region; one of each kind is enough.
    let mut kinds = std::collections::HashSet::new();
    out.retain(|o| kinds.insert(o["kind"].as_str().unwrap_or_default().to_owned()));
    out
}

/// The input a registry argument asks the user for: a positional's hint, or a named
/// option's name. None when the registry fixes it (a set value, or a bare flag).
fn argument_input(a: &Value) -> Option<String> {
    if a["value"].is_string() {
        return None;
    }
    let text = |k: &str| a[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    match a["type"].as_str() {
        Some("named") => text("name").filter(|_| a["valueHint"].is_string() || a["default"].is_string()),
        _ => text("valueHint").or_else(|| text("name")).or_else(|| Some("value".into())),
    }
}

/// A registry argument list as command-line words, taking values from the user's inputs.
fn arguments(list: &Value, input: &dyn Fn(&str) -> Option<String>) -> Result<Vec<String>> {
    let mut out = vec![];
    for a in list.as_array().into_iter().flatten() {
        let named = a["type"] == "named";
        let name = a["name"].as_str().unwrap_or_default();
        let value = match argument_input(a) {
            None => a["value"].as_str().map(str::to_owned),
            Some(key) => match input(&key).or_else(|| a["default"].as_str().map(str::to_owned)) {
                Some(v) => Some(v),
                None if a["isRequired"].as_bool().unwrap_or(false) => bail!("{key} is required"),
                None => continue,
            },
        };
        if named && !name.is_empty() {
            out.push(name.to_owned());
        }
        out.extend(value);
    }
    Ok(out)
}

/// Puts the user's values into a URL's `{name}` parts, or their defaults.
fn fill_url(url: &str, variables: &Value, input: &dyn Fn(&str) -> Option<String>) -> Result<String> {
    let mut url = url.to_owned();
    for (k, v) in variables.as_object().into_iter().flatten() {
        let value =
            input(k).or_else(|| v["default"].as_str().map(str::to_owned)).ok_or_else(|| anyhow!("{k} is required"))?;
        url = url.replace(&format!("{{{k}}}"), &value);
    }
    if url.contains('{') {
        bail!("this server's URL has parts the registry doesn't describe; add it as a custom connector");
    }
    Ok(url)
}

/// "com.notion/mcp" -> "Notion", "io.github.microsoft/playwright-mcp" -> "Playwright".
fn title_from_name(name: &str) -> String {
    let (org, last) = name.split_once('/').unwrap_or(("", name));
    let words: Vec<&str> =
        last.split(['-', '_', '.']).filter(|w| !w.is_empty() && !matches!(*w, "mcp" | "server")).collect();
    let words = if words.is_empty() {
        let label = org
            .split('.')
            .find(|l| !matches!(*l, "com" | "io" | "app" | "ai" | "dev" | "org" | "github"))
            .unwrap_or(org);
        vec![label]
    } else {
        words
    };
    words
        .iter()
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn listing(server: &Value, installed: &[Connector]) -> Option<Value> {
    let name = server["name"].as_str()?;
    let options = install_options(server);
    if options.is_empty() {
        return None;
    }
    let title = server["title"].as_str().map_or_else(|| title_from_name(name), str::to_owned);
    Some(json!({
        "name": name,
        "title": title,
        "description": server["description"],
        "version": server["version"],
        "website": server["websiteUrl"].as_str().or_else(|| server["repository"]["url"].as_str()),
        "installed": installed.iter().any(|c| c.registry_name.as_deref() == Some(name)),
        "options": options,
    }))
}

/// Browse the whole MCP Registry a page at a time (featured connectors lead the first
/// page of the unfiltered list), or search it. `nextCursor` fetches the following page.
pub async fn browse_connectors(store: &crate::store::Store, search: &str, cursor: &str) -> Result<Value> {
    let installed = connectors(store)?;
    let search = search.trim();
    let mut servers: Vec<Value> = if search.is_empty() && cursor.is_empty() {
        let lookups = FEATURED.iter().map(|n| registry_server(n));
        futures::future::join_all(lookups).await.into_iter().filter_map(Result::ok).collect()
    } else {
        vec![]
    };
    let (page, next) = registry_page(search, cursor, 60).await?;
    // Later pages of the unfiltered list skip the featured servers the first page led with.
    let shown_already = |s: &Value| {
        search.is_empty() && !cursor.is_empty() && FEATURED.contains(&s["name"].as_str().unwrap_or_default())
    };
    servers.extend(page.into_iter().filter(|s| !shown_already(s)));
    let mut seen = std::collections::HashSet::new();
    let items: Vec<Value> = servers
        .iter()
        .filter(|s| seen.insert(s["name"].as_str().unwrap_or_default().to_owned()))
        .filter_map(|s| listing(s, &installed))
        .collect();
    Ok(json!({"items": items, "nextCursor": next}))
}

/// Fills `{placeholder}` in a header template with the user's value, or uses it as-is.
fn fill(template: Option<&str>, value: &str) -> String {
    match template {
        Some(t) if t.contains('{') && t.contains('}') => {
            let (head, rest) = t.split_once('{').unwrap_or((t, ""));
            let tail = rest.split_once('}').map_or("", |(_, tail)| tail);
            format!("{head}{value}{tail}")
        }
        _ => value.to_owned(),
    }
}

pub async fn connector_info(store: &crate::store::Store, name: &str) -> Result<Value> {
    let server = registry_server(name).await?;
    listing(&server, &connectors(store)?).ok_or_else(|| anyhow!("No supported installation option"))
}

/// Installs a registry server with the user's inputs (`{NAME: value}`).
pub async fn install_connector(store: &crate::store::Store, name: &str, option: &str, inputs: &Value) -> Result<Value> {
    let server = registry_server(name).await?;
    let input = |k: &str| inputs[k].as_str().filter(|v| !v.is_empty()).map(str::to_owned);
    let (kind, index) = option.split_once(':').ok_or_else(|| anyhow!("unknown install option"))?;
    let index: usize = index.parse()?;
    let all = connectors(store)?;
    if let Some(c) = all.iter().find(|c| c.registry_name.as_deref() == Some(name)) {
        return Ok(c.public());
    }
    let title =
        listing(&server, &all).and_then(|l| l["title"].as_str().map(str::to_owned)).unwrap_or_else(|| name.into());
    let mut c = Connector {
        id: unique_id(&title, &all.iter().map(|c| c.id.clone()).collect::<Vec<_>>()),
        name: title,
        description: server["description"].as_str().unwrap_or_default().to_owned(),
        registry_name: Some(name.to_owned()),
        command: None,
        args: vec![],
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        oauth: None,
    };
    match kind {
        "package" => {
            let p = server["packages"].get(index).ok_or_else(|| anyhow!("unknown package"))?;
            let id = p["identifier"].as_str().ok_or_else(|| anyhow!("package has no identifier"))?;
            // A package runs as the user: install exactly the version the registry lists, never "latest".
            let version = p["version"]
                .as_str()
                .filter(|v| !v.is_empty() && *v != "latest" && !v.contains(['^', '~', '*', ' ']))
                .ok_or_else(|| {
                    anyhow!("{id} has no pinned version in the MCP Registry, so it can't be installed safely")
                })?;
            for e in p["environmentVariables"].as_array().into_iter().flatten() {
                let Some(k) = e["name"].as_str() else { continue };
                match input(k).or_else(|| e["default"].as_str().map(str::to_owned)) {
                    Some(v) => {
                        c.env.insert(k.to_owned(), v);
                    }
                    None if e["isRequired"].as_bool().unwrap_or(false) => bail!("{k} is required"),
                    None => {}
                }
            }
            let runtime = arguments(&p["runtimeArguments"], &input)?;
            let package = arguments(&p["packageArguments"], &input)?;
            let (command, mut args) = match p["registryType"].as_str() {
                Some("npm") => ("npx", vec!["-y".to_owned()]),
                Some("pypi") => ("uvx", vec![]),
                Some("oci") => {
                    let mut args = vec!["run".to_owned(), "-i".into(), "--rm".into()];
                    for k in c.env.keys() {
                        args.extend(["-e".into(), k.clone()]);
                    }
                    ("docker", args)
                }
                Some("nuget") => ("dnx", vec![]),
                _ => bail!("this package type isn't supported"),
            };
            // Runtime arguments come before the package; skip flags we already pass.
            for a in runtime {
                if !a.starts_with('-') || !args.contains(&a) {
                    args.push(a);
                }
            }
            args.push(match p["registryType"].as_str() {
                Some("pypi") => format!("{id}=={version}"),
                Some("oci") => id.to_owned(),
                _ => format!("{id}@{version}"),
            });
            if p["registryType"] == "nuget" {
                args.push("--yes".into());
            }
            args.extend(package);
            c.command = Some(command.into());
            c.args = args;
        }
        "remote" => {
            let r = server["remotes"].get(index).ok_or_else(|| anyhow!("unknown remote"))?;
            c.url = Some(fill_url(r["url"].as_str().unwrap_or_default(), &r["variables"], &input)?);
            for h in r["headers"].as_array().into_iter().flatten() {
                let Some(k) = h["name"].as_str() else { continue };
                match input(k) {
                    Some(v) => {
                        c.headers.insert(k.to_owned(), fill(h["value"].as_str(), &v));
                    }
                    None if h["isRequired"].as_bool().unwrap_or(false) => bail!("{k} is required"),
                    None => {}
                }
            }
        }
        _ => bail!("unknown install option"),
    }
    if let Some(url) = &c.url
        && oauth::required(url, &c.headers).await
    {
        c.oauth = Some(oauth::OAuth::default());
    }
    add_connector(store, c)
}

/// A connector you describe yourself: a command line or an https URL.
pub async fn add_custom_connector(store: &crate::store::Store, b: &Value) -> Result<Value> {
    let name =
        b["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("`name` is required"))?;
    let all = connectors(store)?;
    let c = custom(name, b, &all).await?;
    add_connector(store, c)
}

/// Adds every server in a pasted MCP config: the `mcpServers` / `servers` JSON that
/// Claude, Cursor, VS Code and most READMEs use, or one server's own entry.
pub async fn import_connectors(store: &crate::store::Store, config: &str) -> Result<Value> {
    let v: Value = serde_json::from_str(config.trim()).context("that isn't JSON")?;
    let servers = config_servers(&v);
    if servers.is_empty() {
        bail!("no MCP servers in that config");
    }
    let all = connectors(store)?;
    let mut pending = vec![];
    for (name, entry) in servers {
        pending.push(custom(&name, &entry, &all).await.with_context(|| name.clone())?);
    }
    update_connectors(store, |all| {
        let mut added = vec![];
        for mut c in pending {
            c.id = unique_id(&c.name, &all.iter().map(|c| c.id.clone()).collect::<Vec<_>>());
            added.push(c.public());
            all.push(c);
        }
        Ok(json!({"items":added}))
    })
}

/// The named server entries in a pasted config.
fn config_servers(v: &Value) -> Vec<(String, Value)> {
    match ["mcpServers", "servers", "context_servers"].iter().find_map(|k| v[*k].as_object()) {
        Some(map) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        None if v["command"].is_string() || v["url"].is_string() => {
            vec![(v["name"].as_str().unwrap_or("Custom").to_owned(), v.clone())]
        }
        // `{"github": {"command": …}}`: the map without its wrapper.
        None => v
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, e)| e.is_object())
            .map(|(k, e)| (k.clone(), e.clone()))
            .collect(),
    }
}

/// A connector from `{command, args?, env?}` or `{url, headers?}`. A command without
/// `args` is split like a shell would (quotes work).
async fn custom(name: &str, b: &Value, all: &[Connector]) -> Result<Connector> {
    let map = |v: &Value| -> BTreeMap<String, String> {
        v.as_object().into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect()
    };
    let mut c = Connector {
        id: unique_id(name, &all.iter().map(|c| c.id.clone()).collect::<Vec<_>>()),
        name: name.to_owned(),
        description: b["description"].as_str().unwrap_or_default().to_owned(),
        registry_name: None,
        command: None,
        args: vec![],
        env: map(&b["env"]),
        url: None,
        headers: map(&b["headers"]),
        oauth: None,
    };
    let url =
        ["url", "serverUrl", "httpUrl"].iter().find_map(|k| b[*k].as_str()).map(str::trim).filter(|s| !s.is_empty());
    if let Some(url) = url {
        let local = ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|p| url.starts_with(p));
        if !url.starts_with("https://") && !local {
            bail!("remote connectors need an https URL");
        }
        if oauth::required(url, &c.headers).await {
            c.oauth = Some(oauth::OAuth::default());
        }
        c.url = Some(url.to_owned());
        return Ok(c);
    }
    let line = b["command"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("give a command or a URL"))?;
    let mut words = match b["args"].as_array() {
        Some(args) => {
            std::iter::once(line.to_owned()).chain(args.iter().filter_map(|a| a.as_str().map(str::to_owned))).collect()
        }
        None => shlex::split(line).ok_or_else(|| anyhow!("the command has an unclosed quote"))?,
    }
    .into_iter();
    c.command = words.next();
    c.args = words.collect();
    Ok(c)
}

/// Installed MCP servers, then the apps connected through Composio.
pub fn list_connectors(store: &crate::store::Store) -> Result<Value> {
    let mut items: Vec<Value> = connectors(store)?.iter().map(Connector::public).collect();
    items.extend(composio::connections(store)?.iter().filter(|c| c.active()).map(|c| {
        json!({
            "id": format!("{}{}", composio::PREFIX, c.toolkit),
            "name": c.name,
            "description": format!("{} through Composio", c.name),
            "registryName": null,
            "kind": "composio",
            "command": null,
            "url": null,
            "keys": [],
            "logo": c.logo,
        })
    }));
    Ok(json!({"items": items}))
}

pub fn remove_connector(store: &crate::store::Store, id: &str) -> Result<()> {
    update_connectors(store, |all| {
        all.retain(|c| c.id != id);
        Ok(())
    })
}

// MARK: skills

static SKILL_CATALOG: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

/// `name` and `description` from a SKILL.md front matter.
fn front_matter(md: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut lines = md.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().trim_matches('"').to_owned());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(v.trim().trim_matches('"').to_owned());
        }
    }
    (name, description)
}

/// Skills published in anthropics/skills (cached for an hour).
pub async fn browse_skills(store: &crate::store::Store) -> Result<Value> {
    let installed: Vec<String> = skills(store).into_iter().map(|s| s.id).collect();
    let cached = SKILL_CATALOG
        .locked()
        .as_ref()
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(3600))
        .map(|(_, v)| v.clone());
    let catalog = if let Some(v) = cached {
        v
    } else {
        let dirs = get_json(&format!("https://api.github.com/repos/{SKILLS_REPO}/contents/skills"))
            .await
            .context("listing skills on GitHub")?;
        let names: Vec<String> = dirs
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| d["type"] == "dir")
            .filter_map(|d| d["name"].as_str().map(str::to_owned))
            .collect();
        let fetches = names.iter().map(|dir| async move {
            let url = format!("https://raw.githubusercontent.com/{SKILLS_REPO}/main/skills/{dir}/SKILL.md");
            let md = crate::http().get(&url).header("user-agent", UA).timeout(TIMEOUT).send().await.ok()?.text().await.ok()?;
            let (name, description) = front_matter(&md);
            Some(json!({"source": dir, "name": name.unwrap_or_else(|| dir.clone()), "description": description.unwrap_or_default()}))
        });
        let v = Value::Array(futures::future::join_all(fetches).await.into_iter().flatten().collect());
        *SKILL_CATALOG.locked() = Some((Instant::now(), v.clone()));
        v
    };
    let items: Vec<Value> = catalog
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let mut s = s.clone();
            s["installed"] = json!(installed.contains(&slug(s["source"].as_str().unwrap_or_default())));
            s
        })
        .collect();
    Ok(json!({"items": items}))
}

/// Downloads a skill folder from anthropics/skills (files up to 1 MB, two levels deep).
async fn download_dir(repo_path: &str, dest: &std::path::Path, depth: u8) -> Result<()> {
    let listing = get_json(&format!("https://api.github.com/repos/{SKILLS_REPO}/contents/{repo_path}")).await?;
    tokio::fs::create_dir_all(dest).await?;
    for item in listing.as_array().into_iter().flatten() {
        let name = item["name"].as_str().unwrap_or_default();
        // Names become paths: plain file names only.
        if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\']) {
            continue;
        }
        match item["type"].as_str() {
            Some("file") if item["size"].as_u64().unwrap_or(0) <= 1_000_000 => {
                let Some(url) = item["download_url"].as_str() else { continue };
                let bytes =
                    crate::http().get(url).header("user-agent", UA).timeout(TIMEOUT).send().await?.bytes().await?;
                tokio::fs::write(dest.join(name), &bytes).await?;
            }
            Some("dir") if depth > 0 => {
                Box::pin(download_dir(&format!("{repo_path}/{name}"), &dest.join(name), depth - 1)).await?;
            }
            _ => {}
        }
    }
    Ok(())
}

pub async fn install_skill(store: &crate::store::Store, source: &str) -> Result<Value> {
    let id = slug(source);
    let mut all = skills(store);
    if let Some(s) = all.iter().find(|s| s.id == id) {
        return Ok(s.public());
    }
    let dest = skills_dir().join(&id);
    download_dir(&format!("skills/{source}"), &dest, 2).await.context("downloading the skill")?;
    let md = tokio::fs::read_to_string(dest.join("SKILL.md")).await.context("the skill has no SKILL.md")?;
    let (name, description) = front_matter(&md);
    let s = Skill {
        id,
        name: name.unwrap_or_else(|| source.to_owned()),
        description: description.unwrap_or_default(),
        source: SKILLS_REPO.into(),
    };
    all.push(s.clone());
    save(store, "skills", &all)?;
    Ok(s.public())
}

/// A skill you write yourself: a name, when to use it, and the instructions.
pub fn add_custom_skill(store: &crate::store::Store, b: &Value) -> Result<Value> {
    let name =
        b["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("`name` is required"))?;
    let description = b["description"].as_str().unwrap_or_default().trim().replace('\n', " ");
    let body = b["instructions"].as_str().unwrap_or_default();
    let mut all = skills(store);
    let s = Skill {
        id: unique_id(name, &all.iter().map(|s| s.id.clone()).collect::<Vec<_>>()),
        name: name.to_owned(),
        description,
        source: "custom".into(),
    };
    std::fs::create_dir_all(s.dir())?;
    std::fs::write(
        s.dir().join("SKILL.md"),
        format!("---\nname: {}\ndescription: {}\n---\n\n{body}\n", s.name, s.description),
    )?;
    all.push(s.clone());
    save(store, "skills", &all)?;
    Ok(s.public())
}

pub fn list_skills(store: &crate::store::Store) -> Value {
    json!({"items": skills(store).iter().map(Skill::public).collect::<Vec<_>>()})
}

pub fn remove_skill(store: &crate::store::Store, id: &str) -> Result<()> {
    let mut all = skills(store);
    if let Some(s) = all.iter().find(|s| s.id == id) {
        let _ = std::fs::remove_dir_all(s.dir());
    }
    all.retain(|s| s.id != id);
    save(store, "skills", &all)
}

/// The skills block of a bot's profile: what each is for and where to read it.
pub fn skills_brief(store: &crate::store::Store, enabled: &[String]) -> Option<String> {
    let lines: Vec<String> = skills(store)
        .iter()
        .filter(|s| enabled.contains(&s.id))
        .map(|s| {
            format!("- {}: {} (read {} before using it)", s.name, s.description, s.dir().join("SKILL.md").display())
        })
        .collect();
    (!lines.is_empty()).then(|| format!("Skills you can use when they fit the task:\n{}", lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_arguments_become_words() {
        let list = json!([
            {"type": "named", "name": "--rm"},
            {"type": "named", "name": "--db", "valueHint": "path", "isRequired": true},
            {"type": "named", "name": "--mode", "value": "ro"},
            {"type": "positional", "valueHint": "source", "isRequired": false},
        ]);
        let input = |k: &str| (k == "--db").then(|| "/tmp/a.db".to_owned());
        assert_eq!(arguments(&list, &input).unwrap(), ["--rm", "--db", "/tmp/a.db", "--mode", "ro"]);
        assert!(arguments(&list, &|_: &str| None).is_err(), "--db is required");
        assert_eq!(argument_input(&list[0]), None);
        assert_eq!(argument_input(&list[3]).as_deref(), Some("source"));
    }

    #[test]
    fn url_templates_fill_in() {
        let vars = json!({"agent_id": {"isRequired": true}, "region": {"default": "us"}});
        let input = |k: &str| (k == "agent_id").then(|| "a1".to_owned());
        assert_eq!(fill_url("https://x/{region}/{agent_id}/mcp", &vars, &input).unwrap(), "https://x/us/a1/mcp");
        assert!(fill_url("https://x/{agent_id}", &vars, &|_: &str| None).is_err());
        assert!(fill_url("https://x/{other}", &json!({}), &|_: &str| None).is_err());
    }

    #[test]
    fn pasted_configs_list_their_servers() {
        let claude = json!({"mcpServers": {"github": {"command": "npx", "args": ["-y", "x"]}, "linear": {"url": "https://l/mcp"}}});
        assert_eq!(config_servers(&claude).len(), 2);
        let vscode = json!({"servers": {"a": {"type": "sse", "url": "https://a/sse"}}});
        assert_eq!(config_servers(&vscode)[0].0, "a");
        let one = json!({"command": "uvx", "args": ["y"]});
        assert_eq!(config_servers(&one)[0].0, "Custom");
        let bare = json!({"fs": {"command": "npx"}});
        assert_eq!(config_servers(&bare)[0].0, "fs");
    }

    #[test]
    fn slugs_are_safe() {
        assert_eq!(slug("GitHub MCP Server"), "github-mcp-server");
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(slug("中文"), "item");
    }

    #[test]
    fn titles_come_from_names() {
        assert_eq!(title_from_name("com.notion/mcp"), "Notion");
        assert_eq!(title_from_name("com.vercel/vercel-mcp"), "Vercel");
        assert_eq!(title_from_name("io.github.microsoft/playwright-mcp"), "Playwright");
    }

    #[test]
    fn header_templates_are_filled() {
        assert_eq!(fill(Some("Bearer {api_key}"), "abc"), "Bearer abc");
        assert_eq!(fill(Some("token"), "abc"), "abc");
        assert_eq!(fill(None, "abc"), "abc");
    }

    #[test]
    fn front_matter_is_read() {
        let md = "---\nname: pdf\ndescription: \"Work with PDFs\"\n---\n# PDF";
        assert_eq!(front_matter(md), (Some("pdf".into()), Some("Work with PDFs".into())));
        assert_eq!(front_matter("# no front matter"), (None, None));
    }

    #[test]
    fn connectors_become_acp_servers() {
        let mut c = Connector {
            id: "gh".into(),
            name: "GitHub".into(),
            description: String::new(),
            registry_name: None,
            command: Some("npx".into()),
            args: vec!["-y".into(), "pkg@1".into()],
            env: BTreeMap::from([("TOKEN".into(), "x".into())]),
            url: None,
            headers: BTreeMap::new(),
            oauth: None,
        };
        let exe = std::path::Path::new("/bin/codync-host");
        let config = c.acp(exe, 1).unwrap();
        assert_eq!(config["args"][1], "local");
        assert_eq!(config["env"], json!([]));
        assert!(!config.to_string().contains("secret"));
        assert!(c.public().get("env").is_none(), "secrets never leave the host");
        c.command = None;
        c.url = Some("https://example.com/mcp".into());
        assert_eq!(c.acp(exe, 1).unwrap()["args"][1], "remote", "remote servers go through the proxy");
        c.oauth = Some(oauth::OAuth::default());
        assert!(c.acp(exe, 1).is_none(), "not signed in yet");
        assert_eq!(c.public()["auth"], "signedOut");
    }
}
