// Pi extension: pull the skills repo and re-link skills at session start.
// Linked into ~/.pi/agent/extensions/skills-autopull by scripts/setup.sh.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event) => {
    if (event.reason !== "startup") return;
    // Fire and forget: never block or fail the session.
    void (async () => {
      try {
        // realpath resolves the symlink/junction back into the clone.
        const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
        const repo = join(here, "..", "..");
        const shell = process.platform === "win32" ? "bash" : "sh";
        await pi.exec(shell, [join(repo, "scripts", "setup.sh"), "--sync"], {
          timeout: 30_000,
        });
      } catch {
        // Offline, missing shell, or timeout: ignore.
      }
    })();
  });
}
