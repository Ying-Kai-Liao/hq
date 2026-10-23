//! Who is asking, for a run that is not the owner's.
//!
//! An invited person's (or a bot guest's) agent run holds `KITH_RUN_TOKEN`, a random per-run secret the host issues
//! at launch and keeps only in memory, bound to the person, agent and room it was issued for. `kith recall` inside
//! such a run does not read the memory index and does not believe `KITH_PERSON` (an env var the run can change);
//! it asks the host over a unix socket (`KITH_RUN_SOCKET`) with the token. The host runs the kernel's own
//! `kith recall` as the identity the token names, so forging the env var gains nothing.
//!
//! One request per connection: a JSON line `{"token", "method": "recall", "args": [..]}`, answered by one JSON line
//! `{"ok": true, "stdout", "stderr", "code"}` or `{"ok": false, "error"}`.
//!
//! The token also has to come from the run it was issued to: on macOS a process of the same user can read another
//! process's environment (`ps eww` shows a Python or Node child's), so a token alone could be lifted from a
//! neighbouring run. The peer pid of the connection must descend from the pid the run's process was started as.

use crate::LockExt as _;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};

pub const TOKEN_ENV: &str = "KITH_RUN_TOKEN";
pub const SOCKET_ENV: &str = "KITH_RUN_SOCKET";

/// A request line longer than this is refused unread.
const MAX_REQUEST: usize = 64 * 1024;
const MAX_ARGS: usize = 64;
const MAX_ARG_LEN: usize = 4096;
const MAX_OUTPUT: usize = 256 * 1024;
const READ_BUDGET: Duration = Duration::from_secs(5);
const RECALL_BUDGET: Duration = Duration::from_secs(30);
/// How far up the process tree a peer is followed before it counts as not descending.
const MAX_HOPS: usize = 64;

/// Whom a token stands for. Everything the host decides about a request comes from here, never from its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunIdentity {
    pub person: String,
    pub agent: String,
    pub room: Option<String>,
    pub run_id: String,
}

/// What the host learned about the connection's other end.
#[derive(Debug, Clone, Copy, Default)]
pub struct PeerInfo {
    pub pid: Option<u32>,
}

struct Entry {
    identity: RunIdentity,
    /// The process the run was started as; the peer must be it or below it. Not bound yet: nobody matches.
    pid: Option<u32>,
}

/// The live tokens, by the SHA-256 of the token (the map never holds a token itself).
pub struct TokenTable {
    entries: Mutex<HashMap<[u8; 32], Entry>>,
    /// `(peer, ancestor)`: whether `peer` is `ancestor` or one of its descendants. Replaceable for tests.
    ancestry: fn(u32, u32) -> bool,
}

fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl TokenTable {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()), ancestry: descends }
    }

    #[cfg(test)]
    fn with_ancestry(ancestry: fn(u32, u32) -> bool) -> Self {
        Self { entries: Mutex::new(HashMap::new()), ancestry }
    }

    /// A fresh token for `identity`: 256 random bits as hex.
    fn insert(&self, identity: RunIdentity) -> Result<(String, [u8; 32])> {
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw).map_err(|_| anyhow::anyhow!("random bytes unavailable"))?;
        let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        let key = digest(&token);
        self.entries.locked().insert(key, Entry { identity, pid: None });
        Ok((token, key))
    }

    fn bind(&self, key: &[u8; 32], pid: u32) {
        if let Some(e) = self.entries.locked().get_mut(key) {
            e.pid = Some(pid);
        }
    }

    fn revoke(&self, key: &[u8; 32]) {
        self.entries.locked().remove(key);
    }

    pub fn len(&self) -> usize {
        self.entries.locked().len()
    }

    /// The one place a token becomes an identity: the token must be live and the peer must be the run's own process
    /// or below it. Unknown, revoked, unbound and foreign peers are all `None`.
    pub fn resolve(&self, token: &str, peer: PeerInfo) -> Option<RunIdentity> {
        let (identity, pid) = {
            let entries = self.entries.locked();
            let e = entries.get(&digest(token))?;
            (e.identity.clone(), e.pid?)
        };
        let peer = peer.pid?;
        (self.ancestry)(peer, pid).then_some(identity)
    }
}

