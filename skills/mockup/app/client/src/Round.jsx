import { useEffect, useRef, useState } from "react";
import { Md, Attachments, STATUS_LABEL, plain } from "./common.jsx";
import { fileUrl } from "./session.js";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, Flag, CircleDashed, CircleDot, Clock, Loader2, MessageSquare, MessageSquareText, PencilLine, ThumbsDown, ThumbsUp } from "lucide-react";
import { SavedMarks } from "./Annotate.jsx";
import { LivePreview } from "./Preview.jsx";

export const STAGES = [
  { id: "context", label: "Context" },
  { id: "mood", label: "Mood board" },
  { id: "language", label: "Design language" },
  { id: "components", label: "Components" },
  { id: "states", label: "States & interactions" },
  { id: "prototype", label: "Prototype" },
  { id: "handoff", label: "Handoff" },
];
export const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label ?? id;
export const pagesOf = (round) => round.pages ?? [{ title: round.title, blocks: round.body ? [{ type: "markdown", text: round.body }] : [] }];

// Reactions and comments are both "decisions"; the latest of each kind per
// item counts. These index them by "round/item".
const isComment = (d) => "comment" in d;
export const latestOf = (decisions, comments = false) =>
  new Map(decisions.filter((d) => isComment(d) === comments).map((d) => [`${d.round}/${d.item}`, d]));
// The latest marks per "round|image", and those not sent yet.
export const marksOf = (annotations) => new Map(annotations.map((a) => [`${a.round}|${a.image}`, a]));
export const unsentMarksOf = (annotations) => [...marksOf(annotations).values()].filter((a) => !a.sent);
export const unsentOf = (decisions) => [...latestOf(decisions).values(), ...latestOf(decisions, true).values()].filter((d) => !d.sent);

