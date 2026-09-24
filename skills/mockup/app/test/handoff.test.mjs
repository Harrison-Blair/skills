// Screenshots of live previews (`mockup shot`) and the handoff folder
// (`mockup handoff`), through the real CLI, server and headless Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { tokensJson } from "../lib/tokens.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mockup.mjs");

// Width and the top-left pixel of a PNG. Row 0's first pixel is stored as is
// under every PNG filter, so it needs no unfiltering.
function png(file) {
  const buf = readFileSync(file);
  const width = buf.readUInt32BE(16);
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, topLeft: [...raw.subarray(1, 4)] };
}

test("tokens.css becomes W3C design tokens: groups, types, aliases, dark values as modes", () => {
  const css = `/* tokens; not { a: rule } */
:root {
  --color-bg: #ffffff;
  --color-text: var(--color-ink);
  --space-2: 8px;
  --font-body: "Inter; UI", sans-serif;
  --font-weight-bold: 700;
  --motion-fast: 120ms;
  --radius: 6px;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.2);
}
[data-theme="dark"] { --color-bg: #101010; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { --color-text: #eeeeee; } }
.card { color: red; }`;
  assert.deepEqual(tokensJson(css), {
    color: {
      bg: { $value: "#ffffff", $type: "color", $extensions: { mockup: { modes: { dark: "#101010" } } } },
      text: { $value: "{color.ink}", $extensions: { mockup: { modes: { dark: "#eeeeee" } } } },
    },
    space: { 2: { $value: "8px", $type: "dimension" } },
    font: { body: { $value: '"Inter; UI", sans-serif', $type: "fontFamily" }, "weight-bold": { $value: "700", $type: "fontWeight" } },
    motion: { fast: { $value: "120ms", $type: "duration" } },
    radius: { $value: "6px", $type: "dimension" },
    shadow: { card: { $value: "0 1px 2px rgb(0 0 0 / 0.2)" } },
  });
});

