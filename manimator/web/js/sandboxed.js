// Customizations' code (server/kits.py) never runs on this page: scenes that use them are drawn, played, rendered
// and pictured in a sandboxed frame (web/sandbox/), and this module talks to it. createSandboxedEngine() has the
// engine's own API (engine/index.js), so the editor, the presenter and the stage use it the same way; openSandbox()
// makes videos and card pictures. Scenes without customizations keep using the engine directly.
//
// Everything the frame sends is treated as untrusted: only pictures (ImageBitmaps), numbers, Blobs and short texts
// are taken from it, and it only gets the visitor's uploads that the scene's plan names.

import { planAssets } from "./engine/plan/build.js";

const PAGE = "/static/sandbox/engine.html";
const BOOT_MS = 30000;
const CALL_MS = 20000;
const STUCK = "A customization stopped responding (it may loop forever), so it was stopped.";
export const NOT_STARTED = "The customizations' sandbox didn't start.";

const defaultFetchAsset = (name) => fetch(`/api/assets/${encodeURIComponent(name)}`, { credentials: "same-origin" });

// kit.js texts, by package type (each version's file never changes)
const kitTexts = new Map();
function kitText(kit) {
  if (!kitTexts.has(kit.type)) {
    kitTexts.set(kit.type, fetch(kit.js, { credentials: "same-origin" }).then((r) => {
      if (!r.ok) throw new Error(`${kit.class}: its code can't be loaded (${r.status})`);
      return r.text();
    }).catch((e) => {
      kitTexts.delete(kit.type);
      throw e;
    }));
  }
  return kitTexts.get(kit.type);
}

/** {type: kit.js text} for the packages of `plans`: from `given` when the caller has them (the chat's player gets
 *  them with the scene), else fetched from the site. */
async function kitSources(plans, given = null) {
  const out = {};
  for (const plan of plans) {
    for (const kit of plan?.kits ?? []) {
      if (given) {
        if (typeof given[kit.type] !== "string") throw new Error(`${kit.class}: its code didn't arrive`);
        out[kit.type] = given[kit.type];
      } else out[kit.type] = await kitText(kit);
    }
  }
  return out;
}

/** Whether a scene plan uses customizations (and so must go to the sandbox). */
export const usesKits = (plan) => Array.isArray(plan?.kits) && plan.kits.length > 0;

/** One sandboxed frame. */
class Box {
  constructor(fetchAsset = defaultFetchAsset, { page = PAGE, bootMs = BOOT_MS } = {}) {
    this.fetchAsset = fetchAsset;
    this.assets = new Set(); // the uploads the frame may have (the plans' files)
    this.waits = new Map();
    this.progress = new Map();
    this.nextId = 1;
    this.dead = false;
    this.onFrame = null;
    this.frame = document.createElement("iframe");
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.tabIndex = -1;
    this.frame.title = "Customizations";
    // on screen (1 px, invisible), so the browser doesn't slow it down as a hidden frame
    this.frame.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none";
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.bootTimer = setTimeout(() => reject(new Error(NOT_STARTED)), bootMs);
    });
    this.ready.catch(() => this.kill(NOT_STARTED));
    this.listener = (e) => this.receive(e);
    window.addEventListener("message", this.listener);
    this.frame.src = page;
    document.body.append(this.frame);
  }

  receive(e) {
    if (this.dead || e.source !== this.frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.event === "ready") {
      clearTimeout(this.bootTimer);
      this.readyResolve();
    } else if (m.event === "frame") {
      if (m.bitmap instanceof ImageBitmap) {
        if (this.onFrame) this.onFrame(m.bitmap);
        else m.bitmap.close();
      }
    } else if (m.event === "progress") {
      this.progress.get(m.job)?.(Math.min(1, Math.max(0, Number(m.fraction) || 0)));
    } else if (m.need === "asset") {
      this.serveAsset(Number(m.ask), String(m.name));
    } else if (typeof m.id === "number" && this.waits.has(m.id)) {
      const wait = this.waits.get(m.id);
      this.waits.delete(m.id);
      clearTimeout(wait.timer);
      if (m.ok) wait.resolve(m.result);
      else {
        const text = String(m.error ?? "The sandbox failed.").slice(0, 500);
        wait.reject(m.name === "AbortError" ? new DOMException(text, "AbortError") : new Error(text));
      }
    }
  }

  async serveAsset(ask, name) {
    const reply = (msg, transfer = []) => { if (!this.dead) this.frame.contentWindow?.postMessage(msg, "*", transfer); };
    if (!this.assets.has(name)) {
      reply({ asset: ask, status: 404 });
      return;
    }
    try {
      const r = await this.fetchAsset(name);
      const buffer = await r.arrayBuffer();
      reply({ asset: ask, status: r.status, type: r.headers.get("content-type") ?? "", buffer }, [buffer]);
    } catch {
      reply({ asset: ask, status: 502 });
    }
  }

  allow(plans) {
    for (const plan of plans) for (const name of planAssets(plan).keys()) this.assets.add(name);
  }

  /** A request to the frame; a frame that doesn't answer within `timeout` ms is stopped (0: no limit). */
  async call(op, args = {}, timeout = CALL_MS) {
    await this.ready;
    if (this.dead) throw new Error(this.deathReason ?? STUCK);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => this.kill(STUCK), timeout) : 0;
      this.waits.set(id, { resolve, reject, timer });
      this.frame.contentWindow.postMessage({ ...args, id, op }, "*");
    });
  }

  post(message) {
    if (!this.dead) this.frame.contentWindow?.postMessage(message, "*");
  }

  kill(reason = STUCK) {
    if (this.dead) return;
    this.dead = true;
    this.deathReason = reason;
    window.removeEventListener("message", this.listener);
    this.frame.remove();
    for (const wait of this.waits.values()) {
      clearTimeout(wait.timer);
      wait.reject(new Error(reason));
    }
    this.waits.clear();
  }
}

