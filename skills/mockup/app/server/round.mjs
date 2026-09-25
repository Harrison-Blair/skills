// Validates what the agent publishes as a round and what the browser sends
// back about it. Errors name the exact field so the agent can fix its JSON.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { normalizeUri } from "micromark-util-sanitize-uri";

export const STAGES = ["context", "mood", "language", "components", "states", "prototype", "handoff"];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Browsers render these in <img> without running scripts; SVG is allowed only
// in agent-made assets, and files are served with a sandboxing CSP regardless.
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
export const FILE_DIRS = ["assets", "renders"];
// Live previews: a page under ui/ that the server bundles with the component
// files it imports.
const PAGE = { dirs: ["ui"], exts: [".jsx", ".tsx", ".js", ".ts"], example: "ui/pages/Today.jsx" };
export const DEVICES = ["fit", "phone", "tablet", "desktop"];

class RoundError extends Error {}
const bad = (where, why) => {
  throw new RoundError(`${where}: ${why}`);
};

// A path relative to the design directory, inside assets/ or renders/ (or
// the given dirs), that exists and does not escape through a symlink.
export function designFile(designDir, rel, where, { dirs = FILE_DIRS, exts = IMAGE_EXTS, example = "assets/web/photo.jpg" } = {}) {
  if (typeof rel !== "string" || !rel) bad(where, `must be a path such as ${example}`);
  const parts = rel.split("/");
  if (!dirs.includes(parts[0]) || parts.some((p) => !p || p === "." || p === "..")) {
    bad(where, `"${rel}" must be a relative path under ${dirs.map((d) => `${d}/`).join(" or ")}`);
  }
  if (!exts.includes(extname(rel).toLowerCase())) bad(where, `"${rel}" must be one of ${exts.join(" ")}`);
  const full = join(designDir, ...parts);
  if (!existsSync(full)) bad(where, `"${rel}" does not exist in ${designDir}`);
  const root = realpathSync(designDir);
  if (!realpathSync(full).startsWith(root + sep)) bad(where, `"${rel}" resolves outside the design directory`);
  return rel;
}

// Rounds are immutable, so each image a round shows is copied to a file
// named by its content. Editing assets/ later changes new rounds, not old
// ones. Copies of Git-ignored images (from the web, or renders) stay ignored;
// copies of your own and uploaded images are tracked like their originals.
const IGNORED_SOURCES = ["assets/web/", "renders/"];
function publish(designDir, rel) {
  const dir = IGNORED_SOURCES.some((p) => rel.startsWith(p)) ? "renders/published" : "assets/published";
  if (rel.startsWith(`${dir}/`)) return rel;
  const hash = createHash("sha256").update(readFileSync(join(designDir, ...rel.split("/")))).digest("hex");
  const out = `${dir}/${hash}${extname(rel).toLowerCase()}`;
  const full = join(designDir, ...out.split("/"));
  if (!existsSync(full)) {
    mkdirSync(join(designDir, ...dir.split("/")), { recursive: true });
    copyFileSync(join(designDir, ...rel.split("/")), full);
  }
  return out;
}

// Local images in Markdown are published the same way. The text is parsed
// like the page renders it (GFM), so every image form counts (inline, <...>,
// reference) and code spans or links do not. The text stays as written; the
// returned map sends each local image to its published copy.
function mediaOf(designDir, md, where) {
  if (md === undefined) return undefined;
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map();
  const images = [];
  (function walk(node) {
    // First definition wins, as CommonMark (and the page) renders it.
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if (node.type === "image") images.push(node.url);
    if (node.type === "imageReference") images.push({ ref: node.identifier });
    for (const child of node.children ?? []) walk(child);
  })(tree);
  // Keyed by the path exactly as the page's renderer writes it (normalizeUri),
  // so the page finds the copy without decoding anything.
  const media = {};
  const rawOf = {};
  for (const img of images) {
    const url = typeof img === "string" ? img : definitions.get(img.ref);
    if (!url || !FILE_DIRS.some((d) => url.startsWith(`${d}/`))) continue;
    const key = normalizeUri(url);
    if (rawOf[key] !== undefined && rawOf[key] !== url) bad(where, `"${rawOf[key]}" and "${url}" are the same image path to the page; rename one`);
    rawOf[key] = url;
    media[key] = publish(designDir, designFile(designDir, url, where));
  }
  return Object.keys(media).length ? media : undefined;
}

