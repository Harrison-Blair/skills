// Full loop through the real CLI and a real browser:
// browser Send -> durable inbox -> `mockup wait` -> `mockup say` -> browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mockup.mjs");
const mockup = (cwd, ...args) => run(process.execPath, [CLI, ...args], { cwd, timeout: 240_000 });

let repo, browser, link;

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "mockup-e2e-"));
  const { stdout } = await mockup(repo, "start", "--design", "e2e", "--no-open");
  link = stdout.match(/open: (\S+)/)[1];
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (repo) await mockup(repo, "stop");
});

test("a browser message wakes `mockup wait` and the reply shows in the browser", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  assert.doesNotMatch(page.url(), /token=/, "token must be dropped from the address bar");
  assert.equal(await page.locator(".chat").evaluate((el) => Math.round(el.getBoundingClientRect().width)), 570, "the chat starts 570px wide");

  const waiting = mockup(repo, "wait");
  await page.getByText("Agent listening").waitFor();
  await page.getByLabel("Message").fill("Designing a habit tracker");
  await page.getByLabel("Message").press("Enter");

  const { stdout } = await waiting;
  assert.match(stdout, /Designing a habit tracker/);

  await mockup(repo, "say", "Who uses it?");
  await page.getByText("Who uses it?").waitFor();
  await page.getByText("Done").waitFor();
  if (process.env.MOCKUP_SCREENSHOT) await page.screenshot({ path: process.env.MOCKUP_SCREENSHOT });
});

test("rounds appear under their stage, notes attach to them, and long text stays inside bubbles", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  await mockup(repo, "round", "--stage", "context", "--title", "Draft brief", "**Streak** is a *habit tracker*.");
  const rail = page.getByRole("navigation", { name: "Stages and review rounds" });
  await rail.getByRole("button", { name: /Round 1 · Draft brief/ }).waitFor();
  await page.locator(".canvas strong", { hasText: "Streak" }).waitFor();

  const waiting = mockup(repo, "wait");
  await page.getByLabel("Message").fill("Make it `calmer` " + "x".repeat(300));
  await page.getByLabel("Message").press("Enter");
  assert.match((await waiting).stdout, /about round context-1/);
  await page.locator(".notes code", { hasText: "calmer" }).waitFor();

  const bubble = await page.locator(".message.user").last().evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  assert.ok(bubble.scroll <= bubble.client + 1, `text overflows its bubble (${bubble.scroll} > ${bubble.client})`);
  await mockup(repo, "say", "Noted.");

  // A long conversation scrolls inside the chat; the composer stays on screen.
  for (let i = 0; i < 12; i++) await mockup(repo, "say", "--progress", `line ${i}\n\nmore\n\nand more`);
  await page.getByText("line 11").waitFor();
  const list = await page.locator(".messages").evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  assert.ok(list.scroll > list.client, "messages should overflow into a scroll area");
  const squashed = await page.locator(".message").evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight + 1).length);
  assert.equal(squashed, 0, "bubbles must grow to fit their text, not be squashed by the scroll area");
  const composer = await page.getByLabel("Message").boundingBox();
  assert.ok(composer.y + composer.height <= page.viewportSize().height, "composer pushed off screen");
});

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("likes, choices, selections, pins and uploads reach the agent as one feedback message", { timeout: 90_000 }, async () => {
  const designDir = join(repo, ".design", "e2e");
  mkdirSync(join(designDir, "assets", "web"), { recursive: true });
  writeFileSync(join(designDir, "assets", "web", "a.png"), PNG_1PX);
  writeFileSync(join(repo, "round.json"), JSON.stringify({
    stage: "mood", title: "Taste check", kind: "explore",
    pages: [
      { title: "Looks", blocks: [{ type: "option", id: "calm", title: "Calm paper", images: ["assets/web/a.png"] }] },
      { title: "Questions", blocks: [{ type: "question", id: "tone", text: "Tone?", choices: ["Quiet", "Loud"] }] },
    ],
  }));
  await mockup(repo, "round", "--file", "round.json");

  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Taste check/ }).click();
  const card = page.locator("article.option", { hasText: "Calm paper" });
  await card.getByRole("button", { name: "Like", exact: true }).click();
  await card.getByText("not sent yet").waitFor();
  await card.getByRole("button", { name: "Select" }).click();
  await card.getByRole("button", { name: "Pin" }).click();
  const box = await card.locator(".mark-surface").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await card.getByLabel("Note on mark 1").fill("this spot");
  await card.getByLabel("Note on mark 1").press("Enter");

  await card.getByRole("button", { name: "Add comment" }).click();
  await card.getByLabel("Comment").fill("a bit warmer");
  await card.getByLabel("Comment").blur();
  await card.getByRole("button", { name: "Comment", exact: true }).waitFor();

  await page.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("radio", { name: "Loud" }).check();
  await page.locator("input[type=file]").setInputFiles({ name: "ref.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.locator(".thumb-chip img").waitFor();

  const waiting = mockup(repo, "wait");
  await page.getByRole("complementary", { name: "Chat with the agent" }).getByRole("button", { name: "Send feedback" }).click();
  const { stdout } = await waiting;
  assert.match(stdout, /liked mood-\d+\/calm "Calm paper"/);
  assert.match(stdout, /commented on mood-\d+\/calm "Calm paper": a bit warmer/);
  assert.match(stdout, /chose "Loud" for mood-\d+\/tone/);
  assert.match(stdout, /selected mood-\d+\/calm "Calm paper"/);
  assert.match(stdout, /1\. pin at 50% across, 50% down: this spot/);
  assert.match(stdout, /\(your assets\/web\/a\.png as published in mood-\d+\)/, "the agent learns which of its files was marked");
  const upload = stdout.match(/uploaded image: (\S+)/)[1];
  const render = stdout.match(/open (\S+) to see the marks/)[1];
  assert.ok(existsSync(upload) && existsSync(render), "attached files exist where the agent is told to look");
  await card.getByText("not sent yet").waitFor({ state: "detached" });
  await mockup(repo, "say", "Thanks!");

  // The pin stays where it was placed, with its note, after sending and a reload.
  await page.reload();
  await page.getByRole("button", { name: /Taste check/ }).click();
  await card.getByRole("button", { name: "Mark 1", exact: true }).click();
  assert.equal(await card.getByLabel("Note on mark 1").inputValue(), "this spot");
});

