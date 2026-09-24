import { useEffect, useRef, useState } from "react";
import { fileUrl } from "./session.js";
import { Circle, MapPin, Trash2, X } from "lucide-react";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function MarkTools({ tool, onTool, disabled = false }) {
  return (
    <>
      <button type="button" className="mark-tool" disabled={disabled} aria-pressed={tool === "pin"} onClick={() => onTool(tool === "pin" ? null : "pin")}><MapPin size={14} fill={tool === "pin" ? "currentColor" : "none"} aria-hidden="true" />Pin</button>
      <button type="button" className="mark-tool" disabled={disabled} aria-pressed={tool === "circle"} onClick={() => onTool(tool === "circle" ? null : "circle")}><Circle size={14} strokeWidth={tool === "circle" ? 3 : 2} aria-hidden="true" />Circle</button>
    </>
  );
}

// An image the user can drop numbered pins on or circle parts of. Marks are
// fractions of the image size, so they survive any display size. Each mark
// opens a small box for a note. Pass tool and onTool to put the tools
// elsewhere; otherwise they sit under the image.
export function MarkableImage({ src, alt, marks, onAdd, onRemove, onNote, tool: shared, onTool, disabled = false, className = "" }) {
  const [own, setOwn] = useState(null);
  const tool = onTool ? shared : own;
  const setTool = onTool ?? setOwn;
  const [drawing, setDrawing] = useState(null);
  // The mark whose note box is open; a new mark opens its own.
  const [open, setOpen] = useState(null);
  const box = useRef(null);

  function point(e) {
    const r = box.current.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height), w: r.width, h: r.height };
  }

  function down(e) {
    if (!tool || disabled) return;
    e.preventDefault();
    const p = point(e);
    if (tool === "pin") {
      onAdd({ shape: "pin", x: p.x, y: p.y });
      setOpen(marks.length);
      return;
    }
    box.current.setPointerCapture(e.pointerId);
    setDrawing({ shape: "circle", x: p.x, y: p.y, r: 0 });
  }

  function move(e) {
    if (!drawing) return;
    const p = point(e);
    // r is a fraction of the width; dy is converted so the circle stays round.
    const dx = p.x - drawing.x;
    const dy = ((p.y - drawing.y) * p.h) / p.w;
    setDrawing({ ...drawing, r: Math.min(1, Math.hypot(dx, dy)) });
  }

  function up() {
    if (drawing && drawing.r > 0.01) {
      onAdd(drawing);
      setOpen(marks.length);
    }
    setDrawing(null);
  }

  const shown = drawing ? [...marks, drawing] : marks;
  return (
    <figure className={`markable ${className}`}>
      <div
        ref={box}
        className={`mark-surface ${tool ? `tool-${tool}` : ""}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
      >
        <img src={fileUrl(src)} alt={alt} draggable={false} />
        {shown.map((m, i) => {
          // The numbered badge opens the mark's note box. The drawing in
          // progress has no badge to click yet.
          const badge = m === drawing ? (
            <span className="mark-badge">{i + 1}</span>
          ) : (
            <button
              type="button"
              className="mark-badge"
              aria-label={`Mark ${i + 1}`}
              aria-expanded={open === i}
              title={m.note ? m.note : "Add a note or remove this mark"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setOpen(open === i ? null : i)}
            >
              {i + 1}
            </button>
          );
          return m.shape === "pin" ? (
            <span key={i} className="pin" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}>{badge}</span>
          ) : (
            <span key={i} className="ring" style={{ left: `${(m.x - m.r) * 100}%`, top: `${m.y * 100}%`, width: `${m.r * 200}%` }}>
              {badge}
            </span>
          );
        })}
        {open !== null && marks[open] && (
          <MarkNote
            key={open}
            mark={marks[open]}
            n={open + 1}
            disabled={disabled}
            onNote={(note) => onNote(open, note)}
            onRemove={() => {
              onRemove(open);
              setOpen(null);
            }}
            onClose={() => setOpen(null)}
          />
        )}
      </div>
      {!onTool && (
        <div className="mark-tools" role="toolbar" aria-label="Mark up this image">
          <MarkTools tool={tool} onTool={setTool} disabled={disabled} />
        </div>
      )}
    </figure>
  );
}

// A MarkableImage whose marks are saved on the round. Changes show at once
// and are saved in order. The saved record replaces them only when no save of
// ours is still in flight: an older echo must not undo newer marks.
// A record that arrived meanwhile (another tab's edit) is applied once the
// saves settle.
export function SavedMarks({ record, onSave, ...props }) {
  const [marks, setMarks] = useState(record?.marks ?? []);
  const inFlight = useRef(0);
  const latest = useRef(record);
  latest.current = record;
  useEffect(() => {
    if (inFlight.current === 0) setMarks(record?.marks ?? []);
  }, [record?.id]);
  // Clicks are discrete events, so marks is current for each one.
  const update = (change) => {
    const next = change(marks);
    setMarks(next);
    inFlight.current++;
    Promise.resolve(onSave(next)).then((saved) => {
      if (--inFlight.current > 0) return;
      // The save's own answer may beat its echo; take whichever is newer.
      const other = latest.current;
      const newest = saved && (!other || saved.at >= other.at) ? saved : other;
      setMarks(newest?.marks ?? next);
    });
  };
  return (
    <MarkableImage
      {...props}
      marks={marks}
      onAdd={(mark) => update((prev) => [...prev, mark])}
      onRemove={(i) => update((prev) => prev.filter((_, j) => j !== i))}
      onNote={(i, note) => update((prev) => prev.map((m, j) => (j === i ? { ...m, note } : m)))}
    />
  );
}

// A note box beside a mark. It flips left or up near the image's edges. The
// note is saved when the box closes or loses focus, not on every keystroke.
function MarkNote({ mark, n, onNote, onRemove, onClose, disabled }) {
  const [text, setText] = useState(mark.note ?? "");
  const save = () => {
    if (text !== (mark.note ?? "")) onNote(text);
  };
  const close = () => {
    save();
    onClose();
  };
  const left = mark.x > 0.6;
  const up = mark.y > 0.75;
  return (
    <div
      className="mark-note"
      role="dialog"
      aria-label={`Mark ${n}`}
      style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%`, transform: `translate(${left ? "calc(-100% + 12px)" : "-12px"}, ${up ? "calc(-100% - 18px)" : "18px"})` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="mark-num">{n}</span>
      <input
        aria-label={`Note on mark ${n}`}
        placeholder={mark.shape === "pin" ? "What about this spot?" : "What about this area?"}
        value={text}
        autoFocus
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") close();
        }}
      />
      {!disabled && <button type="button" aria-label={`Remove mark ${n}`} title="Remove this mark" onClick={onRemove}><Trash2 size={14} aria-hidden="true" /></button>}
      <button type="button" aria-label="Close note" title="Close" onClick={close}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}

// Draw the marks onto a copy of the image, so the agent sees what the user saw.
export async function renderMarks(src, marks) {
  const img = new Image();
  img.src = fileUrl(src);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const W = canvas.width;
  const unit = Math.max(W, canvas.height) / 60;
  ctx.lineWidth = unit / 2.5;
  ctx.font = `bold ${unit * 1.1}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  marks.forEach((m, i) => {
    const x = m.x * W;
    const y = m.y * canvas.height;
    ctx.strokeStyle = "#ff2d55";
    if (m.shape === "circle") {
      ctx.beginPath();
      ctx.arc(x, y, m.r * W, 0, Math.PI * 2);
      ctx.stroke();
    }
    const [lx, ly] = m.shape === "circle" ? [x + m.r * W * 0.7, y - m.r * W * 0.7] : [x, y];
    ctx.fillStyle = "#ff2d55";
    ctx.beginPath();
    ctx.arc(lx, ly, unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(String(i + 1), lx, ly);
  });
  return new Promise((ok) => canvas.toBlob(ok, "image/png"));
}
