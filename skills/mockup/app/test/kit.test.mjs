// The page script in a sandboxed frame, as the shell will embed it: a stub
// server serves a parent page and child pages with the server's policy.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Absolute path because a fresh worktree has no node_modules.
import { chromium } from "/home/penguin/source/skills/skills/mockup/app/node_modules/playwright/index.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");
const OPTIONS = `
  <mockup-option value="Tabs">Tabs across the top<small>All four sections visible at once.</small></mockup-option>
  <mockup-option value="Sidebar">Sidebar<small>Room for labels and progress.</small></mockup-option>
  <mockup-option value="Steps">One step at a time<small>Back and Continue only.</small></mockup-option>`;
const PAGES = {
  "pages/ask.html": `<title>Order page</title>
    <style>small { color: rgb(255, 0, 0) } div { border: 5px solid red }</style>
    <h3>Which navigation should the order page use?</h3><small id="outside">Page text</small>
    <button id="start">Start</button>
    <mockup-choice name="nav" label="Which navigation?" write-in>${OPTIONS}</mockup-choice>`,
  "pages/multi.html": `<title>Multi</title>
    <mockup-choice name="nav" label="Which navigation?" multiple>${OPTIONS}</mockup-choice>`,
  "pages/order page.html": `<title>Spaced</title>`,
};

