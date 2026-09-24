// Durable message log for one design: an append-only JSON-lines file.
// Only the server writes it. Every change is appended and fsynced before the
// caller is answered, so a crash never loses an acknowledged message; state is
// rebuilt by replaying the file on start.
import { appendFileSync, existsSync, fsyncSync, openSync, closeSync, readFileSync, truncateSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { STAGES } from "./round.mjs";

// A decision is a reaction (value) or a comment on one round item; the latest
// of each kind per item is what counts.
const decisionKey = (d) => `${d.round}\u0000${d.item}\u0000${"comment" in d ? "comment" : "value"}`;

// Pins and circles on one round image (or preview snapshot); the latest set
// per image is what counts.
export const annotationKey = (a) => `${a.round}\u0000${a.image}`;

// queued -> delivered -> done, or failed. A delivered message that never
// reached done is handed out again by the next `wait`.
export const STATUSES = ["queued", "delivered", "done", "failed"];

export class Store {
  constructor(file) {
    this.file = file;
    this.messages = new Map();
    this.rounds = new Map();
    // Likes, dislikes, choices and draft approvals, oldest first. A decision is
    // "sent" once a message carried it to the agent.
    this.decisions = [];
    // Marks the user placed, oldest first; "sent" like decisions.
    this.annotations = [];
    this.seq = 0;
    if (existsSync(file)) this.replay();
  }

  replay() {
    const buf = readFileSync(this.file);
    // Every record ends with a newline, so bytes after the last one are a
    // record torn by a crash mid-append; it was never acknowledged. Cut it
    // off, or the next append would be glued onto it and lost.
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end < buf.length) truncateSync(this.file, end);
    const lines = buf.subarray(0, end).toString("utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`${this.file}:${i + 1}: corrupt log line`);
      }
      this.apply(event);
    }
  }

  apply(event) {
    if (event.type === "message") {
      this.messages.set(event.message.id, { ...event.message });
      this.seq = Math.max(this.seq, event.message.seq);
      // Carrying the latest decision on an item also retires the unsent ones it replaced.
      const carried = new Set((event.message.decisions ?? []).map(decisionKey));
      for (const d of this.decisions) if (!d.sent && carried.has(decisionKey(d))) d.sent = event.message.id;
      // Carrying a revision of an image's marks retires it and any older
      // unsent ones; a newer edit made meanwhile stays unsent.
      for (const carried of event.message.annotations ?? []) {
        const upTo = this.annotations.findIndex((a) => a.id === carried.id);
        for (const a of this.annotations.slice(0, upTo + 1)) {
          if (!a.sent && annotationKey(a) === annotationKey(carried)) a.sent = event.message.id;
        }
      }
    } else if (event.type === "annotation") {
      this.annotations.push({ ...event.annotation });
    } else if (event.type === "decision") {
      this.decisions.push({ ...event.decision });
    } else if (event.type === "round") {
      this.rounds.set(event.round.id, { ...event.round });
    } else if (event.type === "status") {
      const m = this.messages.get(event.id);
      if (m) Object.assign(m, { status: event.status, [`${event.status}At`]: event.at }, event.note ? { note: event.note } : {});
    }
  }

  append(event) {
    const fd = openSync(this.file, "a");
    try {
      appendFileSync(fd, JSON.stringify(event) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.apply(event);
  }

  // Every user message carries the decisions not yet sent, so none are lost
  // whether the user presses Send feedback, chats, or ends the session. Marks
  // go only as the page drew them: renders maps "round|image" to { id, path }
  // (path null for marks cleared), and exactly those revisions are carried.
  // Anything marked meanwhile stays unsent for the next message.
  add({ from, kind = "chat", text = "", attachments = null, round = null, renders = {} }) {
    const decisions = from === "user" ? this.unsentDecisions() : [];
    const annotations = from === "user" ? this.drawn(renders).map(({ annotation, path }) => (path ? { ...annotation, render: path } : annotation)) : [];
    const message = {
      id: randomUUID(),
      seq: this.seq + 1,
      from,
      kind,
      text,
      attachments,
      round,
      ...(decisions.length ? { decisions } : {}),
      ...(annotations.length ? { annotations } : {}),
      status: from === "user" ? "queued" : "done",
      createdAt: new Date().toISOString(),
    };
    this.append({ type: "message", message });
    return this.messages.get(message.id);
  }

  setStatus(id, status, note) {
    if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
    const at = new Date().toISOString();
    this.append({ type: "status", id, status, at, ...(note ? { note } : {}) });
    return this.messages.get(id);
  }

  // Rounds are immutable once published; a stage's rounds are numbered from 1.
  addRound({ stage, title, kind = "explore", pages }) {
    if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
    const n = this.roundList().filter((r) => r.stage === stage).length + 1;
    const round = { id: `${stage}-${n}`, stage, n, title, kind, pages, createdAt: new Date().toISOString() };
    this.append({ type: "round", round });
    return this.rounds.get(round.id);
  }

  roundList() {
    return [...this.rounds.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // A later decision on the same item replaces an earlier unsent one.
  decide({ round, item, value, comment }) {
    const decision = { id: randomUUID(), round, item, ...(comment !== undefined ? { comment } : { value }), at: new Date().toISOString() };
    this.append({ type: "decision", decision });
    return decision;
  }

  // Replaces the marks on one image; an empty list removes them.
  annotate({ round, item, image, marks }) {
    const annotation = { id: randomUUID(), round, ...(item !== undefined ? { item } : {}), image, marks, at: new Date().toISOString() };
    this.append({ type: "annotation", annotation });
    return annotation;
  }

  // The unsent mark revisions a renders map names, with their drawn copies.
  drawn(renders) {
    return Object.entries(renders).flatMap(([key, r]) => {
      const annotation = this.annotations.find((a) => a.id === r.id && !a.sent && `${a.round}|${a.image}` === key);
      return annotation ? [{ annotation, path: r.path }] : [];
    });
  }

  unsentAnnotations() {
    const latest = new Map();
    for (const a of this.annotations) if (!a.sent) latest.set(annotationKey(a), a);
    return [...latest.values()];
  }

  unsentDecisions() {
    const latest = new Map();
    for (const d of this.decisions) if (!d.sent) latest.set(decisionKey(d), d);
    return [...latest.values()];
  }

  list() {
    return [...this.messages.values()].sort((a, b) => a.seq - b.seq);
  }

  // User messages the agent has not finished: new ones and redeliveries.
  pending() {
    return this.list().filter((m) => m.from === "user" && (m.status === "queued" || m.status === "delivered"));
  }
}
