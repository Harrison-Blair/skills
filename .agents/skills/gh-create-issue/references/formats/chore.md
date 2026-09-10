# Chore format

Title prefix: `[Chore]`. Label candidates, in order: `chore`, `maintenance`.

## Sections

```markdown
## Summary
One sentence: what maintenance work this is.

## Motivation
Why it is worth doing now: debt, risk, upgrade, consistency.

## Tasks
- [ ] Concrete steps, each naming its target (file, module, configuration, workflow).

## Risk
What could break, how to verify, how to roll back.

## Acceptance criteria
- [ ] How we know it is done: tests green, lint clean, behavior unchanged, and so on.

## Affected areas
Only when grounding found any: `path` pointers with a one-line note each.

## Related issues
Only when the issue search found any: `#<number>` with a one-line relevance note each.
```

## Question batches

1. Summary + Motivation
2. Tasks + Risk + Acceptance criteria
3. Confirm-only: Affected areas, Related issues

## Guidance per section

- **Summary**: a chore changes no user-facing behavior; if it does, suggest the Feature or Bug format instead.
- **Motivation**: propose the reason from grounding (outdated pin, duplicated code, failing lint rule, missing CI job) and ask the user to confirm the urgency.
- **Tasks**: propose one task per concrete target grounding identified, in a sensible execution order.
- **Risk**: propose what the tasks touch that other code depends on, the project's verification commands from its guidance files, and the rollback (revert, pin, feature flag).
- **Acceptance criteria**: propose the project's own gates (test suite, lint, build) plus "no behavior change" where applicable.
- **Affected areas / Related issues**: omit when grounding or the search found nothing.