let server, base, browser;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(`<iframe sandbox="allow-scripts allow-forms" src="/d/${url.searchParams.get("page")}" style="width: 600px; height: 500px"></iframe>
        <script>
          const frame = document.querySelector("iframe");
          window.received = [];
          addEventListener("message", (event) => { if (event.source === frame.contentWindow) received.push(event.data); });
          window.toChild = (data) => frame.contentWindow.postMessage(data, "*");
        </script>`);
    }
    if (url.pathname === "/kit/page.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(["core.js", "kit.js", "annotate.js"].map((file) => readFileSync(join(KIT, file), "utf8")).join(""));
    }
    const body = PAGES[decodeURIComponent(url.pathname.replace(/^\/d\//, ""))];
    if (!body) return res.writeHead(404).end();
    res.setHeader("content-type", "text/html");
    res.setHeader("content-security-policy", `sandbox allow-scripts allow-forms; script-src ${base} 'unsafe-inline'`);
    res.end(`<!doctype html><html><body>${body}${url.searchParams.has("bare") ? "" : '<script src="/kit/page.js"></script>'}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Opens the parent page with the child framed and waits for its ready message.
async function open(page = "pages/ask.html") {
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error));
  await tab.goto(`${base}/?page=${encodeURIComponent(page)}`);
  await tab.waitForFunction(() => received.some((m) => m.type === "ready"));
  const frame = tab.frames()[1];
  return { tab, frame, errors, rows: frame.locator("mockup-option") };
}

// Waits for the parent to hold more than `count` messages and returns the newest.
async function next(tab, count) {
  await tab.waitForFunction((n) => received.length > n, count, { timeout: 2000 });
  return tab.evaluate(() => received.at(-1));
}

const received = (tab) => tab.evaluate(() => received.length);

test("1: posts ready with the page path and title", async () => {
  const { tab } = await open();
  const ready = await tab.evaluate(() => received[0]);
  assert.deepEqual(ready, { mockup: 1, type: "ready", path: "pages/ask.html", title: "Order page" });
  await tab.close();
});

test("1: ready.path is decoded so it matches the shown page path", async () => {
  const { tab } = await open("pages/order page.html");
  assert.equal(await tab.evaluate(() => received[0].path), "pages/order page.html");
  await tab.close();
});

test("2: single choice posts the clicked value and replaces it", async () => {
  const { tab, rows } = await open();
  assert.equal(await rows.count(), 3);
  let count = await received(tab);
  await rows.nth(0).click();
  assert.deepEqual(await next(tab, count), {
    mockup: 1, type: "draft",
    draft: { id: "choice:nav", kind: "choice", name: "nav", label: "Which navigation?", value: ["Tabs"], written: [] },
  });
  count = await received(tab);
  await rows.nth(1).click();
  assert.deepEqual((await next(tab, count)).draft.value, ["Sidebar"]);
  assert.equal(await rows.nth(0).getAttribute("aria-checked"), "false");
  assert.equal(await rows.nth(1).getAttribute("aria-checked"), "true");
  await tab.close();
});

test("3: multiple choice adds, removes, and undrafts the last value", async () => {
  const { tab, rows } = await open("pages/multi.html");
  let count = await received(tab);
  await rows.nth(0).click();
  await next(tab, count);
  count = await received(tab);
  await rows.nth(2).click();
  assert.deepEqual((await next(tab, count)).draft.value, ["Tabs", "Steps"]);
  count = await received(tab);
  await rows.nth(0).click();
  assert.deepEqual((await next(tab, count)).draft.value, ["Steps"]);
  count = await received(tab);
  await rows.nth(2).click();
  assert.deepEqual(await next(tab, count), { mockup: 1, type: "undraft", id: "choice:nav" });
  await tab.close();
});

test("4: the write-in posts written text and undrafts when cleared", async () => {
  const { tab, frame } = await open();
  const field = frame.getByLabel("Something else");
  let count = await received(tab);
  await field.fill("a drawer on phone");
  const draft = (await next(tab, count)).draft;
  assert.deepEqual([draft.value, draft.written], [[], ["a drawer on phone"]]);
  count = await received(tab);
  await field.fill("");
  assert.deepEqual(await next(tab, count), { mockup: 1, type: "undraft", id: "choice:nav" });
  await tab.close();
});

test("5: restore shows the saved draft and fills mockup.state", async () => {
  const { tab, frame, rows } = await open();
  const saved = { id: "choice:nav", kind: "choice", name: "nav", label: "Which navigation?", value: ["Steps"], written: ["tabs on desktop"] };
  await tab.evaluate((saved) => toChild({ mockup: 1, type: "restore", values: { nav: saved } }), saved);
  await frame.waitForFunction(() => window.mockup.state.nav);
  assert.deepEqual(await frame.evaluate(() => window.mockup.state.nav), saved);
  assert.equal(await rows.nth(2).getAttribute("aria-checked"), "true");
  assert.equal(await rows.nth(0).getAttribute("aria-checked"), "false");
  assert.equal(await frame.getByLabel("Something else").inputValue(), "tabs on desktop");
  if (process.env.MOCKUP_SCREENSHOT) await tab.screenshot({ path: process.env.MOCKUP_SCREENSHOT });
  await tab.close();
});

test("6: clear resets the element and posts nothing", async () => {
  const { tab, frame, rows } = await open();
  await rows.nth(1).click();
  await frame.getByLabel("Something else").fill("maybe");
  await tab.waitForFunction(() => received.at(-1).draft?.written?.[0] === "maybe");
  const count = await received(tab);
  await tab.evaluate(() => toChild({ mockup: 1, type: "clear" }));
  await frame.waitForFunction(() => !document.querySelector("mockup-option[aria-checked=true]"));
  assert.equal(await frame.getByLabel("Something else").inputValue(), "");
  await tab.waitForTimeout(200);
  assert.equal(await received(tab), count);
  await tab.close();
});

test("7: mockup.send posts a text draft", async () => {
  const { tab, frame } = await open();
  const count = await received(tab);
  await frame.evaluate(() => window.mockup.send("Use plan B", { name: "plan", value: "B" }));
  assert.deepEqual(await next(tab, count), {
    mockup: 1, type: "draft", draft: { id: "send:plan", kind: "text", note: "Use plan B", name: "plan", value: "B" },
  });
  await tab.close();
});

test("8: ignores messages from windows other than the parent", async () => {
  const { tab, frame, rows } = await open();
  await frame.evaluate(() => window.postMessage({ mockup: 1, type: "restore", values: { nav: { value: ["Tabs"], written: [] } } }, "*"));
  await tab.waitForTimeout(200);
  assert.equal(await frame.evaluate(() => window.mockup.state.nav), undefined);
  assert.equal(await rows.nth(0).getAttribute("aria-checked"), "false");
  await tab.close();
});

test("9: rows work by keyboard with radio or checkbox roles", async () => {
  const { tab, frame, rows } = await open();
  for (let i = 0; i < 3; i++) assert.equal(await rows.nth(i).getAttribute("role"), "radio");
  await frame.locator("#start").focus();
  await tab.keyboard.press("Tab");
  assert.equal(await frame.evaluate(() => document.activeElement.getAttribute("value")), "Tabs");
  let count = await received(tab);
  await tab.keyboard.press(" ");
  assert.deepEqual((await next(tab, count)).draft.value, ["Tabs"]);
  assert.equal(await rows.nth(0).getAttribute("aria-checked"), "true");
  await tab.keyboard.press("Tab");
  count = await received(tab);
  await tab.keyboard.press("Enter");
  assert.deepEqual((await next(tab, count)).draft.value, ["Sidebar"]);
  await tab.close();

  const multi = await open("pages/multi.html");
  assert.equal(await multi.rows.nth(0).getAttribute("role"), "checkbox");
  assert.equal(await multi.rows.nth(0).getAttribute("aria-checked"), "false");
  await multi.tab.close();
});

test("10: the kit leaves the page's own styles alone", async () => {
  const { tab, frame, rows } = await open();
  assert.equal(await frame.locator("#outside").evaluate((el) => getComputedStyle(el).color), "rgb(255, 0, 0)");
  const borders = await rows.nth(0).evaluate((row) => [row, ...row.shadowRoot.querySelectorAll("div")]
    .map((el) => getComputedStyle(el))
    .map((style) => [style.borderTopWidth, style.borderBottomWidth]));
  assert.deepEqual(borders, [["0px", "1px"], ["0px", "0px"]]);
  await tab.close();
});

test("11: opened without a parent frame it posts nothing and throws nothing", async () => {
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error));
  await tab.addInitScript(() => {
    window.posted = [];
    addEventListener("message", (event) => window.posted.push(event.data));
  });
  await tab.goto(`${base}/d/pages/ask.html`);
  await tab.locator("mockup-option").first().click();
  await tab.evaluate(() => window.mockup.send("offline"));
  await tab.waitForTimeout(400);
  assert.deepEqual(await tab.evaluate(() => window.posted), []);
  assert.deepEqual(errors, []);
  for (const text of ["Tabs across the top", "All four sections visible at once.", "One step at a time"]) {
    assert.ok(await tab.getByText(text).isVisible(), text);
  }
  await tab.close();
});

test("12: without the script the option text reads as ordinary content", async () => {
  const tab = await browser.newPage();
  await tab.goto(`${base}/d/pages/ask.html?bare`);
  assert.equal(await tab.evaluate(() => customElements.get("mockup-choice")), undefined);
  for (const text of ["Tabs across the top", "All four sections visible at once.", "Sidebar", "Back and Continue only."]) {
    assert.ok(await tab.getByText(text).isVisible(), text);
  }
  await tab.close();
});
