import { useEffect, useRef, useState } from "react";
import { api, fileUrl } from "./session.js";
import { MarkTools, SavedMarks } from "./Annotate.jsx";
import { Loader2, Maximize2, Monitor, Moon, PenLine, Smartphone, Sun, Tablet } from "lucide-react";

export const DEVICES = {
  fit: { label: "Fit", icon: Maximize2 },
  phone: { label: "Phone", icon: Smartphone, width: 390, height: 844 },
  tablet: { label: "Tablet", icon: Tablet, width: 820, height: 1180 },
  desktop: { label: "Desktop", icon: Monitor, width: 1280, height: 800 },
};

function dataUrlToBlob(url) {
  const [head, body] = url.split(",");
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: head.slice(5).split(";")[0] });
}

// A page the agent built from the design's component files, running in a
// sandboxed frame. The user can click through it, switch device and theme,
// and freeze it to pin or circle what they see. Each marked-up picture stays
// under the preview, to reopen and edit. The card's action row lives here
// too, so Annotate and its tools sit next to Flag and Comment.
export function LivePreview({ block, round, marks, onMark, disabled, marking = !disabled, reactions, tools }) {
  const [device, setDevice] = useState(block.device ?? "fit");
  const [theme, setTheme] = useState("light");
  const [snapshot, setSnapshot] = useState(null);
  const [tool, setTool] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [width, setWidth] = useState(0);
  const [fitHeight, setFitHeight] = useState(400);
  const frame = useRef(null);
  const stage = useRef(null);
  const pending = useRef(new Map());
  // Resolves once the frame has loaded, which is after its script started
  // listening; requests sent earlier would be lost.
  const ready = useRef(null);
  if (!ready.current) {
    let open;
    ready.current = Object.assign(new Promise((ok) => (open = ok)), { open });
  }

  const post = (msg) => frame.current?.contentWindow?.postMessage({ mockup: true, ...msg }, "*");
  useEffect(() => post({ type: "theme", theme }), [theme]);

  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== frame.current?.contentWindow || !e.data?.mockup) return;
      if (e.data.type === "size") setFitHeight(Math.max(120, Math.ceil(e.data.height)));
      const wait = pending.current.get(e.data.id);
      if (wait && e.data.type === "captured") wait.ok(e.data.png);
      if (wait && e.data.type === "capture-failed") wait.fail(new Error(e.data.error));
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);

  function capture() {
    const id = crypto.randomUUID();
    return new Promise((ok, fail) => {
      pending.current.set(id, { ok, fail });
      ready.current.then(() => post({ type: "capture", id }));
      setTimeout(() => fail(new Error("the preview did not answer")), 30000);
    }).finally(() => pending.current.delete(id));
  }

  async function annotate() {
    if (snapshot) return setSnapshot(null);
    setBusy(true);
    setError(null);
    try {
      const { path } = await api.upload(dataUrlToBlob(await capture()), "render");
      setSnapshot(path);
      setTool("pin");
    } catch (err) {
      setError(`Could not take a picture of the preview: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const spec = DEVICES[device];
  // Device frames keep their real size and scale down to fit the canvas.
  const scale = spec.width && width ? Math.min(1, width / spec.width) : 1;
  const box = spec.width ? { width: spec.width * scale, height: spec.height * scale } : { width: "100%", height: fitHeight };
  const saved = [...marks.values()].filter((a) => a.round === round.id && a.item === block.id && a.marks.length);

  return (
    <div className="live-preview">
      <div className="preview-tools" role="toolbar" aria-label={`Preview controls for ${block.title}`}>
        <span className="segmented" role="group" aria-label="Device">
          {Object.entries(DEVICES).map(([id, d]) => (
            <button key={id} type="button" aria-pressed={device === id} title={d.width ? `${d.label} (${d.width}×${d.height})` : "Fit the canvas"} onClick={() => setDevice(id)} disabled={Boolean(snapshot)}>
              <d.icon size={14} aria-hidden="true" />{d.label}
            </button>
          ))}
        </span>
        <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} disabled={Boolean(snapshot)} title="Switch light or dark">
          {theme === "dark" ? <Moon size={14} fill="currentColor" aria-hidden="true" /> : <Sun size={14} aria-hidden="true" />}
          {theme === "dark" ? "Dark" : "Light"}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div ref={stage} className="preview-stage">
        {snapshot && (
          <div style={{ width: box.width }} className="preview-snapshot">
            <SavedMarks
              key={snapshot}
              src={snapshot}
              alt={`Snapshot of ${block.title}`}
              disabled={!marking}
              record={marks.get(`${round.id}|${snapshot}`)}
              onSave={(next) => onMark({ round: round.id, item: block.id, image: snapshot, marks: next })}
              tool={tool}
              onTool={setTool}
            />
          </div>
        )}
        {/* Hidden, not removed, while annotating: the page keeps its state. */}
        <div className="preview-frame" style={{ ...box, display: snapshot ? "none" : undefined }}>
          <iframe
            ref={frame}
            title={block.title}
            src={`/previews/${block.bundle}`}
            sandbox="allow-scripts"
            onLoad={() => {
              ready.current.open();
              post({ type: "theme", theme });
            }}
            style={spec.width ? { width: spec.width, height: spec.height, transform: `scale(${scale})` } : { width: "100%", height: "100%" }}
          />
        </div>
      </div>
      {saved.length > 0 && (
        <div className="snapshots" role="group" aria-label="Your annotations on this preview">
          {saved.map((a, i) => (
            <button
              key={a.image}
              type="button"
              className="snapshot-thumb"
              aria-pressed={snapshot === a.image}
              aria-label={`Open annotation ${i + 1} (${a.marks.length} mark${a.marks.length > 1 ? "s" : ""})`}
              title={a.marks.map((m, j) => `${j + 1}. ${m.note || (m.shape === "pin" ? "pin" : "circle")}`).join("\n")}
              onClick={() => {
                setSnapshot(snapshot === a.image ? null : a.image);
                setTool(null);
              }}
            >
              <img src={fileUrl(a.image)} alt="" />
              <span className="count">{a.marks.length}</span>
              {!a.sent && <span className="unsent-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
      <div className="card-actions">
        {reactions}
        <span className="card-tools">
          <span className={`annotate-tools ${snapshot ? "on" : ""}`}>
            <button type="button" className="annotate" aria-pressed={Boolean(snapshot)} onClick={annotate} disabled={busy || disabled} title={snapshot ? "Back to the live page" : "Freeze the page and mark it up"}>
              {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <PenLine size={16} aria-hidden="true" />}
              {snapshot ? "Done annotating" : "Annotate"}
            </button>
            {snapshot && <MarkTools tool={tool} onTool={setTool} disabled={!marking} />}
          </span>
          {tools}
        </span>
      </div>
    </div>
  );
}
