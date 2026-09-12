# skills

Portable agent skills plus the session-start hooks that keep them updated, for
Claude Code, Codex, Cursor, Pi, and OpenCode. One clone per machine is the source
of truth for synced skills. Machine-local skills can live alongside its links.

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
- Keeps `~/.claude/skills` as a real directory and links each shared skill into
  it from `~/.agents/skills`, including machine-local shared skills. Existing
  local folders are preserved. An older whole-directory link to
  `~/.agents/skills` is automatically replaced with individual links without
  changing the shared contents. Unrelated directory links are left untouched
  with a warning.
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

The installed session-start hooks run `scripts/setup.sh --sync`, which attempts
to fast-forward the clone and reconciles individual skill links in both
`~/.agents/skills` and `~/.claude/skills`. Sync also migrates the older Claude
whole-directory link. Normal output is suppressed; conflicts produce warnings,
and a failed pull does not prevent linking the current checkout or fail a session.
On Linux/macOS, broken links matching this setup's managed targets are pruned.
On Windows, remove stale junctions manually. To update by hand:

```sh
~/source/skills/scripts/setup.sh --sync
```

## Machine-local skills

Choose the location based on what you want to share. Each skill is a directory
containing `SKILL.md`.

| Purpose | Location | Synced by this repo? |
| --- | --- | --- |
| Shared collection across machines | `skills/<name>/` in this clone | Yes, after commit and push |
| Shared across harnesses on this machine | `~/.agents/skills/<name>/` as a plain directory | No |
| Local extras for Claude Code | `~/.claude/skills/<name>/` as a plain directory | No |
| Local extras for Codex | `~/.codex/skills/<name>/` | No |
| Local extras for Cursor | `~/.cursor/skills/<name>/` | No |
| Local extras for Pi | `~/.pi/agent/skills/<name>/` | No |
| Local extras for OpenCode | `~/.config/opencode/skills/<name>/` | No |

Setup and sync preserve ordinary local folders and unrelated links. If a shared
skill's name conflicts with an existing local entry, they warn and skip that
link; they do not overwrite the local entry. Use distinct names to keep both.
Shared machine-local skills added to `~/.agents/skills` become linked into
Claude's directory on the next setup or sync.

These locations separate storage, not visibility: [Cursor also discovers
Claude and Codex skills](https://cursor.com/docs/skills), and [OpenCode also
discovers Claude skills](https://opencode.ai/docs/skills/). This setup leaves
those compatibility behaviors unchanged.

Sync only pulls repo changes; it never imports installed skills, commits, or
pushes local edits. Editing a linked repo skill changes the file in this clone,
so commit and push it to distribute the edit. To share a standalone local skill
between machines, move its contents into `skills/<name>/` in the clone, remove
the old local entry so setup can create its link, then commit and push.

## Adding hooks later

Add entries to `hooks/claude.json` or `hooks/codex.json`, push, then re-run
`scripts/setup.sh` on each machine. Entries are matched by command string, so
re-running is safe.

## Publishing edits

Commit and push from the clone. Other machines pick the change up at their next
session start.

## Testing setup changes

Run `python3 -B -m unittest discover -s tests -v` on Linux/macOS. Tests use
temporary fixtures and do not change your installed skills or hooks. They cover
setup, sync, migration, conflicts, and pruning. Windows command boundaries are
simulated; native junction migration still needs a smoke test in Windows Git Bash.
