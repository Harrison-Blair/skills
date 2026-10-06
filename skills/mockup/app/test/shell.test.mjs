// Browser shell in headless Chromium against a stub server that implements
// just enough of the contract: GET /, /shell/*, /api/state, /api/events,
// POST /api/messages and one /d/ page that posts `ready` and one `draft`.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SHELL = join(dirname(fileURLToPath(import.meta.url)), "..", "shell");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'";

// The framed page: posts `ready`, then one draft, and records what the shell sends it.
const PAGE = `<!doctype html><title>Ask</title><h1>Which navigation?</h1>
<button id="left" style="position:absolute;left:0;top:80px">Left edge</button>
<script>
window.got = [];
document.getElementById("left").addEventListener("click", () => { window.clicked = true; });
addEventListener("message", (e) => { if (e.source === parent) got.push(e.data); });
parent.postMessage({ mockup: 1, type: "ready", path: "pages/ask.html", title: "Ask" }, "*");
parent.postMessage({ mockup: 1, type: "draft", draft: { id: "choice:nav", kind: "choice", name: "nav",
  label: "Which navigation?", value: ["Tabs"], written: [] } }, "*");
</script>`;

let server, base, browser, state, posts, clients;

function emit(event, data) {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === "/" || url.pathname.startsWith("/shell/")) {
      const file = url.pathname === "/" ? "index.html" : normalize(url.pathname.slice(7));
      try {
        const body = await readFile(join(SHELL, file));
        res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] || "text/plain", "content-security-policy": CSP });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }
    if (url.pathname === "/d/pages/ask.html") {
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts allow-forms" });
      return res.end(PAGE);
    }
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state));
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": hi\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/messages" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const msg = JSON.parse(body);
      posts.push(msg);
      const stored = { id: `u${posts.length}`, seq: posts.length, from: "user", status: "queued", createdAt: new Date().toISOString(), ...msg };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(stored));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  for (const res of clients) res.end();
  server?.close();
});

beforeEach(() => {
  posts = [];
  clients = new Set();
  state = {
    session: { id: "s1", kind: "once", name: "tmp", harness: "claude" },
    showing: { pages: ["pages/ask.html"], title: null, device: "fit" },
    messages: [],
    agent: { listening: true, stalled: false },
  };
});

// Opens the shell and waits until the framed page's first draft is listed.
// Page errors and console errors (such as CSP violations) fail the test on close.
async function open(width = 1200) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  page.close = ((close) => async () => {
    await close.call(page);
    assert.deepEqual(errors, [], "no page or console errors");
  })(page.close);
  await page.goto(base);
  await page.locator(".drafts .draft").first().waitFor();
  await page.waitForFunction(() => document.body.dataset.connected === "1");
  const frame = page.frames().find((f) => f.url().endsWith("/d/pages/ask.html"));
  return { page, frame };
}

const toShell = (frame, data) => frame.evaluate((d) => parent.postMessage({ mockup: 1, ...d }, "*"), data);

test("1: one sandboxed frame shows the page", async () => {
  const { page } = await open();
  const frames = page.locator("iframe");
  assert.equal(await frames.count(), 1);
  assert.equal(await frames.getAttribute("sandbox"), "allow-scripts allow-forms");
  assert.equal(await frames.getAttribute("src"), "/d/pages/ask.html");
  await page.close();
});

test("2: drafts appear under Unsent, replace by id, and undraft removes them", async () => {
  const { page, frame } = await open();
  const rows = page.locator(".drafts .draft");
  const lines = page.locator(".drafts .draft .line");
  assert.deepEqual(await lines.allTextContents(), ["Chose Tabs"]);
  await toShell(frame, { type: "draft", draft: { id: "choice:nav", kind: "choice", name: "nav", value: ["Sidebar"], written: ["a drawer on phone"] } });
  await page.getByText('Wrote in "a drawer on phone"').waitFor();
  assert.equal(await rows.count(), 1, "the same id replaces the row");
  assert.deepEqual(await lines.allTextContents(), ["Chose Sidebar", 'Wrote in "a drawer on phone"']);
  assert.equal(await page.locator(".drafts .label").textContent(), "Unsent (1)");
  await toShell(frame, { type: "undraft", id: "choice:nav" });
  await rows.first().waitFor({ state: "detached" });
  assert.equal(await rows.count(), 0);
  await page.close();
});

