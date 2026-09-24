# Claude Code

How to run the mockup listen loop in Claude Code.

## Listen

Run `mockup wait` with the Bash tool's `run_in_background: true`. It has no time limit and blocks until the user sends something, even for hours. Do not add a timeout, poll it, sleep, or read its output file while it runs. An idle background wait makes no model calls, so a user who walks away costs nothing. Claude Code re-invokes you when the command exits, and its output holds the browser messages. Then reply with `mockup say` and start a new background `mockup wait`.

Keep exactly one `mockup wait` running. Starting a second one while the first is alive splits delivery between them. If a wait exits with an error, read it, fix the cause (usually `mockup start` again), and resume. Do not work around errors with a shorter wait.

This relies on background commands. If `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is set, background commands are unavailable. In that case, run `mockup wait` in the foreground with a Bash timeout of 600000 ms, and run it again whenever the Bash tool stops it. Tell the user that this mode wakes you every 10 minutes while idle, which costs tokens.

## Permissions

Every turn runs `mockup`, so a permission prompt on each call would leave the browser waiting. At `mockup start`, suggest that the user allow the CLI once, for example with this permission rule in `.claude/settings.local.json`:

```json
{ "permissions": { "allow": ["Bash(mockup:*)"] } }
```

Do not suggest bypassing permissions in general.

## Checks

In a fresh Claude Code session:

1. `/mockup` appears once in the skills list.
2. `/mockup` with a request like "explore a look for this app" starts the server, opens the page, and starts a background `mockup wait`.
3. A message sent from the page wakes the session without any terminal input, and the reply appears in the page marked Done.
4. After more than 10 minutes of idle time, a message still wakes the session, and the session made no model calls while idle.