// A Markdown field and, when it shows local images, their published copies.
const markdown = (designDir, value, where) => {
  const media = mediaOf(designDir, value, where);
  return media ? { media } : {};
};

const text = (v, where, required = true) => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || (required && !v.trim())) bad(where, "must be a non-empty string");
  return v;
};

function block(b, where, designDir, ids) {
  if (!b || typeof b !== "object") bad(where, "must be an object");
  const id = () => {
    if (!ID.test(b.id ?? "")) bad(`${where}.id`, "must be lowercase letters, digits and hyphens");
    if (ids.has(b.id)) bad(`${where}.id`, `"${b.id}" is used twice in this round`);
    ids.add(b.id);
    return b.id;
  };
  const images = (list, at) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) bad(at, "must be a list of paths");
    return list.map((p, i) => publish(designDir, designFile(designDir, p, `${at}[${i}]`)));
  };
  switch (b.type) {
    case "markdown":
      return { type: "markdown", text: text(b.text, `${where}.text`), ...markdown(designDir, b.text, `${where}.text`) };
    case "image":
      // An id makes the image something the user can like or dislike on its own.
      return {
        type: "image",
        ...(b.id !== undefined ? { id: id() } : {}),
        src: publish(designDir, designFile(designDir, b.src, `${where}.src`)),
        from: b.src,
        caption: text(b.caption, `${where}.caption`, false),
      };
    case "option":
      return {
        type: "option",
        id: id(),
        title: text(b.title, `${where}.title`),
        text: text(b.text, `${where}.text`, false),
        ...markdown(designDir, b.text, `${where}.text`),
        images: images(b.images, `${where}.images`),
        ...(b.images?.length ? { imagesFrom: b.images } : {}),
      };
    case "question": {
      let choices;
      if (b.choices !== undefined) {
        if (!Array.isArray(b.choices) || b.choices.length < 2) bad(`${where}.choices`, "must list at least two choices");
        // A choice is its label, or { label, text, images } to compare side by side.
        choices = b.choices.map((c, i) => {
          const at = `${where}.choices[${i}]`;
          if (typeof c === "string") return text(c, at);
          if (!c || typeof c !== "object") bad(at, "must be a string or { label, text, images }");
          return {
            label: text(c.label, `${at}.label`),
            text: text(c.text, `${at}.text`, false),
            ...markdown(designDir, c.text, `${at}.text`),
            images: images(c.images, `${at}.images`),
          };
        });
        if (new Set(choices.map(choiceLabel)).size !== choices.length) bad(`${where}.choices`, "labels must be unique");
      }
      const needsChoices = (field, ok) => {
        if (b[field] !== undefined && (!ok(b[field]) || !choices)) bad(`${where}.${field}`, `must be ${field === "columns" ? "1, 2 or 3" : "true or false"}, and needs choices`);
      };
      needsChoices("multiple", (v) => typeof v === "boolean");
      needsChoices("other", (v) => typeof v === "boolean");
      needsChoices("columns", (v) => [1, 2, 3].includes(v));
      return {
        type: "question",
        id: id(),
        text: text(b.text, `${where}.text`),
        ...markdown(designDir, b.text, `${where}.text`),
        choices,
        ...(b.multiple ? { multiple: true } : {}),
        ...(b.other ? { other: true } : {}),
        ...(b.columns > 1 ? { columns: b.columns } : {}),
      };
    }
    case "preview":
      if (b.device !== undefined && !DEVICES.includes(b.device)) bad(`${where}.device`, `must be one of ${DEVICES.join(", ")}`);
      return {
        type: "preview",
        id: id(),
        title: text(b.title, `${where}.title`),
        text: text(b.text, `${where}.text`, false),
        ...markdown(designDir, b.text, `${where}.text`),
        src: designFile(designDir, b.src, `${where}.src`, PAGE),
        device: b.device ?? "fit",
      };
    default:
      return bad(`${where}.type`, 'must be "markdown", "image", "option", "question" or "preview"');
  }
}

