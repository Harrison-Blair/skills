// Reads the design tokens out of ui/tokens.css (CSS custom properties) into
// the W3C Design Tokens format. `--color-bg` becomes color.bg; values that are
// just var(--x) become aliases; dark values (under [data-theme="dark"] or a
// prefers-color-scheme: dark query) go in $extensions.mockup.modes.

// [{ name, value, mode }] for each custom property, in source order.
export function customProperties(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const stack = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  const declaration = (text) => {
    const m = /^\s*--([\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(text);
    if (!m || !stack.length) return;
    const context = stack.join(" ");
    const mode = /data-theme\s*=\s*["']?(\w+)/.exec(context)?.[1] ?? /prefers-color-scheme\s*:\s*(\w+)/.exec(context)?.[1] ?? "light";
    out.push({ name: m[1], value: m[2].replace(/\s*!important$/, ""), mode });
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "{") {
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (depth === 0 && (c === ";" || c === "}")) {
      declaration(css.slice(start, i));
      if (c === "}") stack.pop();
      start = i + 1;
    }
  }
  return out;
}

function typeOf(name, value) {
  if (/^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\(.*\)|transparent)$/i.test(value)) return "color";
  if (/^-?[\d.]+(px|rem|em)$/.test(value) || value === "0") return "dimension";
  if (/^[\d.]+m?s$/.test(value)) return "duration";
  if (/^cubic-bezier\(/.test(value)) return "cubicBezier";
  if (/weight/.test(name) && /^\d{3}$/.test(value)) return "fontWeight";
  if (/font|family/.test(name)) return "fontFamily";
  if (/^-?[\d.]+$/.test(value)) return "number";
  return undefined;
}

export function tokensJson(css) {
  const props = customProperties(css);
  const path = (name) => {
    const cut = name.indexOf("-");
    return cut > 0 ? [name.slice(0, cut), name.slice(cut + 1)] : [name];
  };
  const alias = (value) => {
    const m = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
    return m ? `{${path(m[1]).join(".")}}` : value;
  };
  const tokens = {};
  const at = (name) => {
    const [group, rest] = path(name);
    if (rest === undefined) return (tokens[group] ??= {});
    tokens[group] ??= {};
    return (tokens[group][rest] ??= {});
  };
  for (const { name, value, mode } of props) {
    const token = at(name);
    if (mode === "light" && token.$value === undefined) {
      token.$value = alias(value);
      const type = typeOf(name, value);
      if (type) token.$type = type;
    } else if (mode !== "light") {
      ((token.$extensions ??= { mockup: { modes: {} } }).mockup.modes[mode] = alias(value));
    }
  }
  return tokens;
}
