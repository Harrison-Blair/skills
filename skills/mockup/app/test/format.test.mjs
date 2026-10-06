import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "../lib/format.mjs";

const choice = (value, written = []) => ({ id: "choice:nav", kind: "choice", name: "nav", label: "Which navigation?", value, written });
const msg = (fields) => ({ id: "m", seq: 3, from: "user", kind: "feedback", text: "", page: "pages/ask.html", drafts: [], status: "delivered", createdAt: "2026-09-29T00:00:00Z", ...fields });

test("matches the contract example", () => {
  const m = msg({ text: "Keep it simple.", drafts: [choice(["Tabs"], ["maybe a drawer on phone"])] });
  assert.equal(format([m], "claude"), [
    "[mockup] 1 message from the browser:",
    "--- #3 feedback on pages/ask.html",
    "* chose \"Tabs\" for nav \"Which navigation?\"",
    "* wrote in \"maybe a drawer on phone\" for nav \"Which navigation?\"",
    "Keep it simple.",
    "--- reply with `mockup say`, then run `mockup wait` again.",
  ].join("\n"));
});

test("header counts one and two messages", () => {
  assert.match(format([msg({ text: "a" })]), /^\[mockup\] 1 message from the browser:\n/);
  assert.match(format([msg({ text: "a" }), msg({ seq: 4, text: "b" })]), /^\[mockup\] 2 messages from the browser:\n/);
});

test("per-message line has sequence number, kind and page", () => {
  const lines = format([msg({ seq: 7, kind: "chat", text: "hi", page: "pages/home.html" })]).split("\n");
  assert.equal(lines[1], "--- #7 chat on pages/home.html");
});

test("redelivered messages carry a note", () => {
  const lines = format([msg({ text: "hi", redelivered: true })]).split("\n");
  assert.equal(lines[1], "--- #3 feedback on pages/ask.html (redelivered: you may have handled this before a crash)");
});

test("a choice draft names the value, field and label", () => {
  const lines = format([msg({ drafts: [choice(["Tabs"])] })]).split("\n");
  assert.equal(lines[2], "* chose \"Tabs\" for nav \"Which navigation?\"");
  assert.equal(lines.length, 4);
});

test("a written-in value is its own line", () => {
  const lines = format([msg({ drafts: [choice([], ["a drawer"])] })]).split("\n");
  assert.equal(lines[2], "* wrote in \"a drawer\" for nav \"Which navigation?\"");
  assert.equal(lines.length, 4);
});

test("a multiple choice lists both values", () => {
  const lines = format([msg({ drafts: [choice(["Tabs", "Sidebar"])] })]).split("\n");
  assert.equal(lines[2], "* chose \"Tabs\", \"Sidebar\" for nav \"Which navigation?\"");
});

test("free text follows the draft lines", () => {
  const lines = format([msg({ text: "Keep it simple.", drafts: [choice(["Tabs"])] })]).split("\n");
  assert.deepEqual(lines.slice(2, 4), ["* chose \"Tabs\" for nav \"Which navigation?\"", "Keep it simple."]);
});

test("closing line depends on the harness", () => {
  const last = (h) => format([msg({ text: "hi" })], h).split("\n").at(-1);
  assert.equal(last("claude"), "--- reply with `mockup say`, then run `mockup wait` again.");
  assert.equal(last("codex"), "--- reply with `mockup say`, then end your turn.");
  assert.equal(last("pi"), "--- reply with `mockup say`, then end your turn.");
});

test("an exit message tells the agent to say goodbye and stop", () => {
  const lines = format([msg({ kind: "exit", text: "Thanks." })]).split("\n");
  assert.deepEqual(lines.slice(1, 4), [
    "--- #3 exit on pages/ask.html",
    "Thanks.",
    "* the user ended the session: say goodbye with `mockup say`, then run `mockup stop`.",
  ]);
});

test("a text draft quotes the note and names the field", () => {
  const drafts = [
    { id: "send:plan", kind: "text", note: "Use plan B", name: "plan", value: "B" },
    { id: "send:1", kind: "text", note: "Looks cramped" },
  ];
  const lines = format([msg({ drafts })]).split("\n");
  assert.deepEqual(lines.slice(2, 4), ["* noted \"Use plan B\" (plan = \"B\")", "* noted \"Looks cramped\""]);
});

test("an unknown draft kind is shown, not dropped", () => {
  const lines = format([msg({ drafts: [{ id: "p1", kind: "pin", x: 0.5 }] })]).split("\n");
  assert.equal(lines[2], "* sent a pin draft: {\"x\":0.5}");
});

test("a message without a page has no page part", () => {
  const lines = format([msg({ kind: "chat", text: "hi", page: null })]).split("\n");
  assert.equal(lines[1], "--- #3 chat");
});
