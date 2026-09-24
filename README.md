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

## Setup and updating

One line, on Linux, macOS, or Windows in Git Bash:

```sh
curl -fsSL https://raw.githubusercontent.com/Harrison-Blair/skills/main/scripts/setup.sh | sh
```

Run with no clone around it, the script clones the repo to `~/source/skills`
(set `SKILLS_HOME` for another path) and hands the rest of the run to that
copy, so the hook it installs names a path that keeps working. It refuses to
touch a directory that is already there and is not this repo.

To choose the location yourself, clone anywhere and run setup from it:

```sh
git clone https://github.com/Harrison-Blair/skills.git ~/source/skills
~/source/skills/scripts/setup.sh
```

On Windows the directory links are created as junctions, so no admin rights are
needed.

That run installs one `SessionStart` hook per harness, and the hook runs
`scripts/setup.sh --sync` from this clone at each session start. Sync does
everything setup does, so later changes -- new skills, an edited hook template
-- arrive on their own; setup is only needed again after moving or re-cloning
the repo. To sync by hand:

```sh
~/source/skills/scripts/setup.sh --sync
```

Both modes do the following, skipping any harness whose config directory is
absent:

- Fast-forwards the clone. If the pull moved `HEAD`, the script re-executes
  itself once so the rest of the run comes from the new copy rather than a
  half-read old one. A failed pull still links the current checkout and never
  fails a session.
- Links each `skills/<name>` into `~/.agents/skills/<name>`. Codex, Cursor, Pi,
  and OpenCode read that directory directly.
- Keeps `~/.claude/skills` as a real directory and links each shared skill into
  it from `~/.agents/skills`, including machine-local shared skills. Existing
  local folders are preserved. An older whole-directory link to
  `~/.agents/skills` is automatically replaced with individual links without
  changing the shared contents. Unrelated directory links are left untouched
  with a warning.
- Links the Pi extension into `~/.pi/agent/extensions/skills-autopull`.
- Writes a small wrapper into `~/.local/bin` for every command a skill ships in
  `skills/<name>/bin/`, so agents in any harness run it by its bare name (for
  example `mockup`). A file there that is not one of these wrappers, or a
  wrapper for another clone that still exists, is left alone with a warning;
  wrappers for commands removed from this clone are deleted. Setup warns when
  `~/.local/bin` is not on `PATH`.
- Merges one `SessionStart` hook into `~/.claude/settings.json` and
  `~/.codex/hooks.json`, next to whatever hooks are already there. The entries
  this repo manages are the ones running `scripts/setup.sh --sync`: the entry
  for this clone is rewritten in place when the template changes, an entry for
  a clone that no longer exists on disk is dropped, and an entry for a second
  clone that does exist is kept with a warning. Every other hook is left alone
  and the file is replaced atomically. The merge uses `python3`, `python`, or
  `powershell`; if none is found, the entry is printed for you to paste.
- Prunes the links it made for skills that are gone: broken symlinks on
  Linux/macOS, and on Windows junctions that point into this clone's `skills/`
  (or, in Claude's directory, into `~/.agents/skills`) at something no longer
  there. A junction pointing anywhere else is left alone, and removal is
  `rmdir` without `/S`, which unlinks the junction and never its target.

Setup reports each step; sync is quiet on stdout and prints only warnings. One
run happens at a time: each holds `.sync.lock` in the clone, a directory
reclaimed only once it is older than ten minutes. A sync that finds the lock
held exits straight away without doing anything, so it never delays a session;
a setup run waits a few seconds and then says so. Pulls are throttled with
`.sync-stamp` to about one a minute, so a burst of session starts fetches once.

Two manual steps remain:

- **Codex** does not run new hooks until you trust them. Open Codex and run
  `/hooks` to review the entry.
- **Cursor** has no file of its own here. Enable "Third-party skills" under
  Settings > Rules, Skills, Subagents and it will run the hook from
  `~/.claude/settings.json`.

## Uninstalling

```sh
~/source/skills/scripts/setup.sh --uninstall
```

This reverses what setup installed for that clone and prints each removal: the
skill links in `~/.agents/skills` that point into it, the links in
`~/.claude/skills` that point at those, the Pi extension link, the command
wrappers in `~/.local/bin` that run its skills' commands, and the hook
entries running that clone's `--sync`. It never removes a real directory, a
link pointing anywhere else, a hook this repo did not write, or an entry for a
different clone -- including a dead one, which belongs to whoever owns it. The
clone itself stays; delete it afterwards if you want it gone.

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

Add entries to `hooks/claude.json` or `hooks/codex.json` and push. Every machine
picks them up at its next session start, because sync re-merges the templates
and rewrites the entry it manages for that clone.

## Publishing edits

Commit and push from the clone. Other machines pick the change up at their next
session start.

## Testing setup changes

Install the CI-only parsers and reference validator, then run the checks locally:

```sh
python3 -m pip install -r requirements-ci.txt
python3 -B -m unittest discover -s tests -v
python3 scripts/validate_repo.py
shellcheck scripts/setup.sh
```

Tests use temporary fixtures and do not change your installed skills or hooks.
They cover setup, sync, hook merging, the post-pull re-exec, the sync lock,
bootstrap, uninstall, migration, conflicts, pruning, metadata, and Markdown
links. The Windows job runs the junction tests with Git for Windows Bash;
native Windows testing is required before a junction change -- pruning
included -- is considered verified.