/** An engine (engine/index.js's API) whose drawing happens in a sandboxed frame; pictures come back to `canvas`.
 *  `page`: the sandbox page (the chat's player names the site's, with ?embed=chat); `sources`: the packages' code by
 *  type, when the caller has it; `bootMs`: how long the frame may take to start. */
export async function createSandboxedEngine({ canvas = null, fetchAsset = defaultFetchAsset, page = PAGE,
  sources = null, bootMs = BOOT_MS } = {}) {
  let box = null;
  let target = canvas;
  let size = null; // [width, height] the frame draws at
  let quality = null;
  let current = null; // the plan shown, with its packages' code
  let duration = 0;
  let time = null;
  let token = 0;
  let player = null; // { raf }
  const queued = new Map(); // op -> latest args, for requests that only the newest of matters (drag, renderAt)
  const busy = new Set();

  function paint(bitmap) {
    if (target && bitmap.width && bitmap.height) {
      if (target.width !== bitmap.width || target.height !== bitmap.height) {
        target.getContext("2d").clearRect(0, 0, target.width, target.height);
      }
      target.getContext("2d").drawImage(bitmap, 0, 0, target.width, target.height);
    }
    bitmap.close();
  }

  /** The frame, made again (with the scene shown) if a stuck customization had it stopped. */
  async function frame() {
    if (box && !box.dead) return box;
    box = new Box(fetchAsset, { page, bootMs });
    box.onFrame = paint;
    if (quality) await box.call("quality", { q: quality });
    if (size) await box.call("resize", { width: size[0], height: size[1] });
    if (current) {
      box.allow([current.plan]);
      await box.call("show", current);
    }
    return box;
  }

  /** Sends the newest `args` for `op`, once the one before has been answered (dragging, scrubbing, playing). */
  function latest(op, args) {
    queued.set(op, args);
    if (busy.has(op)) return;
    busy.add(op);
    (async () => {
      while (queued.has(op)) {
        const next = queued.get(op);
        queued.delete(op);
        try {
          await (await frame()).call(op, next);
        } catch (e) {
          console.warn("sandbox", e);
        }
      }
      busy.delete(op);
    })();
  }

  function stopPlayer() {
    if (player) cancelAnimationFrame(player.raf);
    player = null;
  }

  const engine = {
    get canvas() { return target; },
    get duration() { return duration; },
    get time() { return time; },
    get playing() { return player !== null; },

    setQuality(q) {
      quality = q;
      frame().then((b) => b.call("quality", { q })).catch(() => {});
    },

    attach(cnv) {
      target = cnv;
      if (target && current) latest("renderAt", { t: time });
    },

    async show(plan) {
      const mine = ++token;
      const kits = await kitSources([plan], sources);
      if (mine !== token) return null;
      current = { plan, kits };
      const b = await frame();
      b.allow([plan]);
      const shown = await b.call("show", current, 60000);
      if (mine !== token || !shown) return null;
      stopPlayer();
      duration = Number(shown.duration) || 0;
      time = null;
      return shown;
    },

    drag(id, dx = 0, dy = 0) {
      if (current && time === null) latest("drag", { id: id ?? null, dx, dy });
    },

    async prepare() {
      if (current) await (await frame()).call("prepare", {}, 60000);
    },

    renderAt(t) {
      time = t === null || t === undefined ? null : Math.min(Math.max(0, t), duration);
      if (current) latest("renderAt", { t: time });
    },

    play(from = 0, onTime = () => {}) {
      stopPlayer();
      if (!current) return;
      const start = performance.now();
      const startAt = from >= duration ? 0 : from;
      const tick = () => {
        const t = startAt + (performance.now() - start) / 1000;
        const ended = t >= duration;
        engine.renderAt(ended ? duration : t);
        if (ended) player = null;
        else player.raf = requestAnimationFrame(tick);
        onTime(time, ended);
      };
      player = { raf: requestAnimationFrame(tick) };
    },

    stop() {
      stopPlayer();
    },

    resize(width, height) {
      size = [width, height];
      if (target && (target.width !== width || target.height !== height)) {
        target.width = width;
        target.height = height;
      }
      frame().then((b) => b.call("resize", { width, height })).catch(() => {});
    },

    async snapshotPNG({ width = 640, height = 360 } = {}) {
      return current ? (await frame()).call("snapshot", { width, height }) : null;
    },

    dispose() {
      stopPlayer();
      token += 1;
      box?.kill("closed");
      box = null;
      current = null;
      target = null;
    },
  };
  return engine;
}