test("3: messages from a window other than the frame are ignored", async () => {
  const { page } = await open();
  await page.evaluate(() => {
    window.postMessage({ mockup: 1, type: "draft", draft: { id: "choice:x", kind: "choice", name: "x", value: ["Evil"], written: [] } }, "*");
    window.postMessage({ mockup: 1, type: "undraft", id: "choice:nav" }, "*");
  });
  await page.waitForTimeout(200);
  assert.deepEqual(await page.locator(".drafts .draft .line").allTextContents(), ["Chose Tabs"]);
  await page.close();
});

test("4: Send posts one feedback message, then clears drafts, composer and the page", async () => {
  const { page, frame } = await open();
  await page.getByLabel("Message").fill("Keep it simple.");
  await page.getByRole("button", { name: "Send to agent" }).click();
  await page.locator(".drafts .draft").first().waitFor({ state: "detached" });
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], {
    text: "Keep it simple.", kind: "feedback", page: "pages/ask.html",
    drafts: [{ id: "choice:nav", kind: "choice", name: "nav", label: "Which navigation?", value: ["Tabs"], written: [] }],
  });
  assert.equal(await page.getByLabel("Message").inputValue(), "");
  await frame.waitForFunction(() => got.some((m) => m.type === "clear"));
  await page.waitForTimeout(100);
  assert.equal(posts.length, 1);
  await page.close();
});

test("5: Send is disabled with no text and no draft", async () => {
  const { page, frame } = await open();
  const send = page.getByRole("button", { name: "Send to agent" });
  assert.equal(await send.isEnabled(), true, "enabled with a draft");
  await toShell(frame, { type: "undraft", id: "choice:nav" });
  await page.locator(".drafts .draft").waitFor({ state: "detached" });
  assert.equal(await send.isDisabled(), true, "disabled with nothing to send");
  await page.getByLabel("Message").fill("hi");
  assert.equal(await send.isEnabled(), true, "enabled with text");
  await page.getByLabel("Message").fill("   ");
  assert.equal(await send.isDisabled(), true, "blank text does not count");
  await page.close();
});

