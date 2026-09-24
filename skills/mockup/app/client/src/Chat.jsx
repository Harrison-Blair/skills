import { useEffect, useRef, useState } from "react";
import { Md, Attachments, STATUS_LABEL } from "./common.jsx";
import { fileUrl } from "./session.js";
import { stageLabel } from "./Round.jsx";
import { Flag, ListTodo, LogOut, Paperclip, SendHorizontal, X } from "lucide-react";

const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Everything waiting to go with the next message: selections and uploads.
// Marks stay on their images and go along too.
function Tray({ draft, setDraft }) {
  if (!draft.selections.length && !draft.uploads.length) return null;
  const drop = (patch) => setDraft((d) => ({ ...d, ...patch(d) }));
  return (
    <div className="tray" aria-label="Attached to your next message">
      {draft.selections.map((s) => (
        <span key={`${s.round}/${s.item}`} className="chip">
          <span className="chip-label">{s.label}</span>
          <button type="button" aria-label={`Remove ${s.label}`} onClick={() => drop((d) => ({ selections: d.selections.filter((x) => x !== s) }))}><X size={12} aria-hidden="true" /></button>
        </span>
      ))}
      {draft.uploads.map((p) => (
        <span key={p} className="chip thumb-chip">
          <img src={fileUrl(p)} alt="upload" />
          <button type="button" aria-label="Remove upload" onClick={() => drop((d) => ({ uploads: d.uploads.filter((x) => x !== p) }))}><X size={12} aria-hidden="true" /></button>
        </span>
      ))}
    </div>
  );
}

export function Chat({ messages, round, ended, draft, setDraft, canSend, onSend, onExit, onUpload, unsent, review }) {
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const end = useRef(null);
  const picker = useRef(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function run(fn) {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(err.message);
    }
  }

  const addFiles = (files) =>
    run(async () => {
      for (const f of files) {
        if (!ACCEPT.includes(f.type)) throw new Error(`${f.name || "That file"} is not a PNG, JPEG, WebP or GIF image`);
        if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name} is larger than 10 MB`);
        await onUpload(f);
      }
    });

  return (
    <aside
      className={`chat ${dragging ? "dragging" : ""}`}
      aria-label="Chat with the agent"
      onDragOver={(e) => {
        if (ended) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!ended) addFiles([...e.dataTransfer.files]);
      }}
    >
      <ol className="messages">
        {messages.length === 0 && <li className="empty">Say hello, or describe what you're designing. You can drop or paste images here.</li>}
        {messages.map((m) => (
          <li key={m.id} className={`message ${m.from} ${m.kind}`}>
            {m.kind === "exit" ? <p>Ended the session</p> : m.text?.trim() ? <Md>{m.text}</Md> : null}
            {m.decisions?.length > 0 && <p className="sent-reactions">Sent {m.decisions.length} reaction{m.decisions.length > 1 ? "s" : ""}</p>}
            <Attachments attachments={m.attachments} marked={m.annotations} />
            {m.from === "user" && (
              <span className={`status ${m.status}`}>
                {m.round && <span className="about">{m.round} · </span>}
                {STATUS_LABEL[m.status]}{m.note ? `: ${m.note}` : ""}
              </span>
            )}
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ol>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) run(onSend);
        }}
      >
        {round && <p className="about-line">About {stageLabel(round.stage)} · Round {round.n}</p>}
        {!ended && (unsent > 0 || review.unanswered > 0 || review.flagged > 0) && (
          <div className="review-line">
            {unsent > 0 && <span className="unsent-count">{unsent} reaction{unsent > 1 ? "s" : ""} or comment{unsent > 1 ? "s" : ""} not sent yet</span>}
            <span className="review-buttons">
              {review.flagged > 0 && (
                <button type="button" className="jump" onClick={() => review.onJump("flagged")} title="Go to the next flagged item" aria-label={`Next flagged (${review.flagged})`}>
                  <Flag size={14} aria-hidden="true" />Flagged <span className="count">{review.flagged}</span>
                </button>
              )}
              {review.unanswered > 0 && (
                <button type="button" className="jump" onClick={() => review.onJump("unanswered")} title="Go to the next item you haven't answered" aria-label={`Go to unanswered (${review.unanswered})`}>
                  <ListTodo size={14} aria-hidden="true" />Unanswered <span className="count">{review.unanswered}</span>
                </button>
              )}
              {unsent > 0 && <button type="button" className="send-feedback" onClick={() => canSend && run(onSend)} disabled={!canSend}>Send feedback</button>}
            </span>
          </div>
        )}
        <Tray draft={draft} setDraft={setDraft} />
        <textarea
          value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) run(onSend);
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          placeholder={ended ? "Session ended" : "Message the agent (Markdown works)"}
          rows={3}
          aria-label="Message"
          disabled={ended}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <input
            ref={picker}
            type="file"
            accept={ACCEPT.join(",")}
            multiple
            hidden
            onChange={(e) => {
              addFiles([...e.target.files]);
              e.target.value = "";
            }}
          />
          <button type="button" className="icon attach" onClick={() => picker.current.click()} disabled={ended} title="Attach images" aria-label="Attach images">
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <span className="spacer" />
          <button type="button" className="icon exit" onClick={() => run(onExit)} disabled={ended} title="End session" aria-label="End session">
            <LogOut size={18} aria-hidden="true" />
          </button>
          <button type="submit" className="send" disabled={ended || !canSend}>Send<SendHorizontal size={16} aria-hidden="true" /></button>
        </div>
      </form>
    </aside>
  );
}
