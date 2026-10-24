"""What a run for anyone but the owner may not touch: the secrets and the run-later paths (rule W).

One list, read by both layers `kernel/bin/kith` writes for such a run: the OS sandbox around Bash (denyRead / denyWrite)
and the permission rules of the file tools (Read / Edit deny rules, which beat any allow). Keep `serve/host/src/cards/
resource.rs` SENSITIVE in step with SECRET_RULES.

Rule W (designs/2026-10-24-cards-plan.md, plan 2): a run that is not the owner's never writes a file that something
outside the sandbox later runs, loads as settings, or loads as instructions. Everything here is by real path and, where
a link is involved, by both spellings.
"""
import os

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