impl Default for TokenTable {
    fn default() -> Self {
        Self::new()
    }
}

/// A token's lifetime: revoked when this is dropped, which is when the run's process is gone.
pub struct RunGrant {
    table: Arc<TokenTable>,
    key: [u8; 32],
    token: String,
}

impl RunGrant {
    /// Issues a token on `table`.
    pub fn issue(table: &Arc<TokenTable>, identity: RunIdentity) -> Result<Self> {
        let (token, key) = table.insert(identity)?;
        Ok(Self { table: table.clone(), key, token })
    }

    /// Binds the token to the process the run was started as. Until then no request resolves.
    pub fn bind_pid(&self, pid: u32) {
        self.table.bind(&self.key, pid);
    }

    /// The environment the run gets. The only place the token leaves this module.
    pub fn env(&self, socket: &Path) -> [(String, String); 2] {
        [(TOKEN_ENV.into(), self.token.clone()), (SOCKET_ENV.into(), socket.to_string_lossy().into_owned())]
    }
}

impl Drop for RunGrant {
    fn drop(&mut self) {
        self.table.revoke(&self.key);
    }
}

static TABLE: OnceLock<Arc<TokenTable>> = OnceLock::new();
static SOCKET: OnceLock<PathBuf> = OnceLock::new();

pub fn table() -> &'static Arc<TokenTable> {
    TABLE.get_or_init(|| Arc::new(TokenTable::new()))
}

/// A grant for a run of `person` (an invited person's or a bot guest's id) on `agent`, with the environment to give
/// it. `None` when the socket isn't listening: such a run gets no token and no socket, and its recall reads nothing.
pub fn grant_for(person: &str, agent: &str, room: Option<&str>) -> Option<(RunGrant, [(String, String); 2])> {
    let socket = SOCKET.get()?;
    let identity = RunIdentity {
        person: person.to_owned(),
        agent: agent.to_owned(),
        room: room.filter(|r| !r.is_empty()).map(str::to_owned),
        run_id: uuid::Uuid::new_v4().simple().to_string(),
    };
    match RunGrant::issue(table(), identity) {
        Ok(grant) => {
            let env = grant.env(socket);
            Some((grant, env))
        }
        Err(error) => {
            tracing::warn!(error = format!("{error:#}"), "no run token issued");
            None
        }
    }
}

/// For a run started from an environment list (channel runs): when it names a person, issues a grant and adds the
/// token and socket to the list. The owner's list (no `KITH_PERSON`) is left alone.
pub fn grant_for_env(env: &mut Vec<(std::ffi::OsString, std::ffi::OsString)>, agent: &str) -> Option<RunGrant> {
    let get = |name: &str| env.iter().rev().find(|(k, _)| k == name).and_then(|(_, v)| v.to_str()).map(str::to_owned);
    let person = get("KITH_PERSON").filter(|p| !p.is_empty())?;
    let room = get("KITH_ROOM");
    let (grant, vars) = grant_for(&person, agent, room.as_deref())?;
    env.extend(vars.into_iter().map(|(k, v)| (k.into(), v.into())));
    Some(grant)
}

/// `$KITH_MACHINE/run/host.sock`: outside the serve data folder, which a guest's sandbox denies.
pub fn socket_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    crate::kernel::machine_dir(&home).join("run").join("host.sock")
}

// ---- requests

#[derive(Debug, PartialEq, Eq)]
pub enum Response {
    Ok { stdout: String, stderr: String, code: i32 },
    Refused(String),
}

impl Response {
    fn refused(why: &str) -> Self {
        Self::Refused(why.to_owned())
    }

