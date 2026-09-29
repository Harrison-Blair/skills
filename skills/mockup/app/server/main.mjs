// Detached server process started by `mockup start`, configured by the
// environment (MOCKUP_DIR, MOCKUP_KIND, MOCKUP_NAME, MOCKUP_HARNESS,
// MOCKUP_THREAD). The CLI sends its output to .runtime/server.log.
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const app = createServer({ dir, session: { id, kind, name: env.MOCKUP_NAME || null, harness }, deliver });
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

const read = () => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// True when the server a session.json names answers with its id.
function answers(s) {
  return new Promise((ok) => {
    if (!s?.port) return ok(false);
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
  rmSync(file, { force: true });
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
