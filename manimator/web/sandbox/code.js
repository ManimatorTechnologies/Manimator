// The code sandbox: the only place the Code view's Python runs (web/js/code/PyBridge.js, with Pyodide). The app
// frames code.html with sandbox="allow-scripts", so this page has a unique origin: none of the visitor's cookies or
// storage, no way into the app's page or its API, and its CSP (server/api.py) lets it load only the site's engine
// and Pyodide.
//
// The app (web/js/codeview.js) sends requests {id, op, ...}; each gets {id, ok, result | error}, as in main.js.
// Pictures go back as ImageBitmaps ({event: "frame"}), print() output as {event: "output"}, video progress as
// {event: "progress"}. Data files are asked of the app ({need: "asset"}), which fetches them; this page can't.

import { loadPython } from "../js/code/PyBridge.js";
import { replay } from "../js/code/Recorder.js";
import { loadFonts } from "../js/engine/manim/fonts.js";
import { loadOpentype } from "../js/engine/mw/lib.js";

const app = window.parent;
const send = (message, transfer = []) => app.postMessage(message, "*", transfer);
const canvas = new OffscreenCanvas(32, 18);
const jobs = new Map(); // video job -> AbortController
const assetWaits = new Map();
const assets = new Map(); // stored name -> its bytes (stored names change with the content)
let nextAsk = 1;
let python = null;
let shown = null; // the last run: { frames, width, height, at: [recording for each video frame] }

function fetchAsset(name) {
  return new Promise((resolve, reject) => {
    const ask = nextAsk;
    nextAsk += 1;
    assetWaits.set(ask, { resolve, reject });
    send({ need: "asset", ask, name: String(name) });
  });
}

async function getPython() {
  python ??= (async () => {
    await loadFonts(new URL("../fonts", import.meta.url).href, await loadOpentype());
    return loadPython({ onOutput: (text, stream) => send({ event: "output", text: String(text), stream }) });
  })();
  try {
    return await python;
  } catch (e) {
    python = null;
    throw e;
  }
}

/** The script's data files, {shown name: stored name}, written where it opens them. */
async function useFiles(py, files = {}) {
  const out = {};
  for (const [name, stored] of Object.entries(files)) {
    if (!assets.has(stored)) {
      const r = await fetchAsset(stored);
      if (!r.ok) throw new Error(`${name} couldn't be loaded (${r.status})`);
      assets.set(stored, new Uint8Array(await r.arrayBuffer()));
    }
    out[name] = assets.get(stored);
  }
  for (const stored of [...assets.keys()]) if (!Object.values(files).includes(stored)) assets.delete(stored);
  py.setFiles(out);
}

const expand = (frames) => {
  const at = [];
  frames.forEach((f, i) => { for (let k = 0; k < f.count; k += 1) at.push(i); });
  return at;
};

function picture(frame) {
  if (!shown || !shown.at.length || !canvas.width || !canvas.height) return;
  const i = Math.max(0, Math.min(shown.at.length - 1, frame));
  replay(shown.frames[shown.at[i]].ops, canvas.getContext("2d"), canvas.width / shown.width);
  const bitmap = canvas.transferToImageBitmap();
  send({ event: "frame", bitmap }, [bitmap]);
}

const ops = {
  async load() {
    await getPython();
  },
  async run({ code, files, scene = null, q = "l" }) {
    const py = await getPython();
    await useFiles(py, files);
    const result = await py.run(String(code), { sceneName: scene, q });
    shown = { frames: result.frames, width: result.width, height: result.height, at: expand(result.frames) };
    picture(0);
    return { frames: shown.at.length, fps: result.fps, scenes: result.scenes, scene: result.scene,
      error: result.error, ms: result.ms };
  },
  renderAt({ frame }) {
    picture(Number(frame) || 0);
  },
  resize({ width, height, frame = 0 }) {
    canvas.width = Math.max(1, Math.min(8192, Math.round(width)));
    canvas.height = Math.max(1, Math.min(8192, Math.round(height)));
    picture(frame);
  },
  async video({ code, files, scene, quality, job }) {
    const py = await getPython();
    await useFiles(py, files);
    const controller = new AbortController();
    jobs.set(job, controller);
    try {
      const result = await py.run(String(code), { sceneName: scene, q: quality });
      if (result.error) throw new Error(result.error);
      const { encodeVideo } = await import("../js/engine/export.js");
      const { frames, width } = result;
      const pictures = frames.map((f) => ({ count: f.count, draw: (ctx, w) => replay(f.ops, ctx, w / width) }));
      const v = await encodeVideo(quality, pictures, { estimate: frames.reduce((n, f) => n + f.count, 0),
        signal: controller.signal, onProgress: (fraction) => send({ event: "progress", job, fraction }) });
      return { blob: v.blob, type: v.type, ext: v.ext, frames: v.frames, seconds: v.seconds, scene: result.scene };
    } finally {
      jobs.delete(job);
    }
  },
};

let queue = Promise.resolve(); // one request at a time, in order
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