test("`mockup shot` pictures previews in light and dark, and `mockup handoff` bundles the approved design", { timeout: 240_000 }, async () => {
  // Real path: the CLI prints paths from its working directory, which macOS
  // reports without the /var -> /private/var symlink.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mockup-handoff-")));
  const mockup = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", timeout: 120_000 });
  const started = mockup("start", "--design", "hand", "--no-open", "--harness", "claude");
  assert.equal(started.status, 0, started.stderr);
  const designDir = join(repo, ".design", "hand");
  const s = JSON.parse(readFileSync(join(designDir, ".runtime", "session.json"), "utf8"));
  const post = async (path, body) => {
    const res = await fetch(new URL(path, s.url), { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 201, await res.text());
  };
  const write = (rel, text) => {
    mkdirSync(dirname(join(designDir, rel)), { recursive: true });
    writeFileSync(join(designDir, rel), text);
  };
  try {
    write("ui/tokens.css", ':root { --color-bg: #ffffff; } [data-theme="dark"] { --color-bg: #101010; } body { background: var(--color-bg); margin: 0; }');
    write("assets/own/dot.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="4"/></svg>');
    write("assets/own/unused.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
    write("ui/components/Badge.jsx", 'import dot from "../../assets/own/dot.svg";\nexport default function Badge() { return <span><img src={dot} alt="" />Done</span>; }\n');
    write("ui/pages/Home.jsx", 'import "../tokens.css";\nimport Badge from "../components/Badge.jsx";\nexport default () => <main style={{ height: 1200 }}><Badge /></main>;\n');
    write("ui/pages/Broken.jsx", 'export default function Broken() { throw new Error("BROKEN-PAGE"); }\n');
    write("context.md", "# Brief\n\nA habit tracker.\n");
    try {
      symlinkSync(join(designDir, ".runtime", "session.json"), join(designDir, "ui", "secret.json"));
    } catch {
      // No symlinks here (Windows without the privilege); nothing to leak.
    }
    write("look.json", JSON.stringify({
      stage: "language", title: "Look", kind: "draft",
      pages: [{ title: "Look", blocks: [
        { type: "preview", id: "home", title: "Home", src: "ui/pages/Home.jsx", device: "phone" },
        { type: "preview", id: "broken", title: "Broken", src: "ui/pages/Broken.jsx" },
      ] }],
    }));
    assert.equal(mockup("round", "--file", join(designDir, "look.json")).status, 0);
    write("q.json", JSON.stringify({ stage: "context", title: "Platforms", pages: [{ title: "Q", blocks: [{ type: "question", id: "platform", text: "Which platforms?", choices: ["Web", "iOS"], multiple: true }] }] }));
    assert.equal(mockup("round", "--file", join(designDir, "q.json")).status, 0);

    // The latest round with previews is the default.
    const shot = mockup("shot");
    assert.equal(shot.status, 0, shot.stderr);
    const paths = shot.stdout.split("\n").filter((l) => l.endsWith(".png"));
    const dir = join(designDir, "renders", "shots", "language-1");
    assert.deepEqual(paths, ["home.phone.light", "home.phone.dark", "broken.desktop.light", "broken.desktop.dark"].map((n) => join(dir, `${n}.png`)));
    const light = png(paths[0]);
    const dark = png(paths[1]);
    assert.equal(light.width, 390, "the block's device");
    assert.deepEqual(light.topLeft, [255, 255, 255]);
    assert.deepEqual(dark.topLeft, [16, 16, 16], "dark shots use the dark tokens");
    assert.equal(png(paths[2]).width, 1280, "fit is shot at desktop width");
    assert.match(shot.stdout, /broken\.desktop\.light\.png\n {2}page error: .*BROKEN-PAGE/, "what the page threw is reported under its shot");
    assert.doesNotMatch(shot.stdout.split("broken.desktop")[0], /page error/, "a page that renders reports nothing");

    const one = mockup("shot", "--round", "language-1", "--item", "home", "--device", "tablet", "--theme", "dark");
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout.trim(), join(dir, "home.tablet.dark.png"));
    assert.equal(png(join(dir, "home.tablet.dark.png")).width, 820);
    assert.match(mockup("shot", "--round", "context-1").stderr, /context-1 has no live previews/);

    // Asking for changes is not approval, so nothing is pictured yet.
    await post("/api/decisions", { round: "language-1", item: "draft", value: "changes" });
    const before = mockup("handoff");
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /Now write .*GUIDE\.md/);
    const out = join(designDir, "handoff");
    assert.match(readFileSync(join(out, "decisions.md"), "utf8"), /\| language \| not approved \|/);
    assert.equal(existsSync(join(out, "shots")), false);

    await post("/api/decisions", { round: "language-1", item: "draft", value: "approve" });
    await post("/api/decisions", { round: "context-1", item: "platform", value: ["Web", "iOS"] });
    writeFileSync(join(out, "GUIDE.md"), "my guide\n");
    writeFileSync(join(out, "stale.txt"), "from an older handoff\n");

    const after = mockup("handoff");
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /GUIDE\.md is kept/);
    assert.equal(readFileSync(join(out, "GUIDE.md"), "utf8"), "my guide\n", "the agent's guide survives a rerun");
    assert.equal(existsSync(join(out, "stale.txt")), false, "everything else is regenerated");
    const decisions = readFileSync(join(out, "decisions.md"), "utf8");
    assert.match(decisions, /\| language \| language-1 "Look" \|/);
    assert.match(decisions, /\| mood \| not approved \|/);
    assert.match(decisions, /context-1\/platform "Which platforms\?": Web, iOS/);
    assert.equal(readFileSync(join(out, "brief.md"), "utf8"), "# Brief\n\nA habit tracker.\n");
    assert.equal(JSON.parse(readFileSync(join(out, "tokens.json"), "utf8")).color.bg.$extensions.mockup.modes.dark, "#101010");
    for (const f of ["ui/tokens.css", "ui/components/Badge.jsx", "ui/pages/Home.jsx", "assets/own/dot.svg", "shots/language-1/home.phone.light.png", "shots/language-1/broken.desktop.dark.png"]) {
      assert.ok(existsSync(join(out, f)), `${f} is handed off`);
    }
    assert.equal(existsSync(join(out, "assets", "own", "unused.svg")), false, "only imported assets are copied");
    assert.equal(existsSync(join(out, "ui", "secret.json")), false, "symlinks are not followed into the handoff");
    const readme = readFileSync(join(out, "README.md"), "utf8");
    for (const f of ["GUIDE.md", "brief.md", "decisions.md", "tokens.json", "ui/", "assets/", "shots/"]) assert.match(readme, new RegExp(`- ${f.replace(".", "\\.")}`));
  } finally {
    mockup("stop", "--dir", designDir);
  }
});
