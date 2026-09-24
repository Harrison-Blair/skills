// CLI behaviour that only shows up across processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a failed install releases the install lock", () => {
  // A copy of the CLI whose lockfile makes `npm ci` fail immediately.
  const app = mkdtempSync(join(tmpdir(), "mockup-cli-"));
  for (const dir of ["bin", "lib"]) cpSync(join(APP, dir), join(app, dir), { recursive: true });
  writeFileSync(join(app, "package.json"), '{"name":"x","private":true}');
  writeFileSync(join(app, "package-lock.json"), "not json");
  const repo = mkdtempSync(join(tmpdir(), "mockup-cli-repo-"));
  const run = spawnSync(process.execPath, [join(app, "bin", "mockup.mjs"), "start", "--design", "x", "--no-open"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /npm ci .*failed/);
  assert.equal(existsSync(join(app, ".install-lock")), false);
  rmSync(app, { recursive: true, force: true });
});

test("two starts at once share one server", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mockup-cli-repo-"));
  const start = () => new Promise((ok) => {
    const child = spawn(process.execPath, [join(APP, "bin", "mockup.mjs"), "start", "--design", "twice", "--no-open"], { cwd: repo });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => ok({ code, out }));
  });
  const began = Date.now();
  const [a, b] = await Promise.all([start(), start()]);
  try {
    assert.ok(Date.now() - began < 10_000, "neither start waits for a timeout");
    const log = readFileSync(join(repo, ".design", "twice", ".runtime", "server.log"), "utf8");
    assert.equal(log.match(/listening on/g)?.length, 1, `exactly one server started:\n${log}`);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    const link = (r) => r.out.match(/(?:open|already running): (\S+)/)[1];
    assert.equal(link(a), link(b), "both report the same server");
    const lock = readFileSync(join(repo, ".design", "twice", ".runtime", "server.lock"), "utf8");
    const session = JSON.parse(readFileSync(join(repo, ".design", "twice", ".runtime", "session.json"), "utf8"));
    assert.equal(Number(lock), session.pid, "the running server holds the lock");
  } finally {
    spawnSync(process.execPath, [join(APP, "bin", "mockup.mjs"), "stop", "--dir", join(repo, ".design", "twice")]);
  }
  assert.equal(existsSync(join(repo, ".design", "twice", ".runtime", "server.lock")), false, "stop releases the lock");
});

test("a lock left by a crashed server is taken over cleanly", () => {
  const repo = mkdtempSync(join(tmpdir(), "mockup-cli-repo-"));
  const runtime = join(repo, ".design", "crashed", ".runtime");
  mkdirSync(runtime, { recursive: true });
  // A pid that is not running.
  writeFileSync(join(runtime, "server.lock"), "999999999");
  const mockup = (...args) => spawnSync(process.execPath, [join(APP, "bin", "mockup.mjs"), ...args], { cwd: repo, encoding: "utf8", timeout: 60_000 });
  const started = mockup("start", "--design", "crashed", "--no-open");
  try {
    assert.equal(started.status, 0, started.stderr);
    const session = JSON.parse(readFileSync(join(runtime, "session.json"), "utf8"));
    assert.equal(Number(readFileSync(join(runtime, "server.lock"), "utf8")), session.pid);
    assert.deepEqual(readdirSync(runtime).filter((f) => f.startsWith("server.lock.")), [], "no leftover temp files");
  } finally {
    mockup("stop", "--dir", join(repo, ".design", "crashed"));
  }
});

