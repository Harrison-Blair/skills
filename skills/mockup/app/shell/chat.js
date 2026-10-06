import { renderMarkdown } from "./markdown.js";
import { draftRow } from "./drafts.js";

function messageNode(msg) {
  const node = document.createElement("div");
  node.className = `msg ${msg.from}${msg.kind === "progress" ? " progress" : ""}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = msg.from === "agent" ? "Agent" : msg.status === "failed" ? "You (not delivered)" : "You";
  node.append(who);
  if (msg.from === "agent") {
    node.append(renderMarkdown(msg.text));
  } else {
    for (const draft of msg.drafts ?? []) node.append(draftRow(draft));
    if (msg.text) {
      const text = document.createElement("p");
      text.textContent = msg.text;
      node.append(text);
    }
    if (msg.kind === "exit") {
      const end = document.createElement("p");
      end.className = "who";
      end.textContent = "Ended the session";
      node.append(end);
    }
  }
  return node;
}

// Replaces the chat list with the messages in order.
export function renderChat(list, messages) {
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  list.replaceChildren(...sorted.map(messageNode));
  if (!sorted.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No messages yet.";
    list.append(empty);
  }
  if (atBottom) list.scrollTop = list.scrollHeight;
}
