import { icon } from "./icons.js";

function words(...parts) {
  const span = document.createElement("span");
  span.className = "line";
  span.append(...parts);
  return span;
}

function bold(text) {
  const b = document.createElement("b");
  b.textContent = text;
  return b;
}

// Plain-words summary lines for one draft, e.g. "Chose Tabs".
export function draftLines(draft) {
  if (draft.kind === "choice") {
    const lines = [];
    if (draft.value?.length) lines.push(words("Chose ", bold(draft.value.join(", "))));
    for (const w of draft.written ?? []) lines.push(words(`Wrote in "${w}"`));
    return lines;
  }
  if (draft.kind === "text") return [words(`Noted "${draft.note}"`)];
  return [words(`Sent a ${draft.kind} draft`)];
}

// One flat row per draft; `onRemove` adds a remove control that calls it with the id.
export function draftRow(draft, onRemove) {
  const row = document.createElement("div");
  row.className = "draft";
  const lines = document.createElement("div");
  lines.className = "lines";
  lines.append(...draftLines(draft));
  row.append(lines);
  if (onRemove) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "x";
    remove.title = "Remove";
    remove.setAttribute("aria-label", "Remove");
    remove.append(icon("x"));
    remove.addEventListener("click", () => onRemove(draft.id));
    row.append(remove);
  }
  return row;
}
