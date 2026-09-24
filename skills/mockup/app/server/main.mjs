// Detached server process started by `mockup start`. The token arrives in the
// environment (never argv, which other users can list) and is written only to
// the design's ignored .runtime/ directory.
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.mjs";
import { codexDeliver } from "./deliver.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const designDir = args["design-dir"];
const token = process.env.MOCKUP_TOKEN;
if (!designDir || !token) {
  console.error("usage: MOCKUP_TOKEN=... main.mjs --design-dir DIR [--harness NAME] [--thread ID]");
  process.exit(2);
}
delete process.env.MOCKUP_TOKEN;

const runtime = join(designDir, ".runtime");
mkdirSync(runtime, { recursive: true });

// One server per design: the log has a single writer. Every server takes a
// mutex (server.lock.recover) before touching the lock, then, inside it,
// reads the lock, removes it only if its owner is dead, and links its own.
// Both files appear atomically with their owner's pid already in them (hard
// links of a finished file), so no one sees a half-made one, and a live lock
// is never removed. The mutex is cleared only when its owner is dead, never
// by age: a paused owner is waited for, not overtaken.
const lock = join(runtime, "server.lock");
const mutex = `${lock}.recover`;
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidIn = (file) => {
  try {
    return Number(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const mine = `${lock}.${process.pid}`;
writeFileSync(mine, String(process.pid));

function takeMutex() {
  for (;;) {
    try {
      linkSync(mine, mutex);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const holder = pidIn(mutex);
    if (holder === null) continue;
    if (holder && alive(holder)) {
      sleep(20);
      continue;
    }
    // Its holder died mid-acquisition. Move it aside, and if what moved was a
    // new live holder's mutex after all, put it back.
    const aside = `${mutex}.${process.pid}`;
    try {
      renameSync(mutex, aside);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    const moved = pidIn(aside);
    if (moved && moved !== holder && alive(moved)) {
      try {
        linkSync(aside, mutex);
      } catch {
        // Someone else holds it now.
      }
    }
    rmSync(aside, { force: true });
  }
}
const releaseMutex = () => {
  if (pidIn(mutex) === process.pid) rmSync(mutex, { force: true });
};

takeMutex();
try {
  const owner = existsSync(lock) ? pidIn(lock) : null;
  if (owner && alive(owner)) {
    releaseMutex();
    rmSync(mine, { force: true });
    console.error(`another server (pid ${owner}) already runs this design`);
    process.exit(3);
  }
  // Tests widen the window between reading a dead owner and removing it.
  const pause = Number(process.env.MOCKUP_TEST_TAKEOVER_PAUSE_MS || 0);
  if (pause) sleep(pause * Math.random());
  if (owner !== null) rmSync(lock, { force: true });
  linkSync(mine, lock);
} finally {
  releaseMutex();
}
rmSync(mine, { force: true });
const releaseLock = () => {
  try {
    if (Number(readFileSync(lock, "utf8")) === process.pid) rmSync(lock, { force: true });
  } catch {
    // Already gone.
  }
};
process.on("exit", releaseLock);

// Codex is woken by the server; Claude and Pi listen with `mockup wait`.
let app;
const deliver = args.harness === "codex" && args.thread ? codexDeliver({ thread: args.thread, designDir, rounds: () => app.store.roundList() }) : null;
app = createServer({
  designDir,
  token,
  deliver,
  staticDir: join(dirname(fileURLToPath(import.meta.url)), "..", "dist"),
});
const port = await app.listen(Number(args.port ?? 0));

const session = {
  pid: process.pid,
  port,
  token,
  url: `http://127.0.0.1:${port}/`,
  harness: args.harness ?? "claude",
  thread: args.thread ?? null,
  startedAt: new Date().toISOString(),
};
const tmp = join(runtime, `session.json.${process.pid}`);
writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
renameSync(tmp, join(runtime, "session.json"));
console.log(`listening on ${session.url}`);

async function shutdown() {
  rmSync(join(runtime, "session.json"), { force: true });
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
