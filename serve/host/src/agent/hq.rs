//! hq agents as bots. hq says how to start an agent (`kith <agent> --launch-json`), the host starts it: this file
//! runs the `hq` CLI and turns its answer into the ACP session request for claude-agent-acp. The host adds nothing
//! of Kith's to such a bot, so the agent runs with its own prompt, memory, skills, servers and settings.

use crate::LockExt as _;
use crate::store::BotConfig;
use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt as _;

/// `kith ls --json` reads a few folders; `--launch-json` assembles prompt, settings and servers.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);

/// Test hosts name the ACP command that stands in for claude-agent-acp.
pub const ACP_COMMAND_ENV: &str = "KITH_SERVE_HQ_ACP_COMMAND";

/// The `kith` to run: `KITH_KERNEL_BIN` (the old `HQ_BIN`) when set (an empty value turns it off), else `kith` on PATH,
/// else `hq` on PATH (installed before the rename), else `~/.local/bin/kith` or `~/.local/bin/hq`.
/// Blocking: looking on PATH may ask the login shell.
pub fn bin() -> Option<PathBuf> {
    if let Some(set) = ["KITH_KERNEL_BIN", "HQ_BIN"].iter().find_map(std::env::var_os) {
        return (!set.is_empty()).then(|| PathBuf::from(set));
    }
    crate::agent::backends::which("kith").or_else(|| crate::agent::backends::which("hq")).or_else(|| {
        let bin = dirs::home_dir()?.join(".local/bin");
        ["kith", "hq"].iter().map(|n| bin.join(n)).find(|p| p.is_file())
    })
}

/// One line of `kith ls --json`.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct HqAgent {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The agent's folder, where its bot works.
    pub home: String,
    /// The agent's harness; hq before it listed one means Claude.
    #[serde(default = "claude")]
    pub harness: String,
}

fn claude() -> String {
    "claude".into()
}

impl HqAgent {
    /// Whether the host can run it: `kith <agent> --launch-json` covers Claude agents only.
    pub fn runnable(&self) -> bool {
        self.harness == "claude"
    }
}

/// What `kith <agent> --launch-json` printed, the parts the host uses.
#[derive(Deserialize, Debug, Clone, Default)]
pub struct Launch {
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub settings: Value,
    #[serde(default)]
    pub mcp_servers: Value,
    #[serde(default)]
    pub add_dirs: Vec<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub disable_slash_commands: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
}

