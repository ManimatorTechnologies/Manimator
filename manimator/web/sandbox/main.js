// The sandbox: the only place customizations' code (server/kits.py) runs. The app frames engine.html with
// sandbox="allow-scripts", so this page has a unique origin: none of the visitor's cookies or storage, no way into
// the app's page, its API, popups or navigation, and its CSP (server/api.py) lets it load only the site's engine.
//
// The app (web/js/sandboxed.js) sends requests {id, op, ...}; each gets {id, ok, result | error}. Pictures go back
// as ImageBitmaps ({event: "frame"}), video progress as {event: "progress"}. The visitor's uploaded files are asked
// of the app ({need: "asset"}), which fetches them; this page can't.

import { createEngine } from "../js/engine/index.js";
import { setQuality } from "../js/engine/manim/config.js";
import { BuildCache } from "../js/engine/plan/build.js";
import { registerKits } from "../js/engine/kits.js";

const app = window.parent;
const send = (message, transfer = []) => app.postMessage(message, "*", transfer);
const canvas = new OffscreenCanvas(32, 18);
const sources = {}; // package type -> its kit.js text (sent with the plans)
const jobs = new Map(); // video job -> AbortController
const assetWaits = new Map();
let nextAsk = 1;
let engine = null;
const videoCache = new BuildCache();

/** An uploaded file of the visitor's, fetched by the app (only those the app's plan names). */
function fetchAsset(name) {
  return new Promise((resolve, reject) => {
    const ask = nextAsk;
    nextAsk += 1;
    assetWaits.set(ask, { resolve, reject });
    send({ need: "asset", ask, name: String(name) });
  });
}

/** The engine, with the plan's packages registered (a fresh one when a class name now means another package). */
async function engineFor(kits) {
  const replaced = await registerKits(kits, sources);
  if (!engine || replaced) {
    engine?.dispose();
    engine = await createEngine({ canvas, fetchAsset });
  }
  return engine;
}

/** The picture drawn now, to the app. */
function picture() {
  if (!canvas.width || !canvas.height) return;
  const bitmap = canvas.transferToImageBitmap();
  send({ event: "frame", bitmap }, [bitmap]);
}

const ops = {
  async show({ plan, kits, draw = true }) {
    Object.assign(sources, kits ?? {});
    const e = await engineFor(plan.kits);
    const shown = await e.show(plan, { draw });
    if (shown && draw) { // (draw false: no picture until renderAt)
      e.renderAt(null);
      picture();
    }
    return shown;
  },
  async prepare() {
    await engine?.prepare();
  },
  renderAt({ t }) {
    if (!engine) return;
    engine.renderAt(t ?? null);
    picture();
  },
  drag({ id, dx, dy }) {
    if (!engine) return;
    engine.drag(id ?? null, dx, dy);
    engine.renderAt(engine.time);
    picture();
  },
  resize({ width, height }) {
    canvas.width = Math.max(1, Math.min(8192, Math.round(width)));
    canvas.height = Math.max(1, Math.min(8192, Math.round(height)));
    if (!engine) return;
    engine.resize(canvas.width, canvas.height);
    engine.renderAt(engine.time);
    picture();
  },
  quality({ q }) {
    setQuality(q);
  },
  async snapshot({ width, height }) {
    return engine ? engine.snapshotPNG({ width, height }) : null;
  },
  async thumbnail({ plan, kits }) {
    Object.assign(sources, kits ?? {});
    await registerKits(plan.kits, sources);
    const { thumbnailPNG } = await import("../js/engine/thumbs.js");
    return thumbnailPNG(plan, { fetchAsset });
  },
  async video({ plan, kits, quality, job }) {
    Object.assign(sources, kits ?? {});
    await registerKits(plan.kits, sources);
    const { makeVideo } = await import("../js/engine/export.js");
    const controller = new AbortController();
    jobs.set(job, controller);
    try {
      const v = await makeVideo(plan, quality, { signal: controller.signal, fetchAsset, cache: videoCache,
        onProgress: (fraction) => send({ event: "progress", job, fraction }) });
      return { blob: v.blob, type: v.type, ext: v.ext, frames: v.frames, seconds: v.seconds };
    } finally {
      jobs.delete(job);
    }
  },
};

let queue = Promise.resolve(); // one request at a time, in order (a video job runs in a frame of its own)
window.addEventListener("message", (event) => {
  if (event.source !== app) return;
  const m = event.data;
  if (!m || typeof m !== "object") return;
  if (typeof m.asset === "number") { // the app's answer to fetchAsset
    const wait = assetWaits.get(m.asset);
    assetWaits.delete(m.asset);
    if (!wait) return;
    if (m.buffer instanceof ArrayBuffer) {
      wait.resolve(new Response(m.buffer, { status: m.status || 200, headers: { "Content-Type": String(m.type || "") } }));
    } else {
      wait.resolve(new Response(null, { status: m.status || 404 }));
    }
    return;
  }
  if (m.op === "abort") {
    jobs.get(m.job)?.abort();
    return;
  }
  const fn = Object.hasOwn(ops, m.op) ? ops[m.op] : null;
  queue = queue.then(async () => {
    if (!fn) {
      send({ id: m.id, ok: false, error: `unknown request ${m.op}` });
      return;
    }
    try {
      send({ id: m.id, ok: true, result: await fn(m) });
    } catch (err) {
      send({ id: m.id, ok: false, error: String(err?.message ?? err), name: err?.name ?? "Error" });
    }
  });
});

send({ event: "ready" });