// "explore" rounds are quick taste checks: the user likes or dislikes each
// option. A "draft" pulls the liked parts together into the stage's proposal,
// which the user approves as a whole.
export const KINDS = ["explore", "draft"];
export const DRAFT_ITEM = "draft";

// { stage, title, kind, pages: [{ title, blocks: [...] }] } or the plain-Markdown
// shorthand { stage, title, kind, body }.
export function normalizeRound(input, designDir) {
  if (!STAGES.includes(input.stage)) bad("stage", `must be one of ${STAGES.join(", ")}`);
  const title = text(input.title, "title");
  const kind = input.kind ?? "explore";
  if (!KINDS.includes(kind)) bad("kind", 'must be "explore" or "draft"');
  let pages = input.pages;
  if (pages === undefined) {
    pages = [{ title, blocks: input.body?.trim() ? [{ type: "markdown", text: input.body }] : [] }];
  }
  if (!Array.isArray(pages) || !pages.length) bad("pages", "must be a non-empty list");
  const ids = new Set([DRAFT_ITEM]);
  return {
    stage: input.stage,
    title,
    kind,
    pages: pages.map((p, i) => {
      const where = `pages[${i}]`;
      if (!p || typeof p !== "object") bad(where, "must be an object");
      if (!Array.isArray(p.blocks)) bad(`${where}.blocks`, "must be a list");
      // How the page's questions first show; the user can switch.
      if (p.questions !== undefined && !["all", "one"].includes(p.questions)) bad(`${where}.questions`, 'must be "all" or "one"');
      return {
        title: text(p.title, `${where}.title`),
        ...(p.questions === "one" ? { questions: "one" } : {}),
        blocks: p.blocks.map((b, j) => block(b, `${where}.blocks[${j}]`, designDir, ids)),
      };
    }),
  };
}

// Rounds published before pages existed carry a Markdown body instead.
export function pagesOf(round) {
  return round.pages ?? [{ title: round.title, blocks: round.body ? [{ type: "markdown", text: round.body }] : [] }];
}

export const choiceLabel = (c) => (typeof c === "string" ? c : c.label);

// A write-in answer: any text that is not one of the choices.
const writeIn = (v) => typeof v === "string" && v.trim() !== "" && v.length <= 500;

// Why a decision value is not allowed for this item, or null when it is. A
// multiple-choice question takes a list of its choices (empty clears it).
// With `other`, one answer may be the user's own text instead.
export function decisionError(round, itemId, value) {
  let allowed;
  if (itemId === DRAFT_ITEM) allowed = round.kind === "draft" ? ["approve", "changes"] : null;
  else {
    const item = findItem(round, itemId);
    allowed = item ? item.choices?.map(choiceLabel) ?? ["like", "dislike"] : null;
    const extra = (list) => list.filter((v) => !allowed.includes(v));
    if (item?.multiple) {
      const others = Array.isArray(value) ? extra(value) : null;
      const ok = others && new Set(value).size === value.length && (others.length === 0 || (item.other && others.length === 1 && writeIn(others[0])));
      return ok ? null : `value must be a list drawn from: ${allowed.join(", ")}${item.other ? ", plus one write-in" : ""}`;
    }
    if (item?.other && writeIn(value)) return null;
  }
  if (!allowed) return "unknown round or item";
  return allowed.includes(value) ? null : `value must be one of ${allowed.join(", ")}`;
}

// Anything with an id can take a comment, and so can a draft as a whole.
export function commentable(round, itemId) {
  return itemId === DRAFT_ITEM ? round.kind === "draft" : Boolean(findItem(round, itemId));
}

export function findItem(round, itemId) {
  for (const page of pagesOf(round)) {
    for (const b of page.blocks) if (b.id === itemId) return b;
  }
  return null;
}

export { RoundError };
