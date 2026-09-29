import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/server.mjs";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "main.mjs");
const SESSION = { id: "session-id", kind: "once", name: null, harness: "claude" };
let app, port, dir, fixtures;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mockup-server-"));
  fixtures = mkdtempSync(join(tmpdir(), "mockup-fixtures-"));
  mkdirSync(join(fixtures, "shell"));
  mkdirSync(join(fixtures, "kit"));
  writeFileSync(join(fixtures, "shell", "index.html"), "<html>shell</html>");
  writeFileSync(join(fixtures, "shell", "app.js"), "shell();");
  writeFileSync(join(fixtures, "secret.txt"), "SECRET");
  page("pages/ask.html", "<html><body><p>Ask</p></body></html>");
  app = createServer({ dir, session: SESSION, stallMs: 200, shellDir: join(fixtures, "shell"), kitDir: join(fixtures, "kit") });
  port = await app.listen(0);
});
afterEach(() => app.close());

function page(rel, content) {
  mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, ...rel.split("/")), content);
  return rel;
}

// Raw requests so tests control Host, Origin and sec-fetch-* exactly.
function call(method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({
      host: "127.0.0.1", port, method, path,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        ok({
          status: res.statusCode,
          headers: res.headers,
          bytes,
          body: res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(bytes) : bytes.toString("utf8"),
        });
      });
    });
    req.on("error", fail);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// What a sandboxed frame's subresource request looks like (measured).
const FRAMED = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" };
const pageCsp = () => `sandbox allow-scripts allow-forms; script-src http://127.0.0.1:${port} 'unsafe-inline'`;

// --- checks ---

test("T1: a foreign Host header is refused in every check group", async () => {
  const evil = { host: `evil.example:${port}` };
  for (const [method, path] of [["GET", "/api/ping"], ["GET", "/api/state"], ["GET", "/"], ["GET", "/d/pages/ask.html"], ["GET", "/kit/page.js"], ["GET", "/api/agent/wait"], ["POST", "/api/agent/say"]]) {
    assert.equal((await call(method, path, { headers: evil })).status, 421, `${method} ${path}`);
  }
  assert.deepEqual((await call("GET", "/api/ping")).body, { id: SESSION.id });
  assert.equal((await call("GET", "/api/ping", { headers: { host: `localhost:${port}` } })).status, 200);
});

