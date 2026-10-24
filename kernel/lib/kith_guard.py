"""What a run for anyone but the owner may not touch: the secrets and the run-later paths (rule W).

One list, read by both layers `kernel/bin/kith` writes for such a run: the OS sandbox around Bash (denyRead / denyWrite)
and the permission rules of the file tools (Read / Edit deny rules, which beat any allow). Keep `serve/host/src/cards/
resource.rs` SENSITIVE in step with SECRET_RULES.

Rule W (designs/2026-10-24-cards-plan.md, plan 2): a run that is not the owner's never writes a file that something
outside the sandbox later runs, loads as settings, or loads as instructions. Everything here is by real path and, where
a link is involved, by both spellings.
"""
import os
import re

# Under the Kith state folder and the machine folder: whole folders that hold logins, tokens and every audience's index.
SECRET_DIRS = ("secrets", "serve", "browsers", "bridge", "index", "room-ledger")
# The same places as permission-rule patterns (Read/Edit), plus the database files that sit among them.
SECRET_RULES = ("secrets/**", "serve/token", "serve/identity.json", "serve/*.db", "serve/*.db-*", "browsers/**", "bridge/**",
                "index/**", "memory.db*")

# Below any folder a run may write in (and below the working directory, which is read-only for a guest): files and
# folders that Claude Code, git, an editor or a shell loads and runs on the owner's next call.
IN_FOLDER_TREES = (".claude", ".vscode", ".idea", ".git/hooks")
IN_FOLDER_FILES = ("CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".envrc", ".git/config", ".gitmodules")
# Below the owner's home folder.
HOME_TREES = (".config/git", "Library/LaunchAgents", ".local/bin", ".npm-global", ".cargo/bin")
HOME_FILES = (".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".gitconfig", ".claude.json")
# Absolute: command folders on PATH.
ABS_TREES = ("/opt/homebrew", "/usr/local/bin")


def both(p):
    return list(dict.fromkeys((p, os.path.realpath(p))))


def secret_paths(roots, secrets_dir, machine):
    """Absolute folders (denyRead / denyWrite) for the secrets: `roots` are the state and machine folders."""
    out = []
    for r in dict.fromkeys(x for root in roots for x in both(root)):
        out += ["%s/%s" % (r, f) for f in SECRET_DIRS]
    machine = both(machine)
    for p in both(secrets_dir):   # the older layout keeps two files among the machine things
        out += [p + "/env", p + "/auth.json"] if p in machine else [p]
    return list(dict.fromkeys(out))


def rule_w(home, folders, trees=(), files=()):
    """(trees, files) the run may not write: below each of `folders`, below `home`, the PATH folders, and the extra
    `trees` / `files` (the kernel, the agent's package, ...). Both spellings of each."""
    t, f = [], []
    for d in folders:
        for x in both(d):
            # at any depth: a repository cloned or created below a folder the run may write in
            for pre in ("%s/" % x, "%s/**/" % x):
                t += [pre + n for n in IN_FOLDER_TREES]
                f += [pre + n for n in IN_FOLDER_FILES]
    for x in both(home):
        t += ["%s/%s" % (x, n) for n in HOME_TREES]
        f += ["%s/%s" % (x, n) for n in HOME_FILES]
    for a in ABS_TREES:
        t += both(a)
    for p in trees:
        t += both(p)
    for p in files:
        f += both(p)
    return list(dict.fromkeys(t)), list(dict.fromkeys(f))


def edit_rules(trees, files):
    """Edit deny rules (which cover every tool that writes a file) for a rule W list."""
    return ["Edit(/%s/**)" % t for t in trees] + ["Edit(/%s)" % f for f in files]


# ---- access grants (F11 step 2b)
# What a yes on an escape card adds to the next run's profile. The host decides what is granted (cards, kith-auth); this is
# the build-time half, and it checks again: a grant is never added when it resolves into the secrets or rule W, however
# it got here.
DOMAIN = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")


def valid_domain(d):
    """A plain host name (no wildcard, no address, no port)."""
    return isinstance(d, str) and DOMAIN.match(d) is not None


def covers(entry, path):
    """Whether a deny entry (a path, `dir/**` for a tree, `dir/**/name` at any depth) holds `path`. Case-folded on macOS."""
    if os.uname().sysname == "Darwin":
        entry, path = entry.lower(), path.lower()
    e = entry[:-3] if entry.endswith("/**") else entry
    rx = re.escape(e).replace("/\\*\\*/", "/(?:.*/)?")
    return re.fullmatch(rx + "(?:/.*)?", path) is not None


def is_rule_w(home, path, trees=(), files=()):
    """Whether `path` is, or is below, a place rule W closes: the in-folder names at any depth, the home and PATH folders,
    and the extra `trees` / `files`."""
    t, f = rule_w(home, [], trees, files)
    t += ["/**/" + n for n in IN_FOLDER_TREES]
    f += ["/**/" + n for n in IN_FOLDER_FILES]
    return any(covers(x, path) for x in t) or any(covers(x, path) for x in f)


def apply_grants(s, grants, home, secrets):
    """Adds `grants` ({"read": [...], "write": [...], "domains": [...]}) to the guest settings `s` (a dict, in place).

    `secrets` is the list of absolute secret folders (`secret_paths`). Returns the (kind, value) pairs that went in; the
    rest are dropped: not an absolute real path (a link on the way now leads elsewhere, so the grant is for something
    else), inside a secret or a denied place, inside rule W for a write, or a bad domain name."""
    fs = s["sandbox"]["filesystem"]
    perms = s.setdefault("permissions", {})
    deny = perms.setdefault("deny", [])
    allow = perms.setdefault("allow", [])
    add_dirs = perms.setdefault("additionalDirectories", [])
    # Named denies (other agents, other people, the owner's user.md) and the secrets stay on top of everything below. The
    # Kith folder and agents folder are denied whole with a way back in, so a grant inside them is judged by the named ones.
    whole = {p for r in ("KITH_HOME", "KITH_AGENTS") if os.environ.get(r) for p in both(os.path.abspath(os.environ[r]))}
    never_read = [d for d in fs.get("denyRead", []) if d != "/" and d not in whole] + list(secrets)
    never_write = list(fs.get("denyWrite", [])) + list(secrets)
    done = []

    def put(lst, x):
        if x not in lst:
            lst.append(x)

    def real(p):
        return p if isinstance(p, str) and os.path.isabs(p) and os.path.realpath(p) == p else None

    writes = {p for p in grants.get("write", []) if real(p)}
    for kind in ("read", "write"):
        for p in dict.fromkeys(grants.get(kind, [])):
            p = real(p)
            if not p or any(covers(d, p) for d in never_read):
                continue
            if kind == "write":
                if any(covers(d, p) for d in never_write):
                    continue
                if is_rule_w(home, p):
                    continue
                trees, files = rule_w(home, [p])
                for t in trees:
                    put(fs.setdefault("denyWrite", []), t)
                    if "**" in t:
                        put(fs["denyWrite"], t + "/**")
                for f in files:
                    put(fs.setdefault("denyWrite", []), f)
                for r in edit_rules(trees, files):
                    put(deny, r)
                put(fs.setdefault("allowWrite", []), p)
                put(allow, "Edit(/%s/**)" % p if os.path.isdir(p) else "Edit(/%s)" % p)
            elif p not in writes:
                # read only: the file tools may not write there, whatever the permission mode would allow
                put(deny, "Edit(/%s/**)" % p if os.path.isdir(p) else "Edit(/%s)" % p)
            put(fs.setdefault("allowRead", []), p)
            if os.path.isdir(p):
                put(add_dirs, p)
            else:
                put(allow, "Read(/%s)" % p)
            done.append((kind, p))
    for d in dict.fromkeys(grants.get("domains", [])):
        if valid_domain(d):
            put(s["sandbox"].setdefault("network", {}).setdefault("allowedDomains", []), d)
            done.append(("domain", d))
    return done
