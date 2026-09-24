import { useEffect, useState } from "react";

function upsert(list, item) {
  const i = list.findIndex((p) => p.id === item.id);
  return i === -1 ? [...list, item] : list.map((p) => (p.id === item.id ? item : p));
}

async function call(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Decisions and marks go out one at a time, so the server's "latest" is the
// user's last click. A save that failed blocks sending until the same item is
// saved again, so nothing is silently left behind.
let decisionQueue = Promise.resolve();
const failed = new Set();
const inOrder = (path, body, key) => {
  const next = decisionQueue.then(() => call(path, json(body)));
  decisionQueue = next.then(
    () => failed.delete(key),
    () => failed.add(key),
  );
  return next;
};
// Waits for every save in flight, then refuses if any failed.
async function settled() {
  await decisionQueue;
  if (failed.size) throw new Error(`${failed.size} change${failed.size > 1 ? "s" : ""} could not be saved. Make ${failed.size > 1 ? "them" : "it"} again, then send.`);
}

export const api = {
  send: (body) => call("/api/messages", json(body)),
  decide: (body) => inOrder("/api/decisions", body, `${body.round}/${body.item}/${"comment" in body ? "comment" : "value"}`),
  annotate: (body) => inOrder("/api/annotations", body, `${body.round}|${body.image}`),
  settled,
  state: () => call("/api/state"),
  upload: (blob, kind = "upload") => call(`/api/uploads?kind=${kind}`, { method: "POST", body: blob }),
};

export const fileUrl = (rel) => `/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

export function useSession() {
  const [state, setState] = useState({ design: "", messages: [], rounds: [], decisions: [], annotations: [], agent: null, ended: false });
  const [connected, setConnected] = useState(null);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    let events;
    let closed = false;
    // The stream carries changes only, so every (re)connect reloads the full
    // state, then replays what arrived while that load was in flight.
    // Only the newest load may land: an older one finishing late would
    // put back state from before a reconnect.
    let loading = null;
    let generation = 0;
    async function load() {
      const mine = ++generation;
      const buffered = [];
      loading = buffered;
      const res = await fetch("/api/state");
      if (res.status === 401) return setAuthError(true);
      const snapshot = await res.json();
      if (closed || mine !== generation) return;
      loading = null;
      setState(buffered.reduce((s, apply) => apply(s), snapshot));
    }
    fetch("/api/state").then((res) => {
      if (res.status === 401) return setAuthError(true);
      if (closed) return;
      events = new EventSource("/api/events");
      events.onopen = () => {
        setConnected(true);
        load();
      };
      events.onerror = () => setConnected(false);
      const on = (type, fn) =>
        events.addEventListener(type, (e) => {
          const apply = (s) => fn(s, JSON.parse(e.data));
          loading?.push(apply);
          setState(apply);
        });
      on("agent", (s, agent) => ({ ...s, agent }));
      on("session", (s, data) => ({ ...s, ...data }));
      on("message", (s, m) => ({ ...s, messages: upsert(s.messages, m) }));
      on("round", (s, r) => ({ ...s, rounds: upsert(s.rounds, r) }));
      on("decision", (s, d) => ({ ...s, decisions: upsert(s.decisions, d) }));
      on("annotation", (s, a) => ({ ...s, annotations: upsert(s.annotations, a) }));
    });
    return () => {
      closed = true;
      events?.close();
    };
  }, []);

  return { ...state, connected, authError };
}