    fn to_line(&self) -> String {
        let v = match self {
            Self::Ok { stdout, stderr, code } => json!({"ok": true, "stdout": stdout, "stderr": stderr, "code": code}),
            Self::Refused(error) => json!({"ok": false, "error": error}),
        };
        format!("{v}\n")
    }
}

/// What a request is allowed to run: the identity (from the token alone) and the arguments `kith recall` is given.
#[derive(Debug, PartialEq, Eq)]
pub struct Authorized {
    pub identity: RunIdentity,
    pub args: Vec<String>,
}

/// Checks a request line without running anything. Every token failure reads the same to the caller, so a probe
/// learns nothing about which tokens exist.
pub fn authorize(table: &TokenTable, line: &[u8], peer: PeerInfo) -> Result<Authorized, Response> {
    if line.len() > MAX_REQUEST {
        return Err(Response::refused("request too large"));
    }
    let Ok(req) = serde_json::from_slice::<Value>(line) else {
        return Err(Response::refused("malformed request"));
    };
    let (Some(token), Some(method)) = (req["token"].as_str(), req["method"].as_str()) else {
        return Err(Response::refused("malformed request"));
    };
    let Some(identity) = table.resolve(token, peer) else {
        return Err(Response::refused("not authorized"));
    };
    match method {
        "recall" => {
            let args = recall_args(req["args"].as_array().map_or(&[][..], Vec::as_slice))
                .map_err(|why| Response::Refused(why.to_owned()))?;
            Ok(Authorized { identity, args })
        }
        _ => Err(Response::refused("unknown method")),
    }
}

/// The flags of `kith recall` that only narrow a search (the kernel filters by the caller's audience first); who asks
/// is never an argument.
const VALUE_FLAGS: &[&str] = &["--project", "--room", "--thread", "--tier", "-n", "--limit"];

/// Turns the request's arguments into `kith recall`'s: the query words, `--json` and the narrowing flags above, nothing
/// else (a word starting with `-` is not a query). The result starts with a flag, so a query that begins with `index`
/// (or `forget`) can never reach a subcommand of `kith recall`.
pub fn recall_args(args: &[Value]) -> Result<Vec<String>, &'static str> {
    if args.len() > MAX_ARGS {
        return Err("too many arguments");
    }
    let mut words = Vec::new();
    let (mut json, mut tier, mut limit) = (false, "2".to_owned(), None::<String>);
    let mut flags: Vec<(String, String)> = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let Some(arg) = arg.as_str().filter(|a| a.len() <= MAX_ARG_LEN) else { return Err("bad argument") };
        if arg == "--json" {
            json = true;
        } else if VALUE_FLAGS.contains(&arg) {
            let Some(value) = it.next().and_then(Value::as_str).filter(|v| v.len() <= MAX_ARG_LEN) else {
                return Err("a flag needs a value");
            };
            match arg {
                "--tier" => value.clone_into(&mut tier),
                "-n" | "--limit" => limit = Some(value.to_owned()),
                _ => flags.push((arg.to_owned(), value.to_owned())),
            }
        } else if arg.starts_with('-') {
            return Err("that flag isn't available here");
        } else {
            words.push(arg.to_owned());
        }
    }
    if words.is_empty() {
        return Err("a query is needed");
    }
    let mut out = vec!["--tier".to_owned(), tier];
    if let Some(n) = limit {
        out.extend(["-n".to_owned(), n]);
    }
    for (k, v) in flags {
        out.extend([k, v]);
    }
    if json {
        out.push("--json".into());
    }
    out.extend(words);
    Ok(out)
}

/// Answers one request line: refuses it, or runs the kernel's `kith recall` as the token's identity.
pub async fn handle_request(table: &TokenTable, line: &[u8], peer: PeerInfo) -> Response {
    match authorize(table, line, peer) {
        Ok(job) => run_recall(&job).await,
        Err(refused) => refused,
    }
}

