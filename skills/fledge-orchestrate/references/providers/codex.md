# Codex

Codex-specific mechanics for [fledge-orchestrate](../../SKILL.md). The shared workflow stays authoritative.

## Escalate Fledge socket commands up front

Most Fledge commands talk to Herdr over its local Unix socket, which Codex's restricted sandbox blocks with `connect: operation not permitted`. Do not run one inside the sandbox first to rediscover that failure. On the first call of each such command, request escalation directly:

- `sandbox_permissions: "require_escalated"`;
- a `justification` naming the task, for example "May I run fledge outside the sandbox so it can reach the Herdr socket to spawn and track this session's workers?"; and
- `prefix_rule: ["fledge"]`, so approval covers later Fledge calls without widening to other programs.

Commands that need the socket: every `fledge agent` subcommand except `models`, `fledge task create`/`assign`/`complete`/`verify`, the `fledge worktree` commands, and `fledge doctor`. Help, `--version`, `agent models`, `task get`/`list`/`cancel`/`depend`, and `update` run inside the sandbox. If the installed Fledge's help or the repository's instructions list different commands, follow them.

Also escalate Herdr session-control commands the same way. Use the normal approval flow: an approval denial stands, and approval covers only this session's coordination, not unrelated changes.

## Codex workers

A worker running on Codex does not load this skill. Put the escalation rule above in each Codex worker's brief, so its first `fledge task complete` or `fledge agent message` requests escalation instead of failing.