test("a long round scrolls inside the canvas, never the page", { timeout: 60_000 }, async () => {
  const blocks = Array.from({ length: 12 }, (_, i) => ({ type: "question", id: `q${i}`, text: `Question ${i}?`, choices: ["A", "B", "C"] }));
  writeFileSync(join(repo, "long.json"), JSON.stringify({ stage: "context", title: "Many questions", pages: [{ title: "Q", blocks }] }));
  await mockup(repo, "round", "--file", "long.json");
  const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
  await page.goto(link);
  await page.getByRole("button", { name: /Many questions/ }).click();
  await page.locator("p", { hasText: "Question 11?" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 700, "hidden question legends stretch the page");
  await page.mouse.move(100, 500);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => scrollY), 0, "wheeling over the stages panel scrolls the page");
});

test("questions step one at a time, compare in columns, and take a write-in", { timeout: 90_000 }, async () => {
  const designDir = join(repo, ".design", "e2e");
  mkdirSync(join(designDir, "assets", "own"), { recursive: true });
  writeFileSync(join(designDir, "assets", "own", "b.png"), PNG_1PX);
  writeFileSync(join(repo, "steps.json"), JSON.stringify({
    stage: "states", title: "Stepping", pages: [{ title: "Q", questions: "one", blocks: [
      { type: "markdown", text: "Intro stays put." },
      { type: "question", id: "nav", text: "Which nav?", columns: 2, choices: [
        { label: "Sidebar", text: "Like the editor", images: ["assets/own/b.png"] },
        { label: "Top tabs", text: "Simpler" },
        { label: "Palette", text: "Keyboard first" },
      ] },
      { type: "question", id: "extras", text: "Which extras?", multiple: true, other: true, choices: ["Search", "RSS"] },
    ] }],
  }));
  await mockup(repo, "round", "--file", "steps.json");
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(link);
  await page.getByRole("button", { name: /Stepping/ }).click();

  // Starts one at a time, as the round asked; other blocks stay.
  await page.getByText("Question 1 of 2").waitFor();
  await page.getByText("Intro stays put.").waitFor();
  assert.equal(await page.locator("article.question").count(), 1);
  const [a, b, c] = await page.locator(".choice.rich").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
  assert.ok(a.y === b.y && b.x > a.x, "the first two choices sit side by side");
  assert.ok(c.y > a.y, "the third wraps to the next row");
  await page.getByRole("radio", { name: "Top tabs" }).check();

  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByText("Question 2 of 2").waitFor();
  await page.getByRole("checkbox", { name: "Search" }).check();
  await page.getByRole("checkbox", { name: "Other…" }).check();
  await page.getByLabel("Your own answer").fill("A terminal");
  await page.getByLabel("Your own answer").press("Enter");

  await page.getByRole("button", { name: "All" }).click();
  assert.equal(await page.locator("article.question").count(), 2, "All shows every question");

  const waiting = mockup(repo, "wait");
  await page.getByRole("complementary", { name: "Chat with the agent" }).getByRole("button", { name: "Send feedback" }).click();
  const { stdout } = await waiting;
  assert.match(stdout, /chose "Top tabs" for states-\d+\/nav/);
  assert.match(stdout, /chose "Search" and wrote in "A terminal" for states-\d+\/extras/);
  await mockup(repo, "say", "Got it.");
});

