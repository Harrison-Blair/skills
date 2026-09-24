#!/usr/bin/env node
// mockup CLI: the agent's side of the browser loop.
//
//   mockup start --design NAME [--repo DIR] [--harness claude|codex|pi] [--thread ID] [--no-open]
//   mockup wait  [--dir DESIGN_DIR] [--json] [--for claude|pi]   (blocks until the user sends something; no time limit)
//   mockup say   [--dir DESIGN_DIR] [--progress] TEXT...   (TEXT "-" reads stdin)
//   mockup round [--dir DESIGN_DIR] --file ROUND.json [--stage S] [--title T] [--kind explore|draft]
//   mockup round [--dir DESIGN_DIR] --stage S --title T [--kind K] MARKDOWN...   (MARKDOWN "-" reads stdin)
//   mockup status [--dir DESIGN_DIR]
//   mockup stop  [--dir DESIGN_DIR]
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "../lib/format.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN_GITIGNORE = `# mockup: runtime state and third-party images stay local
*/.runtime/
*/assets/web/
*/renders/
`;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(message, code = 1) {
  console.error(`mockup: ${message}`);
  process.exit(code);
}

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) rest.push(arg);
    else if (["no-open", "json", "progress", "new"].includes(arg.slice(2))) flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = argv[++i];
  }
  return { flags, rest };
}

// --- app install/build, keyed on content hashes so updates are picked up ---

function hashFiles(paths) {
  const h = createHash("sha256");
  for (const p of paths) {
    h.update(relative(APP, p));
    h.update(readFileSync(p));
  }
  return h.digest("hex");
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  ).sort();
}

function withInstallLock(fn) {
  const lock = join(APP, ".install-lock");
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") fail(`cannot install the mockup app in ${APP} (${err.code}); run \`mockup start\` once where that folder is writable, for example outside a sandbox`);
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10 * 60 * 1000) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) fail(`another install holds ${lock}; remove it if no install is running`);
      else spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
    }
  }
  // fail() exits the process mid-install, which skips finally blocks; release
  // on exit too, or the next run would wait on a lock nobody holds.
  const release = () => rmSync(lock, { recursive: true, force: true });
  process.once("exit", release);
  try {
    return fn();
  } finally {
    release();
    process.off("exit", release);
  }
}

function npm(args) {
  console.error(`mockup: npm ${args.join(" ")}`);
  // Build chatter goes to stderr: stdout carries only the result (the link),
  // and a reader that stops early must not break the build.
  const r = spawnSync("npm", args, { cwd: APP, stdio: ["ignore", 2, 2], shell: process.platform === "win32" });
  if (r.status !== 0) fail(`npm ${args.join(" ")} failed`);
}

