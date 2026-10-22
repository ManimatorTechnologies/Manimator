// Presenting: a presentation's scenes and videos one after another, full screen, the way ManimPresenter plays a
// folder of rendered scenes. Each item plays once and holds its last frame. → ↓ Space Page Down: next; ← ↑ Page Up:
// back; Home / End; F: full screen; Esc: leave. A click pauses or plays.
// Scenes come one of three ways, the account's setting (Account page): "live" draws them with the engine as they
// play; "render" renders every scene in this browser before starting (nothing is kept); "stored" plays the renders
// kept in the account's storage, rendering and saving first the ones missing or out of date.
// Every presentation opens on a plain blank "Start" item in the first item's background colour (no text), so the
// first press or click plays the first scene (like a Scene0 placeholder in ManimPresenter). The first item loads
// behind it, so it starts at once.
// A live scene never shows the editor's picture of itself (everything in place): the picture on screen stays until
// the scene's first frame is drawn.

import { html, useEffect, useRef, useState } from "./lib.js";
import { get, sendWithProgress } from "./api.js";
import { emit, loadEngine, project, status, store } from "./store.js";
import { Icon } from "./ui.js";

export function present(id) {
  store.presenting = { id };
  store.menu = null;
  emit();
  document.documentElement.requestFullscreen?.().catch(() => {}); // still inside the click that asked for it
}

function leave() {
  store.presenting = null;
  emit();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  // the editor's engine shares the frame rate setting: back to the open project's
  loadEngine().then((e) => e.setQuality(project()?.settings?.quality ?? "h")).catch(() => {});
}

export function PresenterLayer() {
  return store.presenting ? html`<${Presenter} key=${store.presenting.id} id=${store.presenting.id} />` : null;
}

const fetchAsset = (name) => fetch(`/api/assets/${encodeURIComponent(name)}`, { credentials: "same-origin" });

const START_SECONDS = 1;

