---
name: gh-summarize-pr
description: Investigate a GitHub pull request with the GitHub CLI, summarize its changes in a concise PR-body format, and draft or apply a one-line title and body. Use when a user asks to inspect, explain, summarize, retitle, draft, or update a pull request.
---

# Summarize a GitHub PR

1. Identify the PR from the user's number or URL. If outside its repository, pass `--repo OWNER/REPO` or use the URL. If the user omits the PR, resolve the pull request for the current branch with `gh pr view`; ask for a number or URL only when resolution fails or is ambiguous.
2. Choose the interaction mode before drafting:
   - For a clearly read-only request such as explain, summarize, or draft only, produce the draft without asking about approval and never update GitHub.
   - Treat a standalone affirmative `approve` argument as explicit authorization to update the resolved PR's title and body after drafting, without another confirmation.
   - When the user explicitly invokes the skill without a read-only intent, or asks to update without choosing a review mode, ask whether they want to review the draft before it is applied or have it applied automatically. Ask before drafting. In review mode, show the draft and wait for approval; in automatic mode, apply it without another confirmation.
   - If `approve` conflicts with a read-only instruction, ask the user to clarify and do not update GitHub.
3. Run `gh pr view <PR> --json number,title,body,url,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,changedFiles,commits,files`. Capture the full head and base commit SHAs as the snapshot being summarized. Select the review range using the existing footer as described below before reading the patch.
4. Base new or revised claims on the selected diff, using commit messages only as supporting context. Carry forward relevant existing information, checking affected claims against the new changes; do not infer behavior that the changes do not establish.
5. Draft a single-line PR title that summarizes the overall major effort. Prefer the outcome over a list of files or minor changes.
6. Inspect the repository's instructions, manifests, and CI configuration when available so verification suggestions use the project's real commands and practices.
7. Update the body to describe the whole PR at the captured head. Incorporate new changes and revise or remove statements made stale by reversals, replacements, or changed scope. Preserve relevant existing rationale, issue links, user-authored context, and verification evidence. Respect existing headings and repository templates; revise affected sections in place instead of replacing the body wholesale. Use the fallback below for an empty or placeholder-only body or an existing summary in this format.

## Select the review range

- Read the `Reviewed commit` and `Base commit` SHAs from the existing summary footer. Treat them as a reusable checkpoint only when they are full commit SHAs, resolve to available commits, the reviewed commit is an ancestor of the captured PR head, the recorded base matches the captured PR base, and the body contains a usable prior summary. Validate ancestry with `git merge-base --is-ancestor <reviewed-sha> <head-sha>` or an equivalent repository API check; do not trust a footer alone.
- With a valid checkpoint, inspect `git diff <reviewed-sha> <head-sha>` (the endpoint diff) or an equivalent complete comparison. Focus review on those new changes and reuse still-relevant prior context; inspect older code or diffs only as needed to resolve affected or uncertain claims. If the head is unchanged, there is no new diff to review.
- Without a usable checkpoint, or after a rebase, force-push that breaks ancestry, or base change, review the full PR diff from the captured base/head merge base to the captured head, for example `git diff <base-sha>...<head-sha>`. Fetch missing commits without changing the user's working tree when needed. Explain briefly why a full review was necessary. Do not advance the checkpoint if the required diff cannot be obtained and reviewed completely.
- Keep the title, body, and LOC table cumulative for the entire PR. Recompute LOC from the full PR diff at the captured snapshot even during an incremental review; do not add incremental counts to old totals, since edits and reversions can overlap.

## Fallback body

````markdown
## Summary

<concise, outcome-focused overview>

## Changes

- <cohesive behavior or implementation change>
- <feature added>
- <other material change>

## LOC by module

| Module | Source (+ / -) | Tests (+ / -) | Docs (+ / -) | Total (+ / -) | Net |
| --- | ---: | ---: | ---: | ---: | ---: |
| <module> | +40 / -10 | +20 / -5 | +8 / -2 | +68 / -17 | +51 |
| **Total** | **+40 / -10** | **+20 / -5** | **+8 / -2** | **+68 / -17** | **+51** |

