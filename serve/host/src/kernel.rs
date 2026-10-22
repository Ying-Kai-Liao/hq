//! The `kith` entry point: one binary for the host (`kith serve ...`) and the kernel's bash commands.
//!
//! `kith serve <host subcommand>` runs the host here. Everything else (`kith <agent>`, `kith doctor`,
//! `kith serve start`, ...) is handed to the kernel's bash entry with the same arguments, so it behaves
//! exactly like `hq ...` does. Run as `kith-serve` (the launchd job's binary name) the host never looks
//! for a kernel.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The kernel's command, relative to the kernel folder. The only place that names it: change it here when
/// the kernel's entry point is renamed.
pub const KERNEL_ENTRY: &str = "bin/hq";
/// The kernel folder inside a packaged install, relative to the folder holding `bin/`.
const SHIPPED_KERNEL: &str = "share/kith/kernel";
/// Env var that names a kernel folder, first in the lookup.
pub const KERNEL_ENV: &str = "KITH_KERNEL";
/// `kith serve <verb>` that the kernel handles (building, installing and configuring the host; its bash
/// wrapper then calls this binary's host subcommands). Anything else after `serve` is the host's.
const KERNEL_SERVE_VERBS: &[&str] = &["start", "stop", "restart", "status", "relay", "help", "-h", "--help"];
/// Host subcommands that the host starts itself with its own binary (MCP servers, npm installs, Claude's
/// statusLine): never the kernel's, whatever the binary is called.
const HOST_INTERNAL: &[&str] = &["mcp", "npm", "node", "statusline", "compat"];

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Run the host with these arguments (the first is the program name for usage text).
    Host(Vec<OsString>),
    /// Run the kernel's entry point with these arguments.
    Kernel(Vec<OsString>),
    /// Print the version.
    Version,
}