/// Runs `bin args…` in `cwd` with `KITH_VIA=serve` (and `HQ_VIA`): its stdout, or the stderr text it failed with.
async fn run(bin: &Path, args: &[&str], cwd: Option<&str>, budget: Duration) -> Result<String> {
    let shown = format!("kith {}", args.join(" "));
    let mut command = tokio::process::Command::new(bin);
    command
        .args(args)
        .envs(crate::kernel::both("VIA", "serve"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().with_context(|| format!("starting {}", bin.display()))?;
    let (mut out, mut err) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let work = async {
        let (mut stdout, mut stderr) = (String::new(), String::new());
        let (a, b) = tokio::join!(out.read_to_string(&mut stdout), err.read_to_string(&mut stderr));
        a.and(b)?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    };
    let (status, stdout, stderr) = tokio::time::timeout(budget, work)
        .await
        .map_err(|_| anyhow!("`{shown}` took longer than {}s", budget.as_secs()))??;
    if !status.success() {
        let why = stderr.trim();
        bail!("`{shown}` failed ({status}){}", if why.is_empty() { String::new() } else { format!(": {why}") });
    }
    Ok(stdout)
}

pub async fn list(bin: &Path) -> Result<Vec<HqAgent>> {
    let out = run(bin, &["ls", "--json"], None, LIST_TIMEOUT).await?;
    serde_json::from_str(out.trim()).context("`kith ls --json` didn't print a JSON list of agents")
}

/// One registered hq project, from `kith project ls --json`.
#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// The project's home folder, when it has one.
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
}

impl Project {
    /// The folder to work in: the home if it is a directory here, else the first path that is. None when this
    /// computer has none of them.
    pub fn folder(&self) -> Option<String> {
        self.home.iter().chain(&self.paths).find(|p| Path::new(p).is_dir()).cloned()
    }

    /// Every path the project is registered under, for matching a folder to its project.
    pub fn all_paths(&self) -> impl Iterator<Item = &String> {
        self.home.iter().chain(&self.paths)
    }
}

/// How long a project list is reused: the pickers ask repeatedly while one is open.
const PROJECTS_FRESH: Duration = Duration::from_secs(5);

type Cached = Option<(Instant, Vec<Project>)>;
static PROJECTS: std::sync::Mutex<Cached> = std::sync::Mutex::new(None);

fn remember_projects(list: &[Project]) {
    *PROJECTS.locked() = Some((Instant::now(), list.to_vec()));
}

/// The last project list hq gave, however old; empty before the first. For code that can't wait for hq.
pub fn cached_projects() -> Vec<Project> {
    PROJECTS.locked().as_ref().map(|(_, l)| l.clone()).unwrap_or_default()
}

/// What `kith project ls --json` prints.
#[derive(Deserialize)]
struct Listing {
    projects: Vec<Project>,
}

/// The projects without making a chat load wait on hq: the last list however old (refreshed behind the call when it
/// is stale), or, before there is one, hq's answer for at most two seconds.
pub async fn projects_soon() -> Vec<Project> {
    let cached = PROJECTS.locked().clone();
    match cached {
        Some((at, list)) => {
            if at.elapsed() >= PROJECTS_FRESH {
                tokio::spawn(async { drop(projects(true).await) });
            }
            list
        }
        None => tokio::time::timeout(Duration::from_secs(2), projects(false))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default(),
    }
}

/// `kith project ls --json`, reused for a few seconds unless `fresh`. Fails when hq is missing or the command does.
pub async fn projects(fresh: bool) -> Result<Vec<Project>> {
    if !fresh
        && let Some((at, list)) = PROJECTS.locked().clone()
        && at.elapsed() < PROJECTS_FRESH
    {
        return Ok(list);
    }
    let Some(bin) = tokio::task::spawn_blocking(bin).await? else {
        bail!("kith isn't installed on this computer (set KITH_KERNEL_BIN, or put `kith` on PATH)");
    };
    let out = run(&bin, &["project", "ls", "--json"], None, LIST_TIMEOUT).await?;
    let list = serde_json::from_str::<Listing>(out.trim())
        .context("`kith project ls --json` didn't print a JSON list of projects")?
        .projects;
    remember_projects(&list);
    Ok(list)
}

/// How long an agent's `--info-json` is reused; a stale one is still served while a run refreshes it behind the call.
const INFO_FRESH: Duration = Duration::from_secs(30);
/// `--info-json` reads the role, skills, schedules, cost ledger and memory folder: more than a launch, less than a minute.
const INFO_TIMEOUT: Duration = Duration::from_secs(45);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

/// What one `kith <agent> --info-json` run gave (or why it did not).
#[derive(Clone, Debug)]
pub struct InfoRun {
    pub info: Result<Value, String>,
    /// Unix milliseconds the run finished.
    pub fetched_at: u64,
    at: Instant,
}

/// One agent's cache entry. `gate` lets one run per agent go at a time: a second caller waits and then finds the
/// first one's answer fresh.
#[derive(Default)]
struct InfoSlot {
    gate: tokio::sync::Mutex<()>,
    last: std::sync::Mutex<Option<InfoRun>>,
}

type Slots = std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<InfoSlot>>>;
static INFOS: std::sync::LazyLock<Slots> = std::sync::LazyLock::new(Default::default);

fn slot(agent: &str) -> std::sync::Arc<InfoSlot> {
    INFOS.locked().entry(agent.to_owned()).or_default().clone()
}

async fn run_info(agent: &str) -> Result<Value> {
    let Some(bin) = tokio::task::spawn_blocking(bin).await? else {
        bail!("kith isn't installed on this computer (set KITH_KERNEL_BIN, or put `kith` on PATH)");
    };
    let out = run(&bin, &[agent, "--info-json"], None, INFO_TIMEOUT).await?;
    let info: Value = serde_json::from_str(out.trim())
        .with_context(|| format!("`kith {agent} --info-json` didn't print a JSON object"))?;
    if !info.is_object() {
        bail!("`kith {agent} --info-json` didn't print a JSON object");
    }
    Ok(info)
}

/// Runs kith for `agent` unless a run that finished while this one waited its turn is still fresh (or `force`).
async fn refill(agent: &str, force: bool) -> InfoRun {
    let slot = slot(agent);
    let _turn = slot.gate.lock().await;
    if !force
        && let Some(last) = slot.last.locked().clone()
        && last.at.elapsed() < INFO_FRESH
    {
        return last;
    }
    let info = run_info(agent).await.map_err(|e| format!("{e:#}"));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let got = InfoRun { info, fetched_at: now, at: Instant::now() };
    *slot.last.locked() = Some(got.clone());
    got
}

/// What `kith <agent> --info-json` printed, reused for 30 s. Stale answers are returned at once and refreshed
/// behind the call; the first one (or `fresh`) waits for kith. Never blocks the runtime: kith is a child process.
pub async fn info(agent: &str, fresh: bool) -> InfoRun {
    let cached = slot(agent).last.locked().clone();
    match cached {
        Some(last) if !fresh => {
            if last.at.elapsed() >= INFO_FRESH {
                let agent = agent.to_owned();
                tokio::spawn(async move { drop(refill(&agent, false).await) });
            }
            last
        }
        _ => refill(agent, fresh).await,
    }
}

/// `kith memory search <query> --agent <agent> --json -n <limit>`: the `hits` list as kith printed it.
pub async fn memory_search(agent: &str, query: &str, limit: usize) -> Result<Vec<Value>> {
    let Some(bin) = tokio::task::spawn_blocking(bin).await? else {
        bail!("kith isn't installed on this computer (set KITH_KERNEL_BIN, or put `kith` on PATH)");
    };
    let n = limit.to_string();
    let args = ["memory", "search", query, "--agent", agent, "--json", "-n", &n];
    let out = run(&bin, &args, None, SEARCH_TIMEOUT).await?;
    let found: Value =
        serde_json::from_str(out.trim()).context("`kith memory search --json` didn't print a JSON object")?;
    found["hits"].as_array().cloned().ok_or_else(|| anyhow!("`kith memory search --json` printed no `hits` list"))
}

/// `kith project add <id> <path>`: kith's own error text on failure (a taken id, a path that isn't a folder…).
pub async fn project_add(id: &str, path: &str) -> Result<()> {
    let Some(bin) = tokio::task::spawn_blocking(bin).await? else {
        bail!("kith isn't installed on this computer (set KITH_KERNEL_BIN, or put `kith` on PATH)");
    };
    run(&bin, &["project", "add", id, path], None, LIST_TIMEOUT).await?;
    // The next list must show it.
    *PROJECTS.locked() = None;
    Ok(())
}

/// Asks hq how to start `agent` for a run in `cwd`; `project` goes as `-p <id>`, so hq loads that project's context.
/// The model and effort the user picked for the bot go to hq as `-m`/`-e`, so its ledger tag and `KITH_MODEL` say what ran.
pub async fn launch(bin: &Path, agent: &str, cwd: &str, cfg: &BotConfig, project: Option<&str>) -> Result<Launch> {
    let mut args = vec![agent, "--launch-json"];
    if let Some(project) = project {
        args.extend(["-p", project]);
    }
    if let Some(model) = cfg.model.as_deref().filter(|m| !m.is_empty()) {
        args.extend(["-m", model]);
    }
    if let Some(effort) = cfg.model_options.get("effort").filter(|e| !e.is_empty()) {
        args.extend(["-e", effort]);
    }
    let out = run(bin, &args, Some(cwd), LAUNCH_TIMEOUT).await?;
    let launch: Launch = serde_json::from_str(out.trim())
        .with_context(|| format!("`kith {agent} --launch-json` didn't print a launch object"))?;
    if !launch.harness.is_empty() && launch.harness != "claude" {
        bail!("{agent} runs on {}; the host starts claude agents only", launch.harness);
    }
    Ok(launch)
}

impl Launch {
    /// Where the agent works: hq's choice, else the bot's folder.
    pub fn cwd<'a>(&'a self, cfg: &'a BotConfig) -> &'a str {
        if self.cwd.is_empty() { &cfg.cwd } else { &self.cwd }
    }

    /// The agent process's environment, on top of the host's own.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if !self.env.contains_key("KITH_VIA") {
            env.extend(crate::kernel::both("VIA", "serve"));
        }
        env
    }

    /// claude-agent-acp's `_meta` for `session/new` and `session/load`. The adapter passes `claudeCode.options`
    /// to the Claude Agent SDK as its `Options`, so hq's pieces map one to one:
    /// system prompt → `systemPrompt.append` (on top of Claude Code's own, as `hq <agent>` does);
    /// settings → `settings` (with the permission mode as its `defaultMode`, which is how the adapter picks its
    /// starting mode); servers → `mcpServers` in Claude's own format, with `strictMcpConfig` so only hq's count;
    /// `add_dirs` → `additionalDirectories`; `allowed_tools` → `allowedTools`; slash commands off →
    /// `extraArgs` `disable-slash-commands`; model and effort → `model`, `effort` (hq already applied the user's pick).
    pub fn meta(&self) -> Value {
        let mut settings = match &self.settings {
            Value::Object(_) => self.settings.clone(),
            _ => json!({}),
        };
        if let Some(mode) = self.permission_mode.as_deref().filter(|m| !m.is_empty()) {
            // hq's own settings may already say; its explicit mode wins, as `--permission-mode` does.
            if !settings["permissions"].is_object() {
                settings["permissions"] = json!({});
            }
            settings["permissions"]["defaultMode"] = mode.into();
        }
        let mut options = Map::new();
        options.insert("settings".into(), settings);
        options.insert("strictMcpConfig".into(), true.into());
        options.insert(
            "mcpServers".into(),
            if self.mcp_servers.is_object() { self.mcp_servers.clone() } else { json!({}) },
        );
        if !self.add_dirs.is_empty() {
            options.insert("additionalDirectories".into(), json!(self.add_dirs));
        }
        if !self.allowed_tools.is_empty() {
            options.insert("allowedTools".into(), json!(self.allowed_tools));
        }
        if self.disable_slash_commands {
            options.insert("extraArgs".into(), json!({"disable-slash-commands": null}));
        }
        if let Some(model) = self.model.as_deref().filter(|m| !m.is_empty()) {
            options.insert("model".into(), model.into());
        }
        if let Some(effort) = self.effort.as_deref().filter(|e| !e.is_empty()) {
            options.insert("effort".into(), effort.into());
        }
        json!({"systemPrompt": {"append": self.system_prompt}, "claudeCode": {"options": options}})
    }

    /// `session/new` (or, with `session`, `session/load`) for this launch. No ACP `mcpServers` of the host's own:
    /// hq's are in `_meta`.
    pub fn session_params(&self, cfg: &BotConfig, session: Option<&str>) -> Value {
        let mut params = json!({"cwd": self.cwd(cfg), "mcpServers": [], "_meta": self.meta()});
        if let Some(sid) = session {
            params["sessionId"] = sid.into();
        }
        params
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(model: Option<&str>) -> BotConfig {
        serde_json::from_value(json!({
            "id": "a", "name": "house", "backend": "claude", "cwd": "/agents/house", "hqAgent": "house",
            "model": model,
        }))
        .unwrap()
    }

    fn launch() -> Launch {
        serde_json::from_value(json!({
            "version": 1, "agent": "house", "harness": "claude", "cwd": "/agents/house",
            "env": {"KITH_AGENT": "house", "KITH_VIA": "serve"},
            "system_prompt": "You are house.",
            "settings": {"hooks": {"SessionStart": []}},
            "mcp_servers": {"files": {"command": "x", "args": ["1"], "env": {}}},
            "add_dirs": ["/hq", "/mem"],
            "allowed_tools": ["Read", "mcp__files"],
            "disable_slash_commands": true,
            "model": "haiku", "effort": "low", "permission_mode": "auto",
            "claude_args": ["--model", "haiku"],
        }))
        .unwrap()
    }

    #[test]
    fn launch_json_becomes_claude_options_and_nothing_of_serves() {
        let params = launch().session_params(&bot(None), None);
        assert_eq!(params["cwd"], "/agents/house");
        assert_eq!(params["mcpServers"], json!([]));
        let meta = &params["_meta"];
        assert_eq!(meta["systemPrompt"], json!({"append": "You are house."}));
        let o = &meta["claudeCode"]["options"];
        assert_eq!(o["strictMcpConfig"], true);
        assert_eq!(o["mcpServers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["files"]);
        assert_eq!(o["additionalDirectories"], json!(["/hq", "/mem"]));
        assert_eq!(o["allowedTools"], json!(["Read", "mcp__files"]));
        assert_eq!(o["extraArgs"], json!({"disable-slash-commands": null}));
        assert_eq!((o["model"].as_str(), o["effort"].as_str()), (Some("haiku"), Some("low")));
        assert_eq!(o["settings"]["permissions"]["defaultMode"], "auto");
        assert!(o["settings"]["hooks"].is_object(), "hq's hook survives");
        for server in ["chat", "memory", "team", "routines", "connectors"] {
            assert!(!meta.to_string().contains(&format!("\"{server}\"")), "{server}");
        }
    }

    #[test]
    fn a_project_works_in_its_home_else_the_first_path_that_exists() {
        let here = std::env::temp_dir().to_string_lossy().into_owned();
        let project: Project = serde_json::from_value(json!({
            "id": "hq", "paths": ["/nowhere/a", here], "home": "/nowhere/home", "remotes": [], "parent": null,
            "memory": null, "exists": true,
        }))
        .unwrap();
        assert_eq!(project.folder(), Some(here.clone()));
        let home = Project { home: Some(here.clone()), paths: vec![], ..project.clone() };
        assert_eq!(home.folder(), Some(here));
        assert_eq!(Project { home: None, paths: vec!["/nowhere/a".into()], ..project }.folder(), None);
    }

    #[test]
    fn a_load_names_its_session() {
        assert_eq!(launch().session_params(&bot(Some("opus")), Some("s1"))["sessionId"], "s1");
    }

    #[test]
    fn a_sparse_launch_still_makes_a_session() {
        let sparse: Launch = serde_json::from_value(json!({"version": 1, "system_prompt": "p"})).unwrap();
        let params = sparse.session_params(&bot(None), None);
        assert_eq!(params["cwd"], "/agents/house", "the bot's folder");
        let o = &params["_meta"]["claudeCode"]["options"];
        assert_eq!(o["mcpServers"], json!({}));
        assert!(o.get("extraArgs").is_none() && o.get("allowedTools").is_none());
        assert_eq!(
            sparse.env(),
            vec![("KITH_VIA".to_owned(), "serve".to_owned()), ("HQ_VIA".to_owned(), "serve".to_owned())]
        );
    }
}
