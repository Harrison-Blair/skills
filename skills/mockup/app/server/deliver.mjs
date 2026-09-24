// Push delivery for harnesses that cannot sit in `mockup wait`.
//
// Codex does not wake when a background command finishes, but `codex queue`
// starts a turn in a given session with the message (after the current turn,
// if it is busy). The server runs it for each browser message, in order.
import { spawn } from "node:child_process";
import { format } from "../lib/format.mjs";

export function codexDeliver({ thread, designDir, rounds }) {
  let queue = Promise.resolve();
  const run = (text) =>
    new Promise((ok, fail) => {
      const child = spawn("codex", ["queue", "--thread", thread, "--message", text], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.on("error", fail);
      child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(err.trim() || `codex queue exited with ${code}`))));
    });
  return (message) => {
    const next = queue.then(() => run(format([message], rounds(), designDir, "codex")));
    queue = next.catch(() => {});
    return next;
  };
}
