# Codex

How to run the mockup loop in Codex.

## Run mockup outside the sandbox

Codex's default sandbox turns networking off and tears down background processes when a command ends, so `mockup` cannot work inside it. Run every `mockup` command with escalated permissions, outside the sandbox. The first time, Codex asks the user in its terminal; ask them to approve "don't ask again" for commands starting with `mockup`, so the session is not interrupted again. If a `mockup` command says it has to run outside Codex's sandbox, run it again with escalated permissions.

Do not suggest turning the sandbox off in general.

## Listen

Do not run `mockup wait`. A finished background command does not wake Codex, so the mockup server wakes you instead: it queues each browser message into this session with `codex queue`. A message that arrives while you are working waits until your turn ends, then starts a new turn.

`mockup start` reads this session from `CODEX_THREAD_ID`. When a new Codex session runs `mockup start` for the same design, the server restarts and delivers to the new session; messages already sent stay on disk.

Every turn follows the same shape: read the queued message, do the work, reply with `mockup say`, and end your turn. Waiting costs nothing, because nothing runs until the next message arrives.

## Checks

In a fresh Codex session:

1. The mockup skill is listed once among Codex's available skills.
2. Asking for it, with a request like "explore a look for this app", asks once to run `mockup start` outside the sandbox, then starts the server and opens the page.
3. A message sent from the page starts a new turn without any terminal input, and the reply appears in the page marked Done.
4. A message sent while the agent is working arrives after the current turn, not lost.
