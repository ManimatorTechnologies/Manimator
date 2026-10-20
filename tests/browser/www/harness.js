// The engine's test page (/dev/ with MANIMATOR_DEV_PAGES=1): draws scene plans with the browser engine, under the
// site's real Content-Security-Policy. Driven by tools/parity_report.py through window.harness.

import { createEngine } from "/static/js/engine/index.js";

const violations = [];
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample });
});
const log = (s) => {
  document.getElementById("log").textContent += `${s}\n`;
};

let assets = {}; // name -> base64, given with the plan (the CSP doesn't let fetch() read data: URLs)
const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const engine = await createEngine({
  fetchAsset: async (name) => (name in assets ? new Response(decode(assets[name])) : new Response(null, { status: 404 })),
});
const canvas = document.createElement("canvas");
document.getElementById("stage").append(canvas);
engine.attach(canvas);

window.harness = {
  ready: true,

  /** Builds `plan` and draws its starting layout at width x height. Files the plan uses come as base64. */
  async show(plan, { width = 1280, height = 720, files = {} } = {}) {
    assets = files;
    engine.resize(width, height);
    const t0 = performance.now();
    const shown = await engine.show(plan);
    const built = performance.now() - t0;
    engine.renderAt(0);
    return { ...shown, png: canvas.toDataURL("image/png"), ms: Math.round(built), drawMs: Math.round(performance.now() - t0 - built) };
  },

  /** Builds `plan` and draws its video at `t` seconds. */
  async frame(plan, t, { width = 1280, height = 720, files = {}, quality = "h" } = {}) {
    assets = files;
    engine.setQuality(quality);
    engine.resize(width, height);
    await engine.show(plan);
    await engine.prepare();
    engine.renderAt(t);
    return { png: canvas.toDataURL("image/png"), duration: engine.duration };
  },

  violations: () => violations,
};
log("ready");
