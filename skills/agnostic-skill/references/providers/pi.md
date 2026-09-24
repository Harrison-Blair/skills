# Pi

Use this reference only when Pi must discover or invoke the canonical skill. The source of truth is Pi's skills documentation, shipped with the installed package at `docs/skills.md` (checked against pi 0.84.4), and the [Agent Skills specification](https://agentskills.io/specification) it implements.

## Discovery and installation

Pi natively discovers (verified in `docs/skills.md`):

- user skills at `~/.agents/skills/` and `~/.pi/agent/skills/`;
- project skills at `.agents/skills/` in the current directory and each ancestor up to the repository root, and at `.pi/skills/`, but only after the project is trusted;
- skills listed in a `skills` array in `settings.json`, from packages, or passed with `--skill <path>`.

Directories containing `SKILL.md` are found recursively in every location. The canonical user and project locations are already Pi's native layout, so no symlink is needed. Do not add a `~/.pi/agent/skills/<skill-name>` link: a second copy of the same `name` is a collision.

## Portable core

Pi reads the shared `name` and `description` frontmatter. It is lenient: names that break the specification's rules (over 64 characters, invalid characters, leading, trailing or doubled hyphens) and descriptions over 1024 characters load with a warning. A `SKILL.md` with no description, or malformed frontmatter, is not loaded. Unknown frontmatter fields are ignored. Unlike the specification, Pi does not require `name` to match the directory; keep them matching anyway, for the other harnesses.

## Pi-only metadata

`disable-model-invocation: true` hides a skill from the system prompt so that only `/skill:<name>` loads it. Leave it out of portable skills unless explicitly requested. Behavior that Pi cannot reach through a skill, such as reacting to outside events, belongs in a Pi extension (`~/.pi/agent/extensions/`), not in `SKILL.md`.

## Validation and reload

Pi scans skills at startup and when the user runs `/reload`, which also reloads extensions (README, commands table). Skills register as `/skill:<name>` commands when skill commands are enabled.

Representative checks, in a fresh session or after `/reload`:

1. The skill appears once in the startup skill list, with no warning for it.
2. `/skill:<name>` loads it.
3. A request matching its description makes the agent read `SKILL.md` (models do not always do this; `/skill:<name>` forces it).

## Conflicts

Pi warns on a name collision and keeps the first skill found, so a stale copy can silently win. Before installing, search every discovery location above for the same frontmatter `name`, and report the paths of any duplicates rather than removing them. The canonical directory-symlink rules apply only if an unusual setup needs an adapter link: preserve broken, wrong-target and real-directory destinations and report them.
