---
name: interrogate
description: Help the user collaboratively flesh out or thoroughly examine a plan, idea, or decision. Use when the user requests this kind of planning conversation or explicitly invokes interrogate; ordinary clarification alone does not trigger it.
---

Help the user develop their plan through questions until you reach a shared understanding.

Bring every substantive **design decision** to the user, including goals, scope, behavior, architecture, constraints, and tradeoffs. Handle incidental wording, formatting, and mechanical details autonomously. Respect established answers and preferences; revisit them only when new evidence or a user correction warrants it.

Ask **up to 4 related questions per round**, then wait for the user's answers. Ask only questions whose prerequisites are settled. Keep remaining questions for later rounds and adjust them as answers arrive. Do not silently choose answers to unresolved design decisions; let the user settle or explicitly defer them.

Investigate discoverable **facts** using available tools before asking questions that depend on them. Cite relevant evidence and distinguish verified facts from assumptions. If evidence is unavailable, explain the uncertainty rather than presenting a guess as fact.

## Experiments

When an **experiment** could clarify a detail or test an idea, and it is fast and either read-only or confined to a scratch directory, run it before asking and report the result. Offer anything that edits the project, costs money, or spawns subagents as an option on the question it would inform, `Test it first: {what, rough cost}`, and run it only if the user picks that option. Keep every experiment within existing authorization.

Report results under the question they inform:

```
**Tested:** {what was run}
**Found:** {result}
{How this changes the recommendation}
```

## Each round

Present a round in two steps: context as text, then the questions.

**1. Context as text.** Open with a recap, then give each question its own section.

- **Recap:** a bulleted **Settled** list of decisions so far, then a one-line **This round** naming what the round covers. Compress settled items to a few words; group or summarize older ones as the list grows. Omit **Settled** when nothing is settled yet.
- **Per question:** a `## {N}. {Question}` heading followed by short bold-labeled sections. Use markdown emphasis to highlight the key fact or tradeoff. Omit empty sections.
  - **Now** or **Known** -- the relevant facts, with sources.
  - **Picture** -- a small diagram or table in a fenced code block.
  - **Why it matters** -- the consequences and main tradeoffs, plus any assumption or uncertainty that could change the choice.
  - **Other options** -- viable options beyond the fourth, if any.

**2. Then ask.** If the harness provides a structured question tool, ask through it after the text. Keep each question short and give each option a one-line reason. Put the recommended option first and mark it recommended. Offer up to 4 options; name any further viable options in the context text. If no question tool is available, list the options under each question's section, lettered A, B, C, and invite a reply such as `1A, 2B`.

## Writing questions

**Keep it simple and short.** Write in plain language a newcomer to the topic could follow. Define a term the first time it appears if the user may not know it. Keep sentences short. Do not assume the user remembers earlier context; restate the one fact the question hinges on.

**Draw by default.** Give each question a picture whenever it involves a flow, a relationship, a data model, a layout, or a comparison: boxes and arrows, a tree, a short table, or a timeline. Keep it terminal-friendly, under about fifteen lines, and label every box. Skip it only for trivial questions where words alone are clearer.

**Give enough context to judge.** Explain why the decision matters to the user's goal and what each choice leads to in practice. Scale the detail to the decision rather than repeating the question or the recommendation.

**Offer every viable answer.** Include each genuinely workable option, not just two. Always recommend one and say why in a sentence; give each alternative a sentence on when it would be the better choice. The user may answer with their own option.

## Example round

Context as text:

````
**Settled**
- Sync runs from the setup script
- One clone per machine is the common case

**This round:** where the sync lock lives

## 1. Where should the lock file live?

**Known**
- setup.sh writes `.sync.lock` inside the clone (scripts/setup.sh:142)
- Two clones on one machine can sync at the same time today (README.md:81)

**Picture**
```
  per clone                     global
  clone A ─▶ A/.sync.lock       clone A ─┐
  clone B ─▶ B/.sync.lock       clone B ─┴─▶ ~/.agents/.sync.lock
```

**Why it matters**
The lock decides **which syncs wait for each other**. Per-clone locks let clones sync in parallel but leave *shared files* unprotected; a global lock makes every clone take turns.
````

Then the question tool:

```
Where should the lock file live?
- Per clone (recommended) -- matches today's location and keeps clones independent
- Global under ~/.agents -- better if clones write shared files
- No lock; retry on conflict -- better if syncs are rare and short
- Test it first: run two real syncs against a spare clone (~5 min, writes files)
```

## Wrapping up

Once all substantive design decisions are settled or explicitly deferred, summarize the agreed decisions, assumptions, and remaining unknowns as a bulleted list. Ask the user to confirm shared understanding, through the question tool when available. If they correct the summary, revisit the affected questions and update it until they agree. Invoking this skill alone does not authorize implementation.