function ensureApp() {
  const depsStamp = join(APP, "node_modules", ".mockup-deps");
  const buildStamp = join(APP, "dist", ".mockup-build");
  const stale = () => {
    const deps = hashFiles([join(APP, "package-lock.json")]);
    const build = hashFiles([join(APP, "package-lock.json"), ...walk(join(APP, "client"))]);
    const current = (stamp, hash) => existsSync(stamp) && readFileSync(stamp, "utf8") === hash;
    return { deps, build, needDeps: !current(depsStamp, deps), needBuild: !current(buildStamp, build) };
  };
  // Nothing to do needs no lock, so a sandbox that cannot write here (Codex)
  // can still start once the app is installed.
  const first = stale();
  if (!first.needDeps && !first.needBuild) return;
  withInstallLock(() => {
    const now = stale();
    if (now.needDeps) {
      npm(["ci", "--no-audit", "--no-fund"]);
      writeFileSync(depsStamp, now.deps);
    }
    if (now.needBuild) {
      npm(["run", "build"]);
      writeFileSync(buildStamp, now.build);
    }
  });
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

async function api(designDir, method, path, body) {
  const s = session(designDir);
  if (!s || !alive(s.pid)) fail(`server for ${designDir} is not running; run \`mockup start\` again`, 2);
  // node:http rather than fetch: fetch abandons any response slower than five
  // minutes, and `wait` must be able to block for hours.
  const { status, data } = await new Promise((ok) => {
    const req = request(new URL(path, s.url), {
      method,
      headers: { authorization: `Bearer ${s.token}`, ...(body ? { "content-type": "application/json" } : {}) },
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
    req.on("error", (err) => fail(err.code === "EPERM" ? SANDBOX_HINT : `cannot reach the server at ${s.url}: ${err.code ?? err.message}`, 2));
    req.end(body ? JSON.stringify(body) : undefined);
  });
  if (status >= 400) fail(`${method} ${path}: ${data.error ?? status}`);
  return data;
}

// --- commands ---

// Where the Pi extension looks for this session's mockup server.
const piLink = (sessionId) => join(process.env.MOCKUP_HOME ?? join(homedir(), ".mockup"), "pi", `${sessionId}.json`);

async function start(flags) {
  const name = flags.design;
  if (!name || !NAME.test(name)) fail("--design NAME is required (lowercase letters, digits, hyphens)");
  // The harness and its session come from the environment it gives commands,
  // unless named.
  const harness = flags.harness ?? (process.env.CODEX_THREAD_ID ? "codex" : process.env.PI_SESSION_ID ? "pi" : "claude");
  if (!["claude", "codex", "pi"].includes(harness)) fail(`unknown --harness ${harness}`);
  const thread = flags.thread ?? { codex: process.env.CODEX_THREAD_ID, pi: process.env.PI_SESSION_ID }[harness] ?? null;
  if (harness !== "claude" && !thread) fail(`--harness ${harness} needs its session: run inside ${harness}, or pass --thread ID`);
  const repo = resolve(flags.repo ?? process.cwd());
  const designRoot = join(repo, ".design");
  const designDir = join(designRoot, name);
  mkdirSync(join(designDir, ".runtime"), { recursive: true });
  if (!existsSync(join(designRoot, ".gitignore"))) writeFileSync(join(designRoot, ".gitignore"), DESIGN_GITIGNORE);

  const existing = session(designDir);
  if (existing && alive(existing.pid)) {
    if (existing.harness === harness && (existing.thread ?? null) === thread) {
      console.log(`already running: ${existing.url}?token=${existing.token}`);
      console.log(`design dir: ${designDir}`);
      return;
    }
    // A new agent session takes the design over; messages are kept on disk.
    await stop({ dir: designDir, quiet: true });
  }

  ensureApp();

  const token = randomBytes(32).toString("base64url");
  const log = openSync(join(designDir, ".runtime", "server.log"), "a");
  const args = [join(APP, "server", "main.mjs"), "--design-dir", designDir, "--harness", harness];
  if (thread) args.push("--thread", thread);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, MOCKUP_TOKEN: token },
    windowsHide: true,
  });
  child.unref();
  closeSync(log);

  // Two starts at once race for the design's lock; the loser exits, and this
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
  if (!s || !alive(s.pid)) fail(`server did not start; see ${join(designDir, ".runtime", "server.log")}`);

  if (harness === "pi" && s.pid === child.pid) {
    mkdirSync(dirname(piLink(thread)), { recursive: true });
    writeFileSync(piLink(thread), JSON.stringify({ designDir, node: process.execPath, cli: fileURLToPath(import.meta.url) }));
  }

  const link = `${s.url}?token=${s.token}`;
  console.log(`open: ${link}`);
  console.log(`design dir: ${designDir}`);
  if (!flags["no-open"]) openBrowser(link);
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

// Titles for round items, so the agent reads "Calm paper", not an id.
// The agent's own path for a published image copy, when the round has it.
async function wait(flags) {
  const designDir = findDesignDir(flags);
  const { messages } = await api(designDir, "GET", `/api/agent/wait${flags.new ? "?new=1" : ""}`);
  if (flags.json) return console.log(JSON.stringify(messages, null, 2));
  const { rounds } = await api(designDir, "GET", "/api/state");
  console.log(format(messages, rounds, designDir, flags.for ?? "claude"));
}

const textArg = (rest) => (rest.length === 1 && rest[0] === "-" ? readFileSync(0, "utf8") : rest.join(" "));

async function say(flags, rest) {
  const designDir = findDesignDir(flags);
  const text = textArg(rest);
  if (!text.trim()) fail("say needs text");
  await api(designDir, "POST", "/api/agent/say", { text, progress: !!flags.progress });
}

// A JSON file (--file) holds a structured round; flags fill in or override its
// stage, title and kind. Without --file the text is one Markdown page.
async function round(flags, rest) {
  const designDir = findDesignDir(flags);
  let spec = {};
  if (flags.file) {
    try {
      spec = JSON.parse(readFileSync(flags.file === "-" ? 0 : flags.file, "utf8"));
    } catch (err) {
      fail(`cannot read round JSON from ${flags.file}: ${err.message}`);
    }
  } else spec.body = textArg(rest);
  for (const key of ["stage", "title", "kind"]) if (flags[key]) spec[key] = flags[key];
  const r = await api(designDir, "POST", "/api/agent/round", spec);
  console.log(`published round ${r.id}`);
}

async function status(flags) {
  const designDir = findDesignDir(flags);
  const s = session(designDir);
  const { messages, agent } = await api(designDir, "GET", "/api/state");
  const pending = messages.filter((m) => m.from === "user" && ["queued", "delivered"].includes(m.status));
  console.log(JSON.stringify({ designDir, url: s.url, harness: s.harness, pid: s.pid, agent, pending: pending.length }, null, 2));
}

// Returns once the server has exited, so a start right after cannot collide
// with it.
async function stop(flags) {
  const designDir = findDesignDir(flags);
  const s = session(designDir);
  if (s && alive(s.pid)) {
    process.kill(s.pid, "SIGTERM");
    for (const deadline = Date.now() + 10000; alive(s.pid) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
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
// it would die with the command that started it.
const SANDBOX_HINT = "mockup has to run outside Codex's sandbox. Run this command again with escalated permissions (outside the sandbox); when Codex asks, approve \"don't ask again\" for commands starting with `mockup`.";

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parse(argv);
if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") fail(SANDBOX_HINT);
const commands = { start, wait, say: (f) => say(f, rest), round: (f) => round(f, rest), status, stop };
if (!commands[command]) fail("usage: mockup start|wait|say|round|status|stop (see the header of bin/mockup.mjs)");
await commands[command](flags);
