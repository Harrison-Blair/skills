// The whole slice: the real CLI starts the real server, which serves the real
// shell and kit to headless Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const CLI = fileURLToPath(new URL("../bin/mockup.mjs", import.meta.url));
const ENV = { ...process.env };
for (const k of ["CODEX_THREAD_ID", "PI_SESSION_ID", "MOCKUP_DIR"]) delete ENV[k];
const run = promisify(execFile);
const mockup = async (...args) => (await run(process.execPath, [CLI, ...args], { env: ENV })).stdout;

let browser;
const started = new Set();

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  for (const dir of started) {
    await mockup("stop", "--dir", dir).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startOnce() {
  const out = await mockup("start", "--once", "--no-open", "--harness", "claude");
  const dir = out.match(/^dir: (.+)$/m)[1];
  started.add(dir);
  return { dir, url: out.match(/^open: (\S+)$/m)[1] };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ASK = `<!doctype html>
<title>Ask</title>
<h1>Which navigation?</h1>
<mockup-choice name="nav" label="Which navigation?" write-in>
  <mockup-option value="Tabs">Tabs across the top <small>All four sections visible at once.</small></mockup-option>
  <mockup-option value="Sidebar">Sidebar</mockup-option>
</mockup-choice>`;

test("T6: an answer in the browser reaches `mockup wait`, and the reply reaches the chat", { timeout: 60_000 }, async () => {
  const { dir, url } = await startOnce();
  writeFileSync(join(dir, "pages", "ask.html"), ASK);
  assert.equal(await mockup("show", "pages/ask.html", "--dir", dir), "showing: pages/ask.html\nnext: run `mockup wait` in the background\n");

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.connected === "1");

  const wait = spawn(process.execPath, [CLI, "wait", "--dir", dir], { env: ENV });
  let out = "";
  wait.stdout.on("data", (c) => (out += c));
  const waited = new Promise((ok) => wait.on("exit", ok));
  await page.getByText("Agent is listening").waitFor();
  assert.equal(wait.exitCode, null, "wait blocks until the user sends");

  const frame = page.frameLocator("iframe");
  await frame.locator('mockup-option[value="Tabs"]').click();
  await frame.locator("mockup-choice input").fill("maybe a drawer on phone");
  await page.getByText("Unsent (1)").waitFor();
  assert.equal(await page.locator(".drafts .draft").count(), 1);

  await page.locator("#text").fill("Keep it simple.");
  await page.getByRole("button", { name: "Send to agent" }).click();
  assert.equal(await waited, 0);
  assert.equal(out, [
    "[mockup] 1 message from the browser:",
    "--- #1 feedback on pages/ask.html",
    '* chose "Tabs" for nav "Which navigation?"',
    '* wrote in "maybe a drawer on phone" for nav "Which navigation?"',
    "Keep it simple.",
    "--- reply with `mockup say`, then run `mockup wait` again.",
    "",
  ].join("\n"));

  assert.equal(await mockup("say", "--dir", dir, "Got it"), "sent\nnext: run `mockup wait` again\n");
  await page.locator("#chat .msg.agent").getByText("Got it").waitFor();
  assert.match(await mockup("status", "--dir", dir), /pending: 0\n/);
  if (process.env.MOCKUP_E2E_SHOT) await page.screenshot({ path: process.env.MOCKUP_E2E_SHOT });
  await page.close();

  const { pid } = JSON.parse(readFileSync(join(dir, ".runtime", "session.json"), "utf8"));
  assert.equal(await mockup("stop", "--dir", dir), `stopped ${dir}\n`);
  assert.equal(alive(pid), false, "the server exited");
  assert.ok(existsSync(join(dir, "pages", "ask.html")), "the one-off folder stays until Phase 2 cleans it up");
  started.delete(dir);
  rmSync(dir, { recursive: true, force: true });
});

// The page runs its own script in the frame and tries the browser API.
const PROBE = `<!doctype html>
<title>Probe</title>
<script>
const attempt = (path, init) => fetch(path, init).then(
  async (res) => ({ type: res.type, status: res.status, body: await res.text() }),
  (err) => ({ error: String(err) }),
);
const post = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "from the page" }) };
window.probe = Promise.all([
  attempt("/api/state"),
  attempt("/api/messages", post),
  attempt("/api/messages", { ...post, mode: "no-cors" }),
]);
</script>`;

test("T10: a page's own script cannot read the API or post messages", { timeout: 60_000 }, async () => {
  const { dir, url } = await startOnce();
  writeFileSync(join(dir, "pages", "probe.html"), PROBE);
  await mockup("show", "pages/probe.html", "--dir", dir);
  const log = readFileSync(join(dir, "log.jsonl"));

  const page = await browser.newPage();
  await page.goto(url);
  await page.frameLocator("iframe").locator("title").waitFor({ state: "attached" });
  const frame = page.frames().find((f) => f.url().endsWith("/d/pages/probe.html"));
  const results = await frame.evaluate(() => window.probe);
  await page.close();

  assert.equal(results.length, 3);
  for (const r of results) {
    assert.ok(r.error || (r.type === "opaque" && r.body === ""), `no readable response: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(readFileSync(join(dir, "log.jsonl")), log, "the log is unchanged");
  assert.match(await mockup("status", "--dir", dir), /pending: 0\n/);
});

test("a draft removed under Unsent is cleared in the page and not sent", { timeout: 60_000 }, async () => {
  const { dir, url } = await startOnce();
  writeFileSync(join(dir, "pages", "ask.html"), ASK);
  await mockup("show", "pages/ask.html", "--dir", dir);

  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.connected === "1");
  const frame = page.frameLocator("iframe");
  await frame.locator('mockup-option[value="Tabs"]').click();
  await frame.locator("mockup-choice input").fill("maybe a drawer on phone");
  await page.getByText("Unsent (1)").waitFor();

  await page.locator(".drafts .draft").getByRole("button", { name: "Remove" }).click();
  await frame.locator('mockup-option[value="Tabs"][aria-checked="false"]').waitFor();
  assert.equal(await frame.locator('mockup-option[aria-checked="true"]').count(), 0);
  assert.equal(await frame.locator("mockup-choice input").inputValue(), "");
  assert.equal(await page.locator("#drafts").isHidden(), true);

  await page.locator("#text").fill("Just text.");
  await page.getByRole("button", { name: "Send to agent" }).click();
  await page.locator("#chat .msg.user").waitFor();
  await page.close();
  assert.equal(await mockup("wait", "--dir", dir), [
    "[mockup] 1 message from the browser:",
    "--- #1 chat on pages/ask.html",
    "Just text.",
    "--- reply with `mockup say`, then run `mockup wait` again.",
    "",
  ].join("\n"));
});