test("T2: foreign or cross-site requests cannot post messages, and the log is unchanged", async () => {
  await call("POST", "/api/messages", { body: { text: "before" } });
  const log = join(dir, "log.jsonl");
  const before = readFileSync(log);
  for (const headers of [{ origin: "http://evil.example" }, { origin: "null" }, FRAMED]) {
    const res = await call("POST", "/api/messages", { headers, body: { text: "rm -rf" } });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(readFileSync(log), before);
  const own = await call("POST", "/api/messages", { headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" }, body: { text: "mine" } });
  assert.equal(own.status, 201);
});

test("T3: agent routes refuse browser requests before any side effect", async () => {
  for (const headers of [{ "sec-fetch-site": "same-origin" }, { origin: `http://127.0.0.1:${port}` }, { origin: "null" }, FRAMED]) {
    assert.equal((await call("POST", "/api/agent/say", { headers, body: { text: "forged" } })).status, 403, JSON.stringify(headers));
    assert.equal((await call("POST", "/api/agent/show", { headers, body: { pages: ["pages/ask.html"] } })).status, 403, JSON.stringify(headers));
    // Last: a wait that is let through blocks instead of failing.
    assert.equal((await call("GET", "/api/agent/wait", { headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal(existsSync(join(dir, "log.jsonl")), false);
  assert.equal((await call("GET", "/api/state")).body.agent.listening, false);
});

test("browser routes refuse framed requests; page routes accept them", async () => {
  assert.equal((await call("GET", "/api/state", { headers: FRAMED })).status, 403);
  assert.equal((await call("GET", "/", { headers: FRAMED })).status, 403);
  for (const headers of [FRAMED, { ...FRAMED, origin: "null" }]) {
    const res = await call("GET", "/d/pages/ask.html", { headers });
    assert.equal(res.status, 200, JSON.stringify(headers));
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal((await call("GET", "/kit/page.js", { headers })).status, 200);
  }
  assert.equal((await call("POST", "/d/pages/ask.html", { headers: FRAMED })).status, 405);
});

// --- /d/ ---

test("T4: HTML gets the sandbox policy and one page script; other files are sent as they are", async () => {
  const res = await call("GET", "/d/pages/ask.html");
  assert.equal(res.headers["content-security-policy"], pageCsp());
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.body, '<html><body><p>Ask</p><script src="/kit/page.js"></script></body></html>');

  page("pages/two.html", "<body>a</body><!-- </body> -->tail");
  const two = (await call("GET", "/d/pages/two.html")).body;
  assert.equal(two, '<body>a</body><!-- <script src="/kit/page.js"></script></body> -->tail', "before the last </body>");

  page("pages/bare.html", "<p>no body tag</p>");
  assert.equal((await call("GET", "/d/pages/bare.html")).body, '<p>no body tag</p><script src="/kit/page.js"></script>');

  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e]);
  page("assets/dot.png", bytes);
  const png = await call("GET", "/d/assets/dot.png");
  assert.deepEqual(png.bytes, bytes);
  assert.equal(png.headers["content-type"], "image/png");
  assert.equal(png.headers["content-security-policy"], pageCsp(), "every /d/ response is sandboxed");
  assert.equal(png.headers["x-content-type-options"], "nosniff");
  assert.equal(png.headers["access-control-allow-origin"], "*");

  page("tokens.css", ":root{}");
  assert.equal((await call("GET", "/d/tokens.css")).body, ":root{}");
});

test("T5: /d/ serves only pages, assets, approved and tokens.css, never through .. or symlinks", async () => {
  page(".runtime/session.json", '{"id":"x"}');
  page("log.jsonl", "{}\n");
  page("decisions.json", "{}");
  page("brief.md", "brief");
  writeFileSync(join(dir, "..", `outside-${port}.html`), "<body>OUTSIDE</body>");
  const paths = [
    "/d/.runtime/session.json", "/d/log.jsonl", "/d/decisions.json", "/d/brief.md", "/d/pages", "/d/pages/missing.html",
    "/d/pages/../log.jsonl", "/d/pages/%2e%2e/log.jsonl", "/d/pages/..%2flog.jsonl", "/d/pages/..%2f..%2f" + `outside-${port}.html`,
    "/d/pages/%2e%2e%2f.runtime%2fsession.json", "/d/%E0%A4%A",
  ];
  if (process.platform !== "win32") {
    symlinkSync(join(dir, "..", `outside-${port}.html`), join(dir, "pages", "out.html"));
    symlinkSync(join(dir, "log.jsonl"), join(dir, "pages", "log.html"));
    symlinkSync(join(dir, ".runtime"), join(dir, "assets"));
    paths.push("/d/pages/out.html", "/d/pages/log.html", "/d/assets/session.json");
  }
  for (const path of paths) {
    const res = await call("GET", path);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(String(res.body), /OUTSIDE|"id":"x"/, path);
  }
});

// --- shell and kit ---

test("the shell and its files are served with the shell policy, and only from the shell folder", async () => {
  const csp = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'";
  const index = await call("GET", "/");
  assert.equal(index.body, "<html>shell</html>");
  assert.equal(index.headers["content-security-policy"], csp);
  const js = await call("GET", "/shell/app.js");
  assert.equal(js.body, "shell();");
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(js.headers["content-security-policy"], csp);
  for (const path of ["/shell/..%2fsecret.txt", "/shell/missing.js", "/secret.txt"]) {
    const res = await call("GET", path);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(String(res.body), /SECRET/);
  }
});

test("the page script joins core, kit and annotate in order, read on every request", async () => {
  writeFileSync(join(fixtures, "kit", "annotate.js"), "annotate();");
  writeFileSync(join(fixtures, "kit", "core.js"), "core();");
  const one = await call("GET", "/kit/page.js");
  assert.equal(one.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(one.body, "core();\nannotate();\n", "a missing file is skipped");
  writeFileSync(join(fixtures, "kit", "kit.js"), "kit();");
  assert.equal((await call("GET", "/kit/page.js")).body, "core();\nkit();\nannotate();\n");
});

// --- show ---

test("show sets what the shell shows, and refuses pages it cannot serve", async () => {
  const events = [];
  const stream = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (c) => events.push(c));
  });
  stream.on("error", () => {});
  stream.end();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal((await call("GET", "/api/state")).body.showing, null);
  for (const body of [{}, { pages: [] }, { pages: ["pages/missing.html"] }, { pages: ["log.jsonl"] }, { pages: ["pages/ask.html", "pages/ask.html"] }, { pages: ["pages/ask.html"], device: "watch" }]) {
    const res = await call("POST", "/api/agent/show", { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof res.body.error, "string");
  }
  const ok = await call("POST", "/api/agent/show", { body: { pages: ["pages/ask.html"], title: "Ask" } });
  assert.deepEqual(ok.body, { ok: true });
  const showing = { pages: ["pages/ask.html"], title: "Ask", device: "fit" };
  const state = (await call("GET", "/api/state")).body;
  assert.deepEqual(state.showing, showing);
  assert.deepEqual(state.session, SESSION);
  await new Promise((r) => setTimeout(r, 50));
  stream.destroy();
  assert.match(events.join(""), new RegExp(`event: show\ndata: ${JSON.stringify(showing).replace(/[[\]]/g, "\\$&")}\n`));
});

// --- messages, wait and say ---

test("a message is saved before it is acknowledged, then delivered to wait", async () => {
  const drafts = [{ id: "choice:nav", kind: "choice", name: "nav", value: ["Tabs"], written: [] }];
  const posted = await call("POST", "/api/messages", { body: { text: "", page: "pages/ask.html", drafts } });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.kind, "feedback");
  assert.deepEqual(posted.body.drafts, drafts);
  assert.equal(app.store.messages.get(posted.body.id).status, "queued");
  const waited = await call("GET", "/api/agent/wait");
  assert.deepEqual(waited.body.messages.map((m) => m.page), ["pages/ask.html"]);
  assert.equal(waited.body.harness, "claude");
  assert.equal(waited.body.dir, dir);
  assert.equal(waited.body.messages[0].redelivered, undefined);
  assert.equal(app.store.messages.get(posted.body.id).status, "delivered");
});

test("messages need text or drafts, except exit, and drafts need a string id and kind", async () => {
  assert.equal((await call("POST", "/api/messages", { body: { text: "  " } })).status, 400);
  assert.equal((await call("POST", "/api/messages", { body: { kind: "sudo", text: "x" } })).status, 400);
  assert.equal((await call("POST", "/api/messages", { body: { text: "x", drafts: [{ kind: "choice" }] } })).status, 400);
  assert.equal((await call("POST", "/api/messages", { body: { text: "x", drafts: "no" } })).status, 400);
  assert.equal((await call("POST", "/api/messages", { body: { kind: "exit", text: "" } })).status, 201);
  const later = await call("POST", "/api/messages", { body: { text: "still here" } });
  assert.equal(later.status, 201, "no ended state in Phase 1");
  assert.equal(later.body.kind, "chat");
});

test("wait blocks until a message arrives", async () => {
  const pending = call("GET", "/api/agent/wait");
  await new Promise((r) => setTimeout(r, 50));
  await call("POST", "/api/messages", { body: { text: "later" } });
  assert.equal((await pending).body.messages[0].text, "later");
});

test("a disconnected wait stops counting as listening", async () => {
  const req = request({ host: "127.0.0.1", port, path: "/api/agent/wait", headers: { host: `127.0.0.1:${port}` } });
  req.on("error", () => {});
  req.end();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("GET", "/api/state")).body.agent.listening, true);
  req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("GET", "/api/state")).body.agent.listening, false);
});

