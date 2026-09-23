---
name: where-was-i
description: Catch the user up on the current thread after time away - the goal, what is done, what was in progress, decisions, open questions, the next step, and where the work lives - checked against the current repository state. Use when the user explicitly invokes where-was-i or asks "where was I?", "what were we doing?", "catch me up", or similar in an ongoing thread. Read-only.
---

Give the user a short recap of this thread so they can pick the work back up. Change nothing: no edits, commits, task updates, or restarted processes.

## Gather

1. Reread the conversation. If earlier turns survive only as a compacted summary, note that details from that stretch may be missing.
2. Check the current state, without mutating it:
   - `git status`, the current branch, `git worktree list`, and recent commits since the thread's work began;
   - open tasks or to-do lists, if the harness tracks them;
   - background commands, servers, or subagents the thread started, and whether they are still running.
   Skip checks that do not apply, such as git outside a repository, and say which were skipped.
3. Compare the conversation with the current state. Flag each mismatch, such as work reported as finished that has uncommitted edits since, a branch that moved, or a server that is no longer running. When the conversation is thin, fill gaps from repository evidence such as commit messages and notes files, and cite it.

## Report

Write plain terminal text that fits on about one screen. Use these sections in order, a few short bullets each, and omit any section with nothing to say:

- **Goal**: what the thread is trying to achieve and why.
- **Done**: finished work, each with its evidence (commit, passing test, file).
- **In progress**: what was happening when the thread went quiet, and how far it got.
- **Decisions**: what was settled and the reason, so it is not reopened.
- **Open**: unanswered questions, blockers, known bugs, and mismatches found in step 3.
- **Where**: branch, worktree, key files as clickable `path:line` references, running servers or processes.
- **Next step**: the single most sensible next action, stated as a suggestion.

Distinguish verified facts from what the conversation merely claimed. End after the next-step suggestion and wait for the user to choose.
