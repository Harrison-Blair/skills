import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileUrl } from "./session.js";

// Labels come from Markdown fields; chips show them as plain text.
export const plain = (md) => String(md ?? "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~#>]/g, "").replace(/\s+/g, " ").trim();

export const STATUS_LABEL = { queued: "Queued", delivered: "Agent working", done: "Done", failed: "Failed" };

// Round images are referenced as design-relative paths (assets/...); anything
// else in Markdown stays as written, and the page's CSP blocks remote images.
const toSrc = (src) => (/^(assets|renders)\//.test(src ?? "") ? fileUrl(src) : src);

// media maps a round's local image paths to their published copies.
const decoded = (src) => {
  try {
    return decodeURI(src ?? "");
  } catch {
    return src;
  }
};

export function Md({ children, media }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          img: ({ node, src, ...props }) => {
            // Media keys are the renderer's own (percent-encoded) form; a
            // path without a published copy is decoded back to the file name.
            return <img {...props} src={toSrc(media?.[src] ?? decoded(src))} />;
          },
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

// What a sent message carried: uploads and marked-up images as thumbnails,
// selections as chips. marked is the message's saved marks.
export function Attachments({ attachments, marked = [] }) {
  if (!attachments && !marked.length) return null;
  const { selections = [], uploads = [], annotations = [] } = attachments ?? {};
  return (
    <div className="attachments">
      {selections.map((s) => <span key={`${s.round}/${s.item}`} className="chip text-chip">{`Selected: ${plain(s.label ?? s.item)}`}</span>)}
      {[...uploads, ...[...annotations, ...marked.filter((a) => a.marks.length)].map((a) => a.render ?? a.image)].map((p) => (
        <a key={p} href={fileUrl(p)} target="_blank" rel="noopener noreferrer" className="thumb">
          <img src={fileUrl(p)} alt="attached image" />
        </a>
      ))}
    </div>
  );
}