fn base(arg0: &OsString) -> String {
    Path::new(arg0).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Decides what a command line means. `args[0]` is the name the program was started under.
pub fn route(args: &[OsString]) -> Route {
    let Some(name0) = args.first() else { return Route::Host(vec!["kith-serve".into()]) };
    let rest = &args[1..];
    let kernel = |a: &[OsString]| Route::Kernel(a.to_vec());
    match base(name0).as_str() {
        "kith" => {}
        // `hq` as a second name for the same binary.
        "hq" => return kernel(rest),
        // kith-serve, and anything else: the host, as before.
        _ => return Route::Host(args.to_vec()),
    }
    match rest.first().and_then(|a| a.to_str()) {
        Some("--version" | "-V") => Route::Version,
        Some("serve") => match rest.get(1).and_then(|a| a.to_str()) {
            None => kernel(rest),
            Some(v) if KERNEL_SERVE_VERBS.contains(&v) => kernel(rest),
            // `kith serve --port N`: the foreground host (what the background job runs).
            Some(v) if v.starts_with('-') => Route::Host(host_args(&rest[..1], &rest[1..])),
            Some(_) => Route::Host(host_args(&[], &rest[1..])),
        },
        Some(s) if HOST_INTERNAL.contains(&s) => Route::Host(host_args(&[], rest)),
        _ => kernel(rest),
    }
}

fn host_args(lead: &[OsString], rest: &[OsString]) -> Vec<OsString> {
    let mut v: Vec<OsString> = vec!["kith serve".into()];
    v.extend(lead.iter().cloned());
    v.extend(rest.iter().cloned());
    v
}

/// The arguments that make this binary run a host subcommand: `install`, or `serve install` when it is
/// the `kith` binary. For the host starting itself.
pub fn self_args(sub: &[&str]) -> Vec<OsString> {
    let is_kith = std::env::current_exe().ok().is_some_and(|e| base(&e.into_os_string()) == "kith");
    let mut v: Vec<OsString> = Vec::new();
    if is_kith && !sub.first().is_some_and(|s| HOST_INTERNAL.contains(s)) {
        v.push("serve".into());
    }
    v.extend(sub.iter().map(OsString::from));
    v
}

fn is_kernel(dir: &Path) -> bool {
    dir.join(KERNEL_ENTRY).is_file()
}

/// Where the kernel is, in order: `$KITH_KERNEL`, a kernel shipped next to the (real, symlinks resolved)
/// binary (`<prefix>/share/kith/kernel`, or `<prefix>/kernel`), then `~/hq/kernel` (a git checkout).
pub fn find_kernel(env: Option<OsString>, exe: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = env.filter(|e| !e.is_empty()).map(PathBuf::from) {
        return is_kernel(&dir).then_some(dir);
    }
    let prefix = exe.and_then(|e| e.canonicalize().ok()).and_then(|e| e.parent()?.parent().map(Path::to_path_buf));
    if let Some(prefix) = prefix {
        for c in [prefix.join(SHIPPED_KERNEL), prefix.join("kernel")] {
            if is_kernel(&c) {
                return Some(c);
            }
        }
    }
    let checkout = home?.join("hq/kernel");
    is_kernel(&checkout).then_some(checkout)
}

/// Replaces this process with the kernel's entry point. Only returns on failure.
#[cfg(unix)]
pub fn exec_kernel(args: &[OsString]) -> anyhow::Error {
    use std::os::unix::process::CommandExt as _;
    let exe = std::env::current_exe().ok();
    let Some(kernel) = find_kernel(std::env::var_os(KERNEL_ENV), exe.as_deref(), dirs::home_dir().as_deref()) else {
        return anyhow::anyhow!(
            "kith: no kernel found. Set {KERNEL_ENV}, install a packaged kith (it ships share/kith/kernel), or clone hq to ~/hq"
        );
    };
    let entry = kernel.join(KERNEL_ENTRY);
    let mut cmd = std::process::Command::new(&entry);
    cmd.args(args);
    // So the kernel's hq-serve installs this very binary on a packaged install, without cargo.
    if let Some(e) = exe.and_then(|e| e.canonicalize().ok()) {
        cmd.env("KITH_BIN", e);
    }
    anyhow::Error::new(cmd.exec()).context(format!("running {}", entry.display()))
}

#[cfg(not(unix))]
pub fn exec_kernel(_args: &[OsString]) -> anyhow::Error {
    anyhow::anyhow!("kith: the kernel's commands run on macOS and Linux only")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }

    #[test]
    fn kith_routes() {
        assert_eq!(route(&v(&["/x/kith", "--version"])), Route::Version);
        assert_eq!(route(&v(&["kith", "doctor"])), Route::Kernel(v(&["doctor"])));
        assert_eq!(route(&v(&["kith", "coder", "-p", "x"])), Route::Kernel(v(&["coder", "-p", "x"])));
        assert_eq!(
            route(&v(&["kith", "serve", "start", "--no-build"])),
            Route::Kernel(v(&["serve", "start", "--no-build"]))
        );
        assert_eq!(route(&v(&["kith", "serve"])), Route::Kernel(v(&["serve"])));
        assert_eq!(
            route(&v(&["kith", "serve", "install", "--port", "1"])),
            Route::Host(v(&["kith serve", "install", "--port", "1"]))
        );
        assert_eq!(
            route(&v(&["kith", "serve", "--port", "1"])),
            Route::Host(v(&["kith serve", "serve", "--port", "1"]))
        );
        assert_eq!(
            route(&v(&["kith", "statusline", "--", "x"])),
            Route::Host(v(&["kith serve", "statusline", "--", "x"]))
        );
        assert_eq!(route(&v(&["hq", "ls"])), Route::Kernel(v(&["ls"])));
    }

    #[test]
    fn kith_serve_is_the_host() {
        assert_eq!(route(&v(&["/h/kith-serve", "install"])), Route::Host(v(&["/h/kith-serve", "install"])));
    }

    #[test]
    fn finds_kernel_in_order() {
        let t = std::env::temp_dir().join(format!("kith-kernel-test-{}", std::process::id()));
        let mk = |p: &Path| {
            std::fs::create_dir_all(p.join("bin")).unwrap();
            std::fs::write(p.join(KERNEL_ENTRY), "").unwrap();
        };
        let (shipped, checkout, envk) = (t.join("p/share/kith/kernel"), t.join("home/hq/kernel"), t.join("e"));
        mk(&checkout);
        std::fs::create_dir_all(t.join("p/bin")).unwrap();
        std::fs::write(t.join("p/bin/kith"), "").unwrap();
        let exe = t.join("p/bin/kith");
        let home = t.join("home");
        assert_eq!(find_kernel(None, Some(&exe), Some(&home)), Some(checkout));
        mk(&shipped);
        assert_eq!(
            find_kernel(None, Some(&exe), Some(&home)).map(|p| p.canonicalize().unwrap()),
            Some(shipped.canonicalize().unwrap())
        );
        mk(&envk);
        assert_eq!(find_kernel(Some(envk.clone().into()), Some(&exe), Some(&home)), Some(envk));
        assert_eq!(find_kernel(Some(t.join("nope").into()), Some(&exe), Some(&home)), None);
        std::fs::remove_dir_all(&t).unwrap();
    }
}
