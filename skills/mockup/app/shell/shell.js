import { renderChat } from "./chat.js";
import { draftRow } from "./drafts.js";
import { icon } from "./icons.js";
import { renderCompare } from "./compare.js";
import { mountAnnotate } from "./annotate.js";
import { holdReload } from "./reload.js";
import { renderReview } from "./review.js";

const $ = (id) => document.getElementById(id);
const WIDTHS = { phone: 390, tablet: 820, desktop: 1280 };

let state = { session: null, showing: null, messages: [], agent: { listening: false, stalled: false } };
let connected = false;
let sendError = "";
let sending = false;
const drafts = new Map(); // id -> draft, unsent answers from the current page
let frame = null;
let framePage = null;

function post(data) {
  frame?.contentWindow?.postMessage({ mockup: 1, ...data }, "*");
}

function restore() {
  const named = [...drafts.values()].filter((d) => typeof d.name === "string");
  const values = Object.fromEntries(named.map((d) => [d.name, d]));
  post({ type: "restore", values });
}

// Shows `showing` in the canvas. A new frame is made when the page changes or
// when `reload` is set (a fresh `show` event).
function applyShowing(showing, reload) {
  const stage = $("stage");
  const page = showing?.pages?.[0] ?? null;
  $("path").textContent = page ?? "";
  if (renderCompare(stage, showing)) return;
  if (!page) {
    frame = framePage = null;
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing to show yet. The agent's page will appear here.";
    stage.replaceChildren(empty);
    drafts.clear();
    return;
  }
  if (page === framePage && !reload) return setDevice(showing.device);
  if (page === framePage && holdReload(showing, drafts)) return;
  if (page !== framePage) drafts.clear();
  frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.setAttribute("title", showing.title || page);
  frame.setAttribute("src", `/d/${page}`);
  framePage = page;
  stage.replaceChildren(frame);
  setDevice(showing.device);
}

function setDevice(device) {
  if (frame) frame.style.width = WIDTHS[device] ? `${WIDTHS[device]}px` : "";
}

function renderTop() {
  const s = state.session;
  $("session-name").textContent = s?.kind === "design" && s.name ? s.name : "one-off question";
  const on = connected && state.agent?.listening;
  $("dot").classList.toggle("on", Boolean(on));
  $("presence").textContent = !connected ? "Disconnected" : on ? "Agent is listening" : "Agent is not listening";
  const banner = $("banner");
  let text = "";
  if (sendError) text = `Could not send: ${sendError}`;
  else if (state.agent?.stalled) text = "The agent hasn't responded for a while. It may need you in its terminal (a permission prompt or an error).";
  if (!text) return banner.replaceChildren();
  const row = document.createElement("div");
  row.className = "banner warn";
  row.setAttribute("role", "alert");
  const span = document.createElement("span");
  span.textContent = text;
  row.append(icon("triangle-alert"), span);
  banner.replaceChildren(row);
}

function renderDrafts() {
  $("drafts").hidden = drafts.size === 0;
  $("drafts-label").textContent = `Unsent (${drafts.size})`;
  $("draft-rows").replaceChildren(...[...drafts.values()].map((d) => draftRow(d, removeDraft)));
  updateSend();
}

function removeDraft(id) {
  drafts.delete(id);
  renderDrafts();
  restore();
}

function updateSend() {
  const empty = !$("text").value.trim() && drafts.size === 0;
  $("send").disabled = sending || empty;
  $("end").disabled = sending;
}

function render() {
  renderTop();
  renderChat($("chat"), state.messages);
  renderReview($("review"), state);
  renderDrafts();
}

function upsert(msg) {
  const i = state.messages.findIndex((m) => m.id === msg.id);
  if (i < 0) state.messages.push(msg);
  else state.messages[i] = msg;
}

async function send(kind) {
  const text = $("text").value.trim();
  const list = [...drafts.values()];
  const body = { text, kind: kind ?? (list.length ? "feedback" : "chat"), page: framePage, drafts: list };
  sending = true;
  updateSend();
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `the server answered ${res.status}`);
    upsert(data);
    sendError = "";
    drafts.clear();
    $("text").value = "";
    post({ type: "clear" });
  } catch (err) {
    sendError = err.message;
  } finally {
    sending = false;
    render();
  }
}

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  applyShowing(state.showing, false);
  render();
}

function listen() {
  const events = new EventSource("/api/events");
  let dropped = false;
  events.addEventListener("open", () => {
    connected = true;
    document.body.dataset.connected = "1";
    if (dropped) loadState();
    dropped = false;
    renderTop();
  });
  events.addEventListener("error", () => {
    connected = false;
    dropped = true;
    document.body.dataset.connected = "0";
    renderTop();
  });
  events.addEventListener("message", (e) => {
    upsert(JSON.parse(e.data));
    renderChat($("chat"), state.messages);
  });
  events.addEventListener("show", (e) => {
    state.showing = JSON.parse(e.data);
    applyShowing(state.showing, true);
    renderDrafts();
  });
  events.addEventListener("agent", (e) => {
    state.agent = JSON.parse(e.data);
    renderTop();
  });
}

addEventListener("message", (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  const data = e.data;
  if (!data || data.mockup !== 1) return;
  if (data.type === "ready") restore();
  else if (data.type === "draft" && typeof data.draft?.id === "string" && typeof data.draft.kind === "string") {
    drafts.set(data.draft.id, data.draft);
    renderDrafts();
  } else if (data.type === "undraft") {
    drafts.delete(data.id);
    renderDrafts();
  }
});

$("send").prepend(icon("send"));
$("text").addEventListener("input", updateSend);
// Enter sends; Shift+Enter and Enter that ends an input method's composition do not.
$("text").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  $("composer").requestSubmit();
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!$("send").disabled) send();
});
$("end").addEventListener("click", () => send("exit"));
mountAnnotate($("bar"), post);

await loadState();
listen();