test("choices are radio or checkbox rows, and side panels resize and collapse", { timeout: 60_000 }, async () => {
  writeFileSync(join(repo, "q.json"), JSON.stringify({
    stage: "mood", title: "Choices", pages: [{ title: "Q", blocks: [
      { type: "question", id: "one", text: "Pick one", choices: ["A", "B"] },
      { type: "question", id: "many", text: "Pick any", choices: ["X", "Y", "Z"], multiple: true },
    ] }],
  }));
  await mockup(repo, "round", "--file", "q.json");
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(link);
  await page.getByRole("button", { name: /Choices/ }).click();
  await page.getByRole("radio", { name: "B" }).check();
  await page.getByRole("checkbox", { name: "X" }).check();
  await page.getByRole("checkbox", { name: "Z" }).check();
  await page.getByRole("checkbox", { name: "X" }).uncheck();
  await page.waitForTimeout(200);
  const { decisions } = await (await page.request.get(new URL("/api/state", link).href)).json();
  const last = (item) => decisions.filter((d) => d.item === item).at(-1).value;
  assert.equal(last("one"), "B");
  assert.deepEqual(last("many"), ["Z"]);

  const nav = page.getByRole("navigation", { name: "Stages and review rounds" });
  const before = (await nav.boundingBox()).width;
  const handle = await page.getByRole("separator", { name: "Resize stages panel" }).boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + 103, handle.y + 100, { steps: 4 });
  await page.mouse.up();
  assert.ok((await nav.boundingBox()).width > before + 80, "dragging the divider widens the stages panel");

  await page.getByRole("button", { name: "Hide stages panel" }).click();
  await page.getByRole("button", { name: "Hide chat panel" }).click();
  assert.equal(await nav.isVisible(), false);
  assert.equal(await page.locator("aside.chat").isVisible(), false);
  const canvas = await page.locator(".canvas").boundingBox();
  assert.ok(canvas.width > 1300, "the round takes the freed space");
  await page.reload();
  assert.equal(await page.locator("aside.chat").isVisible(), false, "collapsed state is remembered");
  await page.getByRole("button", { name: "Show chat panel" }).click();
  await page.getByRole("button", { name: "Show stages panel" }).click();
  await page.locator("aside.chat").waitFor();
});

test("marks can be removed and edited later, and edits reach the agent", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Taste check/ }).click();
  const card = page.locator("article.option", { hasText: "Calm paper" });
  const surface = card.locator(".mark-surface");
  const rings = card.locator(".ring");
  // Measure after the tool click: clicking may scroll the image.
  const measure = async () => {
    await surface.scrollIntoViewIfNeeded();
    return surface.boundingBox();
  };
  const note = (n) => card.getByLabel(`Note on mark ${n}`);

  // The sent pin from the last test is mark 1; add two circles after it.
  await card.getByRole("button", { name: "Circle" }).click();
  let box = await measure();
  for (const x of [0.15, 0.55]) {
    await page.mouse.move(box.x + box.width * x, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (x + 0.1), box.y + box.height * 0.25, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
  }
  await rings.nth(1).waitFor();
  await card.getByRole("button", { name: "Circle" }).click();

  // Remove the second circle from its note box; later marks renumber.
  await card.getByRole("button", { name: "Mark 3", exact: true }).click();
  await card.getByRole("dialog", { name: "Mark 3" }).getByRole("button", { name: "Remove mark 3" }).click();
  await rings.nth(1).waitFor({ state: "detached" });

  // Edit the sent pin's note; the change goes to the agent.
  await card.getByRole("button", { name: "Mark 1", exact: true }).click();
  await note(1).fill("this spot, but warmer");
  await note(1).press("Enter");
  const waiting = mockup(repo, "wait");
  await page.getByRole("complementary", { name: "Chat with the agent" }).getByRole("button", { name: "Send feedback" }).click();
  const { stdout } = await waiting;
  assert.match(stdout, /1\. pin at 50% across, 50% down: this spot, but warmer/);
  assert.match(stdout, /2\. circle at/);
  await mockup(repo, "say", "Noted.");

  // A second tab on the same session follows along.
  const other = await browser.newPage();
  await other.goto(link);
  await other.getByRole("button", { name: /Taste check/ }).click();
  const otherRings = other.locator("article.option", { hasText: "Calm paper" }).locator(".ring");
  await otherRings.first().waitFor();
  await card.getByRole("button", { name: "Mark 2", exact: true }).click();
  await card.getByRole("dialog", { name: "Mark 2" }).getByRole("button", { name: "Remove mark 2" }).click();
  await otherRings.first().waitFor({ state: "detached" });
  await other.close();

  // Everything is still in place after a reload.
  await page.reload();
  await page.getByRole("button", { name: /Taste check/ }).click();
  await card.getByRole("button", { name: "Mark 1", exact: true }).click();
  assert.equal(await note(1).inputValue(), "this spot, but warmer");
  assert.equal(await rings.count(), 0);
});

