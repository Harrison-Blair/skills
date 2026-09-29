// Agent-written files under the session folder, served at /d/ to sandboxed
// frames. Only pages/, assets/, approved/ and tokens.css are reachable, and a
// path that resolves elsewhere (through .. or a symlink) is not found.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const DIRS = ["pages", "assets", "approved"];
const PAGE_SCRIPT = '<script src="/kit/page.js"></script>';

export const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const servable = (parts) =>
  !parts.some((p) => !p || p === "." || p === ".." || p.includes("\\")) &&
  ((DIRS.includes(parts[0]) && parts.length > 1) || (parts.length === 1 && parts[0] === "tokens.css"));

// The absolute path of a servable file, or null. rel is "/"-separated and
// already decoded. Checked before and after resolving symlinks.
export function sessionFile(dir, rel) {
  if (typeof rel !== "string" || !servable(rel.split("/"))) return null;
  try {
    const root = realpathSync(dir);
    const real = realpathSync(join(dir, ...rel.split("/")));
    if (!servable(relative(root, real).split(sep)) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

// Page scripts may come from this server only (inline or session files),
// never from the internet. Pages use 127.0.0.1, which localhost does not match.
export const pageCsp = (port) => `sandbox allow-scripts allow-forms; script-src http://127.0.0.1:${port} 'unsafe-inline'`;

// Every /d/ response carries these, refusals and errors included.
export const pageHeaders = (port) => ({ "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": pageCsp(port) });

// Exactly one page script, on its own line at the very end. Searching for
// </body> would find it in comments and script strings too; browsers run a
// script after </html> as part of the body anyway.
export const injectScript = (html) => `${html}\n${PAGE_SCRIPT}\n`;

export function servePage(res, dir, rel, port) {
  const file = sessionFile(dir, rel);
  const headers = pageHeaders(port);
  if (!file) {
    res.writeHead(404, { ...headers, "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }
  const ext = extname(file).toLowerCase();
  const bytes = readFileSync(file);
  res.writeHead(200, { ...headers, "content-type": TYPES[ext] ?? "application/octet-stream" });
  res.end(ext === ".html" || ext === ".htm" ? injectScript(bytes.toString("utf8")) : bytes);
}
