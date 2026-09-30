// The CLI against the real server, each command in its own process.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "../lib/format.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mockup.mjs");
const ENV = { ...process.env };
for (const k of ["CODEX_THREAD_ID", "PI_SESSION_ID", "MOCKUP_DIR", "CODEX_SANDBOX_NETWORK_DISABLED"]) delete ENV[k];
const started = new Set();
const temps = [];
const temp = (prefix) => {
  temps.push(mkdtempSync(join(tmpdir(), prefix)));
  return temps.at(-1);
};

const mockup = (args, { cwd = tmpdir(), env = ENV } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

function start(args, options) {
  const r = mockup(["start", "--no-open", ...args], options);
  assert.equal(r.code, 0, r.err);
  const dir = r.out.match(/^dir: (.+)$/m)[1];
  started.add(dir);
  return { ...r, dir };
}

const session = (dir) => JSON.parse(readFileSync(join(dir, ".runtime", "session.json"), "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A browser request to the session's server: node:http, no Origin, like the shell.
function post(dir, path, body) {
  const { port } = session(dir);
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", fail);
    req.end(JSON.stringify(body));
  });
}

function page(dir, rel, html = "<h1>Ask</h1>") {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), html);
}

after(() => {
  for (const dir of started) mockup(["stop", "--dir", dir]);
  for (const dir of [...started, ...temps]) rmSync(dir, { recursive: true, force: true });
});

