---
name: glhf
description: Use only when the user explicitly invokes or requests it. Resolve planning decisions and approvals upfront, then carry the agreed work through completion and verification without routine handbacks. Use alone or alongside other skills.
---

# GLHF

Prepare the work so the user can leave and return to a completed, verified result. Stay active across tasks until the user explicitly releases the mode, for example "exit glhf". Cancelling a task stops that task, not the mode. New tasks inherit the mode, not an earlier task's approvals.

## Small tasks

Judge size by uncertainty and consequences, not line count. For small, clear tasks, assess gaps yourself and proceed with routine, bounded, reversible choices. Verify the result and disclose material assumptions in the completion report. Unclear scope or authority needs upfront clarification even for a tiny change.

## Plan before execution

For substantial work, load [interrogate](../interrogate/SKILL.md) and settle every substantive design decision with the user. Investigate discoverable facts first. Cover the whole agreed scope before any implementation starts, including later work that depends on earlier steps.

Resolve the following before dispatch:

- The goal, deliverable, scope boundaries, and testable acceptance criteria.
- The approach, interfaces, dependencies, and consequential tradeoffs or failure cases.
- The execution workflow, worker responsibilities and briefs when delegating, and verification needed to establish completion.
- Required tools, access, credentials, and permissions. Check availability with non-mutating probes where practical; disclose requirements that cannot be established upfront.
- Actions needing user approval, including any commit, publication, deployment, or external write that is part of the requested outcome. Preserve existing authorization rather than asking for it again.
- Fallback rules for likely uncertainties: what the agent may decide, which alternatives are acceptable, and what requires returning to the user.

Resolve foreseeable gaps rather than enumerating every hypothetical problem. If a required approval or review cannot meaningfully happen upfront, agree on explicit delegation or a revised completion boundary before starting. Do not promise unattended completion with a known unresolved checkpoint.

Have a fresh reviewer audit substantial plans and implementation briefs for missing decisions, approvals, dependencies, and acceptance criteria when delegation is available. Otherwise audit them locally. Reviewers report to the coordinating agent; repair routine omissions and bring substantive new choices to the user through interrogate. Update the affected plan and briefs before final confirmation.

Present the settled brief and execution boundaries and obtain the user's final confirmation once. Combine this with interrogate's confirmation rather than adding a second sign-off. The confirmation covers the agreed scope, authorized actions, fallback rules, and verification; it is not blanket permission for later work.

## Combine with other skills

Use glhf alone or as an overlay on explicitly selected workflows. Preserve the companion skill's domain instructions, execution mechanics, and verification. Resolve conflicting checkpoints and decision rules with the user during planning; do not silently discard them.

For the agreed scope, upfront planning replaces a companion workflow's interleaved planning of later waves. Implementation can still run in waves or parallel where appropriate. Carry the confirmed decisions, authorizations, fallback rules, and acceptance criteria into each implementation brief so workers do not reopen settled choices or ask the user directly.

Invocation does not expand the task's scope, authorize implementation during a planning-only request, or bypass binding system permissions. Work within the requested phase and existing authorization.

## Execute through completion

After confirmation, implement, repair, and verify within the agreed boundaries. Make routine implementation choices autonomously. Do not return control merely because a worker finished, a check failed, or the next planned step is ready. Repairs within the confirmed scope need no new sign-off.

Concise progress updates are welcome and need no response. For new gaps, use the approved fallback rules. If a consequential choice falls outside them, continue independent work and bring back the exceptional blocker with the established facts, remaining work, and a recommendation. Do not guess at new authority or label blocked work complete.

Keep available task tracking current through execution and verification. Preserve enough decision and progress state for a reliable handoff or resumed session.

## Verify and report

Use the companion workflow's verification without adding a duplicate pipeline. Alone, run task-appropriate checks and verify the actual user-visible result when practical. A worker's completion claim is not proof that the acceptance criteria pass. Repair failures and recheck before declaring completion; if an agreed criterion cannot be met, treat that as an exceptional blocker.

Return the completed result with concise verification evidence, material assumptions made during execution, and any limits that remain unverified. For each new substantial task while glhf remains active, repeat planning, review, and final confirmation.
