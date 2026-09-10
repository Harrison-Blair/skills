# Spike format

Title prefix: `[Spike]`. Label candidates, in order: `spike`, `research`.

## Sections

```markdown
## Question
The single question this spike answers.

## Context
Why the question exists, what is already known, what is uncertain.

## Decisions unblocked
What will be decided or built once the question is answered.

## Approach
Candidate options to evaluate; experiments or prototypes to run.

## Success criteria
- [ ] What "answered" looks like: measurements taken, a prototype that does X, a comparison table.

## Timebox
Effort cap, and what happens if it runs out.

## Deliverable
Written findings plus a recommendation, and where they are recorded (ADR, doc, issue comment).

## Starting points
Only when grounding found any: code, docs, and prior issues to read first, as `path:line` or `#<number>` pointers with a one-line note each.

## Related issues
Only when the issue search found any: `#<number>` with a one-line relevance note each.
```

## Question batches

1. Question + Context + Decisions unblocked
2. Approach + Success criteria
3. Timebox + Deliverable
4. Confirm-only: Starting points, Related issues

## Guidance per section

- **Question**: propose one answerable question; if the description contains several, ask which one this spike owns and suggest separate spikes for the rest.
- **Context**: propose what grounding established as already known and what remains uncertain.
- **Decisions unblocked**: propose the concrete feature, refactor, or purchase waiting on the answer.
- **Approach**: propose the candidates the description or related issues named, and the cheapest experiment that discriminates between them.
- **Success criteria**: propose checkable outputs; a spike that ends with "we learned a lot" has failed this section.
- **Timebox**: propose a cap in hours or days and the default decision if the cap is hit.
- **Deliverable**: propose where the project records decisions, if grounding found an ADR directory or decision log.
- **Starting points / Related issues**: omit when grounding or the search found nothing.
