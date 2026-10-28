// The Code view: the project's Manim script (scene.py) with its data files, the preview and the console.
//
// The script runs only in a sandboxed frame (web/sandbox/code.js): Pyodide runs the Python, and the browser engine
// draws what it makes. The frame sends back pictures (ImageBitmaps) and print() output; this page never runs the
// user's code. The script and the list of data files are kept in the project (session.py: set_code, add_code_file),
// the files themselves in the visitor's uploads.

import { html, useEffect, useLayoutEffect, useRef, useState } from "./lib.js";
import { getText, uploadAsset } from "./api.js";
import { emit, project, run, status, store } from "./store.js";
import { Box } from "./sandboxed.js";
import { confirmDialog, Icon, openMenuAt, promptDialog } from "./ui.js";

const PAGE = "/static/sandbox/code.html";
const RUN_MS = 120000; // a run that takes longer is stopped (an endless loop would hold the frame for ever)
const STUCK = "The code ran for more than 2 minutes without finishing, so it was stopped.";
const NOT_STARTED = "Python didn't start. Check your connection and try again.";
const SAVE_MS = 500;
const LINE_H = 20; // the editor's line height, in px (style.css .ce)
const MAX_OUTPUT = 2000;
const DATA_ACCEPT = ".csv,.tsv,.json,.txt";
const ERROR_LINE = /File "scene\.py", line (\d+)/g;

export const STARTER = `from manim import *


class MyScene(Scene):
    def construct(self):
        circle = Circle(color=BLUE)
        self.play(Create(circle))
        self.wait()
`;

// ---------------------------------------------------------------- state (one Code view at a time)
const cv = {
  box: null,
  ready: false, // Python has loaded in the frame
  running: false,
  output: [], // [{ text, stream: "out" | "err" | "info" }]
  result: null, // the last run: { frames, fps, scenes, scene, error, pid }
  frame: 0,
  playing: false,
  raf: 0,
  scene: null, // the scene picked to show (several Scene classes)
  open: null, // a data file shown instead of the script: { name, text }
  text: null, // the script as typed (saved after a pause)
  sent: null, // the text last sent to the server
  saveTimer: 0,
  canvas: null,
  size: null,
  queued: null,
  painting: false,
  goto: null, // the editor's goto(line)
};

const files = () => project()?.code?.files ?? [];
const fileMap = () => Object.fromEntries(files().map((f) => [f.name, f.asset]));
const fetchAsset = (name) => fetch(`/api/assets/${encodeURIComponent(name)}`, { credentials: "same-origin" });

function say(text, stream = "info") {
  const last = cv.output[cv.output.length - 1];
  if (stream === "out" && last?.stream === "out" && !last.text.endsWith("\n")) last.text += text; // print() comes in pieces
  else cv.output.push({ text, stream });
  if (cv.output.length > MAX_OUTPUT) cv.output.splice(0, cv.output.length - MAX_OUTPUT);
  emit();
}

function paint(bitmap) {
  const c = cv.canvas;
  if (c && bitmap.width && bitmap.height) c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close();
}

/** The sandboxed frame (made again if it was stopped). */
function box() {
  if (cv.box && !cv.box.dead) return cv.box;
  cv.ready = false;
  cv.box = new Box(fetchAsset, { page: PAGE, title: "Code", stuck: STUCK });
  cv.box.onFrame = paint;
  cv.box.onOutput = (text, stream) => say(text, stream);
  if (cv.size) cv.box.call("resize", { width: cv.size[0], height: cv.size[1], frame: cv.frame }).catch(() => {});
  return cv.box;
}

/** Loads Python in the frame ahead of the first run (it takes a few seconds the first time). */
function warmUp() {
  if (cv.ready || cv.loading) return;
  cv.loading = true;
  box().call("load", {}, RUN_MS).then(() => { cv.ready = true; }).catch(() => {}).finally(() => {
    cv.loading = false;
    emit();
  });
}

