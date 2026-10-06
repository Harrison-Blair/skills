---
name: orchestrate
description: Use only when the user explicitly invokes it. Coordinate the session's work - make small, clear edits directly, plan larger work with the user through interrogate, delegate implementation, and verify it independently, planning the next wave while earlier work runs.
---

# Orchestrate

From invocation until the user explicitly releases the mode (for example "exit orchestrator mode"), coordinate the work and act as the user's interface to sub-agents. Keep this mode active across tasks, including small ones. Workers follow their bounded briefs; they do not inherit the coordinating role.

## Direct work

Read files, search, run commands, and reason from the results yourself. Use sub-agents to gather context when that helps, such as in a large codebase or for outside research.

Make a change directly when it is small, its intent is clear, and it needs no design decision. Roughly 100 lines in total is a guide, not a limit. Run the relevant checks yourself and report; no separate verifier is needed. Never edit files a worker currently owns. Delegate everything else through planning.

## Planning

Plan each wave of delegated work with the user before any worker starts:

1. Gather context and look for gaps, edge cases, and ambiguities in the request.
2. Load [interrogate](../interrogate/SKILL.md) and settle the design decisions with the user through it.
3. Offer live experiments for untested ideas and anything vague or ambiguous that an agent could test. State what each should show, and run it with any suitable agent only after the user agrees. Keep it isolated (a scratch directory or separate worktree) or undo it afterward, and use the results in the next questions.
4. Write the trust boundaries into the spec. For each place the code takes input it does not control (a file path, a process id, a network peer, an environment variable, a user string), state who can be on the other side, the worst outcome, and what is out of scope. Link [untrusted inputs](references/untrusted-inputs.md) from every brief whose code reads such input. Name one function for each risky concern (one bounded file reader, one request helper that always settles) and add a search of the code for other call sites as an acceptance criterion.
5. Before sign-off, have a fresh agent review the draft spec for gaps and edge cases. Do the same for every contract or brief sent to workers, not only the plan. Bring new gaps to the user as another round.
6. Get the user's confirmation of the spec: goal, scope, testable acceptance criteria, and the threat model. Verifier probes come from the threat model; a finding outside it is a note.

## Implementation and verification

An implementer carries out the confirmed spec and runs its own relevant checks, including the untrusted-input cases the brief links. A separate verifier, which does not implement, then checks the current result against the acceptance criteria and the threat model. When a large integration gets its first review, split it between two verifiers by area so different classes of defect surface in the same round. A verdict on an earlier version does not verify later edits.

A finding fails the work only when it is an unmet acceptance criterion, a defect reachable without deliberate tampering, or a safety issue such as data loss or a signal to the wrong process. Everything else goes to the user as a note and to the backlog. After the first review, each further review re-checks the repaired findings and reruns the existing check list; it adds new probe classes only when the user asks or a repair touched a new area.

Use agents as tools: every pass gets a fresh agent, and an agent is stopped once its result is read. Send failures to a new implementer and the revised result to a new verifier, never to the agents from an earlier pass. Each brief carries what the new agent needs from earlier passes: the findings, the commit to start from, and the evidence already established. Continue while each round fixes something or learns something new. When the same failure recurs with nothing new learned, stop and bring it to the user as a possible spec problem.

When a worker hits a design decision, it returns the decision with a recommendation and pauses only the dependent work. Bring the decision to the user through interrogate.

## Waves

Once a wave's spec is confirmed and its work has started, begin the next round of planning immediately while coordinating the running work.

- Start new work that overlaps the files or areas of running work only after that work passes verification. Start non-overlapping work right away.
- In each question round, include a one-line status of running work. Add decisions returned by workers to the next round.
- If a new decision would change running work, flag it and ask the user whether to stop, redirect, or let that work finish.

## Tracking

Track each delegated task with its acceptance criteria, dependencies, owned files, and open findings. A task is done only when it passes verification; a worker's report does not complete it.

## Briefs

Every dispatch is self-contained. Never rely on a sub-agent inheriting your context. Each brief states:

1. **Goal** - the outcome wanted and its acceptance criteria.
2. **Scope** - what is in and out, the files it owns, and files not to touch.
3. **Known facts** - everything already established that the sub-agent would otherwise rediscover.
4. **Return contract** - concrete evidence (command output, test results, `file:line` references), unresolved findings or decisions with recommendations, and what remains undone.
5. **Rules** - work within the brief and existing authorization; return design decisions to the orchestrator instead of choosing them; address reports to the orchestrator, not the user.

## Concurrency and models

Dispatch independent work concurrently and run dependent work in sequence. Never let two workers, or a worker and you, edit the same files at once. Wait on completion notifications instead of polling.

Match the model to the task's difficulty: an adequate fast model for straightforward work, a more capable one for complex reasoning or verification. Verify with a different model family from the one that implemented when one is available, so the two do not share blind spots. Escalate when evidence shows the current model cannot handle the task reliably. Inherit the current model when model selection is unavailable.

## Reports

Report meaningful milestones, blockers, decisions, and completion, combining related agent results into one update. Lead with a clear status and work-area label, then use scannable bullets:

- **Done** - completed steps or established findings.
- **Checked** - check results, the verifier's verdict or pending verification, and concise evidence.
- **Remaining** - unfinished work, blockers, notes for the user, and the next action.

Omit empty fields. State failures, partial results, and pending verification plainly.
