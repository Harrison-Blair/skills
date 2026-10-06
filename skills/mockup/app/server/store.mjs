// Durable message log for one session: an append-only JSON-lines file.
// Only the server writes it. Every change is appended and fsynced before the
// caller is answered, so a crash never loses an acknowledged message; state is
// rebuilt by replaying the file on start.
import { appendFileSync, existsSync, fsyncSync, openSync, closeSync, readFileSync, truncateSync } from "node:fs";
import { randomUUID } from "node:crypto";

// queued -> delivered -> done, or failed. A delivered message that never
// reached done is handed out again by the next `wait`.
export const STATUSES = ["queued", "delivered", "done", "failed"];

export class Store {
  constructor(file) {
    this.file = file;
    this.messages = new Map();
    // What the shell shows; null until the agent's first `show`.
    this.showing = null;
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

  // Event types this version does not know (older or newer ones) are skipped.
  apply(event) {
    if (event.type === "message") {
      this.messages.set(event.message.id, { ...event.message });
      this.seq = Math.max(this.seq, event.message.seq);
    } else if (event.type === "status") {
      const m = this.messages.get(event.id);
      if (m) Object.assign(m, { status: event.status, [`${event.status}At`]: event.at }, event.note ? { note: event.note } : {});
    } else if (event.type === "show") {
      this.showing = { ...event.showing };
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

  // User messages carry the page they were sent from and its drafts, and
  // start queued; agent messages have neither, and no status.
  add({ from, kind = "chat", text = "", page = null, drafts = [] }) {
    const message = {
      id: randomUUID(),
      seq: this.seq + 1,
      from,
      kind,
      text,
      ...(from === "user" ? { page, drafts, status: "queued" } : {}),
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

  show(showing) {
    this.append({ type: "show", showing });
    return this.showing;
  }

  list() {
    return [...this.messages.values()].sort((a, b) => a.seq - b.seq);
  }

  // User messages the agent has not finished: new ones and redeliveries.
  pending() {
    return this.list().filter((m) => m.from === "user" && (m.status === "queued" || m.status === "delivered"));
  }
}
