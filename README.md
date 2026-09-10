# skills

Portable agent skills for Claude Code, Codex, Cursor, OpenCode, and other harnesses.

Layout is flat: every top-level directory is one skill containing a `SKILL.md` with
`name` and `description` frontmatter. Provider-only metadata lives in sidecar files
such as `agents/openai.yaml`. See `agnostic-skill` for conventions.

## Setup

Clone to the fixed path. Codex, Cursor, OpenCode, and Pi read it from here directly.

```sh
git clone https://github.com/Harrison-Blair/skills.git ~/.agents/skills
```

Claude Code only reads `~/.claude/skills`, so link it:

```sh
ln -s ~/.agents/skills ~/.claude/skills
```

On Windows use a junction:

```powershell
New-Item -ItemType Junction -Path "$HOME\.claude\skills" -Target "$HOME\.agents\skills"
```

## Updating

```sh
git -C ~/.agents/skills pull
```

To publish an edit, commit and push from `~/.agents/skills`.