*LOC counts are added and deleted text lines in the PR diff, including blank lines and comments.*

## Verification

- [ ] `<project-specific automated test command>`
- [ ] `<relevant manual verification method>`

*Generated by <Harness> (<Model>) on YYYY-MM-DD at HH:MM UTC±HH:MM. Reviewed commit: `<full-head-sha>`. Base commit: `<full-base-sha>`.*
````

Follow this output contract:

- For the fallback body, use the level-two headings exactly as shown and in the same order.
- Write `Summary` as a short paragraph describing the PR's overall outcome.
- Write `Changes` as a flat bulleted list of material changes and features established by the diff. Group related edits, avoid path-by-path narration, and omit unsupported claims.
- Replace file listings and file-by-file descriptions with the `LOC by module` table. Report diff line counts, not total file sizes or language-aware executable LOC; retain the counting note shown above.
- Derive module boundaries from repository instructions, workspace manifests, and package or component structure. Group related source, tests, and docs under the same owning module even when they live in separate top-level directories. Use a consistent module level, with `Shared` for cross-module content and `Root` for repository-wide content; if no module boundaries exist, use `Root`. Briefly explain any non-obvious grouping assumption.
- Assign each changed text file to exactly one category using repository conventions and purpose: `Source` for implementation code, `Tests` for tests and their dedicated fixtures, snapshots, and helpers, and `Docs` for documentation. Test fixtures take precedence over their file extension. If files such as build configuration, lockfiles, or generated assets do not fit those categories, add an `Other (+ / -)` column before `Total` and briefly state what it includes; do not silently drop them or inflate source counts.
- Use per-file additions and deletions from the PR metadata or a complete machine-readable diff statistic. If local Git is needed, compare the PR base/head merge base to the PR head, not the working tree or the base tip. Check that the file data is complete, fetching all pages when necessary, and reconcile the sums with the PR's additions and deletions. Do not estimate counts from truncated patches; disclose unavailable counts or unresolved discrepancies instead of presenting partial totals as complete.
- Attribute renames once to the destination module and category, counting only reported line changes; use the old path for deletions. Pure renames and mode-only changes contribute zero lines. Exclude binary content from LOC and note binary changes by module without listing files; never equate unavailable text statistics with zero.
- Sort module rows lexicographically and end with a bold `Total` row. Show `+0 / -0` for empty categories, include modules with zero-line changes, sum every category into each row's `Total`, and calculate `Net` as additions minus deletions. Sum each column across modules for the final row. If there are no changed files, state `No changed files.` instead of rendering an empty table.
- Write `Verification` as an unchecked task list using `- [ ]` for every item. Suggest relevant automated commands and manual checks from project instructions, manifests, CI configuration, and affected behavior. Do not mark an item complete or claim that a suggested check was executed.
- Italicize the entire generation footer. Resolve the exact active model identifier from runtime or system metadata; never infer, shorten, or substitute a model family. Use `model identifier unavailable` rather than guessing when the exact identifier is unavailable. For a `gpt-5.6-sol` run, use `gpt-5.6-sol` exactly.
- Include the full captured PR head SHA as `Reviewed commit` and the full captured PR base SHA as `Base commit` in the footer, including when using an existing body template. Replace the previous generation footer rather than accumulating checkpoints. Record only the snapshot actually reviewed, never the local checkout's HEAD or an unreviewed newer commit. These fields mark summary coverage, not approval of the code or successful test execution.
- Use the local system date and 24-hour time with its numeric UTC offset.

Treat the task as read-only unless the user authorizes an update through `approve`, chooses automatic application, or approves a reviewed draft. Authorization covers only the resolved PR's proposed title and body. Before applying, re-read the PR head, base, title, and body. If they changed during drafting, reconcile the new content and review any newly required diff before updating the footer; obtain renewed approval for a revised draft only when the user chose review mode. If the PR keeps changing, leave the latest draft for review rather than repeatedly overwriting it. Apply an authorized update with `gh pr edit <PR> --title "<title>" --body-file <file>`. After success, report the PR URL, applied title, and that the body was updated. If the edit fails, report the failure without claiming success or silently changing the target.
