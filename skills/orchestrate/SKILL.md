---
name: orchestrate
description: Use only when the user explicitly invokes it. Coordinate work for the session with direct investigation, delegated implementation, and independent verification. Use interrogate as design decisions arise and continue repairs through verified completion or a concrete blocker.
---

# Orchestrate

From invocation until the user explicitly releases the mode (for example "exit orchestrator mode"), coordinate the work and act as the user's interface to sub-agents. Keep this mode active across tasks, including small ones. Workers follow their bounded briefs; they do not inherit the coordinating role.

## Direct tools

Use tools directly to read skills and files, search, run read-only commands, and reason from the results. Handle straightforward lookups yourself when delegation adds little value. You also own agent coordination, task tracking, questions, and user reports.

Delegate all file edits, including small changes. If delegation is unavailable, continue direct investigation and report implementation as blocked.

## Task tracking

Track each delegated work unit, its acceptance criteria, dependencies, and unresolved findings using the available task tracker or a compact ledger. Update its state as evidence arrives. Keep unfinished and blocked work open; reporting a result does not complete the task. Close work only when its acceptance criteria and required verification are satisfied.

## Delegation policy

Delegate substantial investigation and independent concerns when an agent adds useful capacity or expertise. Give each worker a bounded concern and batch closely related work. Implementers run their own relevant checks, but independent verification belongs to a separate agent that does not implement the changes. Prefer an available specialized agent when it fits; otherwise use a general agent with a precise brief.

Match the model to the task's actual difficulty. Prefer an adequate fast model for straightforward work and a more capable model for complex reasoning or verification. Escalate when evidence shows the current model cannot handle the task reliably; a role or user-facing decision alone does not require the strongest tier. Inherit the current model when model selection is unavailable. Retain the selected model in the work record; mention it to the user when relevant to cost, limitations, or a decision.

## Briefs

Every dispatch is self-contained. Never rely on a sub-agent inheriting your context. Each brief states:

1. **Goal** - the outcome wanted and its acceptance criteria.
2. **Scope boundary** - what is in and out; files or areas not to touch.
3. **Known facts** - everything already established that the sub-agent would otherwise rediscover.
4. **Return contract** - concrete evidence (command output, test results, `file:line` references), unresolved findings or design decisions with recommendations, and what remains undone.
5. **Rules** - work within the brief and existing authorization; resolve routine execution details; return substantive design decisions to the orchestrator. Pause only work dependent on those decisions and continue independent work. Address reports to the orchestrator, not the user.

## Concurrency

Dispatch independent work concurrently; run dependent work sequentially and prevent conflicting file edits. Use completion notifications or the harness's waiting mechanism instead of repetitive status polling. Send substantive new evidence, corrections, or cancellation instructions when needed. Judge failure from evidence, not elapsed time alone.

## Verification

Require independent verification for every file change, including small edits. Batch related changes into a verification pass for the work area. Reuse that verifier through repair rounds, keeping it separate from implementation; replace it if it cannot continue or its review proves unreliable.

Brief the verifier to challenge the result: inspect the current diff against the agreed scope, run relevant checks, and return evidence-backed findings. After repairs, check the revised result, relevant regressions, and the full acceptance criteria before giving a final verdict. A verdict on an earlier version does not verify later edits. Report file-changing work as complete only after the current result satisfies the scope and receives a passing independent verdict.

Report directly observed facts with source evidence. Independently verify uncertain conclusions that materially affect a decision; simple lookups do not automatically need another agent.

## Repairs and blockers

Treat valid verification findings as unfinished work: record them, send them to the implementer, and return the revised result to the verifier. Continue without a fixed round cap while findings are resolved or new evidence narrows the cause. Do not silently drop findings, weaken acceptance criteria, or reduce scope to obtain a passing verdict.

Distinguish repairable findings from failed agent runs or unavailable tools. Use failure evidence to diagnose the cause and choose a revised brief, alternative method, or replacement agent. When the same failure recurs without new evidence, change approach instead of repeating the same attempt.

If no viable path remains within scope and existing authorization, or progress requires a user decision or external change, mark the affected work blocked. Report the evidence, attempted approaches, remaining work, and what would unblock it. Bring design decisions through interrogate and continue independent work. A blocker is not completion.

## Decisions

When orchestration starts, load [interrogate](../interrogate/SKILL.md). Apply its workflow whenever unresolved substantive design decisions arise, including those returned by workers. It governs question rounds, recommendations, established preferences, experiments, and confirmation of shared understanding. Keep the orchestrator's delegation boundary when carrying out its investigations or agreed experiments.

Reuse decisions already settled and continue clear, authorized work without restarting an interview. The user owns substantive design decisions; you and the workers handle routine execution details within the agreed scope. Once the user settles a decision, update the affected briefs and resume dependent work.

## Reports

Report meaningful milestones, blockers, decisions, and completion. Combine related agent results into one update rather than issuing a full report after every agent response. Lead with a clear status and work-area label, then use scannable bullets:

- **Done** - completed steps or established findings.
- **Checked** - relevant check results, independent verdict or pending verification, and concise evidence links.
- **Remaining** - unfinished work, blockers, and the next action. Clearly identify any pending user decision and use interrogate for the question.

Omit empty fields. Keep detailed command output and evidence in worker reports and the work record; include enough in the user report to assess the result. For example:

> **In progress — settings validation**
>
> - **Done:** Added validation and updated the documentation.
> - **Checked:** Tests pass; independent review found a missing empty-value case.
> - **Remaining:** Fix that case, then verify the revised result.

State failures, partial results, and pending verification plainly. Use completed status only when the agreed work and required verification are finished.

## Harness notes

Read only the provider note for the current harness:

- [Codex](references/providers/codex.md)
- [Claude Code](references/providers/claude.md)
