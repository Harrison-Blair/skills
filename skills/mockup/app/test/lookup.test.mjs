// Names that are also Object.prototype keys, fed through the real CLI,
// server, shell and kit wherever an outside string picks an entry: each is
// refused cleanly or handled like any other name, never a crash or a 500.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty"];
const CLI = fileURLToPath(new URL("../bin/mockup.mjs", import.meta.url));
const ENV = { ...process.env };
for (const k of ["CODEX_THREAD_ID", "PI_SESSION_ID", "MOCKUP_DIR"]) delete ENV[k];
const mockup = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: ENV, encoding: "utf8", timeout: 30_000 });
const mockupAsync = async (...args) => (await promisify(execFile)(process.execPath, [CLI, ...args], { env: ENV })).stdout;

let dir, port, pid;

before(() => {
  const out = mockup("start", "--once", "--no-open", "--harness", "claude").stdout;
  dir = out.match(/^dir: (.+)$/m)[1];
  ({ port, pid } = JSON.parse(readFileSync(join(dir, ".runtime", "session.json"), "utf8")));
});

after(() => {
  // The server survived everything below.
  process.kill(pid, 0);
  mockup("stop", "--dir", dir);
  rmSync(dir, { recursive: true, force: true });
});

function call(method, path, body) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, data }));
    });
    req.on("error", fail);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("as a command, each name prints usage", () => {
  for (const name of NAMES) {
    const r = mockup(name);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /usage: mockup start\|show/, name);
  }
});

test("as a device, each name is refused by the CLI and the server", async () => {
  writeFileSync(join(dir, "pages", "ask.html"), "<h1>Ask</h1>");
  for (const name of NAMES) {
    const r = mockup("show", "--dir", dir, "--device", name, "pages/ask.html");
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /--device must be one of/);
    const res = await call("POST", "/api/agent/show", { pages: ["pages/ask.html"], device: name });
    assert.equal(res.status, 400, `${name}: ${res.data}`);
  }
});

test("as a page path or URL path, each name is a page like any other or not found", async () => {
  for (const name of NAMES) {
    writeFileSync(join(dir, "pages", `${name}.html`), `<h1>${name}</h1>`);
    const shown = mockup("show", "--dir", dir, `pages/${name}.html`);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, new RegExp(`^showing: pages/${name}\\.html$`, "m"));
    const bare = mockup("show", "--dir", dir, name);
    assert.equal(bare.status, 1, name);
    assert.match(bare.stderr, /is not a file under pages\//);
    assert.equal((await call("GET", `/d/pages/${name}.html`)).status, 200);
    for (const path of [`/${name}`, `/d/${name}`, `/d/pages/${name}`, `/shell/${name}`, `/api/${name}`, `/kit/${name}`]) {
      const res = await call("GET", path);
      assert.equal(res.status, 404, `${path}: ${res.status} ${res.data}`);
    }
  }
});

test("as a draft kind, each name reaches the agent as an unknown kind", async () => {
  const drafts = NAMES.map((kind, i) => ({ id: `d${i}`, kind, x: 1 }));
  const sent = await call("POST", "/api/messages", { text: "", drafts });
  assert.equal(sent.status, 201, sent.data);
  const r = mockup("wait", "--dir", dir);
  assert.equal(r.status, 0, r.stderr);
  for (const kind of NAMES) assert.match(r.stdout, new RegExp(`^\\* sent a ${kind} draft: \\{"x":1\\}$`, "m"));
  mockup("say", "--dir", dir, "ok");
});

test("as a draft name, each choice is kept, restored after a reload and sent", { timeout: 60_000 }, async () => {
  const choices = NAMES.map((name) => `<mockup-choice name="${name}" label="Pick">
    <mockup-option value="A">A</mockup-option><mockup-option value="B">B</mockup-option></mockup-choice>`);
  writeFileSync(join(dir, "pages", "names.html"), `<title>Names</title>${choices.join("\n")}`);
  mockup("show", "--dir", dir, "pages/names.html");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.body.dataset.connected === "1");
    for (const name of NAMES) await page.frameLocator("iframe").locator(`mockup-choice[name="${name}"] mockup-option[value="B"]`).click();
    await page.getByText(`Unsent (${NAMES.length})`).waitFor();

    // A fresh show of the same page reloads the frame and restores by name.
    await mockupAsync("show", "--dir", dir, "pages/names.html");
    const frame = page.frameLocator("iframe");
    for (const name of NAMES) {
      await frame.locator(`mockup-choice[name="${name}"] mockup-option[value="B"][aria-checked="true"]`).waitFor();
    }
    assert.equal(await page.frames()[1].evaluate(() => Object.getPrototypeOf(window.mockup.state) === Object.prototype), true);
    assert.deepEqual(await page.frames()[1].evaluate(() => Object.keys(window.mockup.state).sort()), [...NAMES].sort());

    await page.getByRole("button", { name: "Send to agent" }).click();
    const r = await mockupAsync("wait", "--dir", dir);
    for (const name of NAMES) assert.match(r, new RegExp(`^\\* chose "B" for ${name} "Pick"$`, "m"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
