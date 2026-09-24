// The Pi extension (pi/mockup/index.ts at the repo root) against a real
// mockup server, with a stand-in for Pi's extension API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(APP, "..", "..", "..", "pi", "mockup", "index.ts");

// Records what the extension registers and sends, like Pi would.
function fakePi({ idle }) {
  const handlers = {};
  const sent = [];
  return {
    sent,
    api: {
      on: (name, fn) => (handlers[name] = fn),
      sendUserMessage: (text, options) => sent.push({ text, options }),
    },
    emit: (name, ctx) => handlers[name]?.({ reason: "startup" }, ctx),
    ctx: (sessionId) => ({ sessionManager: { getSessionId: () => sessionId }, isIdle: () => idle.value }),
  };
}

const until = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("the Pi extension hands browser messages to the agent, once each, and stops with the session", async () => {
  const home = mkdtempSync(join(tmpdir(), "mockup-home-"));
  // Real path, as the CLI sees its working directory (macOS links /var).
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mockup-pi-repo-")));
  process.env.MOCKUP_HOME = home;
  const env = { ...process.env, MOCKUP_HOME: home, PI_SESSION_ID: "pi-session-1" };
  delete env.CODEX_THREAD_ID;
  const mockup = (...args) => spawnSync(process.execPath, [join(APP, "bin", "mockup.mjs"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  const designDir = join(repo, ".design", "pi");

  const { default: extension } = await import(pathToFileURL(EXTENSION));
  const idle = { value: true };
  const pi = fakePi({ idle });
  extension(pi.api);
  pi.emit("session_start", pi.ctx("pi-session-1"));
  try {
    const started = mockup("start", "--design", "pi", "--no-open");
    assert.equal(started.status, 0, started.stderr);
    const link = join(home, "pi", "pi-session-1.json");
    assert.equal(JSON.parse(readFileSync(link, "utf8")).designDir, designDir, "start leaves a link for this Pi session");

    const s = JSON.parse(readFileSync(join(designDir, ".runtime", "session.json"), "utf8"));
    const post = (text) => fetch(new URL("/api/messages", s.url), { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });

    await post("make it calmer");
    await until(() => pi.sent.length === 1, "the first message");
    assert.match(pi.sent[0].text, /make it calmer/);
    assert.match(pi.sent[0].text, /Do not run `mockup wait`/);
    assert.equal(pi.sent[0].options, undefined, "an idle agent gets it at once");

    // Still unanswered, it is not handed over again; a busy agent gets the
    // next one as a follow-up.
    idle.value = false;
    await post("and bigger");
    await until(() => pi.sent.length === 2, "the second message");
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(pi.sent.length, 2, "no repeats");
    assert.match(pi.sent[1].text, /and bigger/);
    assert.doesNotMatch(pi.sent[1].text, /make it calmer/);
    assert.deepEqual(pi.sent[1].options, { deliverAs: "followUp" });

    mockup("stop", "--dir", designDir);
    assert.equal(existsSync(link), false, "stop removes the link");
  } finally {
    pi.emit("session_shutdown", pi.ctx("pi-session-1"));
    mockup("stop", "--dir", designDir);
    delete process.env.MOCKUP_HOME;
  }
});