test("rounds show their state from new to reviewed, and drafts to approved", { timeout: 60_000 }, async () => {
  writeFileSync(join(repo, "s.json"), JSON.stringify({
    stage: "language", title: "Status check", pages: [{ title: "P", blocks: [
      { type: "question", id: "a", text: "A?" }, { type: "question", id: "b", text: "B?" },
    ] }],
  }));
  await mockup(repo, "round", "--file", "s.json");
  const page = await browser.newPage();
  await page.goto(link);
  const rail = page.getByRole("button", { name: /Status check/ });
  const status = () => rail.locator(".status-pill").textContent();
  await rail.click();
  assert.equal(await status(), "New");
  await page.locator("article.question").first().getByRole("button", { name: "Like", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".rounds .selected .status-pill")?.textContent === "In progress · 1/2");
  await page.getByRole("complementary", { name: "Chat with the agent" }).getByRole("button", { name: "Send feedback" }).click();
  await page.waitForFunction(() => document.querySelector(".rounds .selected .status-pill")?.textContent === "Agent working");
  await mockup(repo, "wait");
  await mockup(repo, "say", "Got it");
  await page.waitForFunction(() => document.querySelector(".rounds .selected .status-pill")?.textContent === "Reviewed");

  await mockup(repo, "round", "--stage", "language", "--kind", "draft", "--title", "Status draft", "Tokens");
  const draft = page.getByRole("button", { name: /Status draft/ });
  await draft.locator(".status-pill", { hasText: "Awaiting approval" }).waitFor();
  await draft.click();
  await page.getByRole("button", { name: "Approve draft" }).click();
  await draft.locator(".status-pill", { hasText: "Approved" }).waitFor();
  const stage = page.locator("section.stage", { hasText: "Design language" }).locator("h2 .status-pill");
  assert.equal(await stage.textContent(), "Approved");

  // A newer draft with changes requested takes the stage out of Approved.
  await mockup(repo, "round", "--stage", "language", "--kind", "draft", "--title", "Status draft two", "Tokens v2");
  await page.getByRole("button", { name: /Status draft two/ }).click();
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("section.stage")].find((s) => s.textContent.includes("Design language"))?.querySelector("h2 .status-pill")?.textContent === "Changes requested");
});

test("the page refuses to work without the token link", { timeout: 30_000 }, async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(new URL("/", link).href);
  await page.getByText("needs the link the agent printed").waitFor();
});

function designFile(rel, source) {
  const full = join(repo, ".design", "e2e", ...rel.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source);
  return rel;
}

test("a live preview can be clicked, resized, themed, and frozen for annotation", { timeout: 90_000 }, async () => {
  designFile("ui/tokens.css", ':root { --bg: rgb(250, 250, 250); --ink: rgb(10, 10, 10); } [data-theme="dark"] { --bg: rgb(20, 20, 20); --ink: rgb(245, 245, 245); } body { margin: 0; background: var(--bg); color: var(--ink); }');
  designFile("ui/components/Counter.jsx", 'import { useState } from "react";\nexport default function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>Done: {n}</button>; }');
  designFile("ui/pages/Today.jsx", 'import "../tokens.css";\nimport Counter from "../components/Counter.jsx";\nexport default () => <main><h1>Today</h1><Counter /></main>;');
  const file = join(repo, "proto.json");
  writeFileSync(file, JSON.stringify({ stage: "prototype", title: "Today live", pages: [{ title: "Today", blocks: [{ type: "preview", id: "today", title: "Today screen", src: "ui/pages/Today.jsx" }] }] }));
  await mockup(repo, "round", "--file", file);

  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Today live/ }).click();
  const card = page.locator("article.preview");
  const inside = page.frameLocator("iframe[title='Today screen']");
  await inside.getByRole("button", { name: "Done: 0" }).click();
  await inside.getByRole("button", { name: "Done: 1" }).waitFor();

  await card.getByRole("button", { name: "Phone" }).click();
  assert.equal(await card.locator("iframe").evaluate((f) => f.offsetWidth), 390);
  await card.getByRole("button", { name: "Light" }).click();
  await card.getByRole("button", { name: "Dark" }).waitFor();
  // The theme reaches the frame by message, so give it a moment.
  const frame = () => page.frames().find((f) => f.url().includes("/previews/"));
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && (await frame().evaluate(() => document.documentElement.dataset.theme)) !== "dark"; i++) await page.waitForTimeout(100);
  assert.equal(await inside.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor), "rgb(20, 20, 20)");

  await card.getByRole("button", { name: "Annotate" }).click();
  const surface = card.locator(".mark-surface");
  await surface.locator("img").waitFor();
  const size = await surface.locator("img").evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  assert.ok(size[0] >= 390 && size[1] >= 844, `snapshot is the phone screen (${size})`);
  // The picture shows the page itself: its light heading text on the dark
  // theme is there (a blank picture would be background only).
  const inked = await surface.locator("img").evaluate((img) => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, Math.round(c.height / 4)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 600) n++;
    return n;
  });
  assert.ok(inked > 100, `snapshot shows the page's text (${inked} bright pixels)`);
  // Pin is ready, next to Annotate, the moment the picture is taken.
  const actions = card.locator(".card-actions");
  assert.equal(await actions.getByRole("button", { name: "Pin" }).getAttribute("aria-pressed"), "true");
  const order = await actions.locator("button").allTextContents();
  assert.ok(order.indexOf("Done annotating") < order.indexOf("Pin") && order.indexOf("Circle") < order.indexOf("Flag"), `Annotate, Pin, Circle, then Flag: ${order}`);
  const box = await surface.boundingBox();
  await surface.click({ position: { x: box.width / 2, y: 40 } });
  // The new pin's note box opens at once.
  await card.getByLabel("Note on mark 1").fill("bigger title");
  await card.getByLabel("Note on mark 1").press("Enter");

  // Back on the live page, which kept its state; the picture stays as a thumbnail.
  await card.getByRole("button", { name: "Done annotating" }).click();
  await inside.getByRole("button", { name: "Done: 1" }).waitFor();
  const thumb = card.getByRole("button", { name: "Open annotation 1 (1 mark)" });
  await thumb.waitFor();

  const waiting = mockup(repo, "wait");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const { stdout } = await waiting;
  assert.match(stdout, /a snapshot of the live preview prototype-1\/today "Today screen"/);
  assert.match(stdout, /pin at 50% across.*: bigger title/);
  const render = stdout.match(/open (\S+\.png) to see the marks/)[1];
  assert.ok(existsSync(render));
  await mockup(repo, "say", "Got it.");
  // The agent's copy has the pin drawn where it was placed.
  const rel = render.slice(render.search(/renders[\\/]/)).split("\\").join("/");
  const red = await page.evaluate(async ({ rel, y }) => {
    const img = new Image();
    img.src = `/files/${rel}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const unit = Math.max(c.width, c.height) / 60;
    const d = ctx.getImageData(c.width / 2 - unit, y * c.height - unit, unit * 2, unit * 2).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 120) n++;
    return n;
  }, { rel, y: 40 / box.height });
  assert.ok(red > 20, `the pin is drawn on the agent's copy (${red} red pixels)`);

  // After sending, the thumbnail reopens the picture with its pin and note.
  await thumb.click();
  await card.getByRole("button", { name: "Mark 1", exact: true }).click();
  assert.equal(await card.getByLabel("Note on mark 1").inputValue(), "bigger title");
});

