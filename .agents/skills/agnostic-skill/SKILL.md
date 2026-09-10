---
name: agnostic-skill
description: Create or maintain one portable agent skill for multiple coding harnesses, with .agents/skills as the canonical source and provider references for compatibility and installation. Use for cross-harness skills; do not use for skills intentionally tied to one provider.
---

# Agnostic Skill

Maintain one editable skill source and adapt only its discovery and provider-specific features.

## Canonical source

- User scope: `~/.agents/skills/<skill-name>`
- Project scope: `<repository>/.agents/skills/<skill-name>`

Keep portable instructions in the canonical `SKILL.md`. Never maintain synchronized copies for different harnesses.

## Workflow

1. Decide whether the skill is user- or project-scoped and which harnesses must discover it.
2. Keep the canonical frontmatter and instructions compatible with every requested harness.
3. Read only the references for those harnesses:
   - For Codex, read [references/providers/codex.md](references/providers/codex.md).
   - For Claude Code, read [references/providers/claude.md](references/providers/claude.md).
   - For a provider without a reference, research its current official documentation and add a reference using the extension contract below before installing an adapter.
4. Put provider-only metadata or behavior in provider-specific auxiliary files when the harness supports that separation. Do not leak it into the portable core.
5. Validate the canonical skill, install only required discovery adapters, and test each harness in a fresh session when its reload behavior requires one.

## Directory symlinks

Create a per-skill directory symlink only when a harness cannot discover the canonical location directly.

- Resolve the canonical skill directory to an absolute target before linking. Do not use `~` or a relative link target.
- If the provider natively discovers the canonical directory, skip the link.
- If the destination is absent, create its parent directory if needed and then create the directory symlink.
- If the destination is already a symlink that resolves to the canonical directory, leave it unchanged.
- Treat a broken symlink, a symlink to another target, a regular file, and a real directory as conflicts. Preserve them and report the exact destination; never force-replace or merge them.
- Never replace the symlink with a copied mirror or introduce a synchronization workflow.

## Provider-reference contract

Add future providers, such as Cursor, under `references/providers/<provider>.md`. Each reference must state:

- user and project discovery locations;
- whether native discovery makes a symlink unnecessary;
- compatibility restrictions for `SKILL.md`;
- provider-only metadata or auxiliary files;
- initialization and validation procedures;
- cache or reload behavior and representative invocation checks; and
- conflict handling, including correct, missing, broken, wrong-target, and real-directory destination states.

Keep provider references concise, cite current official documentation, distinguish verified behavior from assumptions, and add their routing link above only after the reference exists.
