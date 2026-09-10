# skills

Portable agent skills, usable from Claude Code, Codex, and other harnesses.

- `.agents/skills/<name>/` is the canonical source for each skill.
- `.claude/skills/<name>` is a relative symlink so Claude Code discovers the same skill in this repository.

Each skill has a `SKILL.md` with `name` and `description` frontmatter. Provider-only metadata lives in sidecar files such as `agents/openai.yaml`. See `agnostic-skill` for the conventions.
