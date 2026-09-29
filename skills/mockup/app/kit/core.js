// Page script core: defines window.mockup and links the page to the shell by
// postMessage. The server joins core.js, kit.js and annotate.js, in that
// order, into one classic script injected into every agent-written page.
(() => {
  const framed = window.parent !== window;
  const state = {};
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  setTimeout(resolveReady, 300);
  let sent = 0;

  const post = (message) => {
    if (framed) window.parent.postMessage({ mockup: 1, ...message }, "*");
  };

  // Queues a draft; kind "text" unless the options give one. A named draft
  // replaces the earlier one with the same name.
  const send = (note, options = {}) => {
    const id = "send:" + (options.name ?? ++sent);
    post({ type: "draft", draft: { kind: "text", note, ...options, id } });
  };

  window.mockup = { send, ready, state };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!framed || event.source !== window.parent || !data || data.mockup !== 1) return;
    if (data.type === "restore" || data.type === "clear") {
      for (const name of Object.keys(state)) delete state[name];
      if (data.type === "restore") Object.assign(state, data.values);
      window.dispatchEvent(new Event("mockup:" + data.type));
      if (data.type === "restore") resolveReady();
    }
  });

  const announce = () => post({ type: "ready", path: decodeURIComponent(location.pathname.replace(/^\/d\//, "")), title: document.title });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce);
  else announce();
})();
