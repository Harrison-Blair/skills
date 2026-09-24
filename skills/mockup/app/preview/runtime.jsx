// Runs inside the sandboxed preview frame, bundled with the agent's page. It
// renders the page, follows the theme the user picks, reports its height, and
// takes a picture of exactly what is on screen when the user annotates.
import { createRoot } from "react-dom/client";
import { toPng } from "html-to-image";

const tell = (msg) => parent.postMessage({ mockup: true, ...msg }, "*");

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

async function capture() {
  const html = document.documentElement;
  const background = [getComputedStyle(document.body).backgroundColor, getComputedStyle(html).backgroundColor]
    .find((c) => c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") ?? (html.dataset.theme === "dark" ? "#000" : "#fff");
  // The visible part of the page only, at its current scroll position.
  return toPng(document.body, {
    width: innerWidth,
    height: innerHeight,
    backgroundColor: background,
    pixelRatio: Math.min(2, devicePixelRatio || 1),
    style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
  });
}

export function start(Page) {
  setTheme("light");
  addEventListener("message", async (e) => {
    if (e.source !== parent || !e.data?.mockup) return;
    if (e.data.type === "theme") setTheme(e.data.theme);
    if (e.data.type === "capture") {
      try {
        tell({ type: "captured", id: e.data.id, png: await capture() });
      } catch (err) {
        tell({ type: "capture-failed", id: e.data.id, error: String(err?.message ?? err) });
      }
    }
  });
  new ResizeObserver(() => tell({ type: "size", height: document.documentElement.scrollHeight })).observe(document.body);
  createRoot(document.getElementById("root")).render(<Page />);
}