/// Env names the recall child must not inherit from the host: identity comes from the token only.
const SCRUB: &[&str] = &[
    "KITH_AGENT",
    "HQ_AGENT",
    "KITH_PERSON",
    "HQ_PERSON",
    "KITH_ROOM",
    "HQ_ROOM",
    "KITH_PROJECT",
    "HQ_PROJECT",
    "KITH_VIA",
    "HQ_VIA",
    TOKEN_ENV,
    SOCKET_ENV,
];

async fn run_recall(job: &Authorized) -> Response {
    let Ok(Some(bin)) = tokio::task::spawn_blocking(crate::agent::hq::bin).await else {
        return Response::refused("kith isn't available on this computer");
    };
    let mut command = tokio::process::Command::new(bin);
    command.arg("recall").args(&job.args);
    for name in SCRUB {
        command.env_remove(name);
    }
    command.envs(crate::kernel::both("AGENT", &job.identity.agent));
    command.envs(crate::kernel::both("PERSON", &job.identity.person));
    command.envs(crate::kernel::both("VIA", "serve"));
    if let Some(room) = &job.identity.room {
        command.envs(crate::kernel::both("ROOM", room));
    }
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);
    let Ok(mut child) = command.spawn() else { return Response::refused("could not run recall") };
    let (mut out, mut err) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let work = async {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let (mut out, mut err) = ((&mut out).take(MAX_OUTPUT as u64), (&mut err).take(MAX_OUTPUT as u64));
        let (a, b) = tokio::join!(out.read_to_end(&mut stdout), err.read_to_end(&mut stderr));
        a.and(b)?;
        // Output past the cap is left unread: a child blocked on its full pipe is cut off by the budget below.
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    };
    match tokio::time::timeout(RECALL_BUDGET, work).await {
        Ok(Ok((status, stdout, stderr))) => Response::Ok {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            code: status.code().unwrap_or(1),
        },
        _ => Response::refused("recall timed out"),
    }
}

// ---- the socket

async fn serve_one(table: Arc<TokenTable>, stream: tokio::net::UnixStream) {
    let peer = PeerInfo { pid: stream.peer_cred().ok().and_then(|c| c.pid()).and_then(|p| u32::try_from(p).ok()) };
    let (read, mut write) = stream.into_split();
    let mut line = Vec::new();
    let read = tokio::time::timeout(READ_BUDGET, async {
        // One byte past the cap tells an oversized line from one that is exactly at it.
        BufReader::new(read.take(MAX_REQUEST as u64 + 1)).read_until(b'\n', &mut line).await
    })
    .await;
    let response = match read {
        Ok(Ok(n)) if n > 0 => {
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            handle_request(&table, &line, peer).await
        }
        _ => Response::refused("malformed request"),
    };
    let _ = write.write_all(response.to_line().as_bytes()).await;
}

/// Binds the socket (`dir` 0700, the socket 0600, a stale file from an earlier host removed) and answers requests in
/// the background. A failure leaves the host running and runs without tokens (see [`grant_for`]).
pub fn start() {
    let path = socket_path();
    match bind(&path) {
        Ok(listener) => {
            let _ = SOCKET.set(path.clone());
            tracing::info!(socket = %path.display(), "run socket listening");
            let table = table().clone();
            tokio::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((stream, _)) => {
                            tokio::spawn(serve_one(table.clone(), stream));
                        }
                        Err(error) => {
                            tracing::warn!(%error, "run socket accept failed");
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                }
            });
        }
        Err(error) => tracing::warn!(error = format!("{error:#}"), "run socket not started: guests' recall stays empty"),
    }
}