test("Annotate works even when clicked before the preview has loaded", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  // Hold the preview back so the click lands before the frame can listen.
  await page.route("**/previews/**", async (route) => {
    await new Promise((ok) => setTimeout(ok, 1500));
    await route.continue();
  });
  await page.goto(link);
  await page.getByRole("button", { name: /Today live/ }).click();
  const card = page.locator("article.preview");
  await card.getByRole("button", { name: "Annotate" }).click();
  await card.locator(".preview-snapshot img").waitFor({ timeout: 20_000 });
});

test("Go to unanswered and Next flagged jump across pages", { timeout: 60_000 }, async () => {
  const file = join(repo, "qs.json");
  writeFileSync(file, JSON.stringify({ stage: "mood", title: "Jump check", pages: [
    { title: "One", blocks: [
      { type: "question", id: "q1", text: "First?", choices: ["A", "B"] },
      { type: "question", id: "q2", text: "Second?", choices: ["A", "B"] },
    ] },
    { title: "Two", blocks: [{ type: "question", id: "q3", text: "Third?", choices: ["A", "B"] }] },
  ] }));
  await mockup(repo, "round", "--file", file);
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Jump check/ }).click();
  // The jump buttons share the blue line above the message box with Send feedback.
  const bar = page.getByRole("complementary", { name: "Chat with the agent" }).locator(".review-line");
  // Jumps land a render later, so wait for the expected item to take focus.
  const focused = async (id) => {
    await page.locator(`#${id}[data-focused]`).waitFor({ timeout: 5000 }).catch(() => {});
    return page.locator(".card[data-focused]").getAttribute("id");
  };

  await bar.getByRole("button", { name: "Go to unanswered (3)" }).click();
  assert.equal(await focused("item-q1"), "item-q1");
  await page.locator("#item-q1").getByRole("radio", { name: "A", exact: true }).check();
  await bar.getByRole("button", { name: "Send feedback" }).waitFor();
  await bar.getByRole("button", { name: "Go to unanswered (2)" }).click();
  assert.equal(await focused("item-q2"), "item-q2");
  await bar.getByRole("button", { name: "Go to unanswered (2)" }).click();
  assert.equal(await focused("item-q3"), "item-q3", "moves to the next page");
  await page.getByRole("heading", { name: "Two" }).waitFor();

  await page.locator("#item-q3").getByRole("button", { name: "Flag" }).click();
  await page.getByRole("button", { name: "One", exact: true }).click();
  await page.locator("#item-q1").getByRole("button", { name: "Flag" }).click();
  await bar.getByRole("button", { name: "Next flagged (2)" }).click();
  assert.equal(await focused("item-q1"), "item-q1", "starts from the page the user turned to");
  await bar.getByRole("button", { name: "Next flagged (2)" }).click();
  assert.equal(await focused("item-q3"), "item-q3");
  await bar.getByRole("button", { name: "Next flagged (2)" }).click();
  assert.equal(await focused("item-q1"), "item-q1", "wraps around");

  // Flags survive a reload.
  await page.reload();
  await page.getByRole("button", { name: /Jump check/ }).click();
  await bar.getByRole("button", { name: "Next flagged (2)" }).waitFor();
});