/** Asks the frame for a picture; only the newest request waits (scrubbing, playing). */
function showFrame(frame) {
  cv.frame = frame;
  cv.queued = frame;
  if (cv.painting) return;
  cv.painting = true;
  (async () => {
    while (cv.queued !== null) {
      const f = cv.queued;
      cv.queued = null;
      try { await box().call("renderAt", { frame: f }); } catch { /* a stopped frame: nothing to show */ }
    }
    cv.painting = false;
  })();
}

function resizePreview(width, height) {
  cv.size = [width, height];
  if (cv.canvas) Object.assign(cv.canvas, { width, height });
  if (cv.result) box().call("resize", { width, height, frame: cv.frame }).catch(() => {});
}

// ---------------------------------------------------------------- playing
export function stopCode() {
  cancelAnimationFrame(cv.raf);
  cv.playing = false;
  emit();
}

export function playCode() {
  const r = cv.result;
  if (!r || !r.frames) return;
  if (cv.playing) return stopCode();
  if (cv.frame >= r.frames - 1) cv.frame = 0;
  cv.playing = true;
  const start = performance.now() - (cv.frame / r.fps) * 1000;
  const tick = () => {
    if (!cv.playing) return;
    const f = Math.min(r.frames - 1, Math.floor(((performance.now() - start) / 1000) * r.fps));
    if (f !== cv.frame) showFrame(f);
    if (f >= r.frames - 1) stopCode();
    else {
      cv.raf = requestAnimationFrame(tick);
      emit();
    }
  };
  cv.raf = requestAnimationFrame(tick);
  emit();
}

// ---------------------------------------------------------------- saving and running
function saveNow() {
  clearTimeout(cv.saveTimer);
  cv.saveTimer = 0;
  if (cv.text === null || cv.text === cv.sent) return Promise.resolve();
  cv.sent = cv.text;
  return run("set_code", { text: cv.text }, "code");
}

function edited(text) {
  cv.text = text;
  clearTimeout(cv.saveTimer);
  cv.saveTimer = setTimeout(saveNow, SAVE_MS);
}

/** Runs the script and shows its scene. */
export async function runCode() {
  if (cv.running) return;
  saveNow();
  stopCode();
  const code = cv.text ?? project()?.code?.text ?? "";
  cv.running = true;
  cv.output = [];
  cv.open = null;
  if (!cv.ready) say("Loading Python (the first run takes a few seconds)…");
  emit();
  try {
    const b = box();
    b.assets = new Set(files().map((f) => f.asset));
    const res = await b.call("run", { code, files: fileMap(), scene: cv.scene, q: "l" }, RUN_MS);
    cv.ready = true;
    const scenes = Array.isArray(res?.scenes) ? res.scenes.map(String).slice(0, 100) : [];
    cv.result = { frames: Math.max(0, Number(res?.frames) || 0), fps: Number(res?.fps) || 15, scenes,
      scene: typeof res?.scene === "string" ? res.scene : null, error: res?.error ? String(res.error) : null,
      pid: store.server?.id };
    cv.scene = cv.result.scene;
    cv.frame = 0;
    const seconds = cv.result.frames / cv.result.fps;
    say(`${cv.result.error ? "Stopped" : "Ran"} in ${((Number(res?.ms) || 0) / 1000).toFixed(1)} s`
      + (cv.result.frames ? `: ${seconds.toFixed(1)} s of video` : ""));
    if (!cv.result.error) playCode();
  } catch (e) {
    say(e?.message === "closed" ? "Stopped." : String(e?.message ?? e), "err");
    if (cv.box?.dead) cv.result = null;
  } finally {
    cv.running = false;
    emit();
  }
}

/** The scene Render scene makes: the one shown, else the first the script defines. */
export const codeSceneName = () => cv.scene ?? cv.result?.scenes?.[0] ?? null;

/**
 * Makes the Code view's videos (actions.startRender): `scope` "all" makes every scene the script defines, else the
 * one shown. onVideo({ name, blob, ext }) gets each as it is made.
 */
