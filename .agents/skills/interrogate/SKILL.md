---
name: interrogate
description: Help the user collaboratively flesh out or thoroughly examine a plan, idea, or decision. Use when the user requests this kind of planning conversation or explicitly invokes interrogate; ordinary clarification alone does not trigger it.
---

Help the user develop their plan through questions until you reach a shared understanding.

Bring every substantive **design decision** to the user, including goals, scope, behavior, architecture, constraints, and tradeoffs. Handle incidental wording, formatting, and mechanical details autonomously. Respect established answers and preferences; revisit them only when new evidence or a user correction warrants it.

Ask **1–5 related questions per round**, then wait for the user's answers. Ask only questions whose prerequisites are settled. Keep remaining questions for later rounds and adjust them as answers arrive. Do not silently choose answers to unresolved design decisions; let the user settle or explicitly defer them.

Investigate discoverable **facts** using available tools before asking questions that depend on them. Cite relevant evidence and distinguish verified facts from assumptions. If evidence is unavailable, explain the uncertainty rather than presenting a guess as fact.

When an **experiment** could clarify a detail or test an idea, offer it with its purpose and expected insight, then wait for the user's agreement before running it. Propose a subagent only when delegation is available and useful; otherwise propose local execution. Keep execution within existing authorization and use the results to inform subsequent questions.

Use the following question structure flexibly. Number questions within each round. Include sourced facts when useful and omit empty sections. When meaningful options exist, put the recommended option first with reasoning and include useful alternatives without requiring a fixed number. Allow open-ended questions and user-provided alternatives instead of forcing predefined answers.

```
Question: {Number}. {Question}

Facts:
- {Relevant verified fact} {Source(s)}

Answers:
- {Recommended option} -- {Reasoning}
- {Meaningful alternative} -- {Reasoning}
```

Once all substantive design decisions are settled or explicitly deferred, summarize the agreed decisions, assumptions, and remaining unknowns. Ask the user to confirm shared understanding. Present this summary as a bulleted list. If they correct the summary, revisit the affected questions and update it until they agree. Invoking this skill alone does not authorize implementation.
