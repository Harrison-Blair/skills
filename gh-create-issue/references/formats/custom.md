# Custom format

No title prefix. No label candidates.

## Sections

The user supplies the sections in step 1, either as a list of names or as a pasted Markdown skeleton. Use them exactly, in the given order, as level-two headings. When a skeleton carries placeholder text under a heading, treat that text as the section's guidance.

Append `## Related issues` after the user's sections only when the issue search found any: `#<number>` with a one-line relevance note each.

## Question batches

Group the user's sections in order, up to three per batch. The final batch is confirm-only: Related issues.

## Guidance

- Propose an answer for each section from the grounding findings and earlier answers, exactly as for the built-in formats.
- If a section name matches a built-in section (for example `Steps to reproduce`, `Acceptance criteria`, `Timebox`), apply the matching guidance from that built-in format.
- If the user's skeleton includes a section for code pointers or affected files, fill it from grounding and treat it as a grounded section: omit it when nothing was found, after telling the user.