export async function makeCodeVideos(scope, quality, { signal, onProgress = () => {}, onStep = () => {}, onVideo }) {
  await saveNow();
  const code = cv.text ?? project()?.code?.text ?? "";
  if (!cv.result || cv.result.pid !== store.server?.id) await runCode(); // the scenes it has
  if (!cv.result) throw new Error("Run the code first.");
  if (cv.result.error) throw new Error("The code stopped with an error: fix it and run it again (see the console).");
  const names = scope === "all" ? cv.result.scenes : [codeSceneName()].filter(Boolean);
  if (!names.length) throw new Error("The code has no Scene class.");
  const b = box();
  b.assets = new Set(files().map((f) => f.asset));
  for (let i = 0; i < names.length; i += 1) {
    if (signal?.aborted) throw new DOMException("The render was cancelled.", "AbortError");
    onStep(names[i], i, names.length);
    const job = i + 1 + Math.floor(Math.random() * 1e9);
    b.progress.set(job, (fraction) => onProgress((i + fraction) / names.length));
    let stopTimer = 0;
    const onAbort = () => {
      b.post({ op: "abort", job });
      stopTimer = setTimeout(() => b.kill("The render was cancelled."), 3000); // stuck in Python: stop the frame
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await b.call("video", { code, files: fileMap(), scene: names[i], quality, job }, 0);
      if (!(res?.blob instanceof Blob)) throw new Error("The sandbox sent no video.");
      const ext = res.ext === "webm" ? "webm" : "mp4";
      onVideo({ name: names[i], blob: new Blob([res.blob], { type: ext === "webm" ? "video/webm" : "video/mp4" }), ext });
    } catch (e) {
      if (signal?.aborted) throw new DOMException("The render was cancelled.", "AbortError");
      throw e;
    } finally {
      clearTimeout(stopTimer);
      signal?.removeEventListener("abort", onAbort);
      b.progress.delete(job);
    }
  }
}

// ---------------------------------------------------------------- switching views
const VIEW_KEY = "manimator.view.";

/** Whether the open project shows the Code view (remembered per project in this browser). */
export function codeViewOn() {
  const id = store.server?.id;
  if (store.viewFor !== id) {
    let v = null;
    try { v = localStorage.getItem(VIEW_KEY + id); } catch { /* storage unavailable */ }
    Object.assign(store, { viewFor: id, view: v === "code" && project()?.code ? "code" : "visual" });
    resetCode();
  }
  return store.view === "code";
}

function remember(view) {
  try { localStorage.setItem(VIEW_KEY + store.server.id, view); } catch { /* storage unavailable */ }
}

function resetCode() {
  stopCode();
  Object.assign(cv, { result: null, output: [], frame: 0, scene: null, open: null, text: null, sent: null });
}

/** Switches the editor to the Code view. The first time, the script starts as the project's scenes in Python. */
export async function openCodeView() {
  if (!project().code) {
    const empty = project().scenes.every((s) => !s.mobjects.length && !s.steps.length);
    let text = STARTER;
    if (!empty) {
      try { text = await getText("/api/code"); } catch { /* the starter, then */ }
    }
    if ((await run("set_code", { text })) === undefined && !project().code) return;
  }
  store.view = "code";
  remember("code");
  emit();
}

export async function openVisualView() {
  await saveNow();
  stopCode();
  store.view = "visual";
  remember("visual");
  emit();
}