test("narrow windows keep the round full width, with stages and chat as drawers", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(link);
  const canvas = page.locator(".canvas");
  await canvas.locator("h1").waitFor();
  assert.ok((await canvas.boundingBox()).width >= 385, "the round takes the full width");
  const noPageScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert.ok(await noPageScroll(), "no sideways scrolling");
  const rail = page.getByRole("navigation", { name: "Stages and review rounds" });
  const chat = page.getByRole("complementary", { name: "Chat with the agent" });
  assert.equal(await rail.isVisible(), false, "stages start closed");
  assert.equal(await chat.isVisible(), false, "chat starts closed");

  // Picking a round closes the stages drawer.
  await page.getByRole("button", { name: "Show stages panel" }).click();
  await rail.getByRole("button", { name: /Jump check/ }).click();
  await page.getByRole("heading", { name: "Jump check" }).waitFor();
  await rail.waitFor({ state: "hidden" });

  // The chat drawer opens over the round and works; the scrim closes it.
  await page.getByRole("button", { name: "Show chat panel" }).click();
  await chat.getByLabel("Message").waitFor();
  assert.ok((await chat.boundingBox()).width >= 385, "the chat fills a phone screen");
  // Messages stay inside their scrolling list, clear of the composer.
  const escaped = await chat.evaluate((el) => {
    const list = el.querySelector(".messages").getBoundingClientRect();
    return [...el.querySelectorAll(".message")].filter((m) => getComputedStyle(m).position !== "static" || m.getBoundingClientRect().bottom > list.bottom + 1 && m.getBoundingClientRect().top < list.bottom).length;
  });
  assert.equal(escaped, 0, "no message sits outside the message list");
  const waiting = mockup(repo, "wait");
  await chat.getByLabel("Message").fill("From my phone");
  await chat.getByLabel("Message").press("Enter");
  assert.match((await waiting).stdout, /From my phone/);
  await mockup(repo, "say", "Hi, phone.");
  // Jumping to an item from the chat closes the drawer so the item shows.
  await chat.getByRole("button", { name: /Go to unanswered/ }).click();
  await chat.waitFor({ state: "hidden" });
  assert.ok(await noPageScroll(), "no sideways scrolling with a round open");

  // A preview that starts in a phone frame scales down to fit, rather than
  // being cut off.
  const file = join(repo, "phone.json");
  writeFileSync(file, JSON.stringify({ stage: "prototype", title: "Phone first", pages: [{ title: "Today", blocks: [{ type: "preview", id: "today", title: "Today phone", src: "ui/pages/Today.jsx", device: "phone" }] }] }));
  await mockup(repo, "round", "--file", file);
  await page.getByRole("button", { name: "Show stages panel" }).click();
  await rail.getByRole("button", { name: /Phone first/ }).click();
  const card = page.locator("article.preview");
  await page.frameLocator("iframe[title='Today phone']").getByRole("heading", { name: "Today" }).waitFor();
  const frame = await card.locator(".preview-frame").boundingBox();
  const cardBox = await card.boundingBox();
  assert.ok(frame.x + frame.width <= cardBox.x + cardBox.width + 1 && cardBox.x + cardBox.width <= 391, `frame ${frame.x}+${frame.width} fits card ${cardBox.x}+${cardBox.width}`);
});

test("medium windows cap the side panels so the round keeps its room", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(link);
  await page.locator(".canvas h1").waitFor();
  const width = await page.locator(".canvas").evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(width >= 300, `the round is ${width}px wide`);
});

test("sending waits for a comment that is still saving", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Taste check/ }).click();
  // Hold every save back, so the send would overtake it.
  await page.route("**/api/decisions", async (route) => {
    await new Promise((ok) => setTimeout(ok, 1000));
    await route.continue();
  });
  const card = page.locator("article.option", { hasText: "Calm paper" });
  // The card may already have a comment, which opens its box.
  if (!(await card.getByLabel("Comment").isVisible())) await card.getByRole("button", { name: /Comment/ }).click();
  await card.getByLabel("Comment").fill("slow but saved");
  const chat = page.getByRole("complementary", { name: "Chat with the agent" });
  await chat.getByLabel("Message").fill("see my comment");
  const waiting = mockup(repo, "wait");
  await chat.getByLabel("Message").press("Enter");
  assert.match((await waiting).stdout, /commented on mood-\d+\/calm "Calm paper": slow but saved/);
  await mockup(repo, "say", "Seen.");
});

test("updates sent while the live connection is down still arrive", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  // The first live connection opens and drops at once; the reconnect waits
  // until a reply has been sent in between.
  let release;
  const gate = new Promise((ok) => (release = ok));
  let calls = 0;
  await page.route("**/api/events", async (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": hello\n\n" });
    await gate;
    await route.continue();
  });
  await page.goto(link);
  await page.getByText("Disconnected").waitFor({ timeout: 20_000 });
  await mockup(repo, "say", "--progress", "said while you were away");
  release();
  await page.getByText("said while you were away").waitFor({ timeout: 20_000 });
});

