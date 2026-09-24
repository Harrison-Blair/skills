// Screenshots of published live previews, for the agent to look at its own
// work without the user's browser: each preview's frozen bundle is opened in
// headless Chromium, under the same sandbox the page gets in the studio.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
// The studio's device frames; "fit" is shot at desktop width.
export const SIZES = { phone: [390, 844], tablet: [820, 1180], desktop: [1280, 800] };
export const THEMES = ["light", "dark"];
// Same policy the server sends with /previews/.
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src data: blob: https:";
const ORIGIN = "http://mockup.preview";

// Playwright's own Chromium, else an installed Chrome or Edge, else Playwright's
// Chromium downloaded once (it is shared by every project on this machine).
async function launch() {
  const { chromium } = await import("playwright");
  const missing = (err) => /Executable doesn't exist|install/i.test(err.message);
  try {
    return await chromium.launch();
  } catch (err) {
    if (!missing(err)) throw err;
  }
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // Not installed.
    }
  }
  console.error("mockup: downloading Chromium for screenshots (once)");
  const r = spawnSync(process.execPath, [join(APP, "node_modules", "playwright", "cli.js"), "install", "chromium"], { stdio: ["ignore", 2, 2] });
  if (r.status !== 0) throw new Error("could not install Chromium; run `npx playwright install chromium` in " + APP);
  return chromium.launch();
}

// Preview blocks of a round, or the one with id `item`.
export function previewsOf(round, item) {
  return (round.pages ?? []).flatMap((p) => p.blocks).filter((b) => b.type === "preview" && (!item || b.id === item));
}

// Shoots each preview at each device and theme into outDir as
// <item>.<device>.<theme>.png, the whole page top to bottom. Returns
// [{ item, path, errors }], errors being what the page threw or logged as
// errors while rendering.
export async function shoot(designDir, previews, { outDir, devices, themes = THEMES }) {
  mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const shots = [];
  try {
    for (const b of previews) {
      const html = readFileSync(join(designDir, "renders", "previews", `${b.bundle}.html`));
      for (const device of devices ?? [b.device === "fit" ? "desktop" : b.device]) {
        const [width, height] = SIZES[device];
        for (const theme of themes) {
          const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
          const errors = [];
          page.on("pageerror", (err) => errors.push(err.message));
          page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
          await page.route(`${ORIGIN}/**`, (route) =>
            route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "content-security-policy": CSP }, body: html }));
          await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
          await page.evaluate(async (t) => {
            document.documentElement.dataset.theme = t;
            document.documentElement.style.colorScheme = t;
            await document.fonts.ready;
            await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
          }, theme);
          const path = join(outDir, `${b.id}.${device}.${theme}.png`);
          await page.screenshot({ path, fullPage: true });
          await page.close();
          shots.push({ item: b.id, path, errors });
        }
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}
