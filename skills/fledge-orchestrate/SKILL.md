---
name: fledge-orchestrate
description: Use only when the user explicitly invokes it. Run the orchestrate skill with Fledge as its coordination layer inside a Herdr session - fledge agent for workers, fledge task for tracking, fledge worktree for checkouts - instead of the harness's own sub-agent and task tools.
---

# Orchestrate with Fledge

Load [orchestrate](../orchestrate/SKILL.md) and follow it; it stays authoritative for the coordinating role, briefs, delegation, verification, repairs, decisions, and reports. This skill only replaces its mechanics: where orchestrate says to spawn, message, track, wait for, or stop agents, use Fledge. Skip orchestrate's harness notes except for a step Fledge cannot perform.

## Preconditions

Fledge runs inside Herdr. If `HERDR_ENV` is not `1`, `fledge` is not installed, or `fledge doctor` reports a failure that blocks agent commands, tell the user and continue with plain orchestrate.

Commands change between Fledge versions. Before first use, read `fledge agent --help`, `fledge task --help`, and `fledge worktree --help`, and each subcommand's `--help` before relying on its flags. Follow the repository's own instructions where they say more about Fledge.

## Start

1. Run `fledge agent current`. If it fails with `caller_unregistered`, register: `fledge agent adopt --name orchestrator` when the agent is unnamed, or `fledge agent adopt` when it already has a name.
2. Run `fledge agent rename --to orchestrator`, which renames the agent if needed and labels its pane and, when it is alone there, its tab. If the installed Fledge has no `rename`, skip this step.

## Mapping

| Orchestrate step | Fledge |
| --- | --- |
| Track work units, dependencies, and acceptance | `fledge task create` with the brief skeleton from `fledge task template`; `task depend`, `list`, `get`; `task import` for a planner's proposal |
| Choose a worker and model | `fledge agent profiles`, `fledge agent models` |
| Dispatch a worker | `fledge agent spawn --profile <role> --name <role-n>`, then `fledge task assign`; spawn names the worker's pane and new tab after it |
| Isolate an implementer | `fledge agent spawn ... --worktree new --branch <branch>`, or `fledge worktree create` |
| Send evidence, corrections, or cancellations | `fledge agent message --name <worker>` |
| Wait for results | `fledge agent wait`, then `fledge task get` and `fledge agent read` |
| Interrupt or stop a worker | `fledge agent pause`, `fledge agent stop` |
| Record completion and verification | Workers run `fledge task complete`; the verifier runs `fledge task verify` |
| Tear down | `fledge agent cleanup --dry-run`, then `fledge agent cleanup` |

## Rules

- Write briefs as Fledge task briefs; the task record is the work ledger orchestrate requires. Keep tasks open until verified, and cancel abandoned work with `fledge task cancel`.
- Worker messages arrive with a `ᛉ fledge message from ...` header. Reply with the header's reply command, and address workers by name.
- Run a feature's verifier in that feature's checkout (`fledge agent spawn --worktree <checkout path>`). The implementer commits and leaves a clean tree before verification and makes no edits while it runs. The verifier undoes experimental changes, confirms a clean `git status`, and runs `fledge task verify` only when no findings remain, naming the checked commit when it verifies again after repairs.
- Spawn prompts start with a sender header, so ask a worker in plain words to use a skill; a leading slash command will not run. Pass absolute paths to `--cwd`.
- Stop only the workers you spawned, after their results and any verification are read.
- When Fledge fails or lacks a capability, fall back to the harness tool for that step, tell the user, and record the friction where the repository asks for it.
