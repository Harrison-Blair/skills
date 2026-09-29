#!/usr/bin/env node
// mockup CLI: the agent's side of the browser loop.
//
//   mockup start --design NAME [--repo DIR] [--harness claude|codex|pi] [--thread ID] [--no-open]
//   mockup start --once [--harness claude|codex|pi] [--thread ID] [--no-open]   (a one-off session in the temp folder)
//   mockup show  [--dir DIR] [--title T] [--device phone|tablet|desktop|fit] PAGE   (PAGE relative to the session folder)
//   mockup wait  [--dir DIR] [--json] [--for claude|pi] [--new]   (blocks until the user sends something; no time limit)
//   mockup say   [--dir DIR] [--progress] TEXT...   (TEXT "-" reads stdin)
//   mockup status [--dir DIR]
//   mockup stop  [--dir DIR]
import { spawn } from "node:child_process";
import { request } from "node:http";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { format } from "../lib/format.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN_GITIGNORE = `# mockup: runtime state and third-party images stay local
*/.runtime/
*/log.jsonl
*/renders/
*/assets/web/
`;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(message, code = 1) {
  console.error(`mockup: ${message}`);
  process.exit(code);
}

// --- locating a running session ---

function session(designDir) {
  const file = join(designDir, ".runtime", "session.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function findDesignDir(flags) {
  const explicit = flags.dir ?? process.env.MOCKUP_DIR;
  if (explicit) return resolve(explicit);
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const root = join(dir, ".design");
    if (existsSync(root)) {
      const live = readdirSync(root)
        .map((n) => join(root, n))
        .filter((d) => existsSync(join(d, ".runtime", "session.json")));
      if (live.length === 1) return live[0];
      if (live.length > 1) fail(`several running designs; pass --dir:\n  ${live.join("\n  ")}`);
    }
    if (dirname(dir) === dir) fail("no running design found; run `mockup start` or pass --dir");
  }
}

// Always 127.0.0.1, never localhost: the page policy names 127.0.0.1 only.
const urlOf = (s) => `http://127.0.0.1:${s.port}/`;

async function api(designDir, method, path, body) {
  const s = session(designDir);
  if (!s || !alive(s.pid)) fail(s && inCodex() ? SANDBOX_HINT : `no server is running in ${designDir}; run \`mockup start\` again`, 2);
  // node:http rather than fetch: fetch abandons any response slower than five
  // minutes, and `wait` must be able to block for hours.
  const { status, data } = await new Promise((ok) => {
    const req = request(new URL(path, urlOf(s)), {
      method,
      headers: body ? { "content-type": "application/json" } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          ok({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          fail(`${method} ${path}: unreadable response (${res.statusCode})`);
        }
      });
    });
    req.on("error", (err) => fail(err.code === "EPERM" ? SANDBOX_HINT : `cannot reach the server at ${urlOf(s)}: ${err.code ?? err.message}`, 2));
    req.end(body ? JSON.stringify(body) : undefined);
  });
  // A refused or replaced wait has its own exit code.
  if (status === 409 && path.startsWith("/api/agent/wait")) fail(data.error ?? "wait refused", 3);
  if (status >= 400) fail(`${method} ${path}: ${data.error ?? status}`);
  return data;
}

// --- commands ---

// Where the Pi extension looks for this session's mockup server.
const piLink = (sessionId) => join(process.env.MOCKUP_HOME ?? join(homedir(), ".mockup"), "pi", `${sessionId}.json`);