test("an unfinished delivery is handed out again (crash recovery)", async () => {
  await call("POST", "/api/messages", { body: { text: "once" } });
  await call("GET", "/api/agent/wait");
  const again = await call("GET", "/api/agent/wait");
  assert.equal(again.body.messages[0].text, "once");
  assert.equal(again.body.messages[0].redelivered, true);
});

test("a final say closes delivered messages; progress does not", async () => {
  const { body: m } = await call("POST", "/api/messages", { body: { text: "q" } });
  await call("GET", "/api/agent/wait");
  await call("POST", "/api/agent/say", { body: { text: "on it", progress: true } });
  assert.equal(app.store.messages.get(m.id).status, "delivered");
  await call("POST", "/api/agent/say", { body: { text: "done" } });
  assert.equal(app.store.messages.get(m.id).status, "done");
});

test("the agent is reported stalled when a delivery sits without activity", async () => {
  await call("POST", "/api/messages", { body: { text: "q" } });
  await call("GET", "/api/agent/wait");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await call("GET", "/api/state")).body.agent, { listening: false, stalled: true });
});

test("oversized bodies are refused", async () => {
  const big = (n) => call("POST", "/api/messages", { body: { text: "x".repeat(n) } }).catch((e) => ({ status: e.code }));
  const res = await big(256 * 1024);
  assert.ok([413, "ECONNRESET", "EPIPE"].includes(res.status), String(res.status));
  assert.equal((await big(200 * 1024)).status, 201);
  assert.equal((await call("POST", "/api/agent/say", { body: { text: "x".repeat(512 * 1024) } })).status, 201, "say allows 1 MB");
});

