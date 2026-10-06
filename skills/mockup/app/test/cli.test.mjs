// The CLI against the real server, each command in its own process.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const runAsync = (args, { node = [], env = ENV } = {}) => new Promise((ok) => {
  const child = spawn(process.execPath, [...node, CLI, ...args], { env });
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

// --- what sits at the session.json path ---

// A command that has to return within 5 seconds.
function quick(args) {
  const began = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: tmpdir(), env: ENV, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
  assert.equal(r.signal, null, `${args[0]} did not return within 5 seconds`);
  assert.ok(Date.now() - began < 5000, `${args[0]} took ${Date.now() - began} ms`);
  assert.doesNotMatch(r.stderr, STACK);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The record `s` as JSON of exactly `size` bytes.
const padded = (s, size) => JSON.stringify({ ...s, padding: "x".repeat(size - JSON.stringify({ ...s, padding: "" }).length) });
const entry = (file) => lstatSync(file, { throwIfNoEntry: false });

// A real server in a folder of its own, which the entries below name.
let live = null;
function liveServer() {
  if (!live) {
    const { dir } = start(["--once"]);
    live = { dir, file: join(dir, ".runtime", "session.json"), s: session(dir) };
  }
  return live;
}

// What is not a regular file of at most 65536 bytes.
const ENTRIES = [
  ["a link to /dev/zero", (file) => symlinkSync("/dev/zero", file)],
  ["a link to a missing target", (file) => symlinkSync(join(dirname(file), "missing"), file)],
  ["a link to a valid session file elsewhere", (file, real) => symlinkSync(real.file, file)],
  ["a FIFO", (file) => assert.equal(spawnSync("mkfifo", [file]).status, 0)],
  ["a valid file of 65537 bytes", (file, real) => writeFileSync(file, padded(real.s, 65537))],
  ["a valid file of 5 MB", (file, real) => writeFileSync(file, padded(real.s, 5 * 1024 * 1024))],
  ["an empty directory", (file) => mkdirSync(file)],
  ["a directory with files in it", (file) => {
    mkdirSync(join(file, "inner"), { recursive: true });
    writeFileSync(join(file, "inner", "x"), "x");
  }],
];

for (const [what, make] of ENTRIES) {
  test(`a session.json that is ${what} is stale to status, stop and start`, UNIX, () => {
    const real = liveServer();
    const before = readFileSync(real.file);
    const repo = temp("mockup-entry-");
    const dir = join(repo, ".design", "d");
    const file = join(dir, ".runtime", "session.json");
    const put = () => {
      mkdirSync(join(dir, ".runtime"), { recursive: true });
      make(file, real);
    };
    put();
    const status = quick(["status", "--dir", dir]);
    assert.equal(status.code, 2, status.out);
    assert.equal(status.err, `mockup: no server is running in ${dir}; run \`mockup start\` again\n`);
    assert.ok(entry(file), "status leaves the entry");
    const stop = quick(["stop", "--dir", dir]);
    assert.equal(stop.code, 0, stop.err);
    assert.equal(stop.out, `stopped ${dir} (no server was running)\n`);
    assert.equal(entry(file), undefined, "stop removes the entry");
    put();
    const r = quick(["start", "--design", "d", "--repo", repo, "--no-open"]);
    started.add(dir);
    assert.equal(r.code, 0, r.err);
    assert.ok(entry(file).isFile(), "the new server wrote a regular file");
    const s = session(dir);
    assert.notEqual(s.id, real.s.id);
    assert.equal(r.out.match(/^open: (\S+)$/m)[1], `http://127.0.0.1:${s.port}/`);
    assert.match(quick(["status", "--dir", dir]).out, new RegExp(`server: running at http://127.0.0.1:${s.port}/`));
    assert.equal(alive(real.s.pid), true, "the server the entry named still runs");
    assert.deepEqual(readFileSync(real.file), before, "and its session.json is untouched");
  });
}

test("a valid session.json of exactly 65536 bytes is read", UNIX, () => {
  const repo = temp("mockup-entry-");
  const first = start(["--design", "d", "--repo", repo]);
  const file = join(first.dir, ".runtime", "session.json");
  const s = session(first.dir);
  writeFileSync(file, padded(s, 65536));
  assert.equal(readFileSync(file).length, 65536);
  const status = quick(["status", "--dir", first.dir]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, new RegExp(`server: running at http://127.0.0.1:${s.port}/`));
  const again = quick(["start", "--design", "d", "--repo", repo, "--no-open"]);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out, first.out);
  assert.equal(readFileSync(join(first.dir, ".runtime", "server.log"), "utf8").match(/listening on/g).length, 1, "no new server");
  const stop = quick(["stop", "--dir", first.dir]);
  assert.equal(stop.code, 0, stop.err);
  assert.equal(stop.out, `stopped ${first.dir}\n`);
  assert.equal(alive(s.pid), false);
});