test("switching rounds does not carry a frozen preview over", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Today live/ }).click();
  await page.locator("article.preview").getByRole("button", { name: "Annotate" }).click();
  await page.locator(".preview-snapshot img").waitFor();
  await page.getByRole("button", { name: /Phone first/ }).click();
  await page.frameLocator("iframe[title='Today phone']").getByRole("heading", { name: "Today" }).waitFor();
  assert.equal(await page.locator(".preview-snapshot").count(), 0);
});

test("marks placed while an earlier save is slow are all kept", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Taste check/ }).click();
  const card = page.locator("article.option", { hasText: "Calm paper" });
  const pins = card.locator(".pin");
  const before = await pins.count();
  // Every save takes 1.5s, and saves go out one at a time.
  await page.route("**/api/annotations", async (route) => {
    await new Promise((ok) => setTimeout(ok, 1500));
    await route.continue();
  });
  await card.getByRole("button", { name: "Pin" }).click();
  const surface = card.locator(".mark-surface");
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  for (const x of [0.2, 0.4]) {
    await surface.click({ position: { x: box.width * x, y: box.height * 0.9 } });
    await page.keyboard.press("Escape");
  }
  // The first save has echoed back; the second has not.
  await page.waitForTimeout(2000);
  await surface.click({ position: { x: box.width * 0.6, y: box.height * 0.9 } });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(5000);
  await page.reload();
  await page.getByRole("button", { name: /Taste check/ }).click();
  await pins.nth(before + 2).waitFor();
  assert.equal(await pins.count(), before + 3);
});

test("a slow reload from an old connection does not undo newer state", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  let states = 0;
  let releaseOld;
  const oldHeld = new Promise((ok) => (releaseOld = ok));
  let releaseReconnect;
  const reconnect = new Promise((ok) => (releaseReconnect = ok));
  await page.route("**/api/state", async (route) => {
    states++;
    if (states !== 2) return route.continue();
    // The first connection's load: taken now, delivered late.
    const response = await route.fetch();
    await oldHeld;
    await route.fulfill({ response });
  });
  let events = 0;
  await page.route("**/api/events", async (route) => {
    events++;
    if (events === 1) return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": hello\n\n" });
    await reconnect;
    await route.continue();
  });
  await page.goto(link);
  await page.getByText("Disconnected").waitFor({ timeout: 20_000 });
  await mockup(repo, "say", "--progress", "newer than the old load");
  releaseReconnect();
  await page.getByText("newer than the old load").waitFor({ timeout: 20_000 });
  releaseOld();
  await page.waitForTimeout(1000);
  assert.ok(await page.getByText("newer than the old load").isVisible(), "the old load did not overwrite newer state");
});

test("a save that failed blocks sending until it is redone", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(link);
  await page.getByRole("button", { name: /Taste check/ }).click();
  let fail = true;
  await page.route("**/api/decisions", async (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
    }
    await route.continue();
  });
  const card = page.locator("article.option", { hasText: "Calm paper" });
  if (!(await card.getByLabel("Comment").isVisible())) await card.getByRole("button", { name: /Comment/ }).click();
  await card.getByLabel("Comment").fill("must not be lost");
  await card.getByLabel("Comment").blur();
  const chat = page.getByRole("complementary", { name: "Chat with the agent" });
  await chat.getByLabel("Message").fill("sending now");
  await chat.getByLabel("Message").press("Enter");
  await chat.getByRole("alert").filter({ hasText: /could not be saved/ }).waitFor();

  // Redoing the edit clears the block, and the comment goes with the message.
  await card.getByLabel("Comment").fill("must not be lost, take two");
  await card.getByLabel("Comment").blur();
  const waiting = mockup(repo, "wait");
  await chat.getByLabel("Message").press("Enter");
  assert.match((await waiting).stdout, /commented on mood-\d+\/calm "Calm paper": must not be lost, take two/);
  await mockup(repo, "say", "Got it.");
});

test("sending right after a mark draws the agent's copy with that mark", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Taste check/ }).click();
  await page.route("**/api/annotations", async (route) => {
    await new Promise((ok) => setTimeout(ok, 1000));
    await route.continue();
  });
  const card = page.locator("article.option", { hasText: "Calm paper" });
  await card.getByRole("button", { name: "Pin" }).click();
  const surface = card.locator(".mark-surface");
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  const chat = page.getByRole("complementary", { name: "Chat with the agent" });
  await chat.getByLabel("Message").fill("look at this");
  await surface.click({ position: { x: box.width * 0.8, y: box.height * 0.1 } });
  await page.keyboard.press("Escape");
  // Send at once, while the pin's save is still on its way.
  const waiting = mockup(repo, "wait");
  await chat.getByLabel("Message").press("Enter");
  const { stdout } = await waiting;
  assert.match(stdout, /pin at 80% across, 10% down/);
  assert.match(stdout, /open \S+ to see the marks drawn on it/);
  await mockup(repo, "say", "Seen.");
});

