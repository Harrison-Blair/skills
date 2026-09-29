// The CLI against the real server, each command in its own process.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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

test("inside Codex's sandbox, a server the command cannot see gets the way out", () => {
  const dir = temp("mockup-sandboxed-");
  mkdirSync(join(dir, ".runtime"));
  // From inside the sandbox's own process namespace, the server's pid is not visible.
  writeFileSync(join(dir, ".runtime", "session.json"), JSON.stringify({ pid: 999999999, port: 9 }));
  const say = (extra) => mockup(["say", "--dir", dir, "hi"], { env: { ...ENV, ...extra } });
  assert.match(say({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }).err, /outside Codex's sandbox.*don't ask again/);
  assert.match(say({}).err, /no server is running/);
});
