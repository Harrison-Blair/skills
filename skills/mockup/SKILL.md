---
name: mockup
description: Run a local browser design studio and iterate with the user on an app's visual design (context, mood board, design language, component library, states and interactions, a clickable prototype, handoff). The user works only in the browser; the agent listens and replies through the mockup CLI. Use when the user wants to explore or define how an app should look and behave before implementation; not for writing production UI directly.
---

# Mockup

Run a design session in which the user talks to you only through a local web page. You listen for their messages, do the design work, and reply in the page. Never ask the user to copy text between the browser and the terminal.

Run the `mockup` command. The skills repo's setup puts it on `PATH`. If it is not found, use `<this skill's directory>/bin/mockup` instead.

## Start

1. Pick the target repository: the current one, unless the user names another. If there is no repository yet, offer to create a folder and run `git init` there.
2. Pick a design name: lowercase letters, digits and hyphens, for example `checkout-redesign`. Ask only if the user's request does not suggest one.
3. Run `mockup start --design <name> --repo <repo> --harness <harness>`. `<harness>` is the tool you are running in: `claude`, `codex` or `pi`. The first run installs and builds the app, which takes a minute.
4. The command opens the browser and prints an `open:` link and a `design dir:`. Tell the user the link in the terminal once, in case the browser did not open. That is the last thing you ask them to do in the terminal.
5. Run every later `mockup` command from inside the target repository, or pass `--dir <design dir>` with the printed path. From anywhere else the commands cannot find the session.

Designs live in `<repo>/.design/<name>/`. `mockup start` writes `.design/.gitignore`, which keeps runtime state, web-found images and renders out of Git.

## Listen and reply

The listening step differs per harness. Read your harness's reference before the first listen:

- Claude Code: [references/providers/claude.md](references/providers/claude.md)

Every turn follows the same shape:

1. Listen with `mockup wait`. It blocks, with no time limit, until the user sends something, so waiting costs nothing while they are away. Never add a timeout or poll. You receive every unfinished browser message, oldest first. A message marked `redelivered` reached you before an interruption; check `.design/<name>/` before redoing its work.
2. Do the work, then reply with `mockup say "<text>"`. A reply marks those messages done in the browser. Use `mockup say --progress "<text>"` for interim updates that should not close them, such as "Collecting reference images…". For long or multi-line text, pipe it: `mockup say -`.
3. Listen again. Keep this loop running until the user ends the session.

Write replies for the page, not the terminal. The chat renders Markdown. Keep replies short and concrete, and ask at most a few questions at a time.

If a message says the user ended the session, reply with one short goodbye, run `mockup stop`, and stop listening.

## Review rounds

This is an iterative design review. Show the user concrete things and ask "do you like this?" often, then pull what they liked into drafts for them to confirm.

- **Explore rounds** are quick taste checks: a few options, images or questions. The user likes or dislikes each one, picks answers, selects things, and pins or circles parts of images. Keep them small and publish them often.
- **Draft rounds** bring a stage together into one proposal built from what the user liked. The user approves the draft or asks for changes. An approved draft completes the stage.

Publish rounds with `mockup round --file <round.json>`. [references/rounds.md](references/rounds.md) describes the format: pages, options, images and questions. Put images in the design directory first: your own swatches and renders in `assets/own/`, and images from the web in `assets/web/`, with each image's source URL and license added to `assets/web/SOURCES.md`. Rounds cannot be edited, so publish a new round for each revision. Use chat to point at the round and ask your questions.

Reactions reach you with the user's next message, whichever way they send it: Send feedback, a chat message, or End session. The user can also leave a comment on any item or draft. `mockup wait` lists all of it in plain words, such as `liked mood-1/calm "Calm paper"` or `commented on mood-1/calm "Calm paper": a bit warmer`, and gives absolute paths for uploads and for images with the user's marks drawn on. Open those images with your image tool before replying. Marks stay on the image in the page, and the user can edit them later: each time they change, you get the image's whole current set of marks and notes again, and "removed their marks" means none are left.

## Work through the design

Guide the user through these stages in order. Get explicit approval before moving on. If the user goes back to an earlier stage, tell them which later stages need review.

1. **Context.** Read the repository first (README, package manifest, routes, existing styles), then draft a brief: what the app is, who uses it and in which roles, key screens and flows, platforms and breakpoints, accessibility needs, and what is out of scope. Ask only about the gaps. Publish the brief as a `context` draft round. Save the approved brief to `.design/<name>/context.md`.
2. **Mood board.** Settle the overall vibe through explore rounds of the user's images, images found on the web, and swatches you build (palettes, type samples, textures). End with a draft round holding one collage of the liked pieces.
3. **Design language.** Turn the vibe into named design tokens in `ui/tokens.css`: color, type, spacing, radius, elevation, motion, for light and dark. Show them as live preview pages.
4. **Component library.** Build every component the brief's screens need in `ui/components/`, one reusable file each, styled only from the tokens, and composed the way the real app would use them. Show each one in every state on live preview pages.
5. **States and interactions.** For each flow in the brief, show every state change live, including loading, empty, error, disabled and focus.
6. **Prototype.** Build the key screens in `ui/pages/` from the same components, clickable end to end, and publish them as previews with a device frame. The user plays with it and marks up what to change; edit the components or screens and publish a new round each time.
7. **Handoff.** Bundle what an implementer needs: the tokens, the component files, and a guide mapping them to the app. List any decisions still open.

Live previews are described in [references/rounds.md](references/rounds.md#live-previews).

Approving the design never authorizes changes to the application's production code. Ask separately before implementing anything.

## Stop and recover

- `mockup status` shows the session, whether you are listening, and how many messages are pending.
- `mockup stop` ends the session when the user is finished.
- If a command says the server is not running, run `mockup start` again with the same design name. Messages are saved on disk, so nothing sent from the browser is lost.
- The page tells the user when you have gone quiet so they can check the terminal. If you are blocked, for example on a permission or login, say so in the terminal clearly.
