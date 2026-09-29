// tokens.css read into W3C design tokens (lib/tokens.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokensJson } from "../lib/tokens.mjs";

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
