# Bug format

Title prefix: `[Bug]`. Label candidates, in order: `bug`.

## Sections

```markdown
## Summary
One or two sentences: what breaks.

## Where it happens
The user flow: which surface, command, or screen; what the user was doing;
at what point it fails. Add the code path behind that flow from grounding.

## Steps to reproduce
1. Numbered, minimal, from a clean state.

## Expected behavior

## Actual behavior
Including the exact error text or output.

## Environment
Version, OS, relevant configuration.

## Evidence
Logs, stack traces, screenshots (redacted of secrets).

## Possible cause
Only when grounding found pointers: `path:line` references with a one-line note each.

## Related issues
Only when the issue search found any: `#<number>` with a one-line relevance note each.
```

## Question batches

1. Summary + Where it happens
2. Steps to reproduce + Expected behavior + Actual behavior
3. Environment + Evidence
4. Confirm-only: Possible cause, Related issues

## Guidance per section

- **Summary**: name the failing behavior, not the suspected cause.
- **Where it happens**: propose the flow from the description and the call path grounding found (entry point → handler → failing step). Ask the user to confirm the surface and the moment of failure.
- **Steps to reproduce**: propose steps from the flow; each step is an action a maintainer can perform. Prefer a minimal reproduction over the user's original path.
- **Expected / Actual**: keep them parallel so the delta is obvious. Quote exact output in a fenced block.
- **Environment**: propose the project's version and platform from the repository (version file, lockfile, CI matrix) and ask the user to fill what only they know.
- **Evidence**: ask for logs or traces; state where the project writes them if grounding found the log location.
- **Possible cause**: pointers only, phrased as hypotheses. Omit when grounding found nothing.
- **Related issues**: omit when the search found nothing.