// An optional note on one item, saved when the box loses focus.
function CommentBox({ round, itemId, comment, onDecide, disabled }) {
  const [open, setOpen] = useState(Boolean(comment?.comment));
  const [text, setText] = useState(comment?.comment ?? "");
  useEffect(() => setText(comment?.comment ?? ""), [comment?.id]);
  const has = Boolean(comment?.comment?.trim());
  const save = () => {
    if (text !== (comment?.comment ?? "")) onDecide({ round: round.id, item: itemId, comment: text });
  };
  const Icon = has ? MessageSquareText : MessageSquare;
  return (
    <>
      <button type="button" className={`comment-toggle ${has ? "on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)} disabled={disabled}>
        <Icon size={16} aria-hidden="true" fill={has ? "currentColor" : "none"} fillOpacity={0.15} />
        {has ? "Comment" : "Add comment"}
      </button>
      {open && (
        <div className="comment-box">
          <textarea
            aria-label="Comment"
            placeholder="What do you think about this?"
            rows={2}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
            }}
          />
          {comment && !comment.sent && <span className="unsent">not sent yet</span>}
        </div>
      )}
    </>
  );
}

const VERDICT_LABEL = { like: "Liked", dislike: "Not for me", approve: "Draft approved", changes: "Changes requested" };

const choiceLabel = (c) => (typeof c === "string" ? c : c.label);

// A question's choices: radio buttons, or checkboxes when several answers are
// allowed. Plain choices are full-width rows; choices with text or images are
// cards, `columns` to a row, for comparing. With `other`, the user can write
// their own answer, which is sent as that text.
function Choices({ round, item, decision, onDecide, disabled }) {
  const name = `${round.id}-${item.id}`;
  const labels = item.choices.map(choiceLabel);
  // Local first, so a click shows at once and quick clicks build on each
  // other rather than on a server echo that has not arrived yet.
  const saved = item.multiple ? decision?.value ?? [] : decision ? [decision.value] : [];
  const [picked, setPicked] = useState(saved);
  const savedOther = saved.find((v) => !labels.includes(v));
  const [otherOn, setOtherOn] = useState(savedOther !== undefined);
  const [otherText, setOtherText] = useState(savedOther ?? "");
  useEffect(() => {
    setPicked(saved);
    setOtherOn(savedOther !== undefined);
    setOtherText(savedOther ?? "");
  }, [decision?.id]);
  const choose = (next) => {
    setPicked(next);
    onDecide({ round: round.id, item: item.id, value: item.multiple ? next : next[0] });
  };
  const chosen = picked.filter((p) => labels.includes(p));
  const written = otherText.trim();
  const toggle = (c, on) => {
    if (!item.multiple) {
      setOtherOn(false);
      return choose([c]);
    }
    const next = labels.filter((x) => (x === c ? !on : chosen.includes(x)));
    choose(otherOn && written ? [...next, written] : next);
  };
  const toggleOther = () => {
    const on = !otherOn;
    setOtherOn(on);
    if (item.multiple) {
      if (written) choose(on ? [...chosen, written] : chosen);
    } else if (on) {
      if (written) choose([written]);
      else setPicked([]);
    }
  };
  // The write-in is saved when its box loses focus, like a comment.
  const saveOther = () => {
    if (!otherOn || picked.includes(written)) return;
    if (!written) return item.multiple && chosen.length !== picked.length && choose(chosen);
    choose(item.multiple ? [...chosen, written] : [written]);
  };
  const type = item.multiple ? "checkbox" : "radio";
  const rich = item.choices.some((c) => typeof c !== "string");
  return (
    <fieldset className="choices" disabled={disabled}>
      <legend className="visually-hidden">{plain(item.text)}</legend>
      <div className={rich ? "choice-grid" : "choice-rows"} style={rich ? { "--cols": item.columns ?? 1 } : undefined}>
        {item.choices.map((c) => {
          const label = choiceLabel(c);
          const on = chosen.includes(label);
          return (
            <label key={label} className={`choice ${rich ? "rich" : ""} ${on ? "on" : ""}`}>
              {c.images?.length > 0 && <span className="choice-images">{c.images.map((src) => <img key={src} src={fileUrl(src)} alt="" />)}</span>}
              <span className="choice-head">
                <input type={type} name={name} checked={on} onChange={() => toggle(label, on)} />
                <span>{label}</span>
              </span>
              {c.text && <Md media={c.media}>{c.text}</Md>}
            </label>
          );
        })}
      </div>
      {item.other && (
        <div className={`choice other ${otherOn ? "on" : ""}`}>
          <label className="choice-head">
            <input type={type} name={name} checked={otherOn} onChange={toggleOther} />
            <span>Other…</span>
          </label>
          {otherOn && (
            <input
              type="text"
              className="other-text"
              aria-label="Your own answer"
              placeholder="Type your answer"
              maxLength={500}
              value={otherText}
              autoFocus={!savedOther}
              onChange={(e) => setOtherText(e.target.value)}
              onBlur={saveOther}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          )}
        </div>
      )}
      {decision && !decision.sent && <span className="unsent">not sent yet</span>}
      {item.multiple && <span className="hint">Pick any that apply.</span>}
    </fieldset>
  );
}

// Like / dislike. Unsent decisions are marked.
function Reactions({ round, item, decision, onDecide, disabled }) {
  return (
    <div className="reactions" role="group" aria-label={`Your reaction to ${item.title ?? item.text ?? item.id}`}>
      {["like", "dislike"].map((v) => {
        const on = decision?.value === v;
        // Icons are outlined until chosen, then filled.
        const fill = on ? "currentColor" : "none";
        return (
          <button
            key={v}
            type="button"
            className={`react ${v} ${on ? "on" : ""}`}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onDecide({ round: round.id, item: item.id, value: v })}
          >
            {v === "like" ? <><ThumbsUp size={16} fill={fill} aria-hidden="true" />Like</> : <><ThumbsDown size={16} fill={fill} aria-hidden="true" />Not for me</>}
          </button>
        );
      })}
      {decision && !decision.sent && <span className="unsent" title="Saved; goes to the agent with your next message">not sent yet</span>}
    </div>
  );
}

function SelectToggle({ selected, onToggle, disabled }) {
  return (
    <button type="button" className={`select ${selected ? "on" : ""}`} aria-pressed={selected} onClick={onToggle} disabled={disabled}>
      {selected ? <CheckCircle2 size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
      {selected ? "Selected" : "Select"}
    </button>
  );
}

// A private bookmark: flagged items are one click away from the feedback bar.
function FlagToggle({ flagged, onToggle }) {
  return (
    <button type="button" className={`flag ${flagged ? "on" : ""}`} aria-pressed={flagged} onClick={onToggle} title={flagged ? "Remove flag" : "Flag this to come back to it"}>
      <Flag size={16} fill={flagged ? "currentColor" : "none"} aria-hidden="true" />
      {flagged ? "Flagged" : "Flag"}
    </button>
  );
}

function Block({ block, ctx }) {
  const { round, decisions, comments, marks, onMark, draft, setDraft, onDecide, ended, sending, flags, toggleFlag, focused } = ctx;
  const selected = block.id && draft.selections.some((s) => s.round === round.id && s.item === block.id);
  const toggle = () =>
    setDraft((d) => ({
      ...d,
      selections: selected
        ? d.selections.filter((s) => !(s.round === round.id && s.item === block.id))
        : [...d.selections, { round: round.id, item: block.id, label: plain(block.title ?? block.text ?? block.caption ?? block.id) }],
    }));
  const decision = block.id && decisions.get(`${round.id}/${block.id}`);
  const commentBox = block.id && (
    <>
      <FlagToggle flagged={flags.has(`${round.id}/${block.id}`)} onToggle={() => toggleFlag(`${round.id}/${block.id}`)} />
      <CommentBox round={round} itemId={block.id} comment={comments.get(`${round.id}/${block.id}`)} onDecide={onDecide} disabled={ended} />
    </>
  );
  // Where "Go to unanswered" and "Next flagged" land.
  const anchor = block.id ? { id: `item-${block.id}`, "data-focused": focused === block.id || undefined } : {};
  const image = (src, alt) => (
    <SavedMarks
      key={src}
      src={src}
      alt={alt}
      // Marks pause while a message is on its way, so what is sent matches
      // the picture drawn for it.
      disabled={ended || sending}
      record={marks.get(`${round.id}|${src}`)}
      onSave={(next) => onMark({ round: round.id, image: src, marks: next })}
    />
  );

  switch (block.type) {
    case "markdown":
      return <Md media={block.media}>{block.text}</Md>;
    case "image":
      return (
        <div {...anchor} className={`card image-block ${selected ? "selected" : ""}`}>
          {image(block.src, block.caption ?? "")}
          {block.caption && <p className="caption">{block.caption}</p>}
          {block.id && (
            <div className="card-actions">
              <Reactions round={round} item={block} decision={decision} onDecide={onDecide} disabled={ended} />
              <span className="card-tools">
                {commentBox}
                <SelectToggle selected={selected} onToggle={toggle} disabled={ended} />
              </span>
            </div>
          )}
        </div>
      );
    case "option":
      return (
        <article {...anchor} className={`card option ${selected ? "selected" : ""} ${decision?.value ?? ""}`}>
          <h3>{block.title}</h3>
          {block.images.length > 0 && <div className="option-images">{block.images.map((src) => image(src, block.title))}</div>}
          {block.text && <Md media={block.media}>{block.text}</Md>}
          <div className="card-actions">
            <Reactions round={round} item={block} decision={decision} onDecide={onDecide} disabled={ended} />
            <span className="card-tools">
              {commentBox}
              <SelectToggle selected={selected} onToggle={toggle} disabled={ended} />
            </span>
          </div>
        </article>
      );
    case "question":
      return (
        <article {...anchor} className={`card question ${selected ? "selected" : ""}`}>
          <Md media={block.media}>{block.text}</Md>
          {block.choices && <Choices round={round} item={block} decision={decision} onDecide={onDecide} disabled={ended} />}
          <div className="card-actions">
            {block.choices ? <span /> : <Reactions round={round} item={block} decision={decision} onDecide={onDecide} disabled={ended} />}
            <span className="card-tools">
              {commentBox}
              <SelectToggle selected={selected} onToggle={toggle} disabled={ended} />
            </span>
          </div>
        </article>
      );
    case "preview":
      return (
        <article {...anchor} className={`card preview ${selected ? "selected" : ""} ${decision?.value ?? ""}`}>
          <h3>{block.title}</h3>
          {block.text && <Md media={block.media}>{block.text}</Md>}
          <LivePreview
            block={block}
            round={round}
            marks={marks}
            onMark={onMark}
            disabled={ended}
            marking={!ended && !sending}
            reactions={<Reactions round={round} item={block} decision={decision} onDecide={onDecide} disabled={ended} />}
            tools={<>{commentBox}<SelectToggle selected={selected} onToggle={toggle} disabled={ended} /></>}
          />
        </article>
      );
    default:
      return null;
  }
}

// Every item of a round in page order, and which of them still need an
// answer or carry the user's flag.
export function reviewItems(round, decisions, flags) {
  if (!round) return { items: [], unanswered: [], flagged: [] };
  const latest = latestOf(decisions);
  const items = pagesOf(round).flatMap((p, i) => p.blocks.filter((b) => b.id).map((b) => ({ id: b.id, page: i })));
  return {
    items,
    unanswered: items.filter((it) => !latest.has(`${round.id}/${it.id}`)),
    flagged: items.filter((it) => flags.has(`${round.id}/${it.id}`)),
  };
}

// Flags live in this browser only; they are for the user, not the agent.
export function useFlags() {
  const [flags, setFlags] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("mockup.flags")) ?? []);
    } catch {
      return new Set();
    }
  });
  const toggle = (key) =>
    setFlags((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem("mockup.flags", JSON.stringify([...next]));
      } catch {
        // Private windows may refuse storage; flags then last until reload.
      }
      return next;
    });
  return [flags, toggle];
}

// Where a round stands, from the user's reactions and the messages about it.
export function roundStatus(round, decisions, messages) {
  const latest = new Map();
  for (const d of decisions) if (d.round === round.id && !isComment(d)) latest.set(d.item, d);
  if (round.kind === "draft") {
    const v = latest.get("draft")?.value;
    if (v === "approve") return { key: "approved", label: "Approved" };
    if (v === "changes") return { key: "changes", label: "Changes requested" };
    return { key: "awaiting", label: "Awaiting approval" };
  }
  const items = pagesOf(round).flatMap((p) => p.blocks).filter((b) => b.id);
  const reacted = items.filter((b) => latest.has(b.id)).length;
  const sent = messages.filter((m) => m.from === "user" && (m.round === round.id || m.decisions?.some((d) => d.round === round.id)));
  const unsent = unsentOf(decisions).some((d) => d.round === round.id);
  if (unsent) return { key: "progress", label: `In progress · ${reacted}/${items.length}` };
  if (!sent.length) return reacted ? { key: "progress", label: `In progress · ${reacted}/${items.length}` } : { key: "new", label: "New" };
  if (sent.some((m) => m.status === "queued" || m.status === "delivered")) return { key: "working", label: "Agent working" };
  return { key: "reviewed", label: "Reviewed" };
}

const STATUS_ICON = { new: CircleDashed, progress: CircleDot, working: Loader2, reviewed: CheckCircle2, awaiting: Clock, changes: PencilLine, approved: CheckCircle2 };

export function StatusPill({ status, size = 12 }) {
  const Icon = STATUS_ICON[status.key];
  return (
    <span className={`status-pill ${status.key}`}>
      <Icon size={size} aria-hidden="true" className={status.key === "working" ? "spin" : ""} />
      {status.label}
    </span>
  );
}

function History({ round, messages }) {
  const notes = messages.filter((m) => m.from === "user" && (m.round === round.id || m.decisions?.some((d) => d.round === round.id)));
  if (!notes.length) return <p className="placeholder">Nothing sent about this round yet.</p>;
  return (
    <ol className="history">
      {notes.map((m) => (
        <li key={m.id}>
          {m.text?.trim() && <Md>{m.text}</Md>}
          {(m.decisions ?? []).filter((d) => d.round === round.id).map((d) => (
            <span key={d.id} className={`chip text-chip verdict ${VERDICT_LABEL[d.value] ? d.value : ""}`}>
              {isComment(d) ? `Comment on ${labelOf(round, d.item)}: ${d.comment || "(removed)"}` : Array.isArray(d.value) ? `${labelOf(round, d.item)} → ${d.value.join(", ") || "no answer"}` : VERDICT_LABEL[d.value] ? `${VERDICT_LABEL[d.value]}: ${labelOf(round, d.item)}` : `${labelOf(round, d.item)} → ${d.value}`}
            </span>
          ))}
          <Attachments attachments={m.attachments} marked={m.annotations} />
          <span className="meta">{new Date(m.createdAt).toLocaleString()} · {STATUS_LABEL[m.status]}</span>
        </li>
      ))}
    </ol>
  );
}

export function labelOf(round, itemId) {
  if (itemId === "draft") return "the draft";
  for (const p of pagesOf(round)) for (const b of p.blocks) if (b.id === itemId) return plain(b.title ?? b.text ?? b.caption ?? itemId);
  return itemId;
}

// jump is a request from the chat's review line ({ kind: "unanswered" |
// "flagged" }), a new object each click.
export function RoundView({ round, messages, decisions, annotations, onMark, draft, setDraft, onDecide, ended, sending, flags, toggleFlag, jump }) {
  const [page, setPage] = useState(0);
  const [focused, setFocused] = useState(null);
  // Questions all at once or one at a time: the page's own setting until the
  // user switches, per "round/page". step is the question showing.
  const [modes, setModes] = useState({});
  const [step, setStep] = useState(0);
  useEffect(() => {
    setPage(0);
    setFocused(null);
  }, [round?.id]);
  useEffect(() => setStep(0), [round?.id, page]);
  // Go to the next matching item after the one last jumped to, or after the
  // top of the page the user turned to. Runs once per click.
  const handled = useRef(null);
  useEffect(() => {
    if (!round || !jump || handled.current === jump) return;
    handled.current = jump;
    const { items, unanswered, flagged } = reviewItems(round, decisions, flags);
    const list = jump.kind === "flagged" ? flagged : unanswered;
    if (!list.length) return;
    const at = focused ? items.findIndex((it) => it.id === focused) : items.findIndex((it) => it.page === page) - 1;
    const next = list.find((it) => items.indexOf(it) > at) ?? list[0];
    setPage(next.page);
    setFocused(next.id);
  });
  // A jump to a question shows that question when they come one at a time.
  const questions = round ? pagesOf(round)[Math.min(page, pagesOf(round).length - 1)].blocks.filter((b) => b.type === "question") : [];
  useEffect(() => {
    const i = questions.findIndex((q) => q.id === focused);
    if (i >= 0) setStep(i);
  }, [focused, page]);
  // Scroll to the item jumped to, once its page (and question) is showing.
  useEffect(() => {
    if (focused) document.getElementById(`item-${focused}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused, page, step]);

  if (!round) {
    return (
      <main className="canvas">
        <h1>Nothing published yet</h1>
        <p className="placeholder">The agent posts review rounds here: quick "do you like this?" checks, then drafts for you to approve. Every round stays in the list on the left.</p>
      </main>
    );
  }

  const pages = pagesOf(round);
  const current = pages[Math.min(page, pages.length - 1)];
  const latest = latestOf(decisions);
  const comments = latestOf(decisions, true);
  const draftDecision = latest.get(`${round.id}/draft`);
  const ctx = { round, decisions: latest, comments, marks: marksOf(annotations), onMark, draft, setDraft, onDecide, ended, sending, flags, toggleFlag, focused };
  const modeKey = `${round.id}/${page}`;
  const oneByOne = questions.length > 1 && (modes[modeKey] ?? current.questions ?? "all") === "one";
  const at = Math.min(step, questions.length - 1);
  const shown = (b) => !oneByOne || b.type !== "question" || b === questions[at];
  // Paging by hand starts the next jump from the top of that page.
  const turn = (i) => {
    setPage(i);
    setFocused(null);
  };

  return (
    <main className="canvas">
      <p className="eyebrow">
        {stageLabel(round.stage)} · Round {round.n} · <span className={`kind ${round.kind ?? "explore"}`}>{round.kind === "draft" ? "Draft" : "Explore"}</span>
        <StatusPill status={roundStatus(round, decisions, messages)} />
      </p>
      <h1>{round.title}</h1>

      {round.kind === "draft" && (
        <div className={`draft-bar ${draftDecision?.value ?? ""}`}>
          <p>{draftDecision ? `${VERDICT_LABEL[draftDecision.value]}${draftDecision.sent ? "" : " (not sent yet)"}` : "This draft brings the stage together. Approve it to move on."}</p>
          <button type="button" className="approve" disabled={ended} aria-pressed={draftDecision?.value === "approve"} onClick={() => onDecide({ round: round.id, item: "draft", value: "approve" })}><Check size={16} aria-hidden="true" />Approve draft</button>
          <button type="button" className="changes" disabled={ended} aria-pressed={draftDecision?.value === "changes"} onClick={() => onDecide({ round: round.id, item: "draft", value: "changes" })}><PencilLine size={16} aria-hidden="true" />Request changes</button>
          <div className="draft-comment">
            <CommentBox round={round} itemId="draft" comment={comments.get(`${round.id}/draft`)} onDecide={onDecide} disabled={ended} />
          </div>
        </div>
      )}

      {pages.length > 1 && (
        <nav className="pager" aria-label="Pages in this round">
          <button type="button" onClick={() => turn(page - 1)} disabled={page === 0} aria-label="Previous page"><ChevronLeft size={16} aria-hidden="true" />Prev</button>
          <ol>
            {pages.map((p, i) => (
              <li key={i}>
                <button type="button" aria-current={i === page ? "page" : undefined} className={i === page ? "on" : ""} onClick={() => turn(i)}>{p.title}</button>
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => turn(page + 1)} disabled={page === pages.length - 1} aria-label="Next page">Next<ChevronRight size={16} aria-hidden="true" /></button>
        </nav>
      )}

      <section className="page" aria-label={current.title}>
        {pages.length > 1 && <h2 className="page-title">{current.title}</h2>}
        {questions.length > 1 && (
          <div className="question-bar">
            <div className="segmented" role="group" aria-label="Show questions">
              {[["all", "All"], ["one", "One at a time"]].map(([m, label]) => (
                <button key={m} type="button" aria-pressed={(m === "one") === oneByOne} onClick={() => setModes({ ...modes, [modeKey]: m })}>{label}</button>
              ))}
            </div>
            {oneByOne && (
              <div className="stepper">
                <span>Question {at + 1} of {questions.length}</span>
                <button type="button" onClick={() => setStep(at - 1)} disabled={at === 0} aria-label="Previous question"><ChevronLeft size={16} aria-hidden="true" />Back</button>
                <button type="button" onClick={() => setStep(at + 1)} disabled={at === questions.length - 1} aria-label="Next question">Next<ChevronRight size={16} aria-hidden="true" /></button>
              </div>
            )}
          </div>
        )}
        {/* Keyed by round too: a revision reusing an id starts fresh. */}
        {current.blocks.map((b, i) => shown(b) && <Block key={`${round.id}/${b.id ?? i}`} block={b} ctx={ctx} />)}
      </section>

      <section className="notes" aria-label="History for this round">
        <h2>History</h2>
        <History round={round} messages={messages} />
      </section>
    </main>
  );
}
