//! hq agents as bots. hq says how to start an agent (`hq <agent> --launch-json`), the host starts it: this file
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

/// `hq ls --json` reads a few folders; `--launch-json` assembles prompt, settings and servers.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);

/// Test hosts name the ACP command that stands in for claude-agent-acp.
pub const ACP_COMMAND_ENV: &str = "KITH_SERVE_HQ_ACP_COMMAND";

/// The `hq` to run: `HQ_BIN` when set (an empty value turns hq off), else `hq` on PATH, else `~/.local/bin/hq`.
/// Blocking: looking on PATH may ask the login shell.
pub fn bin() -> Option<PathBuf> {
    if let Some(set) = std::env::var_os("HQ_BIN") {
        return (!set.is_empty()).then(|| PathBuf::from(set));
    }
    crate::agent::backends::which("hq").or_else(|| {
        let local = dirs::home_dir()?.join(".local/bin/hq");
        local.is_file().then_some(local)
    })
}

/// One line of `hq ls --json`.
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
    /// Whether the host can run it: `hq <agent> --launch-json` covers Claude agents only.
    pub fn runnable(&self) -> bool {
        self.harness == "claude"
    }
}

/// What `hq <agent> --launch-json` printed, the parts the host uses.
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

/// Runs `bin args…` in `cwd` with `HQ_VIA=serve`: its stdout, or the stderr text it failed with.
async fn run(bin: &Path, args: &[&str], cwd: Option<&str>, budget: Duration) -> Result<String> {
    let shown = format!("hq {}", args.join(" "));
    let mut command = tokio::process::Command::new(bin);
    command
        .args(args)
        .env("HQ_VIA", "serve")
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
    serde_json::from_str(out.trim()).context("`hq ls --json` didn't print a JSON list of agents")
}

/// One registered hq project, from `hq project ls --json`.
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

/// What `hq project ls --json` prints.
#[derive(Deserialize)]
struct Listing {
    projects: Vec<Project>,
}

/// `hq project ls --json`, reused for a few seconds unless `fresh`. Fails when hq is missing or the command does.
pub async fn projects(fresh: bool) -> Result<Vec<Project>> {
    if !fresh
        && let Some((at, list)) = PROJECTS.locked().clone()
        && at.elapsed() < PROJECTS_FRESH
    {
        return Ok(list);
    }
    let Some(bin) = tokio::task::spawn_blocking(bin).await? else {
        bail!("hq isn't installed on this computer (set HQ_BIN, or put `hq` on PATH)");
    };
    let out = run(&bin, &["project", "ls", "--json"], None, LIST_TIMEOUT).await?;
    let list = serde_json::from_str::<Listing>(out.trim())
        .context("`hq project ls --json` didn't print a JSON list of projects")?
        .projects;
    remember_projects(&list);
    Ok(list)
}

/// `hq project add <id> <path>`: hq's own error text on failure (a taken id, a path that isn't a folder…).
pub async fn project_add(id: &str, path: &str) -> Result<()> {
    let Some(bin) = tokio::task::spawn_blocking(bin).await? else {
        bail!("hq isn't installed on this computer (set HQ_BIN, or put `hq` on PATH)");
    };
    run(&bin, &["project", "add", id, path], None, LIST_TIMEOUT).await?;
    // The next list must show it.
    *PROJECTS.locked() = None;
    Ok(())
}

/// Asks hq how to start `agent` for a run in `cwd`; `project` goes as `-p <id>`, so hq loads that project's context.
/// The model and effort the user picked for the bot go to hq as `-m`/`-e`, so its ledger tag and `HQ_MODEL` say what ran.
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
        .with_context(|| format!("`hq {agent} --launch-json` didn't print a launch object"))?;
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
        if !self.env.contains_key("HQ_VIA") {
            env.push(("HQ_VIA".into(), "serve".into()));
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
            "env": {"HQ_AGENT": "house", "HQ_VIA": "serve"},
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
        assert_eq!(sparse.env(), vec![("HQ_VIA".to_owned(), "serve".to_owned())]);
    }
}