test("6: agent messages from events render safe Markdown in the chat", async () => {
  const { page } = await open();
  emit("message", {
    id: "a1", seq: 1, from: "agent", kind: "chat", createdAt: new Date().toISOString(),
    text: [
      "Pick **one** row.",
      "",
      "- first",
      "- second",
      "",
      "See [docs](https://example.com/docs) and [bad](javascript:alert(1)).",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "<img src=x onerror=alert(1)>",
    ].join("\n"),
  });
  const msg = page.locator(".chat .msg.agent");
  await msg.waitFor();
  assert.equal(await msg.locator("strong").textContent(), "one");
  assert.deepEqual(await msg.locator("ul > li").allTextContents(), ["first", "second"]);
  assert.equal(await msg.locator("a").count(), 1);
  assert.equal(await msg.locator("a").getAttribute("href"), "https://example.com/docs");
  assert.match(await msg.textContent(), /\[bad\]\(javascript:alert\(1\)\)/);
  assert.deepEqual(await msg.locator("table td").allTextContents(), ["1", "2"]);
  assert.deepEqual(await msg.locator("table th").allTextContents(), ["a", "b"]);
  assert.match(await msg.textContent(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator("img").count(), 0);
  await page.close();
});

test("7: the top bar shows the agent status and a stalled warning", async () => {
  const { page } = await open();
  assert.equal(await page.locator(".presence").textContent(), "Agent is listening");
  assert.equal(await page.locator(".banner.warn").count(), 0);
  emit("agent", { listening: true, stalled: true });
  await page.locator(".banner.warn").waitFor();
  assert.match(await page.locator(".banner.warn").textContent(), /hasn't responded/);
  if (process.env.SHELL_SCREENSHOT) await page.screenshot({ path: process.env.SHELL_SCREENSHOT });
  emit("agent", { listening: false, stalled: false });
  await page.getByText("Agent is not listening").waitFor();
  assert.equal(await page.locator(".banner.warn").count(), 0);
  await page.close();
});

for (const [width, device] of [[1200, "desktop"], [400, "tablet"]]) {
  test(`8: at ${width}px with device ${device} the page's left edge can be clicked`, async () => {
    state.showing.device = device;
    const { page, frame } = await open(width);
    await frame.locator("#left").click({ timeout: 2000 });
    assert.equal(await frame.evaluate(() => window.clicked), true);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(sideways, 0, "the shell page never scrolls sideways");
    await page.close();
  });
}

test("8: a frame narrower than the stage stays centered", async () => {
  state.showing.device = "phone";
  const { page } = await open();
  const gap = await page.evaluate(() => {
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const frame = document.querySelector("iframe").getBoundingClientRect();
    return { left: frame.left - stage.left, right: stage.right - frame.right, width: frame.width };
  });
  assert.equal(gap.width, 390);
  assert.ok(gap.left > 100 && Math.abs(gap.left - gap.right) <= 1, `centered: ${JSON.stringify(gap)}`);
  await page.close();
});

test("9: drafts named __proto__ and constructor are restored after ready", async () => {
  const { page, frame } = await open();
  for (const name of ["__proto__", "constructor"]) {
    await toShell(frame, { type: "draft", draft: { id: `choice:${name}`, kind: "choice", name, value: ["A"], written: [] } });
  }
  await page.locator(".drafts .draft").nth(2).waitFor();
  await toShell(frame, { type: "ready", path: "pages/ask.html", title: "Ask" });
  await frame.waitForFunction(() => got.filter((m) => m.type === "restore").length === 2);
  const keys = await frame.evaluate(() => Object.keys(got.filter((m) => m.type === "restore")[1].values).sort());
  assert.deepEqual(keys, ["__proto__", "constructor", "nav"]);
  await page.close();
});

test("10: Enter in the composer sends, and does nothing while Send is disabled", async () => {
  const { page, frame } = await open();
  await toShell(frame, { type: "undraft", id: "choice:nav" });
  await page.locator(".drafts .draft").waitFor({ state: "detached" });
  await page.getByLabel("Message").press("Enter");
  await page.waitForTimeout(200);
  assert.equal(posts.length, 0, "nothing to send");
  await page.getByLabel("Message").fill("Keep it simple.");
  await page.getByLabel("Message").press("Enter");
  await page.waitForFunction(() => document.getElementById("text").value === "");
  assert.deepEqual(posts, [{ text: "Keep it simple.", kind: "chat", page: "pages/ask.html", drafts: [] }]);
  await page.close();
});

test("10: Shift+Enter in the composer inserts a new line and does not send", async () => {
  const { page } = await open();
  const text = page.getByLabel("Message");
  await text.fill("line one");
  await text.press("Shift+Enter");
  await text.pressSequentially("line two");
  await page.waitForTimeout(200);
  assert.equal(await text.inputValue(), "line one\nline two");
  assert.equal(posts.length, 0);
  await page.close();
});

test("10: Enter while an input method is composing does not send", async () => {
  const { page } = await open();
  const text = page.getByLabel("Message");
  await text.fill("にほん");
  await text.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(200);
  assert.equal(posts.length, 0);
  assert.equal(await text.inputValue(), "にほん");
  await page.close();
});
