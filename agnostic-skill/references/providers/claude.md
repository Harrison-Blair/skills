# Claude Code

Use this reference only when Claude Code must discover, validate, or invoke the canonical skill. The source of truth is the current [official skills documentation](https://code.claude.com/docs/en/skills.md).

## Discovery and installation

Claude Code natively discovers:

- personal skills at `~/.claude/skills/<skill-name>/SKILL.md`;
- project skills at `.claude/skills/<skill-name>/SKILL.md`, including parent directories up to the repository root and nested directories as files there are touched;
- plugin skills inside enabled plugins; and
- enterprise skills in the managed settings directory.

Claude Code does **not** discover `.agents/skills` (tracked in [issue #31005](https://github.com/anthropics/claude-code/issues/31005)), so each canonical skill needs a per-skill directory symlink:

- user scope: `~/.claude/skills/<skill-name>` → absolute canonical path;
- project scope: `.claude/skills/<skill-name>` → absolute canonical path.

Follow the canonical directory-symlink rules: absolute targets, preserve and report any conflicting destination, never copy or synchronize. Before installing, check personal, project, and plugin scopes for a duplicate frontmatter `name`; same-named skills are separate entries, and clashes get directory-qualified names.

Symlink caveats:

- Per-skill directory symlinks are documented and verified working on Claude Code 2.1.238; the documentation also states a target reachable from more than one location loads only once.
- Do not symlink the `~/.claude/skills` directory itself; user reports say skills then fail to load ([#38051](https://github.com/anthropics/claude-code/issues/38051)).
- User reports say auto-updates have removed per-skill symlinks from `~/.claude/skills` ([#50052](https://github.com/anthropics/claude-code/issues/50052)); after a Claude Code update, re-check that the links still exist (unverified here, but cheap to guard against).

## Portable core

The shared minimal frontmatter (`name`, `description`) and a standard-Markdown body with relative links are fully compatible. Claude Code silently ignores unknown frontmatter fields, so the Codex-only `agents/openai.yaml` file and any future provider sidecars are harmless.

Keep the `description` well under Claude's 1,536-character listing cap and front-load trigger keywords: Claude loads only `name` + `description` at session start and uses them for implicit selection, truncating long descriptions when the listing budget overflows.

Exclude from the portable core every Claude-only feature, because other harnesses render it as literal text or reject it:

- frontmatter extensions: `allowed-tools`, `disallowed-tools`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `arguments`, `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `shell`, `when_to_use`;
- body substitutions: `$ARGUMENTS`, `$1`-style positional and named arguments, `${CLAUDE_SESSION_ID}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}`, and other `${CLAUDE_*}` variables;
- `` !`command` `` shell preprocessing (inline or block), which executes commands before the model reads the skill.

## Claude-only metadata

Claude Code has no provider metadata sidecar equivalent to `agents/openai.yaml`; its extensions live only in `SKILL.md` frontmatter and body, which the portable core shares. Therefore a cross-harness skill must simply forgo Claude-only invocation features. Claude-specific *instructions* may live in an auxiliary file such as `references/providers/claude.md` (this file) that the body links to conditionally; other harnesses ignore unreferenced content.

## Initialization and validation

There is no bundled validator equivalent to Codex's `quick_validate.py`. Validate manually:

- frontmatter is valid YAML with `name` matching the directory name (lowercase letters, digits, hyphens) and a concise, discriminating `description`;
- every relative Markdown link resolves; and
- no Claude-only syntax from the list above appears in the portable core.

`/skill-doctor` and `claude plugin eval` exist as early-access tooling for skill listing cost and eval runs; use them only where enabled.

## Reload and checks

Skill descriptions load at session start; Claude Code also watches existing skill directories, so edits to `SKILL.md` and a new skill added under an already-watched directory are picked up live. If the top-level skills directory did not exist when the session started, restart Claude Code. Prefer a fresh session for the acceptance checks.

In a fresh Claude Code session:

1. Confirm the skill appears exactly once in the available-skills listing (type `/` and look for `/<skill-name>`).
2. Invoke it explicitly as `/<skill-name>` with a representative request. Claude uses `/`, not Codex's `$` prefix.
3. Submit a matching request without naming it and confirm the description supports appropriate implicit selection.
