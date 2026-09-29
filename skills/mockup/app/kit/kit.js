// Kit elements. <mockup-choice> asks one question as flat rows. The option
// text stays in the light DOM, so the page still reads well without this
// script; the shadow roots hold only the marks, hairlines and write-in.
(() => {
  const framed = window.parent !== window;
  const post = (message) => {
    if (framed) window.parent.postMessage({ mockup: 1, ...message }, "*");
  };
  const hairline = "1px solid color-mix(in srgb, currentColor 18%, transparent)";

  const optionTemplate = `<style>
    :host { display: flex; gap: 10px; align-items: flex-start; padding: 10px 4px; border-bottom: ${hairline}; cursor: pointer; }
    :host(:focus-visible) { outline: 2px solid currentColor; outline-offset: -2px; }
    .mark { flex: none; box-sizing: border-box; width: 16px; height: 16px; margin-top: 3px; border-radius: 50%;
      border: 2px solid color-mix(in srgb, currentColor 55%, transparent); }
    :host([role="checkbox"]) .mark { border-radius: 3px; }
    :host([aria-checked="true"]) .mark { border-color: currentColor; background: radial-gradient(currentColor 0 3px, transparent 3.5px); }
    :host([role="checkbox"][aria-checked="true"]) .mark { background: currentColor; }
    ::slotted(small) { display: block; opacity: 0.75; }
  </style><span class="mark"></span><div><slot></slot></div>`;

  const choiceTemplate = `<style>
    :host { display: block; }
    .rows { border-top: ${hairline}; }
    label { display: block; margin-top: 10px; }
    span { font-size: 0.875em; opacity: 0.75; }
    input { display: block; box-sizing: border-box; width: 100%; margin-top: 4px; padding: 8px 10px; font: inherit; color: inherit;
      background: transparent; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); border-radius: 4px; }
    :host(:not([write-in])) label { display: none; }
  </style><div class="rows"><slot></slot></div><label><span>Something else</span><input type="text"></label>`;

  class MockupOption extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = optionTemplate;
    }
  }

  class MockupChoice extends HTMLElement {
    constructor() {
      super();
      this.selected = new Set();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = choiceTemplate;
      this.rows = root.querySelector(".rows");
      this.input = root.querySelector("input");
      this.restore = () => {
        const name = this.getAttribute("name");
        if (Object.hasOwn(window.mockup.state, name)) this.apply(window.mockup.state[name]);
      };
      this.clear = () => this.apply({});
      root.querySelector("slot").addEventListener("slotchange", () => this.render());
      this.input.addEventListener("input", () => this.post());
      this.addEventListener("click", (event) => this.toggle(event.target.closest("mockup-option")));
      this.addEventListener("keydown", (event) => {
        const option = event.target.closest("mockup-option");
        if (!option || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        this.toggle(option);
      });
    }

    connectedCallback() {
      window.addEventListener("mockup:restore", this.restore);
      window.addEventListener("mockup:clear", this.clear);
      this.render();
      this.restore();
    }

    disconnectedCallback() {
      window.removeEventListener("mockup:restore", this.restore);
      window.removeEventListener("mockup:clear", this.clear);
    }

    render() {
      const multiple = this.hasAttribute("multiple");
      this.rows.setAttribute("role", multiple ? "group" : "radiogroup");
      this.rows.setAttribute("aria-label", this.getAttribute("label") ?? "");
      for (const option of this.querySelectorAll(":scope > mockup-option")) {
        option.setAttribute("role", multiple ? "checkbox" : "radio");
        option.setAttribute("aria-checked", String(this.selected.has(option.getAttribute("value"))));
        option.tabIndex = 0;
      }
    }

    // Shows a saved draft without posting it.
    apply(draft) {
      if (!draft) return;
      this.selected = new Set(draft.value ?? []);
      this.input.value = draft.written?.[0] ?? "";
      this.render();
    }

    toggle(option) {
      if (!option || option.parentElement !== this) return;
      const value = option.getAttribute("value");
      if (!this.hasAttribute("multiple")) this.selected = new Set([value]);
      else if (this.selected.has(value)) this.selected.delete(value);
      else this.selected.add(value);
      this.render();
      this.post();
    }

    post() {
      const name = this.getAttribute("name");
      const id = "choice:" + name;
      const text = this.input.value.trim();
      const written = text ? [text] : [];
      if (!this.selected.size && !written.length) return post({ type: "undraft", id });
      post({ type: "draft", draft: { id, kind: "choice", name, label: this.getAttribute("label"), value: [...this.selected], written } });
    }
  }

  customElements.define("mockup-option", MockupOption);
  customElements.define("mockup-choice", MockupChoice);
})();