test("an unknown flag is an error that names it", () => {
  const r = mockup(["status", "--bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--bogus/);
});

test("no command and an unknown command print usage", () => {
  for (const args of [[], ["frobnicate"]]) {
    const r = mockup(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /usage: mockup start\|show\|wait\|say\|status\|stop/);
  }
});

test("status with no server exits 2", () => {
  const r = mockup(["status", "--dir", temp("mockup-cli-empty-")]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no server is running/);
});

test("start --once makes a temp session folder and prints the three lines", () => {
  const { out, dir } = start(["--once", "--harness", "claude"]);
  const s = session(dir);
  assert.equal(out, [
    `open: http://127.0.0.1:${s.port}/`,
    `dir: ${dir}`,
    `next: write a page under ${join(dir, "pages")}${sep}, then run: mockup show pages/<file>.html --dir ${dir}`,
    "",
  ].join("\n"));
  assert.ok(dir.startsWith(tmpdir()), dir);
  assert.ok(existsSync(join(dir, "pages")));
  assert.deepEqual([s.kind, s.name, s.harness, s.dir], ["once", null, "claude", dir]);
});

test("start --design makes .design/NAME, and a second start reuses the running server", () => {
  const repo = temp("mockup-cli-repo-");
  const first = start(["--design", "shop", "--repo", repo]);
  assert.equal(first.dir, join(repo, ".design", "shop"));
  assert.ok(existsSync(join(repo, ".design", ".gitignore")));
  const s = session(first.dir);
  assert.deepEqual([s.kind, s.name], ["design", "shop"]);

  const second = start(["--design", "shop", "--repo", repo]);
  assert.equal(second.out, first.out);
  assert.equal(session(first.dir).pid, s.pid, "no new server");
  const log = readFileSync(join(first.dir, ".runtime", "server.log"), "utf8");
  assert.equal(log.match(/listening on/g).length, 1, log);
});

test("two starts at once share one server", async () => {
  const repo = temp("mockup-cli-repo-");
  started.add(join(repo, ".design", "twice"));
  const run = () => new Promise((ok) => {
    const child = spawn(process.execPath, [CLI, "start", "--design", "twice", "--repo", repo, "--no-open"], { env: ENV });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => ok({ code, out }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  assert.equal(a.out, b.out, "both report the same server");
  const log = readFileSync(join(repo, ".design", "twice", ".runtime", "server.log"), "utf8");
  assert.equal(log.match(/listening on/g).length, 1, log);
});

test("show takes a path relative to or inside the session folder, and refuses others", () => {
  const { dir } = start(["--once"]);
  page(dir, "pages/ask.html");
  for (const arg of ["pages/ask.html", join(dir, "pages", "ask.html")]) {
    const r = mockup(["show", "--dir", dir, arg]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "showing: pages/ask.html\nnext: run `mockup wait` in the background\n");
  }
  for (const arg of ["../outside.html", join(tmpdir(), "outside.html")]) {
    const r = mockup(["show", "--dir", dir, arg]);
    assert.equal(r.code, 1, arg);
    assert.match(r.err, /is outside the session folder/);
  }
  const missing = mockup(["show", "--dir", dir, "pages/nope.html"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /pages\/nope\.html is not a file under pages\//);
});

test("status, wait, say and stop", async () => {
  const { dir } = start(["--once"]);
  const s = session(dir);
  const status = () => mockup(["status", "--dir", dir]);
  const lines = (pending, showing) => [
    `session: one-off   dir: ${dir}`,
    `server: running at http://127.0.0.1:${s.port}/   harness: claude   listening: no   pending: ${pending}`,
    `showing: ${showing}`,
    "",
  ].join("\n");
  assert.equal(status().out, lines(0, "nothing"));

  page(dir, "pages/ask.html");
  mockup(["show", "--dir", dir, "pages/ask.html"]);
  const drafts = [{ id: "choice:nav", kind: "choice", name: "nav", label: "Which navigation?", value: ["Tabs"], written: [] }];
  const sent = await post(dir, "/api/messages", { text: "Keep it simple.", page: "pages/ask.html", drafts });
  assert.equal(sent.status, 201);
  assert.equal(status().out, lines(1, "pages/ask.html"));

  const text = mockup(["wait", "--dir", dir]);
  assert.equal(text.code, 0, text.err);
  assert.equal(text.out, format([sent.body], "claude") + "\n");
  assert.match(text.out, /^\* chose "Tabs" for nav "Which navigation\?"$/m);

  const progress = mockup(["say", "--dir", dir, "--progress", "working"]);
  assert.equal(progress.out, "sent\n");
  assert.equal(status().out, lines(1, "pages/ask.html"), "progress leaves the message open");
  const final = mockup(["say", "--dir", dir, "Got", "it"]);
  assert.equal(final.out, "sent\nnext: run `mockup wait` again\n");
  assert.equal(status().out, lines(0, "pages/ask.html"));

  const second = await post(dir, "/api/messages", { text: "one more" });
  const json = mockup(["wait", "--dir", dir, "--json"]);
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(JSON.parse(json.out).map((m) => [m.id, m.text, m.status]), [[second.body.id, "one more", "delivered"]]);

  const stopped = mockup(["stop", "--dir", dir]);
  assert.equal(stopped.out, `stopped ${dir}\n`);
  assert.equal(alive(s.pid), false);
  assert.equal(status().code, 2);
});

test("a final say prints no next line for Codex", () => {
  const { dir } = start(["--once", "--harness", "codex", "--thread", "t-1"]);
  const r = mockup(["say", "--dir", dir, "hello"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "sent\n");
});

test("shot and handoff are not available yet", () => {
  for (const command of ["shot", "handoff"]) {
    const r = mockup([command]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `mockup: ${command} is not available yet in this version\n`);
  }
});

// A stand-in `codex` on PATH that records how it was called.
function fakeCodex() {
  const dir = temp("mockup-fake-codex-");
  const log = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "codex"), `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o755 });
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

test("with Codex, the server queues each browser message into the agent's session", { skip: process.platform === "win32" }, async () => {
  const codex = fakeCodex();
  const repo = temp("mockup-cli-repo-");
  const env = { ...ENV, PATH: `${codex.dir}:${ENV.PATH}`, CODEX_THREAD_ID: "thread-123" };
  const { dir } = start(["--design", "cx", "--repo", repo], { env });
  const s = session(dir);
  assert.deepEqual([s.harness, s.thread], ["codex", "thread-123"], "harness and thread come from Codex's environment");

  const first = await post(dir, "/api/messages", { text: "make it calmer" });
  await post(dir, "/api/messages", { text: "and bigger" });
  for (let i = 0; i < 50 && codex.calls().length < 2; i++) await new Promise((ok) => setTimeout(ok, 100));
  const calls = codex.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 4), ["queue", "--thread", "thread-123", "--message"]);
  assert.equal(calls[0][4], format([first.body], "codex"));
  assert.match(calls[1][4], /and bigger/, "in order");
  assert.match(calls[0][4], /then end your turn\.$/);

  // Codex marks even approved (unsandboxed) commands with this variable, so
  // it must not stop a command that can reach the server.
  const approved = mockup(["status", "--dir", dir], { env: { ...env, CODEX_SANDBOX_NETWORK_DISABLED: "1" } });
  assert.equal(approved.code, 0, approved.err);
  assert.match(approved.out, /pending: 2/, "delivered but not answered");

  // A new Codex session takes the design over.
  start(["--design", "cx", "--repo", repo], { env: { ...env, CODEX_THREAD_ID: "thread-456" } });
  const s2 = session(dir);
  assert.equal(s2.thread, "thread-456");
  assert.notEqual(s2.pid, s.pid);
  assert.equal(alive(s.pid), false);
});

// A process that is not a mockup server, and a port where nothing answers.
async function stranger() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  strangers.push(child);
  const probe = createServer();
  await new Promise((ok) => probe.listen(0, "127.0.0.1", ok));
  const port = probe.address().port;
  await new Promise((ok) => probe.close(ok));
  return { pid: child.pid, port };
}
const strangers = [];
after(() => {
  for (const child of strangers) child.kill();
});

// A session.json left behind, naming a pid and port that are not its server.
function staleSession(dir, { pid, port, id = "stale-id", harness = "claude", thread = null }) {
  mkdirSync(join(dir, ".runtime"), { recursive: true });
  mkdirSync(join(dir, "pages"), { recursive: true });
  const s = { id, pid, port, url: `http://127.0.0.1:${port}/`, kind: "once", name: null, dir, harness, thread, startedAt: new Date().toISOString() };
  writeFileSync(join(dir, ".runtime", "session.json"), JSON.stringify(s));
  return s;
}

test("start with a session.json naming a live stranger starts a real server", async () => {
  const other = await stranger();
  const repo = temp("mockup-stale-repo-");
  const design = join(repo, ".design", "d");
  staleSession(design, other);
  const again = mockup(["start", "--design", "d", "--repo", repo, "--no-open"]);
  started.add(design);
  assert.equal(again.code, 0, again.err);
  const s = session(design);
  assert.notEqual(s.id, "stale-id", "a new server wrote its own session.json");
  assert.equal(again.out.match(/^open: (\S+)$/m)[1], `http://127.0.0.1:${s.port}/`);
  assert.notEqual(s.port, other.port);
  assert.equal(mockup(["status", "--dir", design]).code, 0);
  assert.equal(alive(other.pid), true);
});

test("stop with a session.json naming a live stranger signals nothing", async () => {
  const other = await stranger();
  const dir = temp("mockup-stale-");
  staleSession(dir, other);
  const r = mockup(["stop", "--dir", dir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `stopped ${dir} (no server was running)\n`);
  assert.equal(existsSync(join(dir, ".runtime", "session.json")), false, "the stale file is removed");
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(alive(other.pid), true, "the unrelated process is still alive");
});

test("a port where another session's server answers is neither reused nor stopped", async () => {
  const other = await stranger();
  const { dir: otherDir } = start(["--once"]);
  const theirs = session(otherDir);
  const before = readFileSync(join(otherDir, ".runtime", "session.json"));
  const repo = temp("mockup-stale-repo-");
  const dir = join(repo, ".design", "d");
  staleSession(dir, { pid: other.pid, port: theirs.port });

  const stopped = mockup(["stop", "--dir", dir]);
  assert.equal(stopped.out, `stopped ${dir} (no server was running)\n`);
  staleSession(dir, { pid: other.pid, port: theirs.port });
  const r = mockup(["start", "--design", "d", "--repo", repo, "--no-open"]);
  started.add(dir);
  assert.equal(r.code, 0, r.err);
  assert.notEqual(session(dir).port, theirs.port, "not reused");
  assert.equal(alive(theirs.pid), true, "the other server still runs");
  assert.equal(alive(other.pid), true);
  assert.deepEqual(readFileSync(join(otherDir, ".runtime", "session.json")), before, "its session.json is untouched");
  assert.match(mockup(["status", "--dir", otherDir]).out, /server: running/);
});

test("a harness takeover over a stale session.json signals nothing", async () => {
  const other = await stranger();
  const repo = temp("mockup-stale-repo-");
  const dir = join(repo, ".design", "d");
  staleSession(dir, { ...other, harness: "claude" });
  const r = mockup(["start", "--design", "d", "--repo", repo, "--no-open", "--harness", "codex", "--thread", "t-9"]);
  started.add(dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([session(dir).harness, session(dir).thread], ["codex", "t-9"]);
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(alive(other.pid), true, "the unrelated process is still alive");
});

test("stop asks the server to stop; it removes its session.json and exits", () => {
  const { dir } = start(["--once"]);
  const s = session(dir);
  const r = mockup(["stop", "--dir", dir]);
  assert.equal(r.out, `stopped ${dir}\n`);
  assert.equal(alive(s.pid), false);
  assert.equal(existsSync(join(dir, ".runtime", "session.json")), false);
  assert.match(readFileSync(join(dir, ".runtime", "server.log"), "utf8"), /stop requested/);
});

// Session files the CLI must treat as stale, whatever they hold.
const BAD_FILES = [
  ["empty", ""],
  ["not JSON", "{nope"],
  ["null", "null"],
  ["an array", "[]"],
  ["an empty object", "{}"],
  ["id missing", { port: 1 }],
  ["id a number", { id: 7 }],
  ["id empty", { id: "" }],
  ["port a string", { port: "80" }],
  ["port 0", { port: 0 }],
  ["port -1", { port: -1 }],
  ["port 70000", { port: 70000 }],
  ["port 1.5", { port: 1.5 }],
  ["pid missing", { pid: undefined }],
];
const STACK = /at (file:|node:|\/|[A-Z]:\\)/;

for (const [what, content] of BAD_FILES) {
  test(`a session.json that is ${what} is stale to status, stop and start`, async () => {
    const other = await stranger();
    const repo = temp("mockup-bad-file-");
    const dir = join(repo, ".design", "d");
    const write = () => {
      mkdirSync(join(dir, ".runtime"), { recursive: true });
      const text = typeof content === "string" ? content : JSON.stringify({ id: "bad-id", pid: other.pid, port: other.port, ...content });
      writeFileSync(join(dir, ".runtime", "session.json"), text);
    };
    write();
    const status = mockup(["status", "--dir", dir]);
    assert.equal(status.code, 2, status.err);
    assert.equal(status.err, `mockup: no server is running in ${dir}; run \`mockup start\` again\n`);
    const stop = mockup(["stop", "--dir", dir]);
    assert.equal(stop.code, 0, stop.err);
    assert.equal(stop.out, `stopped ${dir} (no server was running)\n`);
    assert.equal(existsSync(join(dir, ".runtime", "session.json")), false);
    write();
    const r = mockup(["start", "--design", "d", "--repo", repo, "--no-open"]);
    started.add(dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(session(dir).id !== "bad-id", true);
    assert.equal(mockup(["status", "--dir", dir]).code, 0);
    for (const err of [status.err, stop.err, r.err]) assert.doesNotMatch(err, STACK);
    assert.equal(alive(other.pid), true);
  });
}

// True when something answers on the URL a server logged.
const answering = (url) => new Promise((ok) => {
  const req = request(new URL("/api/ping", url), { timeout: 1000 }, (res) => ok(res.resume() && true));
  req.on("timeout", () => req.destroy());
  req.on("error", () => ok(false));
  req.end();
});

test("a start that fails after starting its server leaves no server running", { skip: process.platform === "win32" }, async () => {
  // The Pi link is written after the server is up; a file where its folder
  // should be makes that fail.
  const home = join(temp("mockup-home-"), "not-a-folder");
  writeFileSync(home, "");
  const repo = temp("mockup-fail-repo-");
  const dir = join(repo, ".design", "d");
  started.add(dir);
  const r = mockup(["start", "--design", "d", "--repo", repo, "--no-open", "--harness", "pi", "--thread", "p-1"], { env: { ...ENV, MOCKUP_HOME: home } });
  assert.equal(r.code, 1);
  assert.match(r.err, /^mockup: [^\n]+\n$/);
  assert.doesNotMatch(r.err, STACK);
  const url = readFileSync(join(dir, ".runtime", "server.log"), "utf8").match(/listening on (\S+)/)[1];
  let up = true;
  for (let i = 0; i < 50 && up; i++) {
    up = await answering(url);
    if (up) await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.equal(up, false, "the server it started is gone");
});

// A stand-in server in its own process: answers /api/ping with the ids given
// in turn (the last one from then on) and handles the stop request as told.
// `pid` is the expression whose value its ping reports as the pid.
async function standIn(stopMode, ids, pid = "process.pid") {
  const script = `
    const ids = ${JSON.stringify(ids)};
    let pings = 0;
    const server = require("http").createServer((req, res) => {
      if (req.url === "/api/ping") return res.end(JSON.stringify({ id: ids[Math.min(pings++, ids.length - 1)], pid: ${pid} }));
      if (req.url === "/api/agent/stop") {
        if (${JSON.stringify(stopMode)} === "hang") return;
        if (${JSON.stringify(stopMode)} === "exit") return res.end("{}", () => process.exit(0));
        if (${JSON.stringify(stopMode)} === "linger") {
          server.close();
          setTimeout(() => process.exit(0), 1500);
          return res.end("{}", () => server.closeAllConnections());
        }
        res.statusCode = ${JSON.stringify(stopMode)} === "500" ? 500 : 200;
        return res.end("{}");
      }
      res.statusCode = 404;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  strangers.push(child);
  const port = await new Promise((ok) => child.stdout.once("data", (c) => ok(Number(String(c).trim()))));
  const exited = new Promise((ok) => child.on("exit", ok));
  return { child, port, exited };
}

const runAsync = (args) => new Promise((ok) => {
  const child = spawn(process.execPath, [CLI, ...args], { env: ENV });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.on("exit", (code) => ok({ code, out, err }));
});

for (const mode of ["hang", "500", "200"]) {
  test(`stop ends a confirmed server whose stop request ${mode === "hang" ? "never answers" : `answers ${mode} without exiting`}`, { timeout: 30_000, skip: process.platform === "win32" }, async () => {
    const server = await standIn(mode, ["the-id"]);
    const dir = temp("mockup-standin-");
    staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
    const began = Date.now();
    const r = await runAsync(["stop", "--dir", dir]);
    assert.ok(Date.now() - began < 12_000, `took ${Date.now() - began} ms`);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `stopped ${dir}\n`);
    assert.equal(await Promise.race([server.exited.then(() => "gone"), new Promise((ok) => setTimeout(() => ok("alive"), 2000))]), "gone");
  });

  test(`stop signals nothing when the server's id changes (stop request ${mode})`, { timeout: 30_000, skip: process.platform === "win32" }, async () => {
    const server = await standIn(mode, ["the-id", "another-id"]);
    const dir = temp("mockup-standin-");
    staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
    const began = Date.now();
    const r = await runAsync(["stop", "--dir", dir]);
    assert.ok(Date.now() - began < 12_000, `took ${Date.now() - began} ms`);
    assert.doesNotMatch(r.err, STACK);
    assert.equal(alive(server.child.pid), true, "nothing was signalled");
  });
}

const UNIX = { timeout: 30_000, skip: process.platform === "win32" };
const state = (server) => Promise.race([server.exited.then(() => "gone"), new Promise((ok) => setTimeout(() => ok("alive"), 2000))]);

// Runs stop against a stand-in whose session.json records `pid`, and checks
// the time limit and that no failure shows a stack trace.
async function stopStandIn(server, pid) {
  const dir = temp("mockup-standin-");
  staleSession(dir, { id: "the-id", pid, port: server.port });
  const began = Date.now();
  const r = await runAsync(["stop", "--dir", dir]);
  assert.ok(Date.now() - began < 12_000, `took ${Date.now() - began} ms`);
  assert.doesNotMatch(r.err, STACK);
  return { ...r, dir, file: join(dir, ".runtime", "session.json") };
}

test("stop with no recorded pid reports a server that exits on the stop request as stopped", UNIX, async () => {
  const server = await standIn("exit", ["the-id"]);
  const r = await stopStandIn(server, undefined);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `stopped ${r.dir}\n`);
  assert.equal(await state(server), "gone");
  assert.equal(existsSync(r.file), false, "the session.json nothing answers for is removed");
});

test("stop returns only once a server that stopped answering has exited", UNIX, async () => {
  const server = await standIn("linger", ["the-id"]);
  const r = await stopStandIn(server, undefined);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `stopped ${r.dir}\n`);
  assert.equal(await Promise.race([server.exited.then(() => "gone"), new Promise((ok) => setTimeout(() => ok("alive"), 200))]), "gone");
});

// Recorded pids that cannot be signalled; the server's own ping supplies it.
const BAD_PIDS = [["missing", undefined], ['"abc"', "abc"], ["0", 0], ["-1", -1], ["1.5", 1.5], ["null", null]];

for (const [what, pid] of BAD_PIDS) {
  test(`stop with a recorded pid that is ${what} ends a server that ignores the stop request, by the pid its ping reports`, UNIX, async () => {
    const server = await standIn("200", ["the-id"]);
    const r = await stopStandIn(server, pid);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `stopped ${r.dir}\n`);
    assert.equal(await state(server), "gone");
  });

  test(`stop with a recorded pid and a ping pid that are ${what} signals nothing and says the server did not stop`, UNIX, async () => {
    const server = await standIn("200", ["the-id"], JSON.stringify(pid) ?? "undefined");
    const r = await stopStandIn(server, pid);
    assert.equal(r.code, 1);
    assert.equal(r.err, `mockup: the server at http://127.0.0.1:${server.port}/ did not stop\n`);
    assert.equal(r.out, "");
    assert.equal(await state(server), "alive");
  });
}

test("stop never signals the recorded pid when the ping reports none", UNIX, async () => {
  const server = await standIn("200", ["the-id"], "undefined");
  const r = await stopStandIn(server, server.child.pid);
  assert.equal(r.code, 1);
  assert.equal(r.err, `mockup: the server at http://127.0.0.1:${server.port}/ did not stop\n`);
  assert.equal(await state(server), "alive");
});

test("stop with a recorded pid of an unrelated process signals the server the ping names, not that process", UNIX, async () => {
  const other = await stranger();
  const server = await standIn("hang", ["the-id"]);
  const r = await stopStandIn(server, other.pid);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `stopped ${r.dir}\n`);
  assert.equal(await state(server), "gone");
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(alive(other.pid), true, "the unrelated process is still alive");
});

test("stop leaves alone a server that answers later pings with another id", UNIX, async () => {
  const server = await standIn("200", ["the-id", "another-id"]);
  const r = await stopStandIn(server, server.child.pid);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `stopped ${r.dir} (no server was running)\n`);
  assert.equal(await state(server), "alive");
  assert.equal(existsSync(r.file), false, "our stale session.json is removed");
});

test("inside Codex's sandbox, a server the command cannot see gets the way out", () => {
  const dir = temp("mockup-sandboxed-");
  mkdirSync(join(dir, ".runtime"));
  // From inside the sandbox's own process namespace, the server's pid is not visible.
  writeFileSync(join(dir, ".runtime", "session.json"), JSON.stringify({ pid: 999999999, port: 9 }));
  const say = (extra) => mockup(["say", "--dir", dir, "hi"], { env: { ...ENV, ...extra } });
  assert.match(say({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }).err, /outside Codex's sandbox.*don't ask again/);
  assert.match(say({}).err, /no server is running/);
});