/** A video's background: the commonest colour along the edges of its first frame (black if it can't be read). */
async function videoBackground(url) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 6000);
      v.onloadeddata = () => { clearTimeout(timer); resolve(); };
      v.onerror = () => { clearTimeout(timer); reject(new Error("unreadable")); };
      v.src = url;
    });
    const [w, h] = [48, 27];
    const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const bins = new Map(); // colour rounded to 1/16 -> [count, r, g, b]
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x !== 0 && y !== 0 && x !== w - 1 && y !== h - 1) continue;
        const i = 4 * (y * w + x);
        const key = (data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4);
        const bin = bins.get(key) ?? [0, 0, 0, 0];
        bin[0] += 1;
        bin[1] += data[i];
        bin[2] += data[i + 1];
        bin[3] += data[i + 2];
        bins.set(key, bin);
      }
    }
    const [n, r, g, b] = [...bins.values()].sort((a, c) => c[0] - a[0])[0];
    return `#${[r, g, b].map((s) => Math.round(s / n).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return "#000000";
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/** The Start item: blank, in the background colour of the first item that can play. */
async function startItem(items) {
  const first = items.find((it) => it.kind !== "missing");
  let color = "#000000";
  if (first?.kind === "scene") color = first.plan?.background ?? color;
  else if (first?.kind === "video") color = await videoBackground(first.url);
  return { id: "start", kind: "start", name: "Start", color, seconds: START_SECONDS };
}

/** Every item ready to play: `src` (a video's address) for videos and rendered scenes; live scenes keep their plan. */
async function prepare(data, signal, onStep) {
  const items = data.items.map((it) => ({ ...it, src: it.kind === "video" ? it.url : null }));
  let mode = data.mode;
  const scenes = items.filter((it) => it.kind === "scene");
  if (mode === "stored") for (const it of scenes) it.src = it.render;
  if (mode === "live" || !scenes.some((it) => !it.src)) return { items, mode };
  const exporter = await import("./engine/export.js");
  if (!exporter.canMakeVideos()) {
    status(`${exporter.UNSUPPORTED} Playing the scenes live instead.`, "error");
    for (const it of scenes) it.src = mode === "stored" ? it.src : null;
    return { items, mode: "live" };
  }
  const { BuildCache } = await import("./engine/plan/build.js");
  const { openSandbox, usesKits } = await import("./sandboxed.js");
  const cache = new BuildCache();
  const todo = [...new Map(scenes.filter((it) => !it.src).map((it) => [`${it.scene}-${it.hash}`, it])).values()];
  const made = new Map();
  const sandbox = todo.some((it) => usesKits(it.plan)) ? await openSandbox({ fetchAsset }) : null;
  let finished = false;
  try {
    for (let i = 0; i < todo.length; i += 1) {
      const it = todo[i];
      const label = `Rendering ${it.name} (${i + 1} of ${todo.length})`;
      onStep(label, i / todo.length);
      const options = {
        signal, cache, fetchAsset,
        onProgress: (f) => onStep(label, (i + f * (mode === "stored" ? 0.8 : 1)) / todo.length),
      };
      // customizations' code runs only in the sandbox (sandboxed.js)
      const video = usesKits(it.plan) ? await sandbox.video(it.plan, data.quality, options)
        : await exporter.makeVideo(it.plan, data.quality, options);
      let src = URL.createObjectURL(video.blob);
      if (mode === "stored") { // keep it in the account, so next time it plays at once (on any device)
        try {
          const url = `/api/renders?project=${data.project}&scene=${it.scene}&hash=${it.hash}&ext=${video.ext}`;
          const res = await sendWithProgress(url, video.blob,
            (f) => onStep(`Saving ${it.name} (${i + 1} of ${todo.length})`, (i + 0.8 + 0.2 * f) / todo.length), signal);
          URL.revokeObjectURL(src);
          src = res.url;
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          status(`${it.name} plays from this browser only: ${err.message}`, "error");
          mode = "render"; // the rest are made for this time only
        }
      }
      made.set(`${it.scene}-${it.hash}`, src);
    }
    finished = true;
  } finally {
    sandbox?.close();
    if (!finished) { // cancelled or failed: the videos made so far are let go (they can be large)
      for (const src of made.values()) if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    }
  }
  for (const it of scenes) if (!it.src) it.src = made.get(`${it.scene}-${it.hash}`);
  return { items, mode };
}

function Presenter({ id }) {
  const [phase, setPhase] = useState({ kind: "loading" }); // loading | preparing | ready | failed
  const [index, setIndex] = useState(0);
  const [onScreen, setOnScreen] = useState(0); // the item whose picture is up (a live scene: once its first frame is)
  const [chrome, setChrome] = useState(true); // the indicator and the close button, after the pointer moves
  const [name, setName] = useState("");
  const items = useRef([]);
  const video = useRef();
  const canvas = useRef();
  const engine = useRef(null);
  const loaded = useRef(null); // { plan, ready }: the scene the engine holds (built and prepared, not drawn by load())
  const showing = useRef(0); // which call of show() is the latest (moving quickly skips the ones in between)
  const abort = useRef(new AbortController());
  const blobUrls = useRef([]);
  const fadeTimer = useRef(0);
  const ownToggle = useRef(false); // full screen changed by the F key (not a reason to stop)

  const flash = () => {
    setChrome(true);
    clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => setChrome(false), 2000);
  };

  // ---------------------------------------------------------------- getting ready
  useEffect(() => {
    const signal = abort.current.signal;
    (async () => {
      try {
        const data = await get(`/api/presentations/${id}/play`);
        setName(data.name);
        if (!data.items.length) throw new Error("This presentation has nothing in it yet.");
        const [ready, start] = await Promise.all([
          prepare(data, signal, (label, progress) => setPhase({ kind: "preparing", label, progress })),
          startItem(data.items),
        ]);
        items.current = [start, ...ready.items];
        blobUrls.current = ready.items.map((it) => it.src).filter((s) => s?.startsWith("blob:"));
        const live = ready.items.filter((it) => it.kind === "scene" && !it.src);
        if (live.length) {
          const { createSandboxedEngine, usesKits } = await import("./sandboxed.js");
          const { createEngine } = await import("./engine/index.js");
          // scenes with customizations play in the sandbox (their code never runs on this page)
          const made = live.some((it) => usesKits(it.plan))
            ? await createSandboxedEngine({ canvas: canvas.current, fetchAsset })
            : await createEngine({ canvas: canvas.current, fetchAsset });
          if (signal.aborted) made.dispose();
          else {
            engine.current = made;
            engine.current.setQuality(data.quality);
          }
        }
        if (signal.aborted) { // left meanwhile: the clean-up has run already, so what was made here goes now
          for (const u of blobUrls.current) URL.revokeObjectURL(u);
          return;
        }
        setPhase({ kind: "ready" });
        await show(0, false);
      } catch (err) {
        if (err?.name === "AbortError") return;
        setPhase({ kind: "failed", message: err?.message ?? String(err) });
      }
    })();
    return () => {
      abort.current.abort();
      engine.current?.dispose();
      for (const u of blobUrls.current) URL.revokeObjectURL(u);
      clearTimeout(fadeTimer.current);
    };
  }, [id]);

  // ---------------------------------------------------------------- one item
  const fit = () => {
    const c = canvas.current;
    if (!c || !engine.current) return;
    const r = c.getBoundingClientRect();
    const k = Math.min(window.devicePixelRatio || 1, 1920 / Math.max(1, r.width));
    engine.current.resize(Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k)));
  };

  /** The engine holding `plan`, built and prepared, with nothing drawn: resolves true (false: a newer load came). */
  function load(plan) {
    const e = engine.current;
    if (loaded.current?.plan !== plan) {
      const ready = e.show(plan, { draw: false }).then((shown) => !!shown && e.prepare().then(() => true));
      loaded.current = { plan, ready };
      ready.catch(() => { if (loaded.current?.ready === ready) loaded.current = null; });
    }
    return loaded.current.ready;
  }

  /** Draws the loaded scene's first frame at the canvas's size (renderAt first: resizing redraws the moment drawn,
   *  never the editor's picture). */
  function firstFrame() {
    engine.current.renderAt(0);
    fit();
  }

  /** Gets the item after the Start blank ready behind it: a live scene drawn at its start, a video fetched. */
  async function preload(it, mine) {
    if (!it || (it.kind !== "scene" && it.kind !== "video")) return;
    if (it.src) {
      if (video.current.getAttribute("src") !== it.src) video.current.src = it.src;
      return;
    }
    try {
      if (!(await load(it.plan)) || mine !== showing.current) return;
    } catch {
      return; // showing it tries again
    }
    firstFrame();
  }

  async function show(i, play) {
    const list = items.current;
    if (!list.length) return;
    const at = Math.max(0, Math.min(list.length - 1, i));
    const mine = ++showing.current;
    setIndex(at);
    flash();
    const it = list[at];
    const v = video.current;
    engine.current?.stop();
    v.pause();
    if (it.kind === "missing" || it.kind === "start") { // a slate: nothing plays
      setOnScreen(at);
      if (it.kind === "start") preload(list[at + 1], mine);
      return;
    }
    if (it.src) {
      if (v.getAttribute("src") !== it.src) v.src = it.src;
      v.currentTime = 0;
      setOnScreen(at);
      if (play) v.play().catch(() => {});
      return;
    }
    // the picture on screen (the blank, the scene before's last frame) stays until this one's first frame is drawn
    if (!(await load(it.plan)) || mine !== showing.current) return;
    firstFrame();
    setOnScreen(at);
    if (play) engine.current.play(0);
  }

  const current = () => items.current[index];
  const next = () => { if (index < items.current.length - 1) show(index + 1, true); };
  const prev = () => { if (index > 0) show(index - 1, true); };
  const toggle = () => {
    const it = current();
    if (it?.kind === "start") { next(); return; }
    if (!it || it.kind === "missing" || onScreen !== index) return; // (a scene still loading)
    if (it.src) {
      const v = video.current;
      if (v.paused || v.ended) v.play().catch(() => {}); else v.pause();
    } else if (engine.current) {
      const e = engine.current;
      if (e.playing) e.stop(); else e.play(e.time ?? 0);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (phase.kind !== "ready" && e.key !== "Escape") return;
      const keys = {
        ArrowRight: next, ArrowDown: next, PageDown: next, " ": next,
        ArrowLeft: prev, ArrowUp: prev, PageUp: prev,
        Home: () => show(0, true),
        End: () => show(items.current.length - 1, true),
        f: () => {
          ownToggle.current = true; // F leaves full screen but keeps presenting, in a window
          (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
            .catch(() => {});
        },
        Escape: leave,
      };
      const fn = keys[e.key] ?? keys[e.key.toLowerCase?.()];
      if (!fn) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // the editor's own shortcuts wait
      fn();
    };
    const onResize = () => {
      const e = engine.current;
      if (!e || e.time === null) return; // no frame drawn yet: it is sized when it is (firstFrame)
      fit();
      if (!e.playing) e.renderAt(e.time);
    };
    // Esc in full screen is the browser's own (the page never hears it): leaving full screen like that ends the show
    const onFullscreen = () => {
      if (!document.fullscreenElement && !ownToggle.current) leave();
      ownToggle.current = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  });

  // ---------------------------------------------------------------- the picture
  const it = current();
  const up = phase.kind === "ready" ? items.current[onScreen] : null; // the picture shown
  const count = items.current.length - 1; // the Start item isn't counted
  return html`<div class=${`presenter ${chrome ? "chrome" : ""}`} onMouseMove=${flash}>
    <div class="pr-stage" onClick=${() => phase.kind === "ready" && toggle()}>
      <video ref=${video} class=${up?.src ? "on" : ""} preload="auto" playsinline />
      <canvas ref=${canvas} class=${up?.kind === "scene" && !up.src ? "on" : ""} />
      ${up?.kind === "start" && html`<div class="pr-blank" style=${`background:${up.color}`} />`}
      ${up?.kind === "missing" && html`<div class="pr-slate">
        <b>${up.name}</b><span>This scene or video was deleted. Press → to go on.</span></div>`}
    </div>
    ${phase.kind === "loading" && html`<div class="pr-card"><div class="pr-spin" /></div>`}
    ${phase.kind === "preparing" && html`<div class="pr-card">
      <div class="pr-label">${phase.label}</div>
      <div class="pr-bar"><span style=${`width:${Math.round(100 * phase.progress)}%`} /></div>
      <button class="btn" onClick=${leave}><span class="lbl">Cancel</span></button>
    </div>`}
    ${phase.kind === "failed" && html`<div class="pr-card">
      <div class="pr-label">${phase.message}</div>
      <button class="btn" onClick=${leave}><span class="lbl">Close</span></button>
    </div>`}
    ${phase.kind === "ready" && it?.kind !== "start"
      && html`<div class="pr-indicator">${it?.name} (${index}/${count})</div>`}
    <button class="pr-close" title="Leave (Esc)" aria-label="Leave the presentation" onClick=${leave}>
      <${Icon} name="x" size=${18} /></button>
    <div class="pr-title" aria-hidden="true">${name}</div>
  </div>`;
}
