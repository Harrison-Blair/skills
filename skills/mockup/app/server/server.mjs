// HTTP server for one agent session. Loopback only; every API call needs the
// session token (cookie for the browser, bearer header for the CLI); Host and
// Origin are checked so other web pages cannot drive the agent.
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Store } from "./store.mjs";
import { RoundError, commentable, decisionError, designFile, findItem, normalizeRound } from "./round.mjs";
import { BUNDLE, PREVIEW_DIR, bundlePreview } from "./preview.mjs";

const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD = 10 * 1024 * 1024;
// Uploads are identified by their bytes, never by the name or type claimed.
const MAGIC = [
  [".png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  [".jpg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [".gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  [".webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
// No agent activity for this long while a message is delivered: the agent is
// probably stuck on something in its terminal (a permission prompt, a crash).
export const STALL_MS = 2 * 60 * 1000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// Previews run agent-written code: an opaque origin (no allow-same-origin)
// keeps it away from the session cookie and the API.
const PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "connect-src data: blob: https:",
  "frame-ancestors 'self'",
].join("; ");

// Builds every preview block, recording the bundle it shows. A build error
// names the block, like any other bad field.
async function bundlePreviews(round, designDir) {
  for (const [i, page] of round.pages.entries()) {
    for (const [j, b] of page.blocks.entries()) {
      if (b.type !== "preview") continue;
      try {
        b.bundle = await bundlePreview(designDir, b.src);
      } catch (err) {
        throw new RoundError(`pages[${i}].blocks[${j}].src: "${b.src}" failed to build:\n${err.message}`);
      }
    }
  }
  return round;
}

export function createServer({ designDir, token, staticDir, stallMs = STALL_MS, deliver = null }) {
  const store = new Store(join(designDir, "log.jsonl"));
  const sse = new Set();
  const waiters = new Set();
  let port = 0;
  let lastActivity = Date.now();
  let lastAgent = null;
  // Set when the user presses "End session"; the agent then runs `mockup stop`.
  let ended = false;

  const cookieName = () => `mockup_${port}`;
  const origins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  function tokenOk(candidate) {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function authed(req) {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && tokenOk(auth.slice(7))) return true;
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2),
    );
    return tokenOk(cookies[cookieName()]);
  }

  function agentState() {
    const delivered = store.pending().filter((m) => m.status === "delivered");
    const stalled = delivered.length > 0 && Date.now() - lastActivity > stallMs;
    return { listening: waiters.size > 0, stalled, lastActivity: new Date(lastActivity).toISOString() };
  }

  function broadcast(type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(frame);
  }

  function publishAgent() {
    const state = agentState();
    const key = JSON.stringify([state.listening, state.stalled]);
    if (key !== lastAgent) {
      lastAgent = key;
      broadcast("agent", state);
    }
  }

  function touch() {
    lastActivity = Date.now();
    publishAgent();
  }

  // Hand every pending message to one waiting `mockup wait`. A waiter that
  // asked for new messages only (the Pi extension, which has already handed
  // the delivered ones to the agent) is not given those again.
  function flush() {
    const pending = store.pending();
    if (!pending.length) return;
    const waiter = [...waiters].find((w) => !w.onlyNew || pending.some((m) => m.status === "queued"));
    if (!waiter) return;
    waiters.delete(waiter);
    const give = waiter.onlyNew ? pending.filter((m) => m.status === "queued") : pending;
    const out = give.map((m) => (m.status === "queued" ? store.setStatus(m.id, "delivered") : { ...m, redelivered: true }));
    for (const m of out) broadcast("message", m);
    touch();
    send(waiter.res, 200, { messages: out });
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  function readBody(req, max) {
    return new Promise((ok, fail) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > max) {
          fail(Object.assign(new Error("body too large"), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks)));
      req.on("error", fail);
    });
  }

  async function readJson(req) {
    const buf = await readBody(req, MAX_BODY);
    try {
      return buf.length ? JSON.parse(buf.toString("utf8")) : {};
    } catch {
      throw Object.assign(new Error("invalid JSON"), { status: 400 });
    }
  }

  function checkMarks(list, where) {
    if (!Array.isArray(list)) throw new RoundError(`${where}: must be a list`);
    if (list.length > 50) throw new RoundError(`${where}: at most 50 marks`);
    return list.map((m, j) => {
      const ok = m && ["pin", "circle"].includes(m.shape) && [m.x, m.y].every((v) => typeof v === "number" && v >= 0 && v <= 1) && (m.shape === "pin" || (typeof m.r === "number" && m.r > 0 && m.r <= 1));
      if (!ok) throw new RoundError(`${where}[${j}]: needs shape pin|circle, x and y from 0 to 1, and r for circles`);
      if (m.note !== undefined && (typeof m.note !== "string" || m.note.length > 2000)) throw new RoundError(`${where}[${j}].note: must be text up to 2000 characters`);
      return { shape: m.shape, x: m.x, y: m.y, ...(m.shape === "circle" ? { r: m.r } : {}), ...(m.note?.trim() ? { note: m.note } : {}) };
    });
  }

  // Pins and circles on a round image, or on a snapshot of one of its previews.
  function checkAnnotation(an, where) {
    const round = store.rounds.get(an?.round);
    if (!round) throw new RoundError(`${where}: unknown round ${an?.round}`);
    if (an.item !== undefined && findItem(round, an.item)?.type !== "preview") throw new RoundError(`${where}.item: not a preview in ${an.round}`);
    return {
      round: an.round,
      ...(an.item !== undefined ? { item: an.item } : {}),
      image: designFile(designDir, an.image, `${where}.image`),
      marks: checkMarks(an.marks, `${where}.marks`),
    };
  }

  // What the browser attaches to a message: selected items, uploaded images,
  // and pins or circles drawn on round images (with a rendered copy).
  function checkAttachments(a) {
    if (a == null) return null;
    const list = (v, where) => {
      if (v === undefined) return [];
      if (!Array.isArray(v)) throw new RoundError(`${where}: must be a list`);
      return v;
    };
    const roundOf = (id, where) => {
      const r = store.rounds.get(id);
      if (!r) throw new RoundError(`${where}: unknown round ${id}`);
      return r;
    };
    const selections = list(a.selections, "selections").map((sel, i) => {
      const item = findItem(roundOf(sel.round, `selections[${i}]`), sel.item);
      if (!item) throw new RoundError(`selections[${i}]: unknown item ${sel.item}`);
      return { round: sel.round, item: sel.item, label: item.title ?? item.text ?? item.caption ?? sel.item };
    });
    const uploads = list(a.uploads, "uploads").map((p, i) => designFile(designDir, p, `uploads[${i}]`));
    const annotations = list(a.annotations, "annotations").map((an, i) => ({
      ...checkAnnotation(an, `annotations[${i}]`),
      ...(an.render ? { render: designFile(designDir, an.render, `annotations[${i}].render`) } : {}),
    }));
    if (!selections.length && !uploads.length && !annotations.length) return null;
    return { selections, uploads, annotations };
  }

  function serveFile(res, pathname) {
    let rel;
    try {
      rel = designFile(designDir, decodeURIComponent(pathname.slice("/files/".length)), "file");
    } catch {
      return send(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      "content-type": IMAGE_TYPES[extname(rel).toLowerCase()],
      // Even an SVG opened directly cannot run script in this origin.
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    });
    res.end(readFileSync(join(designDir, ...rel.split("/"))));
  }

  function serveStatic(req, res, pathname) {
    if (!staticDir) return send(res, 404, { error: "no client build" });
    const root = resolve(staticDir);
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const file = resolve(root, normalize(rel));
    if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: "forbidden" });
    const target = existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");
    if (!existsSync(target)) return send(res, 404, { error: "not found" });
    res.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(readFileSync(target));
  }

  async function handle(req, res) {
    if (!hosts().includes(req.headers.host)) return send(res, 421, { error: "bad host" });
    const origin = req.headers.origin;
    if (origin && !origins().includes(origin)) return send(res, 403, { error: "bad origin" });
    if (req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "cross-site" });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    // Opening the printed link trades the token for a cookie, then drops it from the URL.
    if (req.method === "GET" && pathname === "/" && url.searchParams.has("token")) {
      if (!tokenOk(url.searchParams.get("token"))) return send(res, 403, { error: "bad token" });
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "referrer-policy": "no-referrer",
      });
      return res.end();
    }

    if (pathname.startsWith("/files/")) {
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });
      return serveFile(res, pathname);
    }
    if (pathname.startsWith("/previews/")) {
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });
      const hash = pathname.slice("/previews/".length);
      const file = join(designDir, ...PREVIEW_DIR.split("/"), `${hash}.html`);
      if (!BUNDLE.test(hash) || !existsSync(file)) return send(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PREVIEW_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "private, max-age=31536000, immutable",
      });
      return res.end(readFileSync(file));
    }
    if (!pathname.startsWith("/api/")) {
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      return serveStatic(req, res, pathname);
    }
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    const route = `${req.method} ${pathname}`;
    switch (route) {
      case "GET /api/state":
        return send(res, 200, {
          design: basename(designDir),
          messages: store.list(),
          rounds: store.roundList(),
          decisions: store.decisions,
          annotations: store.annotations,
          agent: agentState(),
          ended,
        });

      case "GET /api/events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: agent\ndata: ${JSON.stringify(agentState())}\n\n`);
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return;
      }

      case "POST /api/messages": {
        const body = await readJson(req);
        if (ended) return send(res, 409, { error: "session ended" });
        const kind = body.kind ?? "chat";
        if (!["chat", "feedback", "exit"].includes(kind)) return send(res, 400, { error: "unknown kind" });
        const round = body.round ?? null;
        if (round !== null && !store.rounds.has(round)) return send(res, 400, { error: "unknown round" });
        let attachments;
        const renders = {};
        try {
          attachments = checkAttachments(body.attachments);
          // Copies of marked images with the marks drawn on, for the agent.
          for (const [key, r] of Object.entries(body.renders ?? {})) {
            if (typeof r?.id !== "string") throw new RoundError(`renders.${key}.id: must name the marks revision drawn`);
            renders[key] = { id: r.id, path: r.path == null ? null : designFile(designDir, r.path, `renders.${key}.path`) };
          }
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        const text = typeof body.text === "string" ? body.text : "";
        // Feedback may be decisions and attachments alone; anything else needs words.
        // Ending must not strand marks the page did not draw (edited while sending).
        const drawn = new Set(store.drawn(renders).map((d) => d.annotation.id));
        if (kind === "exit" && store.unsentAnnotations().some((a) => !drawn.has(a.id))) {
          return send(res, 409, { error: "Some marks changed while sending; end the session again to include them." });
        }
        const hasContent = text.trim() || attachments || (kind === "feedback" && (store.unsentDecisions().length || drawn.size));
        if (!hasContent && kind !== "exit") return send(res, 400, { error: "nothing to send" });
        const message = store.add({ from: "user", kind, text, attachments, round, renders });
        broadcast("message", message);
        for (const d of message.decisions ?? []) broadcast("decision", { ...d, sent: message.id });
        for (const an of message.annotations ?? []) broadcast("annotation", { ...an, sent: message.id });
        if (kind === "exit") {
          ended = true;
          broadcast("session", { ended });
        }
        send(res, 201, message);
        if (deliver) {
          // Push-style harnesses (Codex, Pi) get the message immediately.
          Promise.resolve(deliver(message)).then(
            () => { broadcast("message", store.setStatus(message.id, "delivered")); touch(); },
            (err) => broadcast("message", store.setStatus(message.id, "failed", String(err?.message ?? err))),
          );
        } else flush();
        return;
      }

      // Agent side: block until user messages are pending, then return them all.
      // There is deliberately no timeout: an idle wait costs the agent nothing.
      case "GET /api/agent/wait": {
        const waiter = { res, onlyNew: url.searchParams.get("new") === "1" };
        waiters.add(waiter);
        res.on("close", () => {
          if (waiters.delete(waiter)) publishAgent();
        });
        touch();
        return flush();
      }

      // Agent reply. A final reply closes every delivered message; progress does not.
      case "POST /api/agent/say": {
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim()) return send(res, 400, { error: "text required" });
        const message = store.add({ from: "agent", kind: body.progress ? "progress" : "chat", text: body.text });
        broadcast("message", message);
        if (!body.progress) {
          for (const m of store.pending().filter((p) => p.status === "delivered")) {
            broadcast("message", store.setStatus(m.id, "done"));
          }
        }
        touch();
        return send(res, 201, message);
      }

      // A like, dislike, choice or draft approval. Saved now, sent with the next message.
      case "POST /api/decisions": {
        const body = await readJson(req);
        if (ended) return send(res, 409, { error: "session ended" });
        const round = store.rounds.get(body.round);
        let decision;
        if (body.comment !== undefined) {
          // A comment on one item; an empty one clears it.
          if (!round || !commentable(round, body.item)) return send(res, 400, { error: "unknown round or item" });
          if (typeof body.comment !== "string" || body.comment.length > 4000) return send(res, 400, { error: "comment must be text up to 4000 characters" });
          decision = store.decide({ round: body.round, item: body.item, comment: body.comment });
        } else {
          const error = round ? decisionError(round, body.item, body.value) : "unknown round or item";
          if (error) return send(res, 400, { error });
          decision = store.decide({ round: body.round, item: body.item, value: body.value });
        }
        broadcast("decision", decision);
        return send(res, 201, decision);
      }

      // The user's pins and circles on one image, replacing any earlier set.
      // Saved now, sent with the next message.
      case "POST /api/annotations": {
        const body = await readJson(req);
        if (ended) return send(res, 409, { error: "session ended" });
        let annotation;
        try {
          annotation = store.annotate(checkAnnotation(body, "annotation"));
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        broadcast("annotation", annotation);
        return send(res, 201, annotation);
      }

      // Raw image bytes. kind=render is a copy of a round image with the user's
      // marks drawn on; it may contain web images, so it goes to ignored renders/.
      case "POST /api/uploads": {
        const buf = await readBody(req, MAX_UPLOAD);
        const ext = MAGIC.find(([, test]) => buf.length > 12 && test(buf))?.[0];
        if (!ext) return send(res, 415, { error: "only PNG, JPEG, WebP and GIF images are accepted" });
        const dir = url.searchParams.get("kind") === "render" ? "renders" : "assets/uploads";
        mkdirSync(join(designDir, ...dir.split("/")), { recursive: true });
        const rel = `${dir}/${randomUUID()}${ext}`;
        writeFileSync(join(designDir, ...rel.split("/")), buf);
        return send(res, 201, { path: rel });
      }

      case "POST /api/agent/round": {
        const body = await readJson(req);
        let round;
        try {
          round = store.addRound(await bundlePreviews(normalizeRound(body, designDir), designDir));
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        broadcast("round", round);
        touch();
        return send(res, 201, round);
      }

      default:
        return send(res, 404, { error: "not found" });
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
      else res.end();
    });
  });
  const ticker = setInterval(publishAgent, Math.min(5000, stallMs));
  ticker.unref();

  return {
    store,
    listen(requestedPort = 0) {
      return new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(requestedPort, "127.0.0.1", () => {
          port = server.address().port;
          ok(port);
        });
      });
    },
    close() {
      clearInterval(ticker);
      for (const res of sse) res.end();
      for (const w of waiters) send(w.res, 503, { error: "server stopping" });
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}
