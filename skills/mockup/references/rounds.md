# Round format

A round is a JSON file passed to `mockup round --file <file>`. The flags `--stage`, `--title` and `--kind` override the same fields in the file. The server checks the whole round and rejects it with the path of the first bad field, such as `pages[0].blocks[2].images[0]: "assets/web/x.jpg" does not exist`. Fix that field and publish again.

```json
{
  "stage": "mood",
  "title": "Three directions",
  "kind": "explore",
  "pages": [
    { "title": "Directions", "blocks": [
      { "type": "markdown", "text": "Like what feels right." },
      { "type": "option", "id": "calm", "title": "Calm paper", "text": "Warm neutrals, sage accent.", "images": ["assets/web/fog.jpg", "assets/own/calm.svg"] }
    ]},
    { "title": "Textures", "blocks": [
      { "type": "image", "id": "grain", "src": "assets/web/grain.jpg", "caption": "Natural grain" }
    ]},
    { "title": "Questions", "blocks": [
      { "type": "question", "id": "tone", "text": "Calm or energetic?", "choices": ["Calm", "Energetic"] },
      { "type": "question", "id": "moments", "text": "When do you check in?", "choices": ["Morning", "Midday", "Night"], "multiple": true },
      { "type": "question", "id": "dark-first", "text": "Should dark mode be the main look?" }
    ]}
  ]
}
```

## Fields

- `stage`: `context`, `mood`, `language`, `components`, `states`, `prototype` or `handoff`.
- `kind`: `explore` (the default) for taste checks, or `draft` for a stage proposal. A draft shows **Approve draft** and **Request changes** above its pages.
- `pages`: one or more pages. The user switches between them with tabs and Prev/Next buttons. Use pages to separate directions, details and questions.

## Blocks

| `type` | Fields | The user can |
| --- | --- | --- |
| `markdown` | `text` | read it |
| `option` | `id`, `title`, optional `text` and `images` | like or dislike it, select it, and mark up its images |
| `image` | `src`, optional `caption`, optional `id` | mark it up; with an `id`, also like, dislike or select it |
| `question` | `id`, `text` (Markdown), optional `choices` (two or more), optional `multiple` | pick one choice (radio rows), several with `"multiple": true` (checkbox rows), or like or dislike it when there are no choices |
| `preview` | `id`, `title`, `src` (a page under `ui/`), optional `text` and `device` | use the live page, switch device and light or dark, freeze it to pin or circle what they see, and like, dislike or select it |

Rules:

- `id` values use lowercase letters, digits and hyphens, and are unique within the round. `draft` is reserved.
- Image paths are relative to the design directory and must be under `assets/` or `renders/`: PNG, JPEG, WebP, GIF, or SVG for your own swatches. Web images cannot be linked directly; download them into `assets/web/` first. Publishing copies each image, including images in the round's Markdown, so a round keeps showing what it showed even if you later change the file; publish a new round to show a new version. Copies of your own and uploaded images go to `assets/published/`, which Git tracks; copies of web images go to the ignored `renders/published/`.
- Standalone image blocks on a page are laid out as a gallery. Options, questions and Markdown take the full width.
- Keep an explore round to a handful of items, so the user can react to all of them quickly.

## Live previews

Design language, components, states and the prototype are shown as live UI, built from real component files in the design directory:

```text
.design/<name>/ui/
  tokens.css               design tokens as CSS variables; dark values under [data-theme="dark"]
  components/Button.jsx    one reusable component per file, styled only from the tokens
  components/HabitRow.jsx  components import other components, as the real app would
  pages/Tokens.jsx         a page for a round: default-exports a React component
  pages/Today.jsx          prototype screens compose the same components
```

- A page imports `../tokens.css` and the components it shows, and default-exports a component. React 19 and `lucide-react` icons are provided; other packages are not, and nothing needs installing. Imports may come only from `ui/` and `assets/`; anything else, including files elsewhere in the repository, is refused. CSS, images and fonts that a page imports are bundled in.
- Keep one component per file and use it everywhere it appears. When the user asks for a change, edit the component once; every later page picks it up.
- `device` is the starting frame: `fit` (the default: full canvas width, as tall as the page), `phone` (390×844), `tablet` (820×1180) or `desktop` (1280×800). The user can switch it.
- The user can switch light and dark. The frame sets `data-theme="light"` or `"dark"` on `<html>`, so define both in `tokens.css`.
- Publishing builds each preview and fails with the file, line and error if it does not build. A published round keeps the build it had, so edit the files and publish a new round to show a revision.
- Previews run sandboxed, with no access to the network except fonts, styles and images over HTTPS. Show interactions for real: hover, focus, pressed, open menus, form errors, loading and empty states.
- When the user marks up a preview, you get a picture of exactly what they saw, with their marks drawn on.

## Shorthand

`mockup round --stage <stage> --title "<title>" [--kind draft] -` publishes standard input as a single Markdown page. Use it for text-only rounds such as a written brief.
