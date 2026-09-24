import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/server.mjs";

const TOKEN = "t".repeat(43);
let app, port, dir;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mockup-server-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<html>shell</html>");
  writeFileSync(join(dir, "secret.txt"), "SECRET");
  app = createServer({ designDir: dir, token: TOKEN, stallMs: 200, staticDir: join(dir, "dist") });
  port = await app.listen(0);
});
afterEach(() => app.close());

// Raw requests so tests control Host and Origin exactly.
function call(method, path, { headers = {}, body, token = TOKEN } = {}) {
  return new Promise((ok, fail) => {
    const req = request({
      host: "127.0.0.1", port, method, path,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({
        status: res.statusCode,
        headers: res.headers,
        body: res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(data) : data,
      }));
    });
    req.on("error", fail);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("API calls without the token are rejected", async () => {
  assert.equal((await call("GET", "/api/state", { token: null })).status, 401);
  assert.equal((await call("GET", "/api/state", { token: "x".repeat(43) })).status, 401);
  assert.equal((await call("GET", "/api/state")).status, 200);
});

test("a foreign Host header is rejected (DNS rebinding)", async () => {
  const res = await call("GET", "/api/state", { headers: { host: `evil.example:${port}` } });
  assert.equal(res.status, 421);
});

test("a foreign Origin cannot post messages even with a cookie", async () => {
  const res = await call("POST", "/api/messages", {
    token: null,
    headers: { origin: "http://evil.example", cookie: `mockup_${port}=${TOKEN}` },
    body: { text: "rm -rf" },
  });
  assert.equal(res.status, 403);
  assert.equal(app.store.list().length, 0);
});

test("the token link sets an HttpOnly SameSite cookie and redirects", async () => {
  const res = await call("GET", `/?token=${TOKEN}`, { token: null });
  assert.equal(res.status, 302);
  assert.match(res.headers["set-cookie"][0], new RegExp(`^mockup_${port}=${TOKEN}; HttpOnly; SameSite=Strict`));
  const withCookie = await call("GET", "/api/state", { token: null, headers: { cookie: `mockup_${port}=${TOKEN}` } });
  assert.equal(withCookie.status, 200);
});

test("a message is saved before it is acknowledged, then delivered to wait", async () => {
  const posted = await call("POST", "/api/messages", { body: { text: "make it warmer" } });
  assert.equal(posted.status, 201);
  assert.equal(app.store.messages.get(posted.body.id).status, "queued");
  const waited = await call("GET", "/api/agent/wait");
  assert.deepEqual(waited.body.messages.map((m) => m.text), ["make it warmer"]);
  assert.equal(waited.body.messages[0].redelivered, undefined);
  assert.equal(app.store.messages.get(posted.body.id).status, "delivered");
});

test("wait blocks until a message arrives", async () => {
  const pending = call("GET", "/api/agent/wait");
  await new Promise((r) => setTimeout(r, 50));
  await call("POST", "/api/messages", { body: { text: "later" } });
  assert.equal((await pending).body.messages[0].text, "later");
});

test("a disconnected wait stops counting as listening", async () => {
  const req = request({ host: "127.0.0.1", port, path: "/api/agent/wait", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` } });
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
  assert.equal((await call("GET", "/api/state")).body.agent.stalled, true);
});

test("static paths cannot escape the build directory", async () => {
  assert.equal((await call("GET", "/", { token: null })).body, "<html>shell</html>");
  const res = await call("GET", "/..%2fsecret.txt", { token: null });
  assert.equal(res.status, 403);
  assert.doesNotMatch(String(res.body), /SECRET/);
});

test("oversized bodies are refused", async () => {
  const res = await call("POST", "/api/messages", { body: { text: "x".repeat(1024 * 1024 + 1) } }).catch((e) => ({ status: e.code }));
  assert.ok([413, "ECONNRESET", "EPIPE"].includes(res.status), String(res.status));
});

test("rounds are numbered per stage and survive a restart", async () => {
  const a = await call("POST", "/api/agent/round", { body: { stage: "context", title: "Brief", body: "# Hi" } });
  const b = await call("POST", "/api/agent/round", { body: { stage: "context", title: "Brief v2" } });
  const c = await call("POST", "/api/agent/round", { body: { stage: "mood", title: "Vibes" } });
  assert.deepEqual([a.body.id, b.body.id, c.body.id], ["context-1", "context-2", "mood-1"]);
  const { Store } = await import("../server/store.mjs");
  assert.equal(new Store(join(dir, "log.jsonl")).rounds.get("context-1").pages[0].blocks[0].text, "# Hi");
  assert.equal((await call("POST", "/api/agent/round", { body: { stage: "nope", title: "x" } })).status, 400);
});

test("a message can be attached to an existing round only", async () => {
  await call("POST", "/api/agent/round", { body: { stage: "context", title: "Brief" } });
  const ok = await call("POST", "/api/messages", { body: { text: "love it", round: "context-1" } });
  assert.equal(ok.body.round, "context-1");
  assert.equal((await call("POST", "/api/messages", { body: { text: "x", round: "mood-9" } })).status, 400);
});

test("ending the session delivers an exit message and refuses new ones", async () => {
  const exit = await call("POST", "/api/messages", { body: { kind: "exit", text: "End session" } });
  assert.equal(exit.status, 201);
  assert.equal((await call("GET", "/api/state")).body.ended, true);
  assert.equal((await call("POST", "/api/messages", { body: { text: "more" } })).status, 409);
  assert.equal((await call("GET", "/api/agent/wait")).body.messages[0].kind, "exit");
  assert.equal((await call("POST", "/api/messages", { body: { kind: "sudo", text: "x" } })).status, 409);
});


// --- structured rounds, decisions, uploads and files ---

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function asset(rel, bytes = PNG) {
  mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, ...rel.split("/")), bytes);
  return rel;
}

function raw(method, path, bytes, token = TOKEN) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end(bytes);
  });
}

const directions = () => ({
  stage: "mood",
  title: "Directions",
  kind: "explore",
  pages: [
    { title: "Looks", blocks: [
      { type: "markdown", text: "Pick what you like" },
      { type: "option", id: "calm", title: "Calm paper", images: [asset("assets/web/calm.png")] },
      { type: "image", id: "swatch", src: asset("assets/own/swatch.png") },
    ] },
    { title: "Questions", blocks: [
      { type: "question", id: "tone", text: "Tone?", choices: ["Calm", "Bright"] },
    ] },
  ],
});

test("a structured round is validated and stored with its pages", async () => {
  const res = await call("POST", "/api/agent/round", { body: directions() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.pages.length, 2);
  assert.equal(res.body.kind, "explore");
});

test("broken rounds are refused with the field that is wrong", async () => {
  const cases = [
    [(r) => { r.pages[0].blocks[1].images = ["assets/web/missing.png"]; }, /pages\[0\]\.blocks\[1\]\.images\[0\].*does not exist/],
    [(r) => { r.pages[0].blocks[1].images = ["../secret.png"]; }, /under assets\/ or renders\//],
    [(r) => { r.pages[1].blocks[0].id = "calm"; }, /"calm" is used twice/],
    [(r) => { r.pages[0].blocks[0].type = "video"; }, /pages\[0\]\.blocks\[0\]\.type/],
    [(r) => { r.kind = "maybe"; }, /kind/],
    [(r) => { r.pages[1].blocks[0].choices = ["only one"]; }, /at least two choices/],
  ];
  for (const [mutate, error] of cases) {
    const r = directions();
    mutate(r);
    const res = await call("POST", "/api/agent/round", { body: r });
    assert.equal(res.status, 400);
    assert.match(res.body.error, error);
  }
});

test("a round image that symlinks out of the design directory is refused", async () => {
  writeFileSync(join(dir, "..", `outside-${port}.png`), PNG);
  mkdirSync(join(dir, "assets"), { recursive: true });
  symlinkSync(join(dir, "..", `outside-${port}.png`), join(dir, "assets", "link.png"));
  const r = directions();
  r.pages[0].blocks[2].src = "assets/link.png";
  const res = await call("POST", "/api/agent/round", { body: r });
  assert.match(res.body.error, /outside the design directory/);
});

test("decisions are checked against the item and ride along with the next message", async () => {
  await call("POST", "/api/agent/round", { body: directions() });
  assert.equal((await call("POST", "/api/decisions", { body: { round: "mood-1", item: "calm", value: "approve" } })).status, 400);
  assert.equal((await call("POST", "/api/decisions", { body: { round: "mood-1", item: "nope", value: "like" } })).status, 400);
  assert.equal((await call("POST", "/api/decisions", { body: { round: "mood-1", item: "draft", value: "approve" } })).status, 400, "explore rounds have no draft approval");
  await call("POST", "/api/decisions", { body: { round: "mood-1", item: "calm", value: "dislike" } });
  await call("POST", "/api/decisions", { body: { round: "mood-1", item: "calm", value: "like" } });
  await call("POST", "/api/decisions", { body: { round: "mood-1", item: "tone", value: "Bright" } });
  // Plain chat still carries them, so "I am done" never drops a click.
  const m = await call("POST", "/api/messages", { body: { text: "I am done" } });
  assert.deepEqual(m.body.decisions.map((d) => [d.item, d.value]), [["calm", "like"], ["tone", "Bright"]]);
  const next = await call("POST", "/api/messages", { body: { text: "more" } });
  assert.equal(next.body.decisions, undefined, "sent decisions, and the ones they replaced, are not sent again");
});

test("feedback may be decisions alone, and ending the session carries unsent ones", async () => {
  await call("POST", "/api/agent/round", { body: { ...directions(), kind: "draft" } });
  assert.equal((await call("POST", "/api/messages", { body: { kind: "feedback" } })).status, 400, "empty feedback is refused");
  await call("POST", "/api/decisions", { body: { round: "mood-1", item: "draft", value: "approve" } });
  const exit = await call("POST", "/api/messages", { body: { kind: "exit" } });
  assert.deepEqual(exit.body.decisions.map((d) => d.value), ["approve"]);
});

test("uploads are identified by their bytes", async () => {
  const ok = await raw("POST", "/api/uploads", PNG);
  const path = JSON.parse(ok.body).path;
  assert.match(path, /^assets\/uploads\/[0-9a-f-]+\.png$/);
  assert.deepEqual(readFileSync(join(dir, ...path.split("/"))), PNG);
  const render = JSON.parse((await raw("POST", "/api/uploads?kind=render", PNG)).body).path;
  assert.match(render, /^renders\//);
  assert.equal((await raw("POST", "/api/uploads", Buffer.from('<svg onload="alert(1)"></svg>'.padEnd(40)))).status, 415);
  assert.equal((await raw("POST", "/api/uploads", PNG, null)).status, 401);
});

test("attachments must point at real rounds, items and files", async () => {
  await call("POST", "/api/agent/round", { body: directions() });
  const up = JSON.parse((await raw("POST", "/api/uploads", PNG)).body).path;
  const good = {
    selections: [{ round: "mood-1", item: "calm" }],
    uploads: [up],
    annotations: [{ round: "mood-1", image: "assets/web/calm.png", marks: [{ shape: "pin", x: 0.2, y: 0.3, note: "this" }, { shape: "circle", x: 0.5, y: 0.5, r: 0.1 }] }],
  };
  const m = await call("POST", "/api/messages", { body: { text: "see", attachments: good } });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(m.body.attachments.annotations[0].marks[0].note, "this");
  for (const broken of [
    { selections: [{ round: "mood-1", item: "ghost" }] },
    { uploads: ["assets/uploads/none.png"] },
    { annotations: [{ round: "mood-1", image: "assets/web/calm.png", marks: [{ shape: "pin", x: 2, y: 0 }] }] },
  ]) {
    assert.equal((await call("POST", "/api/messages", { body: { text: "x", attachments: broken } })).status, 400);
  }
});

test("design files are served only with the token and a sandboxing CSP", async () => {
  asset("assets/web/calm.png");
  const res = await raw("GET", "/files/assets/web/calm.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.match(res.headers["content-security-policy"], /sandbox/);
  assert.equal((await raw("GET", "/files/assets/web/calm.png", undefined, null)).status, 401);
  assert.equal((await raw("GET", "/files/log.jsonl")).status, 404);
  assert.equal((await raw("GET", "/files/assets/..%2f..%2fsecret.txt")).status, 404);
});

test("multiple-choice questions take a list of their choices", async () => {
  const r = directions();
  r.pages[1].blocks[0].multiple = true;
  await call("POST", "/api/agent/round", { body: r });
  const ok = await call("POST", "/api/decisions", { body: { round: "mood-1", item: "tone", value: ["Calm", "Bright"] } });
  assert.equal(ok.status, 201);
  for (const value of ["Calm", ["Calm", "Calm"], ["Loud"]]) {
    assert.equal((await call("POST", "/api/decisions", { body: { round: "mood-1", item: "tone", value } })).status, 400, JSON.stringify(value));
  }
  const bad = directions();
  bad.pages[1].blocks[0] = { type: "question", id: "q", text: "?", multiple: true };
  assert.match((await call("POST", "/api/agent/round", { body: bad })).body.error, /multiple.*needs choices/);
});

test("comments ride along separately from reactions on the same item", async () => {
  await call("POST", "/api/agent/round", { body: directions() });
  await call("POST", "/api/decisions", { body: { round: "mood-1", item: "calm", value: "like" } });
  await call("POST", "/api/decisions", { body: { round: "mood-1", item: "calm", comment: "first thought" } });
  await call("POST", "/api/decisions", { body: { round: "mood-1", item: "calm", comment: "warmer, please" } });
  assert.equal((await call("POST", "/api/decisions", { body: { round: "mood-1", item: "ghost", comment: "x" } })).status, 400);
  assert.equal((await call("POST", "/api/decisions", { body: { round: "mood-1", item: "draft", comment: "x" } })).status, 400, "explore rounds have no draft to comment on");
  assert.equal((await call("POST", "/api/decisions", { body: { round: "mood-1", item: "calm", comment: 5 } })).status, 400);
  const m = await call("POST", "/api/messages", { body: { kind: "feedback" } });
  assert.deepEqual(m.body.decisions.map((d) => d.value ?? d.comment), ["like", "warmer, please"]);
});

function uiFile(rel, source) {
  mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, ...rel.split("/")), source);
  return rel;
}

const prototype = (src) => ({
  stage: "prototype",
  title: "Today screen",
  pages: [{ title: "Today", blocks: [{ type: "preview", id: "today", title: "Today", src, device: "phone" }] }],
});

test("a preview is bundled with the components it imports and served sandboxed", async () => {
  uiFile("ui/components/Badge.jsx", 'export default function Badge({ n }) { return <b className="badge">{n} DONE-BADGE</b>; }');
  const src = uiFile("ui/pages/Today.jsx", 'import Badge from "../components/Badge.jsx";\nexport default () => <Badge n={3} />;');
  const res = await call("POST", "/api/agent/round", { body: prototype(src) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { bundle, device } = res.body.pages[0].blocks[0];
  assert.match(bundle, /^[0-9a-f]{64}$/);
  assert.equal(device, "phone");

  const page = await call("GET", `/previews/${bundle}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /DONE-BADGE/, "the imported component is in the bundle");
  assert.match(page.body, /createRoot|react/i, "React comes from the app, not the design directory");
  assert.match(page.headers["content-security-policy"], /sandbox allow-scripts(;|$)/);
  assert.doesNotMatch(page.headers["content-security-policy"], /allow-same-origin/);

  // Later edits do not change what the published round shows.
  uiFile("ui/components/Badge.jsx", "export default () => <b>CHANGED</b>;");
  assert.match((await call("GET", `/previews/${bundle}`)).body, /DONE-BADGE/);

  assert.equal((await call("GET", `/previews/${bundle}`, { token: null })).status, 401);
  assert.equal((await call("GET", "/previews/..%2F..%2Fsecret.txt")).status, 404);
});

test("a preview that does not build, or is not under ui/, is refused with the reason", async () => {
  const broken = uiFile("ui/pages/Broken.jsx", 'import Nope from "../components/Nope.jsx";\nexport default () => <Nope />;');
  let res = await call("POST", "/api/agent/round", { body: prototype(broken) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /pages\[0\]\.blocks\[0\]\.src: "ui\/pages\/Broken.jsx" failed to build:\nui\/pages\/Broken.jsx:1:\d+: Could not resolve "..\/components\/Nope.jsx"/);
  assert.equal(app.store.roundList().length, 0, "nothing is published");

  res = await call("POST", "/api/agent/round", { body: prototype(asset("assets/own/page.png")) });
  assert.match(res.body.error, /under ui\//);
  const ok = uiFile("ui/pages/Ok.jsx", "export default () => null;");
  const bad = prototype(ok);
  bad.pages[0].blocks[0].device = "watch";
  assert.match((await call("POST", "/api/agent/round", { body: bad })).body.error, /device: must be one of fit, phone, tablet, desktop/);
});

test("a snapshot annotation must name a preview of its round", async () => {
  const src = uiFile("ui/pages/Ok.jsx", "export default () => <p>ok</p>;");
  const round = (await call("POST", "/api/agent/round", { body: prototype(src) })).body;
  const snapshot = asset("renders/snap.png");
  const send = (item) => call("POST", "/api/messages", {
    body: { kind: "feedback", attachments: { annotations: [{ round: round.id, item, image: snapshot, marks: [{ shape: "pin", x: 0.5, y: 0.5 }] }] } },
  });
  const good = await send("today");
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.attachments.annotations[0].item, "today");
  assert.equal((await send("nope")).status, 400);
});

test("marks are saved on the round, ride with the next message, and survive a restart", async () => {
  const round = (await call("POST", "/api/agent/round", { body: directions() })).body;
  const image = "assets/web/calm.png";
  const mark = (marks) => call("POST", "/api/annotations", { body: { round: round.id, image, marks } });

  assert.equal((await mark([{ shape: "pin", x: 2, y: 0 }])).status, 400, "marks are checked");
  assert.equal((await call("POST", "/api/annotations", { body: { round: "mood-9", image, marks: [] } })).status, 400);
  assert.equal((await mark([{ shape: "pin", x: 0.1, y: 0.2 }])).status, 201);
  // A later set replaces the earlier one.
  assert.equal((await mark([{ shape: "pin", x: 0.1, y: 0.2, note: "warmer" }, { shape: "circle", x: 0.5, y: 0.5, r: 0.1 }])).status, 201);

  const render = asset("renders/calm-marked.png");
  const latest = app.store.unsentAnnotations()[0];
  const sent = await call("POST", "/api/messages", { body: { kind: "feedback", renders: { [`${round.id}|${image}`]: { id: latest.id, path: render } } } });
  assert.equal(sent.status, 201, "feedback may be marks alone");
  assert.equal(sent.body.annotations.length, 1);
  assert.equal(sent.body.annotations[0].marks[0].note, "warmer");
  assert.equal(sent.body.annotations[0].render, render);
  assert.equal(app.store.unsentAnnotations().length, 0, "sent marks are retired");

  // Removing them all is a change the agent hears about too.
  const cleared = (await mark([])).body;
  const next = await call("POST", "/api/messages", { body: { kind: "feedback", renders: { [`${round.id}|${image}`]: { id: cleared.id, path: null } } } });
  assert.deepEqual(next.body.annotations[0].marks, []);

  const { Store } = await import("../server/store.mjs");
  const replayed = new Store(join(dir, "log.jsonl"));
  assert.equal(replayed.annotations.length, 3);
  assert.equal(replayed.unsentAnnotations().length, 0);
  assert.equal((await call("GET", "/api/state")).body.annotations.length, 3);
  assert.equal((await call("POST", "/api/messages", { body: { kind: "feedback", renders: { x: { id: "a", path: "../secret.txt" } } } })).status, 400, "renders must be design files");
});

test("a preview may import only from ui/, assets/ and the app's own packages", async () => {
  writeFileSync(join(dir, "..", `outside-${port}.json`), '{"secret": "OUTSIDE"}');
  mkdirSync(join(dir, ".runtime"), { recursive: true });
  writeFileSync(join(dir, ".runtime", "session.json"), '{"token": "RUNTIME-TOKEN"}');
  const cases = [
    [`import s from "../../../outside-${port}.json"; export default () => <p>{s.secret}</p>;`, /outside ui\/ and assets\//],
    ['import s from "../../.runtime/session.json"; export default () => <p>{s.token}</p>;', /outside ui\/ and assets\//],
  ];
  for (const [source, error] of cases) {
    const src = uiFile("ui/pages/Leak.jsx", source);
    const res = await call("POST", "/api/agent/round", { body: prototype(src) });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, error);
  }
  // A symlink inside ui/ that points outside is refused too.
  symlinkSync(join(dir, "..", `outside-${port}.json`), join(dir, "ui", "link.json"));
  const linked = uiFile("ui/pages/Linked.jsx", 'import s from "../link.json"; export default () => <p>{s.secret}</p>;');
  assert.match((await call("POST", "/api/agent/round", { body: prototype(linked) })).body.error, /outside ui\/ and assets\//);
  // Components, assets, and the app's packages are fine.
  asset("assets/own/dot.png");
  uiFile("ui/components/Dot.jsx", 'import dot from "../../assets/own/dot.png"; import { Check } from "lucide-react"; export default () => <p><img src={dot} /><Check /></p>;');
  const ok = uiFile("ui/pages/Ok.jsx", 'import Dot from "../components/Dot.jsx"; export default () => <Dot />;');
  const res = await call("POST", "/api/agent/round", { body: prototype(ok) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("a published round keeps its images even if the files change later", async () => {
  const res = await call("POST", "/api/agent/round", { body: directions() });
  const src = res.body.pages[0].blocks[2].src;
  assert.match(src, /^assets\/published\/[0-9a-f]{64}\.png$/);
  const before = (await raw("GET", `/files/${src}`)).body;
  writeFileSync(join(dir, "assets", "own", "swatch.png"), Buffer.concat([PNG, Buffer.from("changed")]));
  assert.deepEqual((await raw("GET", `/files/${src}`)).body, before);
  assert.equal(res.body.pages[0].blocks[2].from, "assets/own/swatch.png", "the original path is kept for reference");
});

test("a symlinked ui/ or assets/ folder does not widen what previews may import", async () => {
  const outside = join(dir, "..", `outside-dir-${port}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.json"), '{"secret": "OUTSIDE"}');
  symlinkSync(outside, join(dir, "assets"));
  const src = uiFile("ui/pages/Leak.jsx", 'import s from "../../assets/secret.json"; export default () => <p>{s.secret}</p>;');
  const res = await call("POST", "/api/agent/round", { body: prototype(src) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /outside ui\/ and assets\//);
});

test("published copies of your own images stay tracked; web images stay ignored", async () => {
  const res = await call("POST", "/api/agent/round", { body: directions() });
  const [calm] = res.body.pages[0].blocks[1].images;
  const swatch = res.body.pages[0].blocks[2].src;
  assert.match(calm, /^renders\/published\//, "web images are third-party, so their copies stay ignored");
  assert.match(swatch, /^assets\/published\//, "own images' copies live in tracked storage");
});


test("a symlink from ui/ or assets/ to elsewhere in the design grants nothing", async () => {
  mkdirSync(join(dir, ".runtime"), { recursive: true });
  writeFileSync(join(dir, ".runtime", "session.json"), '{"token": "RUNTIME-TOKEN"}');
  symlinkSync(join(dir, ".runtime"), join(dir, "assets"));
  const src = uiFile("ui/pages/Leak.jsx", 'import s from "../../assets/session.json"; export default () => <p>{s.token}</p>;');
  const res = await call("POST", "/api/agent/round", { body: prototype(src) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /outside ui\/ and assets\//);
});

test("every Markdown image form is published, and code or links are left alone", async () => {
  const a = asset("assets/own/a(1).png");
  const b = asset("assets/own/b.png", Buffer.concat([PNG, Buffer.from("b")]));
  const c = asset("assets/own/c.png", Buffer.concat([PNG, Buffer.from("c")]));
  const text = [
    `Inline ![a](${a})`,
    `Angle ![b](<${b}>)`,
    "Reference ![c][cref]",
    "",
    `[cref]: ${c}`,
    "",
    "Code `![x](assets/own/missing.png)` and [a link](https://example.com)",
  ].join("\n");
  const res = await call("POST", "/api/agent/round", { body: { stage: "mood", title: "Md", pages: [{ title: "P", blocks: [{ type: "markdown", text }] }] } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const media = res.body.pages[0].blocks[0].media;
  assert.deepEqual(Object.keys(media).sort(), [a, b, c].sort(), "each local image, in every form, and nothing in code");
  for (const out of Object.values(media)) assert.match(out, /^assets\/published\/[0-9a-f]{64}\.png$/);
  assert.equal(res.body.pages[0].blocks[0].text, text, "the Markdown itself is kept as written");
  const missing = { stage: "mood", title: "Md", pages: [{ title: "P", blocks: [{ type: "markdown", text: "![x](assets/own/missing.png)" }] }] };
  assert.match((await call("POST", "/api/agent/round", { body: missing })).body.error, /does not exist/);
});

test("a message carries the marks its picture shows; a later edit stays unsent", async () => {
  const round = (await call("POST", "/api/agent/round", { body: directions() })).body;
  const image = "assets/web/calm.png";
  const drawn = (await call("POST", "/api/annotations", { body: { round: round.id, image, marks: [{ shape: "pin", x: 0.1, y: 0.1 }] } })).body;
  await call("POST", "/api/annotations", { body: { round: round.id, image, marks: [{ shape: "pin", x: 0.1, y: 0.1 }, { shape: "pin", x: 0.9, y: 0.9 }] } });
  const render = asset("renders/one-pin.png");
  const sent = await call("POST", "/api/messages", { body: { kind: "feedback", renders: { [`${round.id}|${image}`]: { id: drawn.id, path: render } } } });
  assert.equal(sent.body.annotations[0].id, drawn.id);
  assert.equal(sent.body.annotations[0].marks.length, 1);
  const left = app.store.unsentAnnotations();
  assert.equal(left.length, 1, "the newer edit is still waiting");
  assert.equal(left[0].marks.length, 2);
  const { Store } = await import("../server/store.mjs");
  assert.equal(new Store(join(dir, "log.jsonl")).unsentAnnotations().length, 1, "and still after a restart");
});

test("a message carries only the marks the page drew; others stay unsent, and End session refuses to strand them", async () => {
  const round = (await call("POST", "/api/agent/round", { body: directions() })).body;
  const a = "assets/web/calm.png";
  const b = "assets/own/swatch.png";
  const pa = (await call("POST", "/api/annotations", { body: { round: round.id, image: a, marks: [{ shape: "pin", x: 0.1, y: 0.1 }] } })).body;
  // Image B is marked while A's picture is being sent.
  await call("POST", "/api/annotations", { body: { round: round.id, image: b, marks: [{ shape: "pin", x: 0.5, y: 0.5 }] } });
  const render = asset("renders/a.png");
  const sent = await call("POST", "/api/messages", { body: { kind: "feedback", renders: { [`${round.id}|${a}`]: { id: pa.id, path: render } } } });
  assert.deepEqual(sent.body.annotations.map((x) => x.image), [a]);
  assert.deepEqual(app.store.unsentAnnotations().map((x) => x.image), [b], "B waits for a message that draws it");

  const exit = await call("POST", "/api/messages", { body: { kind: "exit", text: "" } });
  assert.equal(exit.status, 409, "ending would strand B's marks");
  assert.match(exit.body.error, /changed while sending/);
  const pb = app.store.unsentAnnotations()[0];
  const ok = await call("POST", "/api/messages", { body: { kind: "exit", text: "", renders: { [`${round.id}|${b}`]: { id: pb.id, path: asset("renders/b.png") } } } });
  assert.equal(ok.status, 201);
});

test("with repeated Markdown definitions, the first wins, as the page renders it", async () => {
  const first = asset("assets/own/first.png");
  const second = asset("assets/own/second.png", Buffer.concat([PNG, Buffer.from("2")]));
  const text = `![tone][t]\n\n[t]: ${first}\n[t]: ${second}\n`;
  const res = await call("POST", "/api/agent/round", { body: { stage: "mood", title: "Dup", pages: [{ title: "P", blocks: [{ type: "markdown", text }] }] } });
  assert.deepEqual(Object.keys(res.body.pages[0].blocks[0].media), [first]);
});

test("Markdown image paths are matched the way the page writes them, and ambiguous ones are refused", async () => {
  const literal = asset("assets/own/a%20b.png");
  const round = (paths) => call("POST", "/api/agent/round", { body: { stage: "mood", title: "Esc", pages: [{ title: "P", blocks: [{ type: "markdown", text: paths.map((p) => `![x](<${p}>)`).join(" ") }] }] } });
  const one = await round([literal]);
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.deepEqual(Object.keys(one.body.pages[0].blocks[0].media), ["assets/own/a%20b.png"]);
  const spaced = asset("assets/own/a b.png", Buffer.concat([PNG, Buffer.from("s")]));
  const both = await round([literal, spaced]);
  assert.equal(both.status, 400);
  assert.match(both.body.error, /same image path/);
});
