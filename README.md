# skills

Portable agent skills plus the session-start hooks that keep them updated, for
Claude Code, Codex, Cursor, Pi, and OpenCode. One clone per machine is the single
source of truth; everything else is a link into it or a hook entry that pulls it.

## Layout

```
skills/<name>/SKILL.md   one skill per directory (see skills/agnostic-skill for conventions)
hooks/claude.json        SessionStart entry merged into ~/.claude/settings.json
hooks/codex.json         SessionStart entry merged into ~/.codex/hooks.json
pi/skills-autopull/      Pi extension, linked into ~/.pi/agent/extensions
scripts/setup.sh         one-time setup, and the --sync command the hooks run
```

## Setup

Clone anywhere, then run setup once. Linux and macOS:

```sh
git clone https://github.com/Harrison-Blair/skills.git ~/source/skills
~/source/skills/scripts/setup.sh
```

Windows: run the same two commands in Git Bash. Directory links are created as
junctions, so no admin rights are needed.

Setup does the following, skipping any harness whose config directory is absent:

- Links each `skills/<name>` into `~/.agents/skills/<name>`. Codex, Cursor, Pi,
  and OpenCode read that directory directly.
- Links `~/.claude/skills` to `~/.agents/skills` for Claude Code. If
  `~/.claude/skills` is already a real directory, setup leaves it alone and tells
  you to move its contents into `~/.agents/skills` first.
- Links the Pi extension into `~/.pi/agent/extensions/skills-autopull`.
- Merges one `SessionStart` hook into `~/.claude/settings.json` and
  `~/.codex/hooks.json`, next to whatever hooks are already there. The hook runs
  `scripts/setup.sh --sync` from this clone. The merge uses `python3`, `python`, or `powershell`;
  if none is found, setup prints the entry for you to paste.

Two manual steps remain:

- **Codex** does not run new hooks until you trust them. Open Codex and run
  `/hooks` to review the entry.
- **Cursor** has no file of its own here. Enable "Third-party skills" under
  Settings > Rules, Skills, Subagents and it will run the hook from
  `~/.claude/settings.json`.

## Updating

Every session start runs `scripts/setup.sh --sync`, which fast-forwards the clone
and re-links any skill that was added or removed. It is silent and never fails a
session. To update by hand:

```sh
~/source/skills/scripts/setup.sh --sync
```

## Machine-local skills

Put a plain directory in `~/.agents/skills/`. Setup and sync never touch anything
there that is not a link into this repo.

## Adding hooks later

Add entries to `hooks/claude.json` or `hooks/codex.json`, push, then re-run
`scripts/setup.sh` on each machine. Entries are matched by command string, so
re-running is safe.

## Publishing edits

Commit and push from the clone. Other machines pick the change up at their next
session start.
