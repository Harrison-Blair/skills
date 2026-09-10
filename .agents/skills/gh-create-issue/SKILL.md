---
name: gh-create-issue
description: Draft and create a well-structured GitHub issue with the GitHub CLI, grounded in the repository's code, docs, and existing issues, in a Bug, Feature, Chore, Spike, or Custom format after batched guided questions. Use when a user asks to create, file, open, write, draft, or flesh out a GitHub issue, bug report, feature request, chore, or spike.
---

# Create a GitHub issue

Guide the user from a rough idea to a complete issue, ground every claim in the repository and its issue tracker, and create the issue only after the user approves the draft. Facts come from the environment; decisions come from the user.

## 1. Establish the request

1. Determine the issue type: `bug`, `feature`, `chore`, `spike`, or `custom`. Determine what the issue is broadly about in one or two sentences. Ask only for whatever the invocation did not already supply, in one short prompt. For `custom`, also ask for the section list (section names, or a pasted Markdown skeleton) before anything else.
2. Resolve the target repository with `gh repo view --json nameWithOwner,url`. Honour a user-supplied `--repo OWNER/REPO` or repository URL. If `gh auth status` fails or no repository resolves, stop and report exactly what is missing; do not guess a repository.
3. Load the format reference for the chosen type:
   - [references/formats/bug.md](references/formats/bug.md)
   - [references/formats/feature.md](references/formats/feature.md)
   - [references/formats/chore.md](references/formats/chore.md)
   - [references/formats/spike.md](references/formats/spike.md)
   - [references/formats/custom.md](references/formats/custom.md)

## 2. Ground the issue

Gather context before asking the user anything else, so the guided questions arrive pre-answered.

**Repository search.** If the harness can delegate work, run the repository search in one or more cheap, fast, read-only subagents, launched in parallel when their targets are independent; otherwise search directly. Derive keywords from the broad description. Search, in this order of value:

- agent-guidance and project files (`AGENTS.md`, `CLAUDE.md`, `README*`, `CONTRIBUTING*`);
- documentation under `docs/` and similar;
- code, tests, and configuration matching the keywords, including the call path behind the user flow the description names;
- `CHANGELOG*` and recent history for the same area;
- `.github/ISSUE_TEMPLATE/` (Markdown templates and YAML issue forms) and `.github/ISSUE_TEMPLATE.md`.

Report findings as `path:line` pointers with short quotes and one-line relevance notes. Never paste whole files into the conversation or the issue.

**Issue search.** Run `gh issue list --repo OWNER/REPO --search "<keywords>" --state all --limit 15 --json number,title,state,url,labels,updatedAt`, then read the most relevant hits (up to five) in full with `gh issue view <number> --repo OWNER/REPO`. Keep, for each relevant issue, its number, title, state, and a one-line note on how it relates.

**Labels.** Run `gh label list --repo OWNER/REPO --limit 100 --json name` so the draft can carry a type label that actually exists.

**Duplicate check.** If any issue found describes the same problem or request, pause before the guided questions. Show each likely duplicate as `#<number> "<title>" (<state>, <last updated>)` with its relevance note and ask whether to continue with a new issue or stop so the user can comment on or reopen the existing one. Never comment on, reopen, or edit an existing issue from this skill.

**Repository templates.** If the repository ships issue templates, ask the user once whether to structure the issue with a matching repository template or with this skill's format. When a repository template is chosen, its headings (or form fields) become the sections, in the template's order; the rest of this workflow applies unchanged.

## 3. Ask guided questions

Ask in batches, one batch per message, in the order the format reference defines. Each batch lists its sections and, for every section, a proposed answer drafted from the grounding findings and earlier answers. The user accepts, edits, or replaces each proposal. Ask a follow-up only when an answer is too vague to write its section. When a repository template or a `custom` section list is in use, batch its sections in groups of up to three in their given order.

The final batch is confirm-only: it shows the grounded sections (`Possible cause`, `Affected areas`, `Starting points`, `Related issues`, as the format defines) with their findings and asks the user to confirm, trim, or drop them. A grounded section with no findings is omitted from the draft, never left as an empty heading.

Write plainly. No emoji, no decorative formatting.

## 4. Draft the issue

- **Title**: one line, outcome-focused, under about 70 characters, prefixed with the bracketed type: `[Bug]`, `[Feature]`, `[Chore]`, `[Spike]`. A `custom` issue has no prefix.
- **Body**: the format's sections in order, level-two headings, filled from the confirmed answers. Omit grounded sections that have no findings. Reference code as `path:line`. Link related issues as `#<number>`.
- **Label**: the first label from the format's label candidates that exists in the repository (case-insensitive exact match); none for `custom` or when no candidate exists.
- **Footer**: end the body with one italic line, `*Generated by <harness> (<exact-model-id>) on YYYY-MM-DD at HH:MM UTC±HH:MM.*`, using the harness name, the exact active model identifier resolved from runtime or system metadata (never inferred, shortened, or substituted; use `model identifier unavailable` when it cannot be resolved), and the local date and 24-hour time with its numeric UTC offset.

Present the title, the label (or "no label"), and the full body verbatim, then ask for approval.

- Approved: continue to step 5.
- Feedback or directions: apply them, re-present the full draft, and ask again. Repeat until approved or the user stops.

Never create the issue without an explicit approval of the draft shown. There is no shortcut argument that skips this gate.

## 5. Create the issue

Write the approved body to a temporary file and run:

```sh
gh issue create --repo OWNER/REPO --title "<title>" --body-file <file> [--label "<label>"]
```

Report the issue URL, the title, and the label applied. If creation fails, report the failure verbatim without claiming success, and offer the approved body so nothing is lost. Add no assignee, milestone, or project unless the user asks.
