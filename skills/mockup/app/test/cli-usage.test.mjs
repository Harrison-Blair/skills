import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/mockup.mjs", import.meta.url));

for (const command of ["toString", "constructor", "__proto__"]) {
  test(`unknown command ${command} prints usage`, () => {
    const r = spawnSync(process.execPath, [CLI, command], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: mockup start\|show\|wait\|say\|status\|stop/);
  });
}