async function start(flags) {
  const name = flags.design;
  if (!!name === !!flags.once) fail("start needs --design NAME or --once");
  if (name && !NAME.test(name)) fail("--design NAME is required (lowercase letters, digits, hyphens)");
  if (flags.once && flags.repo) fail("--repo applies only to --design");
  // The harness and its session come from the environment it gives commands,
  // unless named.
  const harness = flags.harness ?? (process.env.CODEX_THREAD_ID ? "codex" : process.env.PI_SESSION_ID ? "pi" : "claude");
  if (!["claude", "codex", "pi"].includes(harness)) fail(`unknown --harness ${harness}`);
  const thread = flags.thread ?? { codex: process.env.CODEX_THREAD_ID, pi: process.env.PI_SESSION_ID }[harness] ?? null;
  if (harness !== "claude" && !thread) fail(`--harness ${harness} needs its session: run inside ${harness}, or pass --thread ID`);
  let designDir;
  if (flags.once) {
    designDir = mkdtempSync(join(tmpdir(), "mockup-"));
    mkdirSync(join(designDir, "pages"));
  } else {
    const designRoot = join(resolve(flags.repo ?? process.cwd()), ".design");
    designDir = join(designRoot, name);
    mkdirSync(designDir, { recursive: true });
    if (!existsSync(join(designRoot, ".gitignore"))) writeFileSync(join(designRoot, ".gitignore"), DESIGN_GITIGNORE);
  }
  mkdirSync(join(designDir, ".runtime"), { recursive: true });

  const existing = session(designDir);
  if (existing && alive(existing.pid)) {
    if (existing.harness === harness && (existing.thread ?? null) === thread) return printStart(existing, designDir);
    // A new agent session takes the design over; messages are kept on disk.
    await stop({ dir: designDir, quiet: true });
  }

  const log = openSync(join(designDir, ".runtime", "server.log"), "a");
  const env = { ...process.env, MOCKUP_DIR: designDir, MOCKUP_KIND: flags.once ? "once" : "design", MOCKUP_HARNESS: harness };
  delete env.MOCKUP_NAME;
  delete env.MOCKUP_THREAD;
  if (name) env.MOCKUP_NAME = name;
  if (thread) env.MOCKUP_THREAD = thread;
  const child = spawn(process.execPath, [join(APP, "server", "main.mjs")], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
    windowsHide: true,
  });
  child.unref();
  closeSync(log);

  // Two starts at once race for the session file; the loser exits, and this
  // command then reports whichever server won.
  let exited = false;
  child.on("exit", () => (exited = true));
  const deadline = Date.now() + 15000;
  let s = null;
  while (Date.now() < deadline) {
    s = session(designDir);
    if (s?.pid === child.pid || (exited && s && alive(s.pid))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!s || !alive(s.pid)) {
    const log = join(designDir, ".runtime", "server.log");
    const denied = existsSync(log) && /listen EPERM/.test(readFileSync(log, "utf8"));
    fail(denied ? SANDBOX_HINT : `server did not start; see ${log}`);
  }

  if (harness === "pi" && s.pid === child.pid) {
    mkdirSync(dirname(piLink(thread)), { recursive: true });
    writeFileSync(piLink(thread), JSON.stringify({ designDir, node: process.execPath, cli: fileURLToPath(import.meta.url) }));
  }

  printStart(s, designDir);
  if (!flags["no-open"]) openBrowser(urlOf(s));
}

function printStart(s, designDir) {
  console.log(`open: ${urlOf(s)}`);
  console.log(`dir: ${designDir}`);
  console.log(`next: write a page under ${join(designDir, "pages")}${sep}, then run: mockup show pages/<file>.html --dir ${designDir}`);
}