/** A sandboxed frame for making videos and card pictures of scenes that use customizations. close() when done. */
export async function openSandbox({ fetchAsset = defaultFetchAsset } = {}) {
  const box = new Box(fetchAsset);
  let jobs = 0;
  return {
    /** As engine/export.js makeVideo: { blob, type, ext, frames, seconds }. */
    async video(plan, q, { signal = null, onProgress = () => {} } = {}) {
      if (signal?.aborted) throw new DOMException("The render was cancelled.", "AbortError");
      const kits = await kitSources([plan]);
      box.allow([plan]);
      const job = ++jobs;
      box.progress.set(job, onProgress);
      let stopTimer = 0;
      const onAbort = () => {
        box.post({ op: "abort", job });
        stopTimer = setTimeout(() => box.kill("The render was cancelled."), 3000); // stuck: stop the frame
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await box.call("video", { plan, kits, quality: q, job }, 0);
        if (!(result?.blob instanceof Blob)) throw new Error("The sandbox sent no video.");
        const ext = result.ext === "webm" ? "webm" : "mp4";
        return { blob: result.blob, type: ext === "webm" ? "video/webm" : "video/mp4", ext,
          frames: Number(result.frames) || 0, seconds: Number(result.seconds) || 0 };
      } catch (e) {
        if (signal?.aborted) throw new DOMException("The render was cancelled.", "AbortError");
        throw e;
      } finally {
        clearTimeout(stopTimer);
        signal?.removeEventListener("abort", onAbort);
        box.progress.delete(job);
      }
    },

    /** As engine/thumbs.js thumbnailPNG: the first frame's picture as a PNG blob. */
    async thumbnail(plan) {
      const kits = await kitSources([plan]);
      box.allow([plan]);
      const png = await box.call("thumbnail", { plan, kits }, 60000);
      if (!(png instanceof Blob)) throw new Error("The sandbox sent no picture.");
      return png;
    },

    close() {
      box.kill("closed");
    },
  };
}
