// Draft shapes (shell/shape.js) and the feedback text for hostile drafts: a
// page is untrusted, so nothing may assume more than a string id and kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "../lib/format.mjs";
import { malformed, wellFormed } from "../shell/shape.js";

const choice = { id: "choice:nav", kind: "choice", name: "nav", label: "Which navigation?", value: ["Tabs"], written: [] };
const text = { id: "send:plan", kind: "text", note: "Use plan B", name: "plan", value: "B" };
const huge = "x".repeat(1024 * 1024);

const GOOD = [
  ["a choice", choice],
  ["a choice with null label and name", { ...choice, label: null, name: null }],
  ["a choice with value and written missing", { id: "c", kind: "choice", name: "nav" }],
  ["a text draft", text],
  ["a text draft with only a note", { id: "send:1", kind: "text", note: "hi" }],
  ["a choice with a huge extra field", { ...choice, extra: huge }],
];

const HOSTILE = [
  ["value a string", { ...choice, value: "Tabs" }],
  ["value a number", { ...choice, value: 3 }],
  ["value null", { ...choice, value: null }],
  ["value an object", { ...choice, value: { 0: "Tabs" } }],
  ["value holding a non-string", { ...choice, value: ["Tabs", 1] }],
  ["written a string", { ...choice, written: "maybe" }],
  ["written a number", { ...choice, written: 3 }],
  ["written null", { ...choice, written: null }],
  ["written an object", { ...choice, written: {} }],
  ["written holding a non-string", { ...choice, written: [null] }],
  ["name a number", { ...choice, name: 5 }],
  ["name an object", { ...choice, name: {} }],
  ["label an array", { ...choice, label: ["x"] }],
  ["text note missing", { id: "send:1", kind: "text" }],
  ["text note an object", { ...text, note: { toString: 1 } }],
  ["text name a number", { ...text, name: 2 }],
  ["a bad choice with a huge extra field", { ...choice, value: "Tabs", extra: huge }],
];

const msg = (drafts) => ({ id: "m", seq: 1, from: "user", kind: "feedback", text: "", page: "pages/ask.html", drafts, status: "delivered" });

for (const [what, draft] of GOOD) {
  test(`well formed: ${what}`, () => {
    assert.equal(wellFormed(draft), true);
    assert.equal(malformed(draft), false);
    assert.doesNotMatch(format([msg([draft])]), /\* sent a/);
  });
}

for (const [what, draft] of HOSTILE) {
  test(`malformed, and formatted as an unknown kind: ${what}`, () => {
    assert.equal(wellFormed(draft), false);
    assert.equal(malformed(draft), true);
    const { id, kind, ...rest } = draft;
    assert.equal(format([msg([draft])]).split("\n")[2], `* sent a ${kind} draft: ${JSON.stringify(rest)}`);
  });
}

test("a draft that is not an object is neither well formed nor malformed, and still formats", () => {
  for (const draft of [null, [], ["choice"], "choice", 3]) {
    assert.equal(wellFormed(draft), false, JSON.stringify(draft));
    assert.equal(malformed(draft), false, JSON.stringify(draft));
    assert.equal(format([msg([draft])]).split("\n")[2], `* sent a draft: ${JSON.stringify(draft)}`);
  }
});

test("unknown kinds, and kinds named like Object.prototype keys, are not malformed", () => {
  for (const kind of ["pin", "malformed", "__proto__", "constructor", "toString"]) {
    assert.equal(malformed({ id: "x", kind }), false, kind);
    assert.equal(wellFormed({ id: "x", kind }), false, kind);
  }
});

test("a malformed wrapper reaches the agent with the original draft", () => {
  const wrapped = { id: "bad-shape", kind: "malformed", draft: { id: "bad-shape", kind: "choice", name: "nav", value: "Tabs", written: [] } };
  assert.equal(format([msg([wrapped])]).split("\n")[2],
    '* sent a malformed draft: {"draft":{"id":"bad-shape","kind":"choice","name":"nav","value":"Tabs","written":[]}}');
});
