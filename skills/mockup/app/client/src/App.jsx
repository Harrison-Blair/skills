import { useEffect, useState } from "react";
import { api, useSession } from "./session.js";
import { RoundView, STAGES, StatusPill, latestOf, reviewItems, roundStatus, unsentMarksOf, unsentOf, useFlags } from "./Round.jsx";
import { Chat } from "./Chat.jsx";
import { renderMarks } from "./Annotate.jsx";
import { MessageSquare, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ThumbsDown, ThumbsUp } from "lucide-react";

const EMPTY_DRAFT = { text: "", selections: [], uploads: [] };

function Banner({ agent, connected, pending, ended }) {
  if (ended) return <div className="banner info">Session ended. You can close this tab.</div>;
  if (connected === false) return <div className="banner warn">Lost connection to the mockup server. It may have stopped; ask the agent in its terminal to run <code>mockup start</code> again.</div>;
  if (agent?.stalled) return <div className="banner warn">The agent hasn't responded for a while. It may need you in its terminal (a permission prompt or an error).</div>;
  if (pending && agent && !agent.listening) return <div className="banner info">Your message is saved. The agent will pick it up when it next listens.</div>;
  return null;
}

// Each stage heads its own list of rounds: a durable history of what was shown
// and how the user reacted.
function StageRail({ rounds, decisions, messages, shown, onSelect }) {
  const current = rounds.at(-1)?.stage;
  const latest = latestOf(decisions);
  const comments = latestOf(decisions, true);
  return (
    <nav className="stages" aria-label="Stages and review rounds">
      {STAGES.map((stage) => {
        const stageRounds = rounds.filter((r) => r.stage === stage.id);
        // The newest draft decides: approving an old one does not cover a revision.
        const lastDraft = stageRounds.filter((r) => r.kind === "draft").at(-1);
        const verdict = lastDraft && latest.get(`${lastDraft.id}/draft`)?.value;
        return (
          <section key={stage.id} className={`stage ${stage.id === current ? "current" : ""}`}>
            <h2>
              {stage.label}
              {verdict === "approve" ? <StatusPill status={{ key: "approved", label: "Approved" }} />
                : verdict === "changes" ? <StatusPill status={{ key: "changes", label: "Changes requested" }} />
                : stageRounds.length ? <StatusPill status={{ key: "progress", label: "In progress" }} />
                : <span className="meta">Not started</span>}
            </h2>
            {stageRounds.length > 0 && (
              <ol className="rounds">
                {stageRounds.map((r) => {
                  const mine = [...latest.values()].filter((d) => d.round === r.id);
                  const likes = mine.filter((d) => d.value === "like").length;
                  const dislikes = mine.filter((d) => d.value === "dislike").length;
                  return (
                    <li key={r.id}>
                      <button className={shown?.id === r.id ? "selected" : ""} aria-current={shown?.id === r.id} onClick={() => onSelect(r.id)}>
                        <span className="round-title">
                          <span className={`kind-dot ${r.kind ?? "explore"}`} aria-label={r.kind === "draft" ? "Draft" : "Explore"} />
                          Round {r.n} · {r.title}
                        </span>
                        <span className="round-meta">
                          <StatusPill status={roundStatus(r, decisions, messages)} />
                          {likes > 0 && <span className="meta" aria-label={`${likes} liked`}><ThumbsUp size={12} aria-hidden="true" />{likes}</span>}
                          {dislikes > 0 && <span className="meta" aria-label={`${dislikes} disliked`}><ThumbsDown size={12} aria-hidden="true" />{dislikes}</span>}
                          {(() => {
                            const n = [...comments.values()].filter((d) => d.round === r.id && d.comment.trim()).length;
                            return n > 0 && <span className="meta" aria-label={`${n} comments`}><MessageSquare size={12} aria-hidden="true" />{n}</span>;
                          })()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
    </nav>
  );
}

function stored(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const on = () => setMatch(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, [query]);
  return match;
}

// A side panel's width and collapsed state, remembered per browser. side is
// the edge it sits on, which decides which way dragging the divider grows it.
// share caps how far it can be dragged, as a fraction of the window.
function usePanel(key, side, initial, min, share) {
  const [panel, setPanel] = useState(() => ({ width: initial, open: true, ...stored(key, {}) }));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(panel));
    } catch {
      // Private windows may refuse storage; the layout just resets next time.
    }
  }, [key, panel]);
  const clamp = (w) => Math.round(Math.min(Math.max(w, min), window.innerWidth * share));
  const setWidth = (w) => setPanel((p) => ({ ...p, width: clamp(w) }));

  const handle = {
    onPointerDown(e) {
      e.preventDefault();
      const move = (ev) => setWidth(side === "left" ? ev.clientX : window.innerWidth - ev.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
      };
      document.body.classList.add("resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    onKeyDown(e) {
      const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
      const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
      if (e.key === grow) setWidth(panel.width + 20);
      if (e.key === shrink) setWidth(panel.width - 20);
    },
  };
  return { ...panel, handle, toggle: () => setPanel((p) => ({ ...p, open: !p.open })) };
}

export default function App() {
  const { design, messages, rounds, decisions, annotations, agent, ended, connected, authError } = useSession();
  // null follows the newest round; an id pins the one the user picked.
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [sending, setSending] = useState(false);
  const nav = usePanel("mockup.nav", "left", 250, 180, 0.3);
  // v2: the default grew to 570px; the new key drops widths saved before.
  const chat = usePanel("mockup.chat.v2", "right", 570, 300, 0.45);
  // Narrow windows show the round full width; stages and chat open as drawers.
  const narrow = useMedia("(max-width: 900px)");
  const [drawer, setDrawer] = useState(null);
  const toggleDrawer = (name) => setDrawer((d) => (d === name ? null : name));
  const navOpen = narrow ? drawer === "nav" : nav.open;
  const chatOpen = narrow ? drawer === "chat" : chat.open;
  const [flags, toggleFlag] = useFlags();
  const [jump, setJump] = useState(null);

  if (authError) {
    return <main className="auth">This page needs the link the agent printed (it carries a one-time token). Ask the agent for it again.</main>;
  }

  const shown = rounds.find((r) => r.id === selected) ?? rounds.at(-1) ?? null;
  const pending = messages.some((m) => m.from === "user" && m.status === "queued");
  const unsentMarks = unsentMarksOf(annotations);
  const unsent = unsentOf(decisions).length + unsentMarks.length;
  const hasAttachments = draft.selections.length > 0 || draft.uploads.length > 0;
  const canSend = !sending && Boolean(draft.text.trim() || hasAttachments || unsent);
  const { unanswered, flagged } = reviewItems(shown, decisions, flags);

  async function send(kind) {
    setSending(true);
    try {
      // Saves still in flight go first, so nothing is overtaken; the marks to
      // draw come from the server after that, not from this render.
      await api.settled();
      const saved = unsentMarksOf((await api.state()).annotations);
      // The agent gets a copy of each marked image with the marks drawn on.
      const renders = {};
      for (const a of saved) {
        const path = a.marks.length ? (await api.upload(await renderMarks(a.image, a.marks), "render")).path : null;
        renders[`${a.round}|${a.image}`] = { id: a.id, path };
      }
      const attachments = hasAttachments
        ? { selections: draft.selections.map(({ round, item }) => ({ round, item })), uploads: draft.uploads }
        : undefined;
      await api.send({ kind: kind ?? (draft.text.trim() ? "chat" : "feedback"), text: draft.text, round: shown?.id ?? null, attachments, renders });
      setDraft(EMPTY_DRAFT);
    } finally {
      setSending(false);
    }
  }

  async function exit() {
    if (!window.confirm("End this design session? Anything not sent yet goes to the agent, then it wraps up and stops the server.")) return;
    await send("exit");
  }

  return (
    <div
      className={narrow ? `shell narrow ${drawer ? `drawer-${drawer}` : ""}` : `shell ${nav.open ? "" : "nav-closed"} ${chat.open ? "" : "chat-closed"}`}
      style={{ "--nav-width": `${nav.width}px`, "--chat-width": `${chat.width}px` }}
    >
      <header className="top">
        <button type="button" className="panel-toggle" onClick={narrow ? () => toggleDrawer("nav") : nav.toggle} aria-pressed={navOpen} aria-label={navOpen ? "Hide stages panel" : "Show stages panel"} title={navOpen ? "Hide stages" : "Show stages"}>
          {navOpen ? <PanelLeftClose size={18} aria-hidden="true" /> : <PanelLeftOpen size={18} aria-hidden="true" />}
        </button>
        <span className="brand">mockup</span>
        {design && <span className="design">{design}</span>}
        <span className={`dot ${connected && agent?.listening ? "on" : ""}`} aria-hidden="true" />
        <span className="presence">{ended ? "Session ended" : connected === false ? "Disconnected" : agent?.listening ? "Agent listening" : "Agent not listening"}</span>
        <button type="button" className="panel-toggle" onClick={narrow ? () => toggleDrawer("chat") : chat.toggle} aria-pressed={chatOpen} aria-label={chatOpen ? "Hide chat panel" : "Show chat panel"} title={chatOpen ? "Hide chat" : "Show chat"}>
          {chatOpen ? <PanelRightClose size={18} aria-hidden="true" /> : <PanelRightOpen size={18} aria-hidden="true" />}
        </button>
      </header>
      <Banner agent={agent} connected={connected} pending={pending} ended={ended} />
      <StageRail rounds={rounds} decisions={decisions} messages={messages} shown={shown} onSelect={(id) => {
        setSelected(id === rounds.at(-1)?.id ? null : id);
        setDrawer(null);
      }} />
      {narrow && drawer && <div className="scrim" aria-hidden="true" onClick={() => setDrawer(null)} />}
      <div className="resizer nav-resizer" role="separator" aria-orientation="vertical" aria-label="Resize stages panel" aria-valuenow={nav.width} tabIndex={0} {...nav.handle} />
      <RoundView
        round={shown}
        messages={messages}
        decisions={decisions}
        annotations={annotations}
        onMark={(a) => api.annotate(a).catch((err) => window.alert(err.message))}
        draft={draft}
        setDraft={setDraft}
        onDecide={(d) => api.decide(d).catch((err) => window.alert(err.message))}
        ended={ended}
        sending={sending}
        flags={flags}
        toggleFlag={toggleFlag}
        jump={jump}
      />
      <div className="resizer chat-resizer" role="separator" aria-orientation="vertical" aria-label="Resize chat" aria-valuenow={chat.width} tabIndex={0} {...chat.handle} />
      <Chat
        messages={messages}
        round={shown}
        ended={ended}
        draft={draft}
        setDraft={setDraft}
        canSend={canSend}
        onSend={() => send()}
        onExit={exit}
        unsent={unsent}
        review={{ unanswered: unanswered.length, flagged: flagged.length, onJump: (kind) => {
          setJump({ kind });
          setDrawer(null);
        } }}
        onUpload={async (file) => {
          const { path } = await api.upload(file);
          setDraft((d) => ({ ...d, uploads: [...d.uploads, path] }));
        }}
      />
    </div>
  );
}
