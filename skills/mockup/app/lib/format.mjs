// Turns browser messages into plain words for the agent.

const q = (v) => `"${v}"`;

function draftLines(d) {
  if (d.kind === "choice") {
    const field = `for ${d.name}${d.label ? ` ${q(d.label)}` : ""}`;
    const lines = [];
    if (d.value?.length) lines.push(`* chose ${d.value.map(q).join(", ")} ${field}`);
    if (d.written?.length) lines.push(`* wrote in ${d.written.map(q).join(", ")} ${field}`);
    return lines;
  }
  if (d.kind === "text") return [`* noted ${q(d.note)}${d.name ? ` (${d.name} = ${JSON.stringify(d.value)})` : ""}`];
  // Kinds without their own wording yet still reach the agent.
  const { id, kind, ...rest } = d;
  return [`* sent a ${kind} draft: ${JSON.stringify(rest)}`];
}

// What the agent reads about browser messages, the same whichever way it
// arrives: printed by `mockup wait` (Claude), queued into the session by the
// server (Codex), or sent in by the Pi extension. Only the closing
// instruction differs, since only Claude listens with `mockup wait`.
export function format(messages, harness = "claude") {
  const lines = [`[mockup] ${messages.length} message${messages.length === 1 ? "" : "s"} from the browser:`];
  for (const m of messages) {
    const on = m.page ? ` on ${m.page}` : "";
    lines.push(`--- #${m.seq} ${m.kind}${on}${m.redelivered ? " (redelivered: you may have handled this before a crash)" : ""}`);
    for (const d of m.drafts ?? []) lines.push(...draftLines(d));
    if (m.text?.trim()) lines.push(m.text);
    if (m.kind === "exit") lines.push("* the user ended the session: say goodbye with `mockup say`, then run `mockup stop`.");
  }
  lines.push(`--- reply with \`mockup say\`, then ${harness === "claude" ? "run `mockup wait` again." : "end your turn."}`);
  return lines.join("\n");
}
