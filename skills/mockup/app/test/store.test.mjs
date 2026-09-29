import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";

const tmpLog = () => join(mkdtempSync(join(tmpdir(), "mockup-store-")), "log.jsonl");

test("messages and statuses survive a restart", () => {
  const file = tmpLog();
  const a = new Store(file);
  const m = a.add({ from: "user", text: "hi" });
  a.setStatus(m.id, "delivered");
  const b = new Store(file);
  assert.equal(b.messages.get(m.id).status, "delivered");
  assert.equal(b.pending().length, 1);
  assert.equal(b.add({ from: "user", text: "next" }).seq, 2);
});

test("done and failed messages are no longer pending", () => {
  const s = new Store(tmpLog());
  const a = s.add({ from: "user", text: "a" });
  const b = s.add({ from: "user", text: "b" });
  s.add({ from: "agent", text: "reply" });
  s.setStatus(a.id, "done");
  s.setStatus(b.id, "failed", "boom");
  assert.deepEqual(s.pending(), []);
});

test("user messages keep their page and drafts; agent messages have no status", () => {
  const file = tmpLog();
  const s = new Store(file);
  const drafts = [{ id: "choice:nav", kind: "choice", name: "nav", value: ["Tabs"] }];
  const m = s.add({ from: "user", kind: "feedback", text: "", page: "pages/ask.html", drafts });
  assert.equal(m.status, "queued");
  assert.equal(m.page, "pages/ask.html");
  assert.deepEqual(new Store(file).messages.get(m.id).drafts, drafts);
  assert.equal("status" in s.add({ from: "agent", text: "ok" }), false);
});

test("what the shell shows survives a restart", () => {
  const file = tmpLog();
  const showing = { pages: ["pages/ask.html"], title: null, device: "fit" };
  assert.equal(new Store(file).showing, null);
  new Store(file).show(showing);
  assert.deepEqual(new Store(file).showing, showing);
});

test("unknown event types are skipped on replay", () => {
  const file = tmpLog();
  new Store(file).add({ from: "user", text: "kept" });
  appendFileSync(file, JSON.stringify({ type: "approval", page: "pages/a.html" }) + "\n");
  appendFileSync(file, JSON.stringify({ type: "round", round: { id: "context-1" } }) + "\n");
  const s = new Store(file);
  assert.deepEqual(s.list().map((m) => m.text), ["kept"]);
  assert.equal(s.add({ from: "user", text: "after" }).seq, 2);
});

test("a torn final line from a crash is cut off, so later writes survive", () => {
  const file = tmpLog();
  new Store(file).add({ from: "user", text: "kept" });
  appendFileSync(file, '{"type":"message","mess');
  const reopened = new Store(file);
  assert.equal(reopened.list().length, 1);
  reopened.add({ from: "user", text: "after the crash" });
  assert.deepEqual(new Store(file).list().map((m) => m.text), ["kept", "after the crash"]);
});

test("corruption before the last line is an error", () => {
  const file = tmpLog();
  new Store(file).add({ from: "user", text: "before" });
  const good = readFileSync(file, "utf8");
  appendFileSync(file, "garbage\n" + good);
  assert.throws(() => new Store(file), /corrupt/);
});
