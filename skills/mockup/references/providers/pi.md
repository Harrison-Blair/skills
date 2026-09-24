# Pi

How to run the mockup loop in Pi.

## Listen

Do not run `mockup wait`. The skills repo's setup links a Pi extension (`~/.pi/agent/extensions/mockup`) that listens for you. `mockup start` reads this session from `PI_SESSION_ID` and leaves a link for the extension, which then keeps a `mockup wait` running outside the conversation, so waiting makes no model calls. Each browser message reaches you as a user message: at once when you are idle, or after your current work.

Every turn follows the same shape: read the message, do the work, reply with `mockup say`, and end your turn. `mockup stop` removes the link, and the extension stops listening.

If no browser message ever arrives, check that the extension is installed: `~/.pi/agent/extensions/mockup` should exist. If it does not, ask the user to run the skills repo's `scripts/setup.sh`, then `/reload` in Pi.

## Checks

In a fresh Pi session:

1. `/skill:mockup` is listed.
2. `/skill:mockup` with a request like "explore a look for this app" starts the server and opens the page.
3. A message sent from the page starts a new turn without any terminal input, and the reply appears in the page marked Done.
4. A message sent while the agent is working arrives after that work, not lost.
