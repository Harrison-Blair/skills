# Codex

Use this note for Codex-specific mechanics. The workflow in [SKILL.md](../../SKILL.md) remains authoritative for this skill. Official documentation checked on 2026-09-07.

## Agent lifecycle and tool availability

Codex supports spawning agents, routing follow-up instructions, waiting for results, and stopping or closing threads. Sub-agents can inherit the parent's sandbox and approval settings. See the official [sub-agent guide](https://learn.chatgpt.com/docs/agent-configuration/subagents#orchestration-and-thread-controls) and [approval behavior](https://learn.chatgpt.com/docs/agent-configuration/subagents#approvals-and-sandbox-controls).

Apply these adapter rules using the tools exposed in the current session:

- Read the available tool schemas before dispatching; use their actual names, arguments, and return values.
- Retain each returned agent identifier and use the supported follow-up mechanism to continue that worker. Check whether sending a message also starts an idle agent before relying on it to resume work.
- Use the supported waiting or notification mechanism. Distinguish a wait timeout, an agent failure, and a completed result from the returned state.
- Check whether interruption stops a turn or closes the thread. Preserve workers needed for repair rounds; use closure when supported and their work is finished.
- If a task tracker is exposed, map work units to it; otherwise use the ledger described in the shared skill.

## Models and context

Without a configured sub-agent model or reasoning effort, workers inherit the parent's settings. When an explicit spawn request or agent default selects a model without an explicit or configured reasoning setting, that model's default effort applies. See [model and reasoning behavior](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning).

Local configuration supports `agents.default_subagent_model` and `agents.default_subagent_reasoning_effort`; explicit spawn selections override those defaults. See the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Apply the shared model-selection policy through supported runtime controls. Do not hard-code a model catalog or rewrite user configuration to perform an ordinary dispatch. Treat conversation-history inheritance and any restrictions on combining it with model overrides as tool-specific: follow the live schema and supply a self-contained brief either way.

## Concurrency and workspace

Local Codex exposes `agents.max_concurrent_threads_per_session`, which limits open spawned-agent threads and excludes the primary thread; `agents.max_threads` is its legacy alias. Use the current session's reported capacity and counting rules, without assuming a fixed number of slots. Queue additional work when capacity is occupied. See the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Git worktrees provide separate checkouts for parallel chats, with shared repository metadata. Their existence does not establish which checkout a particular worker uses. See the official [worktree guide](https://learn.chatgpt.com/docs/environments/git-worktrees#whats-a-worktree).

For this skill, confirm each worker's working directory and baseline before coordinating writes. In a shared checkout, assign non-conflicting file ownership or serialize edits. If isolation is needed, delegate its setup and verify that the intended starting changes are present. Direct the verifier to the revised result in the correct checkout.