test("a wait for new messages only skips ones already delivered", async () => {
  await call("POST", "/api/messages", { body: { text: "first" } });
  await call("GET", "/api/agent/wait?new=1");
  // The first message is delivered but not finished; a new-only wait holds.
  const waiting = call("GET", "/api/agent/wait?new=1");
  const raced = await Promise.race([waiting.then(() => "returned"), new Promise((ok) => setTimeout(() => ok("waiting"), 300))]);
  assert.equal(raced, "waiting");
  await call("POST", "/api/messages", { body: { text: "second" } });
  assert.deepEqual((await waiting).body.messages.map((m) => m.text), ["second"]);
});

test("a push delivery marks the message delivered", async () => {
  await app.close();
  const got = [];
  app = createServer({ dir, session: SESSION, deliver: async (m) => got.push(m.text), shellDir: join(fixtures, "shell"), kitDir: join(fixtures, "kit") });
  port = await app.listen(0);
  const { body: m } = await call("POST", "/api/messages", { body: { text: "pushed" } });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, ["pushed"]);
  assert.equal(app.store.messages.get(m.id).status, "delivered");
});

// --- server process ---

// Starts `node server/main.mjs` on a folder; `exited` resolves with its code and output.
function startMain(sessionDir) {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, MOCKUP_DIR: sessionDir, MOCKUP_KIND: "design", MOCKUP_NAME: "demo", MOCKUP_HARNESS: "claude" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  child.exited = new Promise((ok) => child.on("exit", (code) => ok({ code, out })));
  return child;
}

async function sessionFile(sessionDir) {
  const file = join(sessionDir, ".runtime", "session.json");
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  return JSON.parse(readFileSync(file, "utf8"));
}

test("the server process writes session.json once, keeps a live server, and replaces a stale one", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "mockup-main-"));
  mkdirSync(join(sessionDir, ".runtime"));
  // A stale file from a crashed server whose port no longer answers.
  writeFileSync(join(sessionDir, ".runtime", "session.json"), JSON.stringify({ id: "dead", pid: 999999, port: 1, url: "http://127.0.0.1:1/" }));
  const first = startMain(sessionDir);
  let second = null;
  let s;
  for (let i = 0; i < 100; i++) {
    s = await sessionFile(sessionDir);
    if (s.id !== "dead") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    assert.notEqual(s.id, "dead");
    assert.equal("token" in s, false);
    assert.deepEqual(
      { pid: s.pid, url: s.url, kind: s.kind, name: s.name, dir: s.dir, harness: s.harness, thread: s.thread },
      { pid: first.pid, url: `http://127.0.0.1:${s.port}/`, kind: "design", name: "demo", dir: sessionDir, harness: "claude", thread: null },
    );
    second = startMain(sessionDir);
    const late = new Promise((ok) => setTimeout(() => ok({ code: "still running", out: "" }), 5000));
    const result = await Promise.race([second.exited, late]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(await sessionFile(sessionDir), s, "the live server's file is untouched");
  } finally {
    first.kill("SIGTERM");
    second?.kill("SIGKILL");
  }
  assert.equal((await first.exited).code, 0);
  assert.equal(existsSync(join(sessionDir, ".runtime", "session.json")), false, "a clean stop removes its file");
});
