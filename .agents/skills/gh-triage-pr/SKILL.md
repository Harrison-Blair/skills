---
name: gh-triage-pr
description: Triage GitHub pull request review feedback with the GitHub CLI, treating each unresolved inline review thread as a to-do item, then plan fixes, implement them after approval, run the project's tests, and optionally commit, push, reply, and resolve the threads. Use when a user asks to triage, address, respond to, or work through PR review comments, review threads, or reviewer feedback.
---

# Triage a GitHub PR

Address every unresolved inline review thread on a pull request: fetch them, plan fixes, implement after approval, verify with tests, then optionally push and resolve the threads.

1. Verify prerequisites. Confirm `gh` is installed and `gh auth status` reports an authenticated account, and that the current directory is inside a git repository. If any check fails, stop and tell the user exactly what is missing.
2. Identify the PR from the user's number or URL; otherwise resolve the current branch's PR with `gh pr view --json number,headRefName,url`. Ask for a number or URL only when resolution fails or is ambiguous. Resolve the repository with `gh repo view --json owner,name`.
3. Fetch the to-do list: unresolved inline review threads. Run:

   ```sh
   gh api graphql --paginate -f owner=<owner> -f name=<repo> -F number=<pr> -f query='
   query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
     repository(owner: $owner, name: $name) {
       pullRequest(number: $number) {
         reviewThreads(first: 100, after: $endCursor) {
           nodes {
             id isResolved isOutdated path line
             comments(first: 50) { nodes { author { login } body url databaseId } }
           }
           pageInfo { hasNextPage endCursor }
         } } } }'
   ```

   Keep only threads with `isResolved == false`. For each, record the thread `id`, `path`, `line`, whether it is outdated, the first comment's `databaseId` (needed for replies), and every comment's author and body. If there are no unresolved threads, say so and stop after reporting any context-only feedback from the next step.
4. Fetch context-only feedback with `gh pr view <pr> --json title,body,reviews,comments`: review summary bodies and issue-style conversation comments. Read them so the plan does not miss asks, but never treat them as resolvable items.
5. Build a plan with one item per unresolved thread: the thread URL, `path:line`, what the reviewer asked for, and the intended change. Fold in anything the context-only feedback adds. Mark any thread you propose not to change (already outdated, a question, or a request you would push back on) as **skip** with a reason. If your environment provides a built-in planning or plan-approval mode, present the plan through it; otherwise present the plan as text and wait for explicit user confirmation. Do not modify any file before the plan is approved, and apply any edits the user makes to the plan.
6. Implement the approved fixes, keeping each change scoped to what its thread asks for.
7. Run the test gate before summarizing or committing. Detect the project's test command from, in order: project instruction files (`CLAUDE.md`, `AGENTS.md`), `package.json` scripts, `Makefile` targets, `pyproject.toml`/pytest configuration, and CI workflows. Run the detected command and confirm the fixes did not break existing behavior. If tests fail, or no test command can be found, stop, report exactly what happened, and ask the user how to proceed; continue only if the user explicitly approves proceeding anyway.
8. Present a summary table mapping each thread to its outcome:

   | Thread | Requested | Change made |
   |---|---|---|
   | <thread URL> | <short ask> | <files touched and what changed, or "skipped: <reason>"> |

9. Ask the user to choose **Commit, push, reply, and resolve**, **Commit and push only**, or **Stop here**. Before acting, show the exact commit message, the push destination (remote and the PR's head branch from `headRefName`), and the list of threads that will receive a reply and be resolved. Do nothing without an explicit affirmative choice.
10. On approval, act in this order so replies can cite the pushed commit:
    1. Commit the fixes and push to the PR's head branch. If the push fails, stop and report; do not reply or resolve.
    2. For each addressed thread, reply with a short note such as `Fixed in <sha>.`:

       ```sh
       gh api repos/{owner}/{repo}/pulls/<pr>/comments/<first-comment-databaseId>/replies -f body='Fixed in <sha>.'
       ```

    3. Resolve each addressed thread:

       ```sh
       gh api graphql -f threadId=<thread-id> -f query='
       mutation($threadId: ID!) {
         resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } } }'
       ```

    Never resolve a thread whose fix was not implemented; for **skip** threads, offer to post an explanatory reply and leave them unresolved.
11. Report the final state: the pushed commit sha, threads replied to and resolved, and any threads left open with the reason.
