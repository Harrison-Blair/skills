// HTTP server for one agent session. Loopback only and unauthenticated: every
// route belongs to a check group (see ROUTES) that decides, before any side
// effect, which callers may use it. Browsers cannot call agent routes, and
// sandboxed pages (cross-site, sometimes Origin: null) reach only /d/ and the
// page script.
import { createServer as createHttpServer } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { TYPES, pageHeaders, servePage, sessionFile } from "./pages.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 1024 * 1024;
const MAX_MESSAGE = 256 * 1024;
// No agent activity for this long while a message is delivered: the agent is
// probably stuck on something in its terminal (a permission prompt, a crash).
export const STALL_MS = 2 * 60 * 1000;
const DEVICES = ["fit", "phone", "tablet", "desktop"];
const KIT = ["core.js", "kit.js", "annotate.js"];
const SHELL_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// Exact routes and prefixes, with their check group.
const ROUTES = {
  "/": "browser",
  "/kit/page.js": "page",
  "/api/ping": "host",
  "/api/state": "browser",
  "/api/events": "browser",
  "/api/messages": "browser",
  "/api/agent/wait": "agent",
  "/api/agent/say": "agent",
  "/api/agent/show": "agent",
};
const PREFIXES = { "/shell/": "browser", "/d/": "page" };

export function createServer({ dir, session, stallMs = STALL_MS, deliver = null, shellDir = join(APP, "shell"), kitDir = join(APP, "kit") }) {
  const store = new Store(join(dir, "log.jsonl"));
  const sse = new Set();
  const waiters = new Set();
  let port = 0;
  let lastActivity = Date.now();
  let lastAgent = null;

  const origins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  // An error message when the request may not use its route's group.
  function refused(req, group) {
    const h = req.headers;
    if (!hosts().includes(h.host)) return [421, "bad host"];
    if (group === "browser") {
      if (h.origin !== undefined && !origins().includes(h.origin)) return [403, "bad origin"];
      if (h["sec-fetch-site"] === "cross-site") return [403, "cross-site"];
    }
    if (group === "agent" && (h.origin !== undefined || Object.keys(h).some((k) => k.startsWith("sec-fetch-")))) return [403, "agent routes are for the CLI only"];
    if (group === "page" && req.method !== "GET") return [405, "method not allowed"];
    return null;
  }

  // Headers every response on a path carries, refusals and errors included.
  function routeHeaders(pathname) {
    if (pathname.startsWith("/d/")) return pageHeaders(port);
    if (pathname === "/" || pathname.startsWith("/shell/")) return SHELL_HEADERS;
    return {};
  }

  function agentState() {
    const delivered = store.pending().filter((m) => m.status === "delivered");
    const stalled = delivered.length > 0 && Date.now() - lastActivity > stallMs;
    return { listening: waiters.size > 0, stalled };
  }

  function broadcast(type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(frame);
  }

  function publishAgent() {
    const state = agentState();
    const key = JSON.stringify(state);
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
    send(waiter.res, 200, { messages: out, harness: session.harness, dir });
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

  async function readJson(req, max = MAX_BODY) {
    const buf = await readBody(req, max);
    try {
      return buf.length ? JSON.parse(buf.toString("utf8")) : {};
    } catch {
      throw Object.assign(new Error("invalid JSON"), { status: 400 });
    }
  }

  // The shell's own files, confined to shellDir.
  function serveShell(res, rel) {
    let file;
    try {
      const root = realpathSync(shellDir);
      file = realpathSync(join(shellDir, rel));
      const inside = relative(root, file);
      if (!inside || inside.startsWith("..") || inside.startsWith(sep) || !statSync(file).isFile()) file = null;
    } catch {
      file = null;
    }
    if (!file) return send(res, 404, { error: "not found" }, SHELL_HEADERS);
    res.writeHead(200, { ...SHELL_HEADERS, "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  // One classic script, read on every request so kit edits show on reload.
  function servePageScript(res) {
    const parts = KIT.map((f) => join(kitDir, f)).filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8") + "\n");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(parts.join(""));
  }

  function draftsError(drafts) {
    if (!Array.isArray(drafts)) return "drafts must be a list";
    if (drafts.some((d) => typeof d?.id !== "string" || typeof d?.kind !== "string")) return "every draft needs a string id and kind";
    return null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const { pathname } = url;
    const prefix = Object.keys(PREFIXES).find((p) => pathname.startsWith(p));
    const group = ROUTES[pathname] ?? PREFIXES[prefix] ?? "host";
    const headers = routeHeaders(pathname);
    const refusal = refused(req, group);
    if (refusal) return send(res, refusal[0], { error: refusal[1] }, headers);

    if (prefix) {
      let rel;
      try {
        rel = decodeURIComponent(pathname.slice(prefix.length));
      } catch {
        return send(res, 404, { error: "not found" }, headers);
      }
      if (prefix === "/d/") return servePage(res, dir, rel, port);
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" }, headers);
      return serveShell(res, rel);
    }

    switch (`${req.method} ${pathname}`) {
      case "GET /":
        return serveShell(res, "index.html");

      case "GET /kit/page.js":
        return servePageScript(res);

      case "GET /api/ping":
        return send(res, 200, { id: session.id });

      case "GET /api/state":
        return send(res, 200, { session, showing: store.showing, messages: store.list(), agent: agentState() });

      case "GET /api/events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: agent\ndata: ${JSON.stringify(agentState())}\n\n`);
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return;
      }

      case "POST /api/messages": {
        const body = await readJson(req, MAX_MESSAGE);
        const drafts = body.drafts ?? [];
        const error = draftsError(drafts);
        if (error) return send(res, 400, { error });
        const kind = body.kind ?? (drafts.length ? "feedback" : "chat");
        if (!["chat", "feedback", "exit"].includes(kind)) return send(res, 400, { error: "unknown kind" });
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim() && !drafts.length && kind !== "exit") return send(res, 400, { error: "nothing to send" });
        const page = typeof body.page === "string" ? body.page : null;
        const message = store.add({ from: "user", kind, text, page, drafts });
        broadcast("message", message);
        send(res, 201, message);
        if (deliver) {
          // Push-style harnesses (Codex) get the message immediately.
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

      // What the shell shows. Phase 1 shows exactly one page.
      case "POST /api/agent/show": {
        const body = await readJson(req);
        const { pages, title = null, device = "fit" } = body;
        if (!Array.isArray(pages) || pages.length !== 1) return send(res, 400, { error: "pages must list exactly one page." });
        if (!sessionFile(dir, pages[0])) return send(res, 400, { error: `${pages[0]} is not a file under pages/, assets/ or approved/ in ${dir}.` });
        if (title !== null && typeof title !== "string") return send(res, 400, { error: "title must be text." });
        if (!DEVICES.includes(device)) return send(res, 400, { error: `device must be one of ${DEVICES.join(", ")}.` });
        const showing = store.show({ pages, title, device });
        broadcast("show", showing);
        touch();
        return send(res, 200, { ok: true });
      }

      default:
        return send(res, ROUTES[pathname] ? 405 : 404, { error: ROUTES[pathname] ? "method not allowed" : "not found" }, headers);
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message }, routeHeaders(req.url.split("?")[0]));
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
