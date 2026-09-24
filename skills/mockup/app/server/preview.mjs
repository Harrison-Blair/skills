// Bundles an agent-written page under ui/ (and the component files it
// imports) into one self-contained HTML file. The file is named by its
// content hash and never changes, so a round keeps showing what it showed
// when it was published even after the components are edited.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME = join(APP, "preview", "runtime.jsx");
export const PREVIEW_DIR = "renders/previews";
export const BUNDLE = /^[0-9a-f]{64}$/;

const NODE_MODULES = join(APP, "node_modules");
const inside = (root, file) => file === root || file.startsWith(root + sep);
// The real path, or the path itself when it does not exist (the entry stub).
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// Previews run code the agent wrote, and anything it imports is bundled into
// a page. Imports may come only from the design's ui/ and assets/, and bare
// packages only from the app's own node_modules (so there is always exactly
// one React). Everything else, such as .runtime/ with the session token or
// files elsewhere on disk, is refused, including through symlinks.
function confine(designDir) {
  // ui/ and assets/ count only as real directories: a symlink, to anywhere,
  // could point at .runtime/ or beyond.
  const allowed = [join(designDir, "ui"), join(designDir, "assets")]
    .filter((d) => {
      try {
        return lstatSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .map(real);
  allowed.push(...[NODE_MODULES, join(APP, "preview")].map(real));
  const modules = real(NODE_MODULES);
  return {
    name: "mockup-confine",
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.confined) return undefined;
        // The app's own packages import each other freely; they are trusted,
        // and checking each of their files would make big packages slow.
        if (args.importer && inside(modules, args.importer)) return undefined;
        const bare = !/^(\.|\/|[a-zA-Z]:[\\/])/.test(args.path);
        // The agent's bare imports resolve from the app, not the target repo.
        const resolveDir = bare ? APP : args.resolveDir;
        const result = await b.resolve(args.path, { kind: args.kind, resolveDir, importer: args.importer, pluginData: { confined: true } });
        if (result.errors.length || result.external) return result;
        if (!allowed.some((root) => inside(root, real(result.path)))) {
          return { errors: [{ text: `"${args.path}" is outside ui/ and assets/; previews may import only from there and from the app's packages` }] };
        }
        return result;
      });
    },
  };
}

const ASSETS = Object.fromEntries(
  [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".woff", ".woff2", ".ttf", ".otf"].map((ext) => [ext, "dataurl"]),
);

// Builds ui/<page> into renders/previews/<hash>.html and returns the hash.
// Throws with esbuild's messages, paths relative to the design directory.
export async function bundlePreview(designDir, rel) {
  const entry = join(designDir, ...rel.split("/"));
  let result;
  try {
    result = await build({
      stdin: {
        contents: `import Page from ${JSON.stringify(entry)};\nimport { start } from ${JSON.stringify(RUNTIME)};\nstart(Page);\n`,
        resolveDir: designDir,
        sourcefile: "mockup-preview-entry.jsx",
        loader: "jsx",
      },
      bundle: true,
      write: false,
      outdir: "out",
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      loader: { ".js": "jsx", ...ASSETS },
      define: { "process.env.NODE_ENV": '"production"' },
      minify: true,
      logLevel: "silent",
      plugins: [confine(designDir)],
    });
  } catch (err) {
    const lines = (err.errors ?? []).map((e) => {
      const at = e.location ? `${relative(designDir, e.location.file) || e.location.file}:${e.location.line}:${e.location.column}: ` : "";
      return `${at}${e.text}`;
    });
    throw new Error(lines.length ? lines.join("\n") : String(err.message ?? err));
  }
  const out = (ext) => result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? "";
  // Inline, so the frame needs nothing else from the server.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${out(".css").replace(/<\/style/gi, "<\\/style")}</style></head>
<body><div id="root"></div><script>${out(".js").replace(/<\/script/gi, "<\\/script")}</script></body></html>
`;
  const hash = createHash("sha256").update(html).digest("hex");
  const dir = join(designDir, ...PREVIEW_DIR.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hash}.html`), html);
  return hash;
}
