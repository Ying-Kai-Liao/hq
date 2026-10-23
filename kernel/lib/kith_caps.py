#!/usr/bin/env python3
"""What an agent's normal work needs in Claude Code's dontAsk mode, as permissions.allow rules.

In dontAsk mode every tool call not matched by an allow rule is refused without a prompt. The role says what its work
needs in capabilities.yaml (`tools:`); this table turns the tags into narrow allow rules. bin/kith uses it for the
owner's runs only: an invitee gets the rules for their own part of the folder, not the owner's tools.

  tag         allows
  artifacts   Artifact, ArtifactComments (publishing a page, reading comments on it)
  browser     headless Chrome from the usual app path (`<Chrome> --headless...`); `infographic` and `anatomy` mean the same
  render      python3, node, `uv run`, bash and sh scripts, and programs, that live inside the agent's own folder
              (every spelling of it)

Unknown tags are ignored. Claude Code only: the Codex harness has no allow rules.

  kith_caps.py allow ROLE_DIR AGENT_DIR...   print the tool rules, one per line (AGENT_DIR: each spelling of the folder)
  kith_caps.py own AGENT_DIR...              print the Read/Edit rules for the agent's own folder
  kith_caps.py unknown ROLE_DIR              print the tags in tools: this table does not know
"""
import os, re, sys

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ALIASES = {"infographic": "browser", "anatomy": "browser"}
KNOWN = {"artifacts", "browser", "render"}


def tags(role_dir):
    """The first word of each entry of `tools:` in capabilities.yaml (inline or block list, comments dropped)."""
    try:
        lines = open(os.path.join(role_dir, "capabilities.yaml")).read().splitlines()
    except OSError:
        return []
    out = []
    for i, line in enumerate(lines):
        m = re.match(r"tools:\s*(.*)$", line)
        if not m:
            continue
        rest = re.sub(r"\s+#.*$", "", m.group(1)).strip()
        if rest.startswith("["):
            items = re.sub(r"\([^)]*\)", "", rest.strip("[]")).split(",")
        else:
            items = []
            for nxt in lines[i + 1:]:
                if re.match(r"\s*#", nxt) or not nxt.strip():
                    continue
                m2 = re.match(r"\s+-\s+(.*)$", nxt)
                if not m2:
                    break
                items.append(re.sub(r"\s+#.*$", "", m2.group(1)))
        out += [x.split()[0] for x in (y.strip() for y in items) if x]
    return list(dict.fromkeys(ALIASES.get(t, t) for t in out))


def own(dirs):
    return ["%s(/%s/**)" % (tool, d) for d in dirs for tool in ("Read", "Edit")]   # Edit covers every file-writing tool


def allow(role_dir, dirs):
    t = tags(role_dir)
    rules = []
    if "artifacts" in t:
        rules += ["Artifact", "ArtifactComments"]
    if "browser" in t:
        rules += ["Bash(%s --headless*)" % CHROME, 'Bash("%s" --headless*)' % CHROME]
    if "render" in t:
        for d in dirs:
            for prog in ("python3", "node", "uv run", "bash", "sh"):
                rules.append("Bash(%s %s/*)" % (prog, d))
                if " " in d:   # a path with a space is typed quoted
                    rules.append('Bash(%s "%s/*)' % (prog, d))
            rules.append("Bash(%s/*)" % d)
            if " " in d:
                rules.append('Bash("%s/*)' % d)
    return list(dict.fromkeys(rules))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "allow":
        print("\n".join(allow(sys.argv[2], sys.argv[3:])))
    elif cmd == "own":
        print("\n".join(own(sys.argv[2:])))
    elif cmd == "unknown":
        print("\n".join(t for t in tags(sys.argv[2]) if t not in KNOWN))
    else:
        sys.exit(__doc__)