function openBrowser(link) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [link]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", link]]
    : ["xdg-open", [link]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

const DEVICES = ["phone", "tablet", "desktop", "fit"];

// Pages are named relative to the session folder; an absolute path inside it
// is made relative, and anything outside it is refused.
async function show(flags, rest) {
  const designDir = findDesignDir(flags);
  if (rest.length !== 1) fail("show needs exactly one PAGE");
  if (flags.device && !DEVICES.includes(flags.device)) fail(`--device must be one of ${DEVICES.join(", ")}`);
  const page = relative(designDir, resolve(designDir, rest[0]));
  if (!page || page.startsWith("..") || isAbsolute(page)) fail(`${rest[0]} is outside the session folder ${designDir}`);
  const path = page.split(sep).join("/");
  await api(designDir, "POST", "/api/agent/show", { pages: [path], title: flags.title, device: flags.device ?? "fit" });
  console.log(`showing: ${path}`);
  console.log(session(designDir).harness === "claude" ? "next: run `mockup wait` in the background" : "next: end your turn; the user's reply will arrive");
}

async function wait(flags) {
  const designDir = findDesignDir(flags);
  const { messages } = await api(designDir, "GET", `/api/agent/wait${flags.new ? "?new=1" : ""}`);
  if (flags.json) return console.log(JSON.stringify(messages, null, 2));
  console.log(format(messages, flags.for ?? "claude"));
}

const textArg = (rest) => (rest.length === 1 && rest[0] === "-" ? readFileSync(0, "utf8") : rest.join(" "));

async function say(flags, rest) {
  const designDir = findDesignDir(flags);
  const text = textArg(rest);
  if (!text.trim()) fail("say needs text");
  await api(designDir, "POST", "/api/agent/say", { text, progress: !!flags.progress });
  console.log("sent");
  if (!flags.progress && session(designDir).harness === "claude") console.log("next: run `mockup wait` again");
}

async function status(flags) {
  const designDir = findDesignDir(flags);
  const { messages, agent, showing } = await api(designDir, "GET", "/api/state");
  const s = session(designDir);
  const pending = messages.filter((m) => m.from === "user" && ["queued", "delivered"].includes(m.status));
  console.log(`session: ${s.name ?? "one-off"}   dir: ${designDir}`);
  console.log(`server: running at ${urlOf(s)}   harness: ${s.harness}   listening: ${agent?.listening ? "yes" : "no"}   pending: ${pending.length}`);
  console.log(`showing: ${showing?.pages?.join(", ") ?? "nothing"}`);
}

// Returns once the server has exited, so a start right after cannot collide
// with it.
async function stop(flags) {
  const designDir = findDesignDir(flags);
  const s = session(designDir);
  if (s && alive(s.pid)) {
    process.kill(s.pid, "SIGTERM");
    for (const deadline = Date.now() + 10000; alive(s.pid) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
    // On Windows the signal ends the server at once, before it can clean up;
    // release what it still holds.
    if (!alive(s.pid)) {
      const file = join(designDir, ".runtime", "session.json");
      try {
        if (JSON.parse(readFileSync(file, "utf8")).pid === s.pid) rmSync(file, { force: true });
      } catch {
        // Already gone.
      }
    }
  }
  // The Pi extension stops listening once its link is gone.
  if (s?.harness === "pi" && s.thread) {
    try {
      if (JSON.parse(readFileSync(piLink(s.thread), "utf8")).designDir === designDir) rmSync(piLink(s.thread), { force: true });
    } catch {
      // No link.
    }
  }
  if (!flags.quiet) console.log(`stopped ${designDir}`);
}

// Inside Codex's sandbox the server can neither listen nor be reached, and
// it would die with the command that started it. Codex sets
// CODEX_SANDBOX_NETWORK_DISABLED even for commands approved to run outside
// the sandbox, so it only explains a failure; it is never a reason to stop.
const inCodex = () => process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
const SANDBOX_HINT = "mockup has to run outside Codex's sandbox. Run this command again with escalated permissions (outside the sandbox); when Codex asks, approve \"don't ask again\" for commands starting with `mockup`.";

// Each command's options; parsing is strict, so an unknown flag is an error.
const dir = { dir: { type: "string" } };
const commands = {
  start: [start, {
    design: { type: "string" }, once: { type: "boolean" }, repo: { type: "string" },
    harness: { type: "string" }, thread: { type: "string" }, "no-open": { type: "boolean" },
  }],
  show: [show, { ...dir, title: { type: "string" }, device: { type: "string" } }, true],
  wait: [wait, { ...dir, json: { type: "boolean" }, for: { type: "string" }, new: { type: "boolean" } }],
  say: [say, { ...dir, progress: { type: "boolean" } }, true],
  status: [status, dir],
  stop: [stop, dir],
};

const [command, ...argv] = process.argv.slice(2);
// shot and handoff read rounds, which this version no longer has.
if (command === "shot" || command === "handoff") fail(`${command} is not available yet in this version`);
if (!commands[command]) fail("usage: mockup start|show|wait|say|status|stop (see the header of bin/mockup.mjs)");
const [run, options, allowPositionals = false] = commands[command];
let parsed;
try {
  parsed = parseArgs({ args: argv, options, strict: true, allowPositionals });
} catch (err) {
  fail(err.message);
}
await run(parsed.values, parsed.positionals);
