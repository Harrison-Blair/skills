# mockup: maintainer notes

Design decisions agreed with the owner on 2026-09-23, and the build order.
Agents running the skill do not need this file; `SKILL.md` is the entry point.

## Decisions

- Harnesses: Claude Code, Codex, Pi. Portable core in `SKILL.md`; harness
  specifics in `references/providers/<harness>.md`.
- App: Node server + React client in `app/`, committed. `node_modules` and
  build output are ignored. Dependencies install on first use and again when
  the lockfile changes.
- The browser is the only interface for design work (chat, picks, comments).
  The terminal is for setup and emergencies only; the browser shows a
  "terminal action required" banner when the agent is blocked there.
- Transport: a shared `mockup` CLI (`wait`, `say`, ...). Wake-up per harness:
  - Claude Code: `mockup wait` runs as a background command; its exit wakes
    the agent (verified).
  - Pi: an extension injects browser messages with `sendUserMessage`
    (API verified). Setup/sync links it into `~/.pi/agent/extensions/`.
  - Codex: the server runs `codex queue --thread <id> --message <text>`
    (verified against an idle session; busy delivery untested). A finished
    background command does NOT wake Codex (verified).
- Delivery is durable: messages are written to disk before the browser shows
  them as sent; statuses queued -> delivered -> done / failed; undone
  deliveries are redelivered after a crash.
- Security: loopback only, per-session random token, Host/Origin checks, no
  CORS, file access confined to the design root, previews in a sandboxed
  frame on a separate channel from chat/control.
- Concurrency: one server per agent session, own port; one active agent per
  design with explicit takeover.
- Storage: target repo `.design/<design-name>/`. Commit project/context,
  rounds, tokens, specs, components, own assets. Ignore `assets/web/`
  (source URL + license note recorded), `renders/` that include web images,
  and `.runtime/`. No repo yet: offer to create a folder and `git init`.
- Stages: context -> mood board -> design language -> component library ->
  states & interactions -> handoff. Linear with approval gates; going back
  marks later stages "needs review".
- Context: agent drafts a brief from the code, asks only the gaps; approved
  brief includes a scoped inventory (screens/flows, roles, breakpoints,
  accessibility, exclusions).
- Mood board: uploads + web images + HTML/CSS swatches; final collage.
- Rounds: one version + all feedback. Outputs immutable; feedback append-only;
  restore copies an old version forward as a new round; approvals reference
  exact versions; the agent is told the active version.
- Visual input: Playwright screenshots after each round, read with the
  harness's image tool.
- Components: real React, one reusable file per component, token-styled.
- Live previews: the agent writes `ui/tokens.css`, `ui/components/*.jsx` (one
  per file, composed as the real app would) and `ui/pages/*.jsx`. Publishing a
  `preview` block bundles the page with esbuild (the app's React, always) into
  `renders/previews/<sha256>.html`, so rounds stay immutable. Served with CSP
  `sandbox allow-scripts` (opaque origin, no cookie or API access). Toolbar:
  device fit/phone/tablet/desktop, light/dark via `data-theme`, and Annotate:
  the frame pictures its own viewport (html-to-image), the user marks the
  picture, and the frame stays mounted so its state survives.
- Published rounds are frozen: images (block, option and Markdown) are copied
  to content-hashed files at publish, into tracked `assets/published/` for own
  and uploaded images or ignored `renders/published/` for web images.
- One server per design: every server takes a mutex file
  (`server.lock.recover`) before touching `.runtime/server.lock`; inside it,
  the lock is read, removed only if its owner is dead, and replaced. Both
  files are hard links of a finished pid file, so they appear whole. The
  mutex is cleared only when its owner is dead (moved aside and re-checked),
  never by age. Residual risk: a crash mid-acquisition racing two new
  contenders at once; pid reuse is not handled.
- Markdown `media` keys are the renderer's `normalizeUri` form of the path;
  two files that normalize alike in one field are refused.
- Round Markdown is parsed (GFM) at publish; local images in any form get
  published copies, recorded as `media` {original: copy} on the block. The
  text stays as written and the page swaps in the copies.
- Marks travel only as the page drew them: `renders: { "round|image": { id,
  path|null } }` names exact revisions, and nothing else is carried. Marking
  pauses while a message is sending; End session refuses (409) if any unsent
  marks were not drawn.
- Stages: context, mood, language, components, states, prototype (clickable
  screens built from the same components), handoff.
- Marks: pins and circles (with notes) are saved per round image or preview
  snapshot (`POST /api/annotations`, latest set per round+image), shown in
  place and editable later, and carried to the agent with the next message
  like decisions, with a client-rendered copy. Preview snapshots stay as
  thumbnails under the preview.
- Review navigation: "Unanswered" and "Flagged" jump buttons share the blue
  line above the chat composer with "Send feedback"; flags are private to the browser (localStorage), not sent to the agent.
- States: live per-component state grid + clickable per-flow state diagrams.
- Handoff: brief, final collage, W3C design tokens + CSS variables, component
  files, state grids and flow diagrams, open decisions, and a mapping guide to
  the target framework. Approval does not authorize production code changes.
- Tests: Node CI job on Linux, macOS, Windows (Git Bash): server, security and
  durability unit tests, Playwright end-to-end browser -> inbox -> wait. Each
  harness wake-up gets a manual fresh-session check in its provider reference.

## Harness delivery (slice 2, verified 2026-09-23)

- The harness and its session come from the environment it gives commands:
  `CODEX_THREAD_ID` (Codex), `PI_SESSION_ID` (Pi); `--harness`/`--thread`
  override. A different session running `mockup start` restarts the server.
- Codex: the default workspace-write sandbox blocks listening and any socket
  connect (TCP or Unix, `EPERM`) and runs each command in its own process
  namespace, killing a server started there. So every `mockup` command runs
  with escalated permissions (the user approves "don't ask again" once);
  inside the sandbox (`CODEX_SANDBOX_NETWORK_DISABLED=1`) the CLI says so.
  The server wakes Codex with `codex queue --thread <id> --message <text>`,
  one message at a time; when Codex is busy, the queued message runs after
  the current turn. Assumed, not verified: an approved command's environment
  matches `-s danger-full-access` (no sandbox marker).
- Pi: nothing outside Pi can wake it, so `pi/mockup/index.ts` (linked by
  setup.sh) runs `mockup wait --for pi` in the background once
  `mockup start` leaves `~/.mockup/pi/<session>.json`, and hands each result
  to `pi.sendUserMessage` (followUp when busy). After its first wait it asks
  only for new messages (`wait --new`), so an unanswered message is not
  handed over twice; the first wait still redelivers after a restart.
- `lib/format.mjs` renders messages for all three; only the closing line
  differs (Claude: run `mockup wait` again; Codex/Pi: end your turn).

## Open items

- Supported Node and browser versions.
- Exact on-disk formats for rounds and approvals.
- Fresh-session checks in real Codex and Pi TUIs (the provider references
  list them); Windows delivery (`codex` resolution, `.cmd` shims) is untested.

## Build order

1. Core loop: CLI (`start`, `wait`, `say`, `done`, `status`), server with
   security and durable inbox, React shell with chat and status, Claude path.
2. Pi extension + setup linking; Codex queue adapter; provider references
   (done).
3. Rounds, approvals, stage gates; context and mood-board stages.
4. Design language, component library, states & interactions, prototype
   (live previews: done).
5. Playwright screenshots, handoff export, CI jobs.
