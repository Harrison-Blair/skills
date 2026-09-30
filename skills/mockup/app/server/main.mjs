// Detached server process started by `mockup start`, configured by the
// environment (MOCKUP_DIR, MOCKUP_KIND, MOCKUP_NAME, MOCKUP_HARNESS,
// MOCKUP_THREAD). The CLI sends its output to .runtime/server.log.
import { randomUUID } from "node:crypto";
import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createServer } from "./server.mjs";
import { codexDeliver } from "./deliver.mjs";

const env = process.env;
const dir = env.MOCKUP_DIR;
const kind = env.MOCKUP_KIND;
if (!dir || !["design", "once"].includes(kind)) {
  console.error("usage: MOCKUP_DIR=/abs/dir MOCKUP_KIND=design|once [MOCKUP_NAME=...] [MOCKUP_HARNESS=...] [MOCKUP_THREAD=...] node main.mjs");
  process.exit(2);
}
const harness = env.MOCKUP_HARNESS || "claude";
const thread = env.MOCKUP_THREAD || null;
const runtime = join(dir, ".runtime");
mkdirSync(runtime, { recursive: true });
const file = join(runtime, "session.json");

// Codex is woken by the server; Claude and Pi listen with `mockup wait`.
const deliver = harness === "codex" && thread ? codexDeliver({ thread }) : null;
const id = randomUUID();
const app = createServer({ dir, session: { id, kind, name: env.MOCKUP_NAME || null, harness }, deliver, stop: () => {
  console.log("stop requested");
  shutdown();
} });
const port = await app.listen(0);

const session = {
  id,
  pid: process.pid,
  port,
  url: `http://127.0.0.1:${port}/`,
  kind,
  name: env.MOCKUP_NAME || null,
  dir,
  harness,
  thread,
  startedAt: new Date().toISOString(),
};

// The only reader of session.json here, with the CLI's rules: anything but a
// regular file of at most 64 KB, or a file that is not JSON or not a usable
// record, reads as none (stale), and is never waited on.
const LIMIT = 65536;
const read = () => {
  let s;
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.size > LIMIT) return null;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const bytes = Buffer.alloc(LIMIT + 1);
      const n = readSync(fd, bytes, 0, bytes.length, 0);
      if (n > LIMIT) return null;
      s = JSON.parse(bytes.toString("utf8", 0, n));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const usable = s !== null && typeof s === "object" && !Array.isArray(s) && typeof s.id === "string" && s.id !== "" &&
    Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535;
  return usable ? s : null;
};

// True when the server a session.json names answers with its id.
function answers(s) {
  return new Promise((ok) => {
    if (!s) return ok(false);
    const req = request({ host: "127.0.0.1", port: s.port, path: "/api/ping", headers: { host: `127.0.0.1:${s.port}` }, timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          ok(JSON.parse(body).id === s.id);
        } catch {
          ok(false);
        }
      });
      // A reply cut off before its end is no answer.
      for (const cut of ["aborted", "error", "close"]) res.on(cut, () => ok(false));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => ok(false));
    req.end();
  });
}

// One server per folder: session.json is created exclusively, complete (a
// hard link of a finished file), so the log has a single writer. A file whose
// server does not answer is stale: remove it and try once more.
const tmp = `${file}.${process.pid}`;
writeFileSync(tmp, JSON.stringify(session, null, 2));
for (let attempt = 0; ; attempt++) {
  try {
    linkSync(tmp, file);
    break;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const existing = read();
  if (existing && (await answers(existing))) {
    rmSync(tmp, { force: true });
    console.log(`already running: ${existing.url}`);
    await app.close();
    process.exit(0);
  }
  if (attempt === 1) {
    rmSync(tmp, { force: true });
    console.error(`${file} exists and its server does not answer`);
    process.exit(1);
  }
  // Whatever is there, a folder included.
  rmSync(file, { recursive: true, force: true });
}
rmSync(tmp, { force: true });
console.log(`listening on ${session.url}`);

async function shutdown() {
  if (read()?.id === id) rmSync(file, { force: true });
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