for (const [what, make] of ENTRIES.slice(-2)) {
  test(`a session.json that is ${what} and cannot be removed fails stop and start with one line`, { ...UNIX, skip: UNIX.skip || process.getuid?.() === 0 }, () => {
    const repo = temp("mockup-entry-");
    const dir = join(repo, ".design", "d");
    const file = join(dir, ".runtime", "session.json");
    mkdirSync(join(dir, ".runtime"), { recursive: true });
    make(file);
    chmodSync(join(dir, ".runtime"), 0o555);
    try {
      assert.equal(quick(["status", "--dir", dir]).code, 2);
      for (const args of [["stop", "--dir", dir], ["start", "--design", "d", "--repo", repo, "--no-open"]]) {
        const r = quick(args);
        assert.equal(r.code, 1, args[0]);
        assert.equal(r.err, `mockup: cannot remove ${file}: EACCES\n`, args[0]);
        assert.equal(r.out, "", args[0]);
      }
      assert.ok(entry(file).isDirectory());
      assert.equal(existsSync(join(dir, ".runtime", "server.log")), false, "start spawned no server");
    } finally {
      chmodSync(join(dir, ".runtime"), 0o755);
    }
  });
}

// --- pids that are never signalled ---

// A preload for the CLI: process.kill records each call and sends nothing.
// It also writes down the CLI's own pid and its parent's for the stand-in.
function recorder() {
  const dir = temp("mockup-recorder-");
  const made = { preload: join(dir, "recorder.mjs"), calls: join(dir, "calls.jsonl"), pids: join(dir, "pids.json") };
  writeFileSync(made.preload, `
    import { appendFileSync, writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(made.pids)}, JSON.stringify({ self: process.pid, parent: process.ppid }));
    process.kill = (pid, signal) => {
      appendFileSync(${JSON.stringify(made.calls)}, JSON.stringify([pid ?? null, signal ?? null]) + "\\n");
      return true;
    };`);
  return made;
}

describe("stop never signals or probes a pid it must not", { concurrency: 12, timeout: 120_000 }, () => {
  const reported = (key) => (made) => `JSON.parse(require("fs").readFileSync(${JSON.stringify(made.pids)}, "utf8")).${key}`;
  const PIDS = [
    ["0", () => "0"], ["1", () => "1"], ["-1", () => "-1"], ["1.5", () => "1.5"], ['"abc"', () => '"abc"'], ["null", () => "null"],
    ["the CLI's own", reported("self")], ["the CLI's parent's", reported("parent")],
  ];
  for (const mode of ["hang", "500", "200"]) {
    for (const [what, pid] of PIDS) {
      test(`ping pid ${what}, stop request ${mode}`, UNIX, async () => {
        const made = recorder();
        const server = await standIn(mode, ["the-id"], pid(made));
        const dir = temp("mockup-standin-");
        staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
        const began = Date.now();
        const r = await runAsync(["stop", "--dir", dir], { node: ["--import", made.preload] });
        assert.ok(existsSync(made.pids), "the recorder was loaded");
        assert.equal(existsSync(made.calls) ? readFileSync(made.calls, "utf8") : "", "", "process.kill was called");
        assert.ok(Date.now() - began < 12_000, `took ${Date.now() - began} ms`);
        assert.equal(r.code, 1);
        assert.equal(r.err, `mockup: the server at http://127.0.0.1:${server.port}/ did not stop\n`);
        assert.equal(r.out, "");
        assert.equal(await state(server), "alive");
      });
    }
  }
});

// --- replies that never finish ---

