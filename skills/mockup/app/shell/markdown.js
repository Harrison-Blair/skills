// A small Markdown renderer for chat messages. Everything is built with
// createElement and text nodes, so message text can never become markup.

const SAFE_URL = /^(https?:|mailto:)/i;
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|(?<!\w)_([^_\s][^_]*?)_(?!\w)|\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/;

function el(tag, ...children) {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}

function inline(text) {
  const out = [];
  while (text) {
    const m = INLINE.exec(text);
    if (!m) { out.push(text); break; }
    if (m.index) out.push(text.slice(0, m.index));
    const [all, code, b1, b2, i1, i2, label, href] = m;
    if (code !== undefined) out.push(el("code", code));
    else if (b1 !== undefined || b2 !== undefined) out.push(el("strong", ...inline(b1 ?? b2)));
    else if (i1 !== undefined || i2 !== undefined) out.push(el("em", ...inline(i1 ?? i2)));
    else if (SAFE_URL.test(href)) {
      const a = el("a", ...inline(label));
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      out.push(a);
    } else out.push(all);
    text = text.slice(m.index + all.length);
  }
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
const ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

// Returns a DocumentFragment for the given Markdown text.
export function renderMarkdown(source) {
  const frag = document.createDocumentFragment();
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^\s*```/.test(line)) {
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      frag.append(el("pre", el("code", body.join("\n"))));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      frag.append(el(`h${heading[1].length}`, ...inline(heading[2])));
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = el("tr", ...cells(line).map((c) => el("th", ...inline(c))));
      const body = el("tbody");
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) {
        body.append(el("tr", ...cells(lines[i]).map((c) => el("td", ...inline(c)))));
      }
      frag.append(el("table", el("thead", head), body));
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const ordered = !item[1];
      const list = el(ordered ? "ol" : "ul");
      if (ordered && item[2] !== "1") list.start = Number(item[2]);
      for (let m; i < lines.length && (m = ITEM.exec(lines[i])) && !m[1] === ordered; i++) {
        list.append(el("li", ...inline(m[3])));
      }
      frag.append(list);
      continue;
    }

    const para = [];
    for (; i < lines.length && lines[i].trim() && !ITEM.exec(lines[i]) && !/^(#{1,6}\s|\s*```)/.test(lines[i]); i++) {
      para.push(lines[i].trim());
    }
    frag.append(el("p", ...inline(para.join(" "))));
  }
  return frag;
}
