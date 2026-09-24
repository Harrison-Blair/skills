// Pi extension: deliver mockup browser messages into this Pi session.
// Linked into ~/.pi/agent/extensions/mockup by scripts/setup.sh.
//
// Pi does not wake for anything outside it, so this extension listens for the
// agent: once the agent runs `mockup start` here, the CLI leaves a link file
// named after this session, and the extension keeps a `mockup wait` running
// against that server (no model turns while it waits). Each message goes to
// the agent as a user message: at once when idle, or after the current work.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POLL_MS = 2000;
const RETRY_MS = 5000;

export default function mockup(pi: ExtensionAPI) {
  let stop: (() => void) | null = null;

  pi.on("session_start", (_event, ctx) => {
    stop?.();
    const link = join(process.env.MOCKUP_HOME ?? join(homedir(), ".mockup"), "pi", `${ctx.sessionManager.getSessionId()}.json`);
    let child: ChildProcess | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    // The first wait also takes messages delivered before a restart that the
    // agent never finished; after that, only new ones.
    let onlyNew = false;

    const later = (ms: number) => {
      timer = setTimeout(listen, ms);
      timer.unref?.();
    };

    function listen() {
      if (closed || child) return;
      if (!existsSync(link)) return later(POLL_MS);
      let target: { designDir: string; node: string; cli: string };
      try {
        target = JSON.parse(readFileSync(link, "utf8"));
      } catch {
        return later(POLL_MS);
      }
      const args = [target.cli, "wait", "--dir", target.designDir, "--for", "pi", ...(onlyNew ? ["--new"] : [])];
      let out = "";
      const proc = spawn(target.node, args, { stdio: ["ignore", "pipe", "ignore"] });
      child = proc;
      proc.stdout?.on("data", (c) => (out += c));
      proc.on("error", () => {});
      proc.on("close", (code) => {
        child = null;
        if (closed) return;
        if (code === 0 && out.trim()) {
          onlyNew = true;
          const text = out.trim();
          if (ctx.isIdle()) pi.sendUserMessage(text);
          else pi.sendUserMessage(text, { deliverAs: "followUp" });
          listen();
        } else {
          // The server stopped or is restarting; `mockup stop` removes the link.
          later(RETRY_MS);
        }
      });
    }

    listen();
    stop = () => {
      closed = true;
      if (timer) clearTimeout(timer);
      child?.kill();
    };
  });

  pi.on("session_shutdown", () => {
    stop?.();
    stop = null;
  });
}