test("marks from another tab arrive even while this tab's save is slow", { timeout: 60_000 }, async () => {
  const designDir = join(repo, ".design", "e2e");
  mkdirSync(join(designDir, "assets", "web"), { recursive: true });
  writeFileSync(join(designDir, "assets", "web", "tab-sync.png"), PNG_1PX);
  writeFileSync(join(repo, "tab-sync.json"), JSON.stringify({
    stage: "mood", title: "Cross tab marks", kind: "explore",
    pages: [{ title: "Looks", blocks: [
      { type: "option", id: "calm", title: "Calm paper", images: ["assets/web/tab-sync.png"] },
    ] }],
  }));
  await mockup(repo, "round", "--file", "tab-sync.json");
  const [mine, theirs] = [await browser.newPage(), await browser.newPage()];
  for (const p of [mine, theirs]) {
    await p.goto(link);
    await p.getByRole("button", { name: /Cross tab marks/ }).click();
  }
  const card = (p) => p.locator("article.option", { hasText: "Calm paper" });
  const place = async (p, x, y) => {
    const surface = card(p).locator(".mark-surface");
    await card(p).getByRole("button", { name: "Pin" }).click();
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    await surface.click({ position: { x: box.width * x, y: box.height * y } });
    await p.keyboard.press("Escape");
    await card(p).getByRole("button", { name: "Pin" }).click();
  };
  const before = await card(mine).locator(".pin").count();
  assert.equal(await card(theirs).locator(".pin").count(), before);
  // Wait until the server has stored my mark, but hold its answer back.
  let stored;
  const storedOnServer = new Promise((ok) => (stored = ok));
  let release;
  const held = new Promise((ok) => (release = ok));
  await mine.route("**/api/annotations", async (route) => {
    const response = await route.fetch();
    stored();
    await held;
    await route.fulfill({ response });
  });
  try {
    await place(mine, 0.1, 0.3);
    await storedOnServer;
    // Do not let the second edit race the first server write. This also proves
    // the other tab receives the update while the first response is still held.
    await card(theirs).locator(".pin").nth(before).waitFor();
    await place(theirs, 0.3, 0.3);
    await card(theirs).locator(".pin").nth(before + 1).waitFor();
    release();
    await card(mine).locator(".pin").nth(before + 1).waitFor({ timeout: 5000 });
    await mine.unroute("**/api/annotations");
    // A new pin here must not drop the other tab's pin.
    await place(mine, 0.5, 0.3);
    await mine.waitForTimeout(500);
    await mine.reload();
    await mine.getByRole("button", { name: /Cross tab marks/ }).click();
    await card(mine).locator(".pin").nth(before + 2).waitFor();
    assert.equal(await card(mine).locator(".pin").count(), before + 3);
  } finally {
    release();
    await mine.unroute("**/api/annotations");
  }
});

test("marking pauses while a message is being sent", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Taste check/ }).click();
  const card = page.locator("article.option", { hasText: "Calm paper" });
  const surface = card.locator(".mark-surface");
  const pinAt = async (x, y) => {
    await card.getByRole("button", { name: "Pin" }).click();
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    await surface.click({ position: { x: box.width * x, y: box.height * y } });
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Pin" }).click();
  };
  await pinAt(0.15, 0.6);
  await page.waitForTimeout(500);
  // Hold the drawn copy's upload, and add a pin meanwhile.
  let release;
  const held = new Promise((ok) => (release = ok));
  await page.route("**/api/uploads?kind=render", async (route) => {
    await held;
    await route.continue();
  });
  const chat = page.getByRole("complementary", { name: "Chat with the agent" });
  const waiting = mockup(repo, "wait");
  await chat.getByRole("button", { name: "Send feedback" }).click();
  await page.waitForTimeout(300);
  // Marking pauses while a message is on its way.
  assert.equal(await card.getByRole("button", { name: "Pin" }).isDisabled(), true);
  release();
  const { stdout } = await waiting;
  assert.match(stdout, /pin at 15% across, 60% down/);
  await mockup(repo, "say", "Seen.");
  await card.getByRole("button", { name: "Pin" }).waitFor({ state: "visible" });
  assert.equal(await card.getByRole("button", { name: "Pin" }).isDisabled(), false, "and resumes after");
});

test("images in round text show the copy published with the round", { timeout: 30_000 }, async () => {
  const own = join(repo, ".design", "e2e", "assets", "own");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "inline.png"), PNG_1PX);
  writeFileSync(join(own, "a b.png"), PNG_1PX);
  writeFileSync(join(own, "café.png"), PNG_1PX);
  await mockup(repo, "round", "--stage", "mood", "--title", "Inline image", "See ![swatch](<assets/own/inline.png>) ![space](<assets/own/a b.png>) ![accent](assets/own/café.png)");
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /Inline image/ }).click();
  const imgs = page.locator(".canvas .md img");
  await imgs.nth(2).waitFor();
  for (const img of await imgs.all()) {
    assert.match(await img.getAttribute("src"), /^\/files\/assets\/published\/[0-9a-f]{64}\.png$/);
    await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle());
  }
});

// Last: it ends the shared session.
test("End session asks for confirmation and closes the composer", { timeout: 30_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(link);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "End session" }).click();
  await page.getByText("Session ended. You can close this tab.").waitFor();
  assert.equal(await page.getByLabel("Message").isDisabled(), true);
  assert.match((await mockup(repo, "wait")).stdout, /The user ended the session/);
});
