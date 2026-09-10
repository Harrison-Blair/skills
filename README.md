# skills

Portable agent skills for Claude Code, Codex, Cursor, OpenCode, and other harnesses.

Layout is flat: every top-level directory except `hooks/` is one skill containing a
`SKILL.md` with `name` and `description` frontmatter. Provider-only metadata lives in
sidecar files such as `agents/openai.yaml`. See `agnostic-skill` for conventions.

## Setup

Clone to the fixed path. Codex, Cursor, OpenCode, and Pi read it from here directly.

```sh
git clone https://github.com/Harrison-Blair/skills.git ~/.agents/skills
```

Link the skills for Claude Code and the tracked hook files for Cursor and Codex.
Each `ln` is guarded so it only runs when that harness is installed.

```sh
[ -d ~/.claude ] && ln -s ~/.agents/skills ~/.claude/skills; [ -d ~/.cursor ] && ln -s ~/.agents/skills/hooks/cursor.json ~/.cursor/hooks.json; [ -d ~/.codex ] && ln -s ~/.agents/skills/hooks/codex.json ~/.codex/hooks.json
```

If a harness already has a `hooks.json`, do not replace it. Paste the entry from the
matching file in `hooks/` into it instead, the same way as for Claude Code below.

Claude Code keeps hooks inside `~/.claude/settings.json`, so add the entry from
`hooks/claude.json` to its `hooks.SessionStart` array once by hand.

## Updating

Every hooked harness fast-forwards the clone at session start. Pulls fail silently
when offline or when the clone has local changes, so if a machine looks stale run
`git -C ~/.agents/skills status`. To publish an edit, commit and push from
`~/.agents/skills`.

## Windows

Clone to `$HOME\.agents\skills`. Directory links need a junction and file links need
Developer Mode or an elevated shell:

```powershell
New-Item -ItemType Junction -Path "$HOME\.claude\skills" -Target "$HOME\.agents\skills"
New-Item -ItemType SymbolicLink -Path "$HOME\.cursor\hooks.json" -Target "$HOME\.agents\skills\hooks\cursor.json"
New-Item -ItemType SymbolicLink -Path "$HOME\.codex\hooks.json" -Target "$HOME\.agents\skills\hooks\codex.json"
```

If `$HOME` does not expand in a hook command on Windows, replace it with the absolute path.