fn bind(path: &Path) -> Result<tokio::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = path.parent().context("socket path has no folder")?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    // A file left by a host that didn't shut down cleanly; the host lock means no other host is using it.
    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path).with_context(|| format!("binding {}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

// ---- process ancestry

/// Whether `pid` is `ancestor` or has it among its parents. Asks `ps`, which both macOS and Linux have; any failure
/// (a process gone, `ps` missing) is "no".
fn descends(pid: u32, ancestor: u32) -> bool {
    let mut cur = pid;
    for _ in 0..MAX_HOPS {
        if cur == ancestor {
            return true;
        }
        if cur <= 1 {
            return false;
        }
        let Ok(out) = std::process::Command::new("ps").args(["-o", "ppid=", "-p", &cur.to_string()]).output() else {
            return false;
        };
        let Some(parent) = String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok() else { return false };
        cur = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(person: &str) -> RunIdentity {
        RunIdentity { person: person.into(), agent: "echo".into(), room: Some("1:1:echo:sam".into()), run_id: "r1".into() }
    }

    fn open_table() -> Arc<TokenTable> {
        Arc::new(TokenTable::with_ancestry(|peer, run| peer == run))
    }

    fn req(token: &str, method: &str, args: &Value) -> Vec<u8> {
        json!({"token": token, "method": method, "args": args}).to_string().into_bytes()
    }

    fn peer(pid: u32) -> PeerInfo {
        PeerInfo { pid: Some(pid) }
    }

    #[test]
    fn issue_lookup_revoke() {
        let t = open_table();
        let g = RunGrant::issue(&t, id("sam")).unwrap();
        let token = g.token.clone();
        assert_eq!(token.len(), 64, "256 bits as hex");
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(t.resolve(&token, peer(7)), None, "unbound: nobody matches");
        g.bind_pid(7);
        assert_eq!(t.resolve(&token, peer(7)), Some(id("sam")));
        assert_eq!(t.resolve(&token, peer(8)), None, "another process");
        assert_eq!(t.resolve(&token, PeerInfo::default()), None, "no peer pid");
        drop(g);
        assert_eq!(t.resolve(&token, peer(7)), None, "revoked with the run");
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn tokens_are_distinct_and_the_table_holds_no_token() {
        let t = open_table();
        let (a, b) = (RunGrant::issue(&t, id("sam")).unwrap(), RunGrant::issue(&t, id("eve")).unwrap());
        assert_ne!(a.token, b.token);
        a.bind_pid(1);
        b.bind_pid(2);
        assert_eq!(t.resolve(&a.token, peer(1)).unwrap().person, "sam");
        assert_eq!(t.resolve(&b.token, peer(2)).unwrap().person, "eve");
        assert_eq!(t.resolve(&a.token, peer(2)), None, "one run's token from another run's process");
        assert!(!t.entries.locked().keys().any(|k| k.as_slice() == a.token.as_bytes()));
    }

    #[test]
    fn unknown_revoked_and_malformed_requests_are_refused() {
        let t = open_table();
        let g = RunGrant::issue(&t, id("sam")).unwrap();
        g.bind_pid(5);
        let ok = req(&g.token, "recall", &json!(["zebra"]));
        assert!(authorize(&t, &ok, peer(5)).is_ok());
        assert!(authorize(&t, &req("nope", "recall", &json!(["zebra"])), peer(5)).is_err());
        assert!(authorize(&t, &req(&g.token, "shell", &json!(["ls"])), peer(5)).is_err(), "unknown method");
        assert!(authorize(&t, &req(&g.token, "forget", &json!(["x"])), peer(5)).is_err(), "no write methods");
        assert!(authorize(&t, b"not json", peer(5)).is_err());
        assert!(authorize(&t, b"{\"method\":\"recall\"}", peer(5)).is_err(), "no token");
        assert!(authorize(&t, b"[1,2]", peer(5)).is_err());
        let big = req(&g.token, "recall", &json!(["x".repeat(MAX_REQUEST)]));
        assert_eq!(authorize(&t, &big, peer(5)), Err(Response::refused("request too large")));
        drop(g);
        assert!(authorize(&t, &ok, peer(5)).is_err(), "after the run is gone");
    }

    #[tokio::test]
    async fn handle_request_refuses_without_running_anything() {
        let t = open_table();
        let r = handle_request(&t, &req("nope", "recall", &json!(["zebra"])), peer(1)).await;
        assert_eq!(r, Response::refused("not authorized"));
        assert!(r.to_line().contains("\"ok\":false"));
    }

    #[test]
    fn the_audience_is_the_tokens_whatever_the_arguments_say() {
        let t = open_table();
        let g = RunGrant::issue(&t, id("sam")).unwrap();
        g.bind_pid(5);
        let line = req(
            &g.token,
            "recall",
            &json!(["zebra", "--project", "alpha", "--room", "1:1:echo:eve", "KITH_PERSON=kai", "--json"]),
        );
        let job = authorize(&t, &line, peer(5)).unwrap();
        assert_eq!(job.identity, id("sam"), "person, agent and room are the token's");
        // Narrowing flags pass as flags with their values; an env-looking word is just a query word.
        assert_eq!(
            job.args,
            ["--tier", "2", "--project", "alpha", "--room", "1:1:echo:eve", "--json", "zebra", "KITH_PERSON=kai"]
        );
        for bad in [
            json!(["zebra", "--person", "kai"]),
            json!(["zebra", "--agent", "other"]),
            json!(["--env", "KITH_PERSON=kai", "zebra"]),
            json!(["zebra", "--project"]),
            json!([]),
            json!(["--json"]),
            json!([1, 2]),
        ] {
            assert!(authorize(&t, &req(&g.token, "recall", &bad), peer(5)).is_err(), "{bad} should be refused");
        }
        for sub in ["index", "forget"] {
            let job = authorize(&t, &req(&g.token, "recall", &json!([sub, "rebuild"])), peer(5)).unwrap();
            assert_eq!(job.args[0], "--tier", "{sub} is a query word, never a subcommand");
        }
    }

    #[test]
    fn recall_args_caps() {
        assert!(recall_args(&vec![json!("a"); MAX_ARGS + 1]).is_err());
        assert!(recall_args(&[json!("x".repeat(MAX_ARG_LEN + 1))]).is_err());
        assert_eq!(recall_args(&[json!("a"), json!("--limit"), json!("3")]).unwrap(), ["--tier", "2", "-n", "3", "a"]);
    }

    #[test]
    fn ancestry_follows_real_parents() {
        let me = std::process::id();
        let mut child = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        let pid = child.id();
        assert!(descends(pid, me), "a child descends from its parent");
        assert!(descends(me, me));
        assert!(!descends(me, pid), "not the other way round");
        assert!(!descends(pid, 1 << 30));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!descends(pid, me), "a gone process descends from nothing");
    }

    #[test]
    fn env_list_gets_a_token_only_with_a_person() {
        // No socket is listening in unit tests, so no token is issued: the list is left as it was.
        let mut owner = vec![("KITH_AGENT".into(), "echo".into())];
        assert!(grant_for_env(&mut owner, "echo").is_none());
        assert_eq!(owner.len(), 1);
        let mut guest = vec![("KITH_PERSON".into(), "sam".into())];
        assert!(grant_for_env(&mut guest, "echo").is_none());
        assert!(!guest.iter().any(|(k, _)| k == TOKEN_ENV));
    }

    #[tokio::test]
    async fn socket_round_trip_refuses_a_forged_token() {
        let dir = std::env::temp_dir().join(format!("kr-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        let sock = dir.join("host.sock");
        let listener = bind(&sock).unwrap();
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let t = open_table();
        let server = tokio::spawn({
            let t = t.clone();
            async move {
                let (stream, _) = listener.accept().await.unwrap();
                serve_one(t, stream).await;
            }
        });
        let mut c = tokio::net::UnixStream::connect(&sock).await.unwrap();
        c.write_all(&req("forged", "recall", &json!(["zebra"]))).await.unwrap();
        c.write_all(b"\n").await.unwrap();
        let mut reply = String::new();
        c.read_to_string(&mut reply).await.unwrap();
        let v: Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(v["ok"], false);
        server.await.unwrap();
        // A stale file from an earlier host is replaced.
        drop(bind(&sock).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