// A stand-in server in its own process that answers /api/ping (when `pings`)
// and gives every other request the headers and part of a JSON body. `then`
// says what follows: "killed" leaves that to the test, which kills it 200 ms
// after the first partial reply; "destroyed" destroys the socket; "silent"
// sends nothing at all, not even the headers; "trickle" sends a space every
// 250 ms and never ends.
async function cutOff(then, pings = true) {
  const script = `
    const server = require("http").createServer((req, res) => {
      if (req.url === "/api/ping" && ${pings}) return res.end(JSON.stringify({ id: "the-id", pid: process.pid }));
      if (${JSON.stringify(then)} === "silent") return;
      res.writeHead(200, { "content-type": "application/json" });
      if (${JSON.stringify(then)} === "trickle") {
        res.write("{");
        const drip = setInterval(() => res.write(" "), 250);
        return req.on("close", () => clearInterval(drip));
      }
      res.write('{"messages":[{"text":"par', () => {
        if (${JSON.stringify(then)} === "destroyed") setTimeout(() => res.socket.destroy(), 50);
        else console.log("partial");
      });
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  strangers.push(child);
  let text = "";
  let partial;
  const sentPartial = new Promise((ok) => (partial = ok));
  const port = await new Promise((ok) => child.stdout.on("data", (c) => {
    text += c;
    const lines = text.split("\n");
    if (lines.length > 1) ok(Number(lines[0]));
    if (lines.includes("partial")) partial();
  }));
  if (then === "killed") sentPartial.then(() => setTimeout(() => child.kill("SIGKILL"), 200));
  return { child, port, exited: new Promise((ok) => child.on("exit", ok)) };
}

const lost = (port) => `mockup: lost the connection to the server at http://127.0.0.1:${port}/; run \`mockup status\`\n`;

for (const then of ["killed", "destroyed"]) {
  for (const command of ["status", "wait", "say", "show"]) {
    test(`${command} against a server whose reply is cut off (${then}) exits 2 with one line`, UNIX, async () => {
      const server = await cutOff(then);
      const dir = temp("mockup-cut-");
      staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
      const r = await runAsync([command, ...{ say: ["hello"], show: ["pages/x.html"] }[command] ?? [], "--dir", dir]);
      assert.equal(r.err, lost(server.port));
      assert.equal(r.code, 2);
      assert.equal(r.out, "");
    });
  }

  test(`stop against a server whose reply is cut off (${then}) ends with the server gone`, UNIX, async () => {
    const server = await cutOff(then);
    const dir = temp("mockup-cut-");
    staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
    const r = await runAsync(["stop", "--dir", dir]);
    assert.equal(r.err, "");
    assert.equal(r.code, 0);
    assert.equal(r.out, `stopped ${dir}\n`);
    assert.equal(await state(server), "gone");
    assert.equal(entry(join(dir, ".runtime", "session.json")), undefined);
  });

  test(`start over a server whose ping reply is cut off (${then}) starts a real server`, UNIX, async () => {
    const server = await cutOff(then, false);
    const repo = temp("mockup-cut-");
    const dir = join(repo, ".design", "d");
    staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
    const r = await runAsync(["start", "--design", "d", "--repo", repo, "--no-open"]);
    started.add(dir);
    assert.equal(r.err, "");
    assert.equal(r.code, 0);
    const s = session(dir);
    assert.notEqual(s.id, "the-id");
    assert.equal(r.out.match(/^open: (\S+)$/m)[1], `http://127.0.0.1:${s.port}/`);
    assert.equal(mockup(["status", "--dir", dir]).code, 0);
  });
}

test("start over a server whose ping reply trickles and never ends starts a real server", UNIX, async () => {
  const server = await cutOff("trickle", false);
  const repo = temp("mockup-cut-");
  const dir = join(repo, ".design", "d");
  staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
  const began = Date.now();
  const r = await runAsync(["start", "--design", "d", "--repo", repo, "--no-open"]);
  started.add(dir);
  const took = Date.now() - began;
  assert.equal(r.err, "");
  assert.equal(r.code, 0);
  assert.notEqual(session(dir).id, "the-id");
  assert.ok(took < 8000, `took ${took} ms`);
});

for (const value of ["-1", "0", "1.5", "abc", "", "1e12"]) {
  test(`MOCKUP_TIMEOUT_MS=${JSON.stringify(value)} is ignored without a warning`, UNIX, async () => {
    const server = await cutOff("destroyed");
    const dir = temp("mockup-cut-");
    staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
    const r = await runAsync(["status", "--dir", dir], { env: { ...ENV, MOCKUP_TIMEOUT_MS: value } });
    assert.equal(r.err, lost(server.port));
    assert.equal(r.code, 2);
  });
}

for (const command of ["status", "say", "show"]) {
  test(`${command} gives up on a server that accepts the request and sends nothing`, UNIX, async () => {
    const server = await cutOff("silent");
    const dir = temp("mockup-cut-");
    staleSession(dir, { id: "the-id", pid: server.child.pid, port: server.port });
    const began = Date.now();
    const r = await runAsync([command, ...{ say: ["hello"], show: ["pages/x.html"] }[command] ?? [], "--dir", dir], { env: { ...ENV, MOCKUP_TIMEOUT_MS: "1000" } });
    const took = Date.now() - began;
    assert.equal(r.err, lost(server.port));
    assert.equal(r.code, 2);
    assert.equal(r.out, "");
    assert.ok(took >= 1000 && took < 5000, `took ${took} ms`);
  });
}
