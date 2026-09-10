# skills

Portable agent skills for Claude Code, Codex, OpenCode, and other harnesses.

Layout is flat: every top-level directory is one skill containing a `SKILL.md`
with `name` and `description` frontmatter. Provider-only metadata lives in
sidecar files such as `agents/openai.yaml`. See `agnostic-skill` for conventions.

## Install

Clone this repository to `~/.agents/skills`, then link it for Claude Code:

```sh
ln -s ~/.agents/skills ~/.claude/skills
```

On Windows use a junction: `New-Item -ItemType Junction -Path "$HOME\.claude\skills" -Target "$HOME\.agents\skills"`.

Codex and OpenCode read `~/.agents/skills` directly. Pull to update; push edits manually.
