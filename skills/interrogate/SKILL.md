---
name: interrogate
description: Help the user collaboratively flesh out or thoroughly examine a plan, idea, or decision. Use when the user requests this kind of planning conversation or explicitly invokes interrogate; ordinary clarification alone does not trigger it.
---

Help the user develop their plan through questions until you reach a shared understanding.

Bring every substantive **design decision** to the user, including goals, scope, behavior, architecture, constraints, and tradeoffs. Handle incidental wording, formatting, and mechanical details autonomously. Respect established answers and preferences; revisit them only when new evidence or a user correction warrants it.

Ask **1–5 related questions per round**, then wait for the user's answers. Ask only questions whose prerequisites are settled. Keep remaining questions for later rounds and adjust them as answers arrive. Do not silently choose answers to unresolved design decisions; let the user settle or explicitly defer them.

Investigate discoverable **facts** using available tools before asking questions that depend on them. Cite relevant evidence and distinguish verified facts from assumptions. If evidence is unavailable, explain the uncertainty rather than presenting a guess as fact.

When an **experiment** could clarify a detail or test an idea, offer it with its purpose and expected insight, then wait for the user's agreement before running it. Propose a subagent only when delegation is available and useful; otherwise propose local execution. Keep execution within existing authorization and use the results to inform subsequent questions.

## Writing questions

**Explain simply.** Write each question and its reasoning in plain language a newcomer to the topic could follow. Define a term the first time it appears if the user may not know it. Keep sentences short. Do not assume the user remembers earlier context; restate the one fact the question hinges on.

**Illustrate when it helps.** When a question involves a flow, a relationship, a data model, or a comparison between shapes of a solution, draw it as a small terminal-friendly diagram inside a fenced code block: boxes and arrows, a tree, a short table, or a timeline. Keep each diagram under about fifteen lines and label every box. Skip the diagram when words alone are clearer.

**Offer every viable answer.** List each option that is genuinely workable, not just two. Put the recommended option first, mark it `(recommended)`, and give one or two sentences on why. Give each alternative one sentence on when it would be the better choice. Always include a recommendation, even for open-ended questions. The user may answer with their own option instead of choosing from the list.

Use the following structure flexibly. Number questions within each round. Include sourced facts when useful and omit empty sections.

```
Question: {Number}. {Question in plain language}

Facts:
- {Relevant verified fact} {Source(s)}

Picture:
  {optional diagram, table, or tree}

Answers:
- {Option} (recommended) -- {Why, in plain words}
- {Alternative} -- {When this is the better choice}
- {Alternative} -- {When this is the better choice}
```

Example round:

```
Question: 1. Where should the lock file live?

Facts:
- setup.sh writes .sync.lock inside the clone directory (scripts/setup.sh:142)
- Two clones on one machine can sync at the same time today (README.md:81)

Picture:
  per-clone                  global
  ~/source/skills/.sync.lock ~/.agents/.sync.lock
  ~/other/skills/.sync.lock       ^
       ^          ^               |
     sync A     sync B      sync A + sync B

Answers:
- Per clone (recommended) -- matches where the lock is now and keeps clones independent
- Global under ~/.agents -- better if two clones must never run at once
- No lock; retry on conflict -- better if syncs are rare and short
```

Once all substantive design decisions are settled or explicitly deferred, summarize the agreed decisions, assumptions, and remaining unknowns. Ask the user to confirm shared understanding. Present this summary as a bulleted list. If they correct the summary, revisit the affected questions and update it until they agree. Invoking this skill alone does not authorize implementation.