// ---------------------------------------------------------------- data files
const cleanName = (name) => {
  const ext = (name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").toLowerCase();
  const stem = name.slice(0, name.length - ext.length).replace(/[^A-Za-z0-9 ._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  return `${(stem || "data").slice(0, 70)}${ext}`;
};

export async function addDataFiles(list) {
  for (const file of list) {
    if (!/\.(csv|tsv|json|txt)$/i.test(file.name)) {
      status(`${file.name}: add CSV, TSV, JSON or TXT files.`, "error");
      continue;
    }
    const name = cleanName(file.name);
    status(`Uploading ${name}…`);
    try {
      const { name: asset } = await uploadAsset(file);
      const had = files().some((f) => f.name === name);
      if ((await run("add_code_file", { name, asset })) !== undefined) {
        status(had ? `Replaced ${name}.` : `Added ${name}. Open it in the code as "${name}".`, "ok");
      }
    } catch (err) {
      status(err.message, "error");
    }
  }
}

function chooseDataFiles() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = DATA_ACCEPT;
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener("change", () => {
    addDataFiles([...input.files]);
    input.remove();
  }, { once: true });
  document.body.append(input);
  input.click();
}

async function openDataFile(f) {
  saveNow();
  try {
    const r = await fetchAsset(f.asset);
    if (!r.ok) throw new Error(`${f.name} couldn't be opened (${r.status}).`);
    const blob = await r.blob();
    const shown = 200_000;
    const text = await blob.slice(0, shown).text();
    cv.open = { name: f.name, text: blob.size > shown ? `${text}\n…\n(${blob.size.toLocaleString()} bytes; the first ${shown.toLocaleString()} are shown)` : text };
  } catch (err) {
    status(err.message, "error");
  }
  emit();
}

function fileMenu(e, f) {
  e.stopPropagation();
  openMenuAt(e, [
    { label: "Rename…", onClick: async () => {
      const name = await promptDialog({ title: "Rename data file", value: f.name, ok: "Rename",
        message: "The code opens it by this name." });
      if (name && name !== f.name) {
        const renamed = await run("rename_code_file", { name: f.name, new_name: cleanName(name) });
        if (renamed && cv.open?.name === f.name) cv.open.name = renamed;
      }
    } },
    { label: "Remove from project", onClick: async () => {
      const ok = await confirmDialog({ title: `Remove ${f.name}?`, ok: "Remove", danger: true,
        message: "The code can't open it any more. The file stays in your storage until you delete it there." });
      if (!ok) return;
      if (cv.open?.name === f.name) cv.open = null;
      await run("remove_code_file", { name: f.name });
    } },
  ]);
}

function FilesPanel() {
  const [over, setOver] = useState(false);
  const drop = (e) => {
    e.preventDefault();
    setOver(false);
    addDataFiles([...(e.dataTransfer?.files ?? [])]);
  };
  return html`<div class=${`cv-files ${over ? "over" : ""}`} onDragOver=${(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave=${() => setOver(false)} onDrop=${drop}>
    <div class="panel-head"><span class="grow">Files</span>
      <button class="btn icon ghost" title="Add data files (CSV, TSV, JSON, TXT)" onClick=${chooseDataFiles}><${Icon} name="plus" /></button>
    </div>
    <div class="cv-list">
      <button class=${`cv-file ${cv.open ? "" : "on"}`} onClick=${() => { cv.open = null; emit(); }}>
        <${Icon} name="code" size=${14} /><span class="n">scene.py</span></button>
      ${files().map((f) => html`<div class=${`cv-file ${cv.open?.name === f.name ? "on" : ""}`} key=${f.name}
          role="button" tabindex="0" onClick=${() => openDataFile(f)} onKeyDown=${(e) => e.key === "Enter" && openDataFile(f)}>
        <${Icon} name="list" size=${14} /><span class="n" title=${f.name}>${f.name}</span>
        <button class="btn icon ghost small" title="More" onClick=${(e) => fileMenu(e, f)}><${Icon} name="more" size=${14} /></button>
      </div>`)}
    </div>
    <div class="cv-drop" onClick=${chooseDataFiles}>
      <div>Drop data files here</div>
      <div class="sub">CSV, TSV, JSON or TXT. Your code opens them by name.</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- the editor
const KEYWORDS = new Set(("False None True and as assert async await break class continue def del elif else except "
  + "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield").split(" "));
const BUILTINS = new Set(("abs all any bool dict enumerate filter float int len list map max min open print range "
  + "reversed round set sorted str sum tuple zip super isinstance self np").split(" "));
const TOKEN = /(#[^\n]*)|([rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|(@[A-Za-z_][\w.]*)|(\b\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?j?\b|\.\d+\b)|([A-Za-z_]\w*)/g;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Python as HTML with coloured spans (comments, strings, keywords, names). */
export function highlight(text) {
  let out = "";
  let last = 0;
  let named = false; // the name after def / class
  for (const m of text.matchAll(TOKEN)) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    const t = esc(m[0]);
    let cls = "";
    if (m[1]) cls = "c";
    else if (m[2]) cls = "s";
    else if (m[3]) cls = "d";
    else if (m[4]) cls = "n";
    else if (named) cls = "f";
    else if (KEYWORDS.has(m[0])) cls = "k";
    else if (BUILTINS.has(m[0])) cls = "b";
    else if (/^[A-Z][A-Z0-9_]+$/.test(m[0])) cls = "o";
    else if (/^[A-Z]/.test(m[0])) cls = "t";
    named = m[5] !== undefined && (m[0] === "def" || m[0] === "class");
    out += cls ? `<span class="${cls}">${t}</span>` : t;
  }
  return `${out + esc(text.slice(last))}\n`;
}

/** Types `text` in place of the selection, so the browser's own undo keeps working. */
function insert(ta, text) {
  ta.focus();
  if (!document.execCommand("insertText", false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
}

function lineBounds(value, start, end) {
  const a = value.lastIndexOf("\n", start - 1) + 1;
  let b = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  if (b < 0) b = value.length;
  return [a, b];
}

/** Changes every line the selection touches: `fn(line) -> line`. */
function eachLine(ta, fn) {
  const [a, b] = lineBounds(ta.value, ta.selectionStart, ta.selectionEnd);
  const lines = ta.value.slice(a, b).split("\n");
  const changed = lines.map(fn).join("\n");
  ta.setSelectionRange(a, b);
  insert(ta, changed);
  ta.setSelectionRange(a, a + changed.length);
}

function onEditorKey(e) {
  const ta = e.target;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === "Enter") {
    e.preventDefault();
    runCode();
  } else if (e.key === "Tab") {
    e.preventDefault();
    const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n");
    if (e.shiftKey) eachLine(ta, (l) => l.replace(/^ {1,4}/, ""));
    else if (multi) eachLine(ta, (l) => (l ? `    ${l}` : l));
    else {
      const col = ta.selectionStart - (ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1);
      insert(ta, " ".repeat(4 - (col % 4)));
    }
  } else if (e.key === "Enter" && !ctrl && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    const line = ta.value.slice(start, ta.selectionStart);
    let indent = line.match(/^ */)[0];
    if (/:\s*(#.*)?$/.test(line)) indent += "    ";
    insert(ta, `\n${indent}`);
  } else if (e.key === "Backspace" && ta.selectionStart === ta.selectionEnd) {
    const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    const before = ta.value.slice(start, ta.selectionStart);
    if (before.length && /^ +$/.test(before)) { // back to the indentation step before
      e.preventDefault();
      ta.setSelectionRange(ta.selectionStart - (((before.length - 1) % 4) + 1), ta.selectionStart);
      insert(ta, "");
    }
  } else if (ctrl && e.key === "/") {
    e.preventDefault();
    const [a, b] = lineBounds(ta.value, ta.selectionStart, ta.selectionEnd);
    const lines = ta.value.slice(a, b).split("\n").filter((l) => l.trim());
    const commented = lines.length && lines.every((l) => /^\s*#/.test(l));
    eachLine(ta, (l) => (!l.trim() ? l : commented ? l.replace(/^(\s*)# ?/, "$1") : l.replace(/^(\s*)/, "$1# ")));
  }
}

function CodeEditor({ value, onInput, errorLine }) {
  const scroller = useRef(null);
  const ta = useRef(null);
  const lines = value.split("\n").length;
  useEffect(() => {
    cv.goto = (line) => {
      const t = ta.current;
      if (!t) return;
      const parts = t.value.split("\n");
      const at = parts.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
      t.focus();
      t.setSelectionRange(at, at + (parts[line - 1]?.length ?? 0));
      const s = scroller.current;
      s.scrollTop = Math.max(0, (line - 4) * LINE_H);
    };
    return () => { cv.goto = null; };
  }, []);
  // keep the caret in view (the text area is as large as its text; the editor scrolls around it)
  const follow = () => {
    const t = ta.current;
    const s = scroller.current;
    if (!t || !s) return;
    const line = t.value.slice(0, t.selectionEnd).split("\n").length;
    const y = 10 + (line - 1) * LINE_H;
    if (y < s.scrollTop) s.scrollTop = y - 10;
    else if (y + LINE_H > s.scrollTop + s.clientHeight) s.scrollTop = y + LINE_H + 10 - s.clientHeight;
  };
  return html`<div class="ce" ref=${scroller}>
    <pre class="ce-gutter" aria-hidden="true">${Array.from({ length: lines }, (_, i) => (i + 1 === errorLine
      ? html`<span class="ce-err">${`${i + 1}\n`}</span>` : `${i + 1}\n`))}</pre>
    <div class="ce-body">
      ${errorLine > 0 && errorLine <= lines && html`<div class="ce-errline" style=${`top:${10 + (errorLine - 1) * LINE_H}px`} />`}
      <pre class="ce-hl" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: highlight(value) }} />
      <textarea ref=${ta} class="ce-input" spellcheck=${false} autocapitalize="off" autocomplete="off" wrap="off"
        aria-label="Python code" value=${value} onInput=${(e) => { onInput(e.target.value); follow(); }}
        onKeyDown=${onEditorKey} onKeyUp=${follow} onClick=${follow} />
    </div>
  </div>`;
}

function DataView() {
  return html`<div class="cv-data">
    <div class="cv-data-head"><b>${cv.open.name}</b><span class="muted">Read only</span><span class="grow" />
      <button class="btn small" onClick=${() => { cv.open = null; emit(); }}><span class="lbl">Back to scene.py</span></button></div>
    <pre class="cv-data-text">${cv.open.text}</pre>
  </div>`;
}

// ---------------------------------------------------------------- preview and console
function Preview() {
  const wrap = useRef(null);
  const canvas = useRef(null);
  useLayoutEffect(() => {
    cv.canvas = canvas.current;
    const fit = () => {
      const el = wrap.current;
      if (!el) return;
      const w = Math.max(1, el.clientWidth - 24); // a 12 px margin around the picture
      const h = Math.max(1, el.clientHeight - 24);
      const width = Math.min(w, (h * 16) / 9);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      Object.assign(canvas.current.style, { width: `${width}px`, height: `${(width * 9) / 16}px` });
      const px = [Math.round(width * dpr), Math.round(((width * 9) / 16) * dpr)];
      if (!cv.size || cv.size[0] !== px[0] || cv.size[1] !== px[1]) resizePreview(...px);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap.current);
    fit();
    return () => {
      ro.disconnect();
      cv.canvas = null;
    };
  }, []);
  const r = cv.result;
  const frames = r?.frames ?? 0;
  const scrub = (e) => {
    stopCode();
    showFrame(Number(e.target.value));
    emit();
  };
  return html`<div class="cv-preview">
    <div class="cv-stage" ref=${wrap}>
      <canvas ref=${canvas} class="cv-canvas" />
      ${!r && cv.running && html`<div class="cv-empty"><span>Running…</span></div>`}
    </div>
    <div class="cv-bar">
      <button class="vp-btn" title=${cv.playing ? "Pause" : "Play"} disabled=${!frames} onClick=${playCode}>
        <${Icon} name=${cv.playing ? "pause" : "play"} /></button>
      <input class="cv-seek" type="range" min="0" max=${Math.max(0, frames - 1)} value=${cv.frame} disabled=${!frames}
        onInput=${scrub} aria-label="Time" />
      <span class="cv-time">${r ? `${(cv.frame / r.fps).toFixed(1)} / ${(frames / r.fps).toFixed(1)} s` : "0.0 s"}</span>
      ${r?.scenes?.length > 1 && html`<select class="cv-scene" title="Scene to show" value=${cv.scene ?? ""}
          onChange=${(e) => { cv.scene = e.target.value; runCode(); }}>
        ${r.scenes.map((n) => html`<option value=${n}>${n}</option>`)}
      </select>`}
    </div>
  </div>`;
}

function errorLineOf(text) {
  let line = 0;
  for (const m of text.matchAll(ERROR_LINE)) line = Number(m[1]);
  return line;
}

function Console() {
  const pre = useRef(null);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  });
  const linked = (text) => {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(ERROR_LINE)) {
      parts.push(text.slice(last, m.index));
      const line = Number(m[1]);
      parts.push(html`<a class="cv-line" href="#" onClick=${(e) => { e.preventDefault(); cv.open = null; emit(); setTimeout(() => cv.goto?.(line)); }}>${m[0]}</a>`);
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return parts;
  };
  return html`<div class="cv-console">
    <div class="panel-head"><span class="grow">Console</span>
      <button class="btn small ghost" disabled=${!cv.output.length} onClick=${() => { cv.output = []; emit(); }}><span class="lbl">Clear</span></button>
    </div>
    <pre class="cv-out" ref=${pre}>${cv.output.map((o) => html`<span class=${`o-${o.stream}`}>${o.stream === "err" ? linked(o.text) : o.text}${o.text.endsWith("\n") ? "" : "\n"}</span>`)}</pre>
  </div>`;
}

// ---------------------------------------------------------------- the view
function useDrag(name, axis, min, max, from) {
  return (e) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.classList.add("active");
    const move = (ev) => {
      const v = Math.round(Math.min(max(), Math.max(min, from(ev))));
      document.documentElement.style.setProperty(`--${name}`, `${v}px`);
    };
    const up = () => {
      el.classList.remove("active");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
}

export function CodeView() {
  const code = project()?.code;
  const server = code?.text ?? "";
  // take the server's script when it changed elsewhere (undo, redo, another tab), not while the visitor types
  if (cv.text === null || (server !== cv.sent && cv.text === cv.sent && !cv.saveTimer)) {
    cv.text = server;
    cv.sent = server;
  }
  if (cv.result && cv.result.pid !== store.server?.id) resetCode();
  const [, force] = useState(0);
  useEffect(() => {
    warmUp();
    const flush = () => saveNow();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      saveNow();
      stopCode();
    };
  }, []);
  const lastErr = [...cv.output].reverse().find((o) => o.stream === "err");
  const errorLine = cv.result?.error ? errorLineOf(cv.result.error) : lastErr ? errorLineOf(lastErr.text) : 0;
  const right = useRef(null);
  return html`<div class="cv">
    <${FilesPanel} />
    <div class="splitter" onPointerDown=${useDrag("code-files", "x", 150, () => 420, (ev) => ev.clientX)} />
    <div class="cv-editor">
      ${cv.open ? html`<${DataView} />` : html`<${CodeEditor} value=${cv.text} errorLine=${errorLine}
        onInput=${(text) => { edited(text); force((n) => n + 1); }} />`}
    </div>
    <div class="splitter" onPointerDown=${useDrag("code-right", "x", 320, () => window.innerWidth - 420, (ev) => window.innerWidth - ev.clientX)} />
    <div class="cv-right" ref=${right}>
      <${Preview} />
      <div class="splitter h" onPointerDown=${useDrag("code-console", "y", 80, () => window.innerHeight - 260,
        (ev) => window.innerHeight - ev.clientY)} />
      <${Console} />
    </div>
  </div>`;
}

/** The Run button's state, for the top bar. */
export const codeRunning = () => cv.running;
