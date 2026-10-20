// The render window: progress, then the finished video (made in this browser) or what went wrong. It opens when a
// render starts.

import { html, useEffect, useState } from "./lib.js";
import { cancelRender, startRender } from "./actions.js";
import { emit, store } from "./store.js";
import { Dropdown, Icon } from "./ui.js";

export function RenderPanel() {
  const r = store.render;
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [store.renderNonce]);
  const running = r.state === "running";
  const videos = r.videos ?? [];
  const video = videos.find((v) => v.index === index) ?? videos[0];
  let text = "No video made yet.";
  let cls = "";
  if (running) text = `${r.label}: ${r.step}`;
  else if (r.state === "done") { text = `${r.label}: done.`; cls = "ok"; }
  else if (r.state === "failed") { text = `${r.label}: failed. ${r.lines.join(" ")}`; cls = "bad"; }
  else if (r.state === "cancelled") text = "Render cancelled.";
  return html`<div class="render">
    <div class="player">
      <div class="bar">
        <span class=${`status ${cls}`} title=${text}>${text}</span>
        ${running && html`<div class=${`progress ${r.progress ? "" : "busy"}`}><div style=${`width:${r.progress}%`} /></div>
          <button class="btn small danger" onClick=${cancelRender}><${Icon} name="stop" /><span class="lbl">Cancel</span></button>`}
        ${videos.length > 1 && html`<${Dropdown} class="small" value=${index} options=${videos.map((v) => [v.index, v.name])}
          onChange=${setIndex} />`}
        <a class=${`btn small ${videos.length ? "" : "disabled"}`} download=${video?.filename ?? ""} href=${video?.url}
          style=${videos.length ? "" : "pointer-events:none;opacity:.4"}><${Icon} name="export" /><span class="lbl">Download video</span></a>
      </div>
      ${videos.length && !running
        ? html`<video key=${`${store.renderNonce}:${index}`} src=${video?.url}
            controls autoplay loop playsinline />`
        : html`<div class="hint" style="flex:1; display:grid; place-items:center; text-align:center">
            ${running ? "Rendering… the video will play here when it's done."
              : html`<div>Your rendered video will play here.<br /><br />
                <button class="btn primary" onClick=${() => startRender("preview")}><${Icon} name="play" /><span class="lbl">Make a quick video (480p)</span></button></div>`}
          </div>`}
    </div>
  </div>`;
}

export function showRender() {
  store.renderOpen = true;
  emit();
}

export function closeRender() {
  if (store.renderOpen) {
    store.renderOpen = false;
    emit();
  }
}

export function RenderDialog() {
  if (!store.renderOpen) return null;
  return html`<div class="modal-back" onMouseDown=${(e) => { if (e.target === e.currentTarget) closeRender(); }}>
    <div class="modal render-modal" role="dialog" aria-label="Render">
      <div class="rm-head"><span>Render</span>
        <button class="btn small icon ghost" title="Close (Esc)" onClick=${closeRender}><${Icon} name="x" /></button>
      </div>
      <${RenderPanel} />
    </div>
  </div>`;
}