test("many servers racing for a free or crashed server's lock leave exactly one", async () => {
  for (let round = 0; round < 5; round++) {
    const designDir = join(mkdtempSync(join(tmpdir(), "mockup-lock-")), ".design", "race");
    const runtime = join(designDir, ".runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "server.lock"), "999999999");
    const servers = Array.from({ length: 8 }, () => spawn(process.execPath, [join(APP, "server", "main.mjs"), "--design-dir", designDir], { env: { ...process.env, MOCKUP_TOKEN: "t".repeat(43), MOCKUP_TEST_TAKEOVER_PAUSE_MS: "300" } }));
    const outcomes = await Promise.all(servers.map((child) => new Promise((ok) => {
      let out = "";
      child.stdout.on("data", (c) => {
        out += c;
        if (out.includes("listening on")) ok("listening");
      });
      child.on("exit", (code) => ok(`exit ${code}`));
    })));
    const running = outcomes.filter((o) => o === "listening").length;
    for (const child of servers) child.kill();
    assert.equal(running, 1, `round ${round}: ${outcomes.join(", ")}`);
  }
});

test("a lock mutex held by a live process is never taken over, however old", async () => {
  const designDir = join(mkdtempSync(join(tmpdir(), "mockup-lock-")), ".design", "held");
  const runtime = join(designDir, ".runtime");
  mkdirSync(runtime, { recursive: true });
  // A live process "holds" the mutex, frozen for a long time.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const mutex = join(runtime, "server.lock.recover");
  writeFileSync(mutex, String(holder.pid));
  const old = new Date(Date.now() - 60_000);
  utimesSync(mutex, old, old);
  const server = spawn(process.execPath, [join(APP, "server", "main.mjs"), "--design-dir", designDir], { env: { ...process.env, MOCKUP_TOKEN: "t".repeat(43) } });
  let out = "";
  server.stdout.on("data", (c) => (out += c));
  try {
    await new Promise((ok) => setTimeout(ok, 1500));
    assert.doesNotMatch(out, /listening/, "it waits for the live holder");
    holder.kill();
    await new Promise((ok) => holder.on("exit", ok));
    for (let i = 0; i < 50 && !out.includes("listening"); i++) await new Promise((ok) => setTimeout(ok, 100));
    assert.match(out, /listening/, "and goes ahead once the holder is gone");
  } finally {
    holder.kill();
    server.kill();
  }
});

// A stand-in `codex` on PATH that records how it was called.
function fakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), "mockup-fake-codex-"));
  const log = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "codex"), `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o755 });
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

async function post(designDir, path, body) {
  const s = JSON.parse(readFileSync(join(designDir, ".runtime", "session.json"), "utf8"));
  const res = await fetch(new URL(path, s.url), { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

test("with Codex, the server queues each browser message into the agent's session", { skip: process.platform === "win32" }, async () => {
  const codex = fakeCodex();
  const repo = mkdtempSync(join(tmpdir(), "mockup-cli-repo-"));
  const env = { ...process.env, PATH: codex.dir + (process.platform === "win32" ? ";" : ":") + process.env.PATH, CODEX_THREAD_ID: "thread-123" };
  delete env.PI_SESSION_ID;
  const run = (...args) => spawnSync(process.execPath, [join(APP, "bin", "mockup.mjs"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  const started = run("start", "--design", "cx", "--no-open");
  const designDir = join(repo, ".design", "cx");
  try {
    assert.equal(started.status, 0, started.stderr);
    const s = JSON.parse(readFileSync(join(designDir, ".runtime", "session.json"), "utf8"));
    assert.deepEqual([s.harness, s.thread], ["codex", "thread-123"], "harness and thread come from Codex's environment");
    await post(designDir, "/api/messages", { text: "make it calmer" });
    await post(designDir, "/api/messages", { text: "and bigger" });
    for (let i = 0; i < 50 && codex.calls().length < 2; i++) await new Promise((ok) => setTimeout(ok, 100));
    const calls = codex.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 4), ["queue", "--thread", "thread-123", "--message"]);
    assert.match(calls[0][4], /make it calmer/);
    assert.match(calls[1][4], /and bigger/, "in order");
    assert.match(calls[0][4], /end your turn: the next browser message arrives on its own\. Do not run `mockup wait`/);
    const state = await (await fetch(new URL("/api/state", s.url), { headers: { authorization: `Bearer ${s.token}` } })).json();
    assert.deepEqual(state.messages.map((m) => m.status), ["delivered", "delivered"]);

    // Codex marks even approved (unsandboxed) commands with this variable, so
    // it must not stop a command that can reach the server.
    const approved = spawnSync(process.execPath, [join(APP, "bin", "mockup.mjs"), "status", "--dir", designDir], { env: { ...env, CODEX_SANDBOX_NETWORK_DISABLED: "1" }, encoding: "utf8" });
    assert.equal(approved.status, 0, approved.stderr);

    // A new Codex session takes the design over.
    const again = spawnSync(process.execPath, [join(APP, "bin", "mockup.mjs"), "start", "--design", "cx", "--no-open"], { cwd: repo, env: { ...env, CODEX_THREAD_ID: "thread-456" }, encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    const s2 = JSON.parse(readFileSync(join(designDir, ".runtime", "session.json"), "utf8"));
    assert.equal(s2.thread, "thread-456");
    assert.notEqual(s2.pid, s.pid);
  } finally {
    run("stop", "--dir", designDir);
  }
});

test("inside Codex's sandbox, a server the command cannot see gets the way out", () => {
  const designDir = join(mkdtempSync(join(tmpdir(), "mockup-sandboxed-")), ".design", "x");
  mkdirSync(join(designDir, ".runtime"), { recursive: true });
  // From inside the sandbox's own process namespace, the server's pid is not visible.
  writeFileSync(join(designDir, ".runtime", "session.json"), JSON.stringify({ pid: 999999999, url: "http://127.0.0.1:9/", token: "t" }));
  const run = (env) => spawnSync(process.execPath, [join(APP, "bin", "mockup.mjs"), "say", "--dir", designDir, "hi"], { env: { ...process.env, ...env }, encoding: "utf8" });
  assert.match(run({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }).stderr, /outside Codex's sandbox.*don't ask again/);
  assert.match(run({ CODEX_SANDBOX_NETWORK_DISABLED: "" }).stderr, /is not running/);
});
