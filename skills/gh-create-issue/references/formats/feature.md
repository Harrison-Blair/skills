# Feature format

Title prefix: `[Feature]`. Label candidates, in order: `enhancement`, `feature`.

## Sections

```markdown
## Summary
One or two sentences: what the feature is.

## Motivation
Who needs it, what they cannot do today, why now.

## Proposed solution
Behavior, interface or UX, configuration surface.

## Alternatives considered
Each alternative and why it loses.

## User flows
Step by step: entry point, actions, what the user sees at each step, exit.
One flow per scenario, happy path first, then edge cases.

## Acceptance criteria
- [ ] Observable, testable outcomes, ideally one per user flow.

## Out of scope
Explicit non-goals.

## Affected areas
Only when grounding found any: modules, docs, and tests that would change, as `path` pointers with a one-line note each.

## Related issues
Only when the issue search found any: `#<number>` with a one-line relevance note each.
```

## Question batches

1. Summary + Motivation
2. Proposed solution + Alternatives considered
3. User flows + Acceptance criteria + Out of scope
4. Confirm-only: Affected areas, Related issues

## Guidance per section

- **Summary**: state the capability, not the implementation.
- **Motivation**: propose the gap from the description and from any related issues that asked for the same thing; ask who is affected and what they do today instead.
- **Proposed solution**: propose an interface consistent with the project's existing conventions found in grounding (CLI flags, config keys, API shape). Name the conventions you matched.
- **Alternatives considered**: propose at least one real alternative, including "do nothing", with the reason it loses.
- **User flows**: propose the happy path from the proposed solution; ask which edge cases matter (failure, cancellation, first run, upgrade).
- **Acceptance criteria**: propose one checkable statement per user flow. Each must be observable without reading the code.
- **Out of scope**: propose the adjacent work the description hinted at but did not ask for.
- **Affected areas / Related issues**: omit when grounding or the search found nothing.
