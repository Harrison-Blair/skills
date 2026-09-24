// Turns browser messages into plain words for the agent.
import { join } from "node:path";

function originalOf(rounds, roundId, image) {
  const round = rounds.find((r) => r.id === roundId);
  for (const page of round?.pages ?? []) {
    for (const b of page.blocks) {
      if (b.src === image && b.from) return b.from;
      const i = b.images?.indexOf(image) ?? -1;
      if (i >= 0 && b.imagesFrom) return b.imagesFrom[i];
    }
  }
  return null;
}

function itemLabel(rounds, roundId, itemId) {
  if (itemId === "draft") return `the whole draft of ${roundId}`;
  const round = rounds.find((r) => r.id === roundId);
  for (const page of round?.pages ?? []) {
    const b = page.blocks.find((x) => x.id === itemId);
    if (b) return `${roundId}/${itemId} "${b.title ?? b.text ?? b.caption ?? b.src}"`;
  }
  return `${roundId}/${itemId}`;
}

const VERDICT = { like: "liked", dislike: "disliked", approve: "APPROVED", changes: "asked for changes to" };

// What the agent reads about browser messages, the same whichever way it
// arrives: printed by `mockup wait` (Claude), queued into the session by the
// server (Codex), or sent in by the Pi extension. Only the closing
// instruction differs, since only Claude listens with `mockup wait`.
const NEXT = {
  claude: "reply with `mockup say`, then run `mockup wait` again.",
  push: "reply with `mockup say`, then end your turn: the next browser message arrives on its own. Do not run `mockup wait`.",
};

export function format(messages, rounds, designDir, harness = "claude") {
  const abs = (rel) => join(designDir, ...rel.split("/"));
  const lines = [`[mockup] ${messages.length} message(s) from the browser:`];
  for (const m of messages) {
    const about = m.round ? ` about round ${m.round}` : "";
    lines.push(`--- #${m.seq} ${m.kind}${about}${m.redelivered ? " (redelivered: you may have handled this before a crash)" : ""}`);
    if (m.text?.trim()) lines.push(m.text);
    for (const d of m.decisions ?? []) {
      if ("comment" in d) {
        lines.push(d.comment.trim() ? `* commented on ${itemLabel(rounds, d.round, d.item)}: ${d.comment.trim()}` : `* deleted their comment on ${itemLabel(rounds, d.round, d.item)}`);
        continue;
      }
      const verdict = Array.isArray(d.value)
        ? d.value.length ? `chose ${d.value.map((v) => `"${v}"`).join(", ")} for` : "cleared their answers to"
        : VERDICT[d.value] ?? `chose "${d.value}" for`;
      lines.push(`* ${verdict} ${itemLabel(rounds, d.round, d.item)}`);
    }
    const a = m.attachments;
    for (const sel of a?.selections ?? []) lines.push(`* selected ${itemLabel(rounds, sel.round, sel.item)}`);
    for (const up of a?.uploads ?? []) lines.push(`* uploaded image: ${abs(up)}`);
    for (const an of [...(a?.annotations ?? []), ...(m.annotations ?? [])]) {
      const from = originalOf(rounds, an.round, an.image);
      const what = an.item
        ? `a snapshot of the live preview ${itemLabel(rounds, an.round, an.item)}, as the user saw it (${abs(an.image)})`
        : `${abs(an.image)}${from ? ` (your ${from} as published in ${an.round})` : ""}`;
      if (!an.marks.length) {
        lines.push(`* removed their marks on ${what}`);
        continue;
      }
      lines.push(`* marked up ${what}${an.render ? `; open ${abs(an.render)} to see the marks drawn on it` : ""}:`);
      an.marks.forEach((mk, i) => {
        const where = `${Math.round(mk.x * 100)}% across, ${Math.round(mk.y * 100)}% down`;
        lines.push(`    ${i + 1}. ${mk.shape === "pin" ? "pin" : "circle"} at ${where}${mk.note ? `: ${mk.note}` : ""}`);
      });
    }
    if (m.kind === "exit") lines.push("The user ended the session. Record any decisions above, reply with one short goodbye, run `mockup stop`, and stop listening.");
  }
  lines.push(`--- open any image paths above with your image tool, ${harness === "claude" ? NEXT.claude : NEXT.push}`);
  return lines.join("\n");
}
