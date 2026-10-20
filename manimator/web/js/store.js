// App state: the server's project plus UI-only state (selection, panels, menus).
// Components read `store` directly; any change calls emit() and the app re-renders.

import { enqueue, get } from "./api.js";

export const store = {
  catalog: null,
  specs: null, // { mobjects: {key: spec}, methods: {...}, animations: {...}, kinds: {...} }
  server: null, // { project, path, dirty, version, can_undo, ... }
  sceneId: null,
  selectedId: null,
  selectedStep: null,
  stepOpen: false, // the floating step editor
  armed: null, // palette type waiting for a canvas click
  paletteOpen: false, // the "+" menu in the Objects panel
  paletteDragging: false, // an object is being dragged out of the palette window
  paletteMax: false,
  animPick: null, // the open animation window: { title, sub, typeKey, onPick }
  methodPick: null, // the open method window: { mobId }
  colorPick: null, // the open colour window: { id, value, optional, onPick }
  grid: false,
  snap: false,
  inspectorTab: "props",
  renderOpen: false, // the render window
  preview: null,
  playback: null, // the browser engine shows the video instead of the editing picture: { t, playing }
  menu: null,
  popover: null,
  modal: null,
  home: false, // the start screen
  homePage: "projects", // its page: "projects" | "presentations" | "account"
  presentationId: null, // the presentation open in its editor (Presentations page)
  presenting: null, // a presentation playing full screen: { id }
  account: null, // /api/account: plan, usage, signed-in user (when this server has accounts)
  auth: null, // the sign-in dialog: { mode: "signin" | "signup" | "reset" | "password" | "sent" }
  pricing: false, // the plans dialog
  checkout: null, // the plans dialog's checkout (account.js, with accounts)
  status: { text: "", kind: "info", id: 0 }, // the latest message; shown briefly as a pop-up
  render: { state: "idle", lines: [], videos: [] },
  kits: { mobjects: [], animations: [] }, // customizations the visitor can add (server/kits.py)
  renderNonce: 0,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit() {
  listeners.forEach((fn) => fn());
}
export function set(patch) {
  Object.assign(store, patch);
  emit();
}

// ---------------------------------------------------------------- accessors
export const project = () => store.server?.project;
export const scene = () => {
  const p = project();
  return p?.scenes.find((s) => s.id === store.sceneId) ?? p?.scenes[0];
};
export const selected = () => scene()?.mobjects.find((m) => m.id === store.selectedId) ?? null;
export const mobSpec = (key) => store.specs.mobjects[key];
export const names = () => Object.fromEntries((scene()?.mobjects ?? []).map((m) => [m.id, m.name]));

export function status(text, kind = "info") {
  // a limit that a bigger plan lifts gets a button that leads there
  let action = null;
  if (kind === "error" && /upgrade/i.test(text) && store.account?.billing) action = { label: "See plans", name: "plans" };
  store.status = { text, kind, id: store.status.id + 1, action };
  emit();
}

// ---------------------------------------------------------------- server state
function reconcile() {
  const p = project();
  if (!p) return;
  if (!p.scenes.some((s) => s.id === store.sceneId)) store.sceneId = p.scenes[0].id;
  const sc = scene();
  if (store.selectedId && !sc.mobjects.some((m) => m.id === store.selectedId)) store.selectedId = null;
  if (store.selectedStep != null && store.selectedStep >= sc.steps.length) store.selectedStep = null;
}

/** Custom object types and animations (server/kits.py), as catalog entries, joining store.specs. */
function addSpecs(specs) {
  for (const m of specs?.mobjects ?? []) store.specs.mobjects[m.key] = m;
  for (const a of specs?.animations ?? []) store.specs.animations[a.key] = a;
}

/** The customizations the visitor can add (the palette's and the animation window's Custom groups). */
export async function loadKits() {
  try {
    store.kits = await get("/api/kits/specs");
  } catch {
    store.kits = { mobjects: [], animations: [] };
  }
  addSpecs(store.kits);
  emit();
}

export function applyState(state) {
  addSpecs(state?.kits); // the project's custom types, for the editor's forms
  if (store.playback && state?.version !== store.server?.version) stopPlayback(); // an edit: back to editing
  if (store.server && state?.id === store.server.id && state?.version !== store.server.version) {
    thumbDirty.add(state.id); // edited: its card picture is out of date (sent when leaving the project)
  }
  store.server = state;
  reconcile();
  emit();
  requestFrame();
}

/** Coming back to this tab: an AI chat may have changed the open project meanwhile (the User MCP), so take the
 *  server's state if it moved on. */
let catchingUp = false;
async function catchUp() {
  if (catchingUp || document.visibilityState !== "visible" || !store.server) return;
  catchingUp = true;
  try {
    const state = await get("/api/state");
    if (state.id !== store.server.id || state.version !== store.server.version) applyState(state);
  } catch {
    // offline: the next visit checks again
  } finally {
    catchingUp = false;
  }
}
document.addEventListener("visibilitychange", catchUp);

export async function boot() {
  const [catalog, state, account] = await Promise.all([
    get("/api/catalog"), get("/api/state"), get("/api/account").catch(() => null)]);
  store.account = account;
  const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
  store.catalog = catalog;
  store.specs = {
    mobjects: byKey(catalog.mobjects),
    methods: byKey(catalog.methods),
    animations: byKey(catalog.animations),
    kinds: byKey(catalog.sceneKinds),
  };
  // Start on the Projects screen, unless the page was reloaded while editing (the editor marks the address).
  store.home = location.hash !== "#editor";
  applyState(state);
  loadKits();
}

/** Run a named edit on the server. Resolves with the op's result, or undefined on error. */
export async function run(op, args = {}, mergeKey = null) {
  try {
    const res = await enqueue("/api/op", { op, args, merge_key: mergeKey }, mergeKey);
    applyState(res.state);
    return res.result;
  } catch (err) {
    status(err.message, "error");
    return undefined;
  }
}

/** Same as run(), for edits inside the current scene. */
export const sop = (op, args = {}, mergeKey = null) => run(op, { scene_id: scene().id, ...args }, mergeKey);

/** Merge key helper: continuous gestures (slider drags, scrubbing) get a 'live:' key. */
export const mk = (base, gesture) => (gesture ? `live:${base}:${gesture}` : base);

export async function undo() {
  try {
    applyState((await enqueue("/api/undo", {})).state);
  } catch (err) {
    status(err.message, "error");
  }
}

export async function redo() {
  try {
    applyState((await enqueue("/api/redo", {})).state);
  } catch (err) {
    status(err.message, "error");
  }
}

// ---------------------------------------------------------------- selection
export function select(id) {
  if (store.selectedId !== id) {
    store.selectedId = id;
    emit();
  }
}

export function selectStep(index) {
  store.selectedStep = index;
  emit();
}

export function setScene(id) {
  if (id === store.sceneId) return;
  stopPlayback();
  Object.assign(store, { sceneId: id, selectedId: null, selectedStep: null, preview: null });
  emit();
  requestFrame(true);
}

// ---------------------------------------------------------------- the canvas
// The browser engine (engine/index.js) builds the scene plan and draws it: {boxes, errors, view, scene_error}.

let enginePromise = null;
/** The engine itself, loaded the first time it is needed (it also holds the frame rate setting). */
export function loadEngine() {
  enginePromise ??= import("./engine/index.js").then((m) => m.createEngine());
  return enginePromise;
}

// A scene that uses customizations (server/kits.py) is drawn by an engine in a sandboxed frame (sandboxed.js): their
// code never runs on this page. The editor's canvas, size and playback go to whichever engine draws the scene now.
let sandboxPromise = null;
let sandboxed = false;
let canvasEl = null;
let canvasSize = null;
function loadSandboxEngine() {
  sandboxPromise ??= import("./sandboxed.js").then((m) => m.createSandboxedEngine());
  return sandboxPromise;
}

/** The engine drawing the editor's picture now. */
export function activeEngine() {
  return sandboxed ? loadSandboxEngine() : loadEngine();
}

/** The stage's canvas (and its pixel size), for whichever engine draws. */
export async function attachCanvas(canvas) {
  canvasEl = canvas;
  (await activeEngine()).attach(canvas);
}
export async function resizeCanvas(width, height) {
  canvasSize = [width, height];
  (await activeEngine()).resize(width, height);
}

async function useSandbox(on) {
  if (on === sandboxed) return;
  const before = await activeEngine();
  before.stop();
  before.attach(null);
  sandboxed = on;
  const now = await activeEngine();
  if (canvasSize) now.resize(...canvasSize);
  now.attach(canvasEl);
}

async function drawFrame(sceneId) {
  const res = await get(`/api/plan?scene_id=${encodeURIComponent(sceneId)}`);
  await useSandbox(Array.isArray(res.plan.kits) && res.plan.kits.length > 0);
  const engine = await activeEngine();
  engine.setQuality(project()?.settings?.quality ?? "h"); // the frame rate the video is made at
  const shown = await engine.show(res.plan);
  return shown && { ...shown, scene_id: res.scene_id, version: res.version };
}

let frameBusy = false;
let sentKey = "";

export function requestFrame(force = false) {
  const key = `${store.sceneId}:${store.server?.version}`;
  if (!force && key === sentKey) return;
  if (frameBusy) return; // the finished request checks the key again
  frameBusy = true;
  sentKey = key;
  drawFrame(store.sceneId)
    .then((res) => {
      if (res && res.scene_id === store.sceneId) store.preview = res;
      emit();
    })
    .catch((err) => status(`Preview failed: ${err.message}`, "error"))
    .finally(() => {
      frameBusy = false;
      if (`${store.sceneId}:${store.server?.version}` !== sentKey) requestFrame();
    });
}

// ---------------------------------------------------------------- playing the video
// The time moves 60 times a second: it goes to listeners (the player bar), not through emit().
const timeListeners = new Set();
export function onPlaybackTime(fn) {
  timeListeners.add(fn);
  return () => timeListeners.delete(fn);
}
const tellTime = (t) => timeListeners.forEach((fn) => fn(t));

/** Plays or pauses the video on the canvas (Space, F5). */
export async function togglePlay() {
  if (!store.preview) return;
  const engine = await activeEngine();
  await engine.prepare();
  if (engine.playing) {
    engine.stop();
    store.playback = { t: engine.time ?? 0, playing: false };
    emit();
    return;
  }
  const from = store.playback && store.playback.t < engine.duration ? store.playback.t : 0;
  store.playback = { t: from, playing: true };
  emit();
  engine.play(from, (t, ended) => {
    if (!store.playback) return;
    store.playback.t = t;
    tellTime(t);
    if (ended) {
      store.playback = { t, playing: false };
      emit();
    }
  });
}

/** Shows the video at `t` seconds (the scrub bar). */
export async function seekPlayback(t) {
  if (!store.preview) return;
  const engine = await activeEngine();
  await engine.prepare();
  engine.stop();
  engine.renderAt(t);
  const wasShown = store.playback;
  store.playback = { t: engine.time ?? t, playing: false };
  tellTime(store.playback.t);
  if (!wasShown || wasShown.playing) emit();
}

/** Back to the editing picture (Esc, an edit, another scene). */
export function stopPlayback() {
  if (!store.playback) return;
  store.playback = null;
  activeEngine().then((engine) => {
    engine.stop();
    engine.renderAt(null);
  });
  emit();
}

// ---------------------------------------------------------------- project card pictures
const thumbDirty = new Set(); // projects edited since their picture was last sent

/** Sends the open project's card picture (its first scene) if it was edited, before leaving it. Never fails. */
export async function sendThumbnail({ timeout = 2000 } = {}) {
  const pid = store.server?.id;
  const first = project()?.scenes?.[0];
  if (!pid || !first || !thumbDirty.has(pid)) return;
  const job = (async () => {
    const res = await get(`/api/plan?scene_id=${encodeURIComponent(first.id)}`);
    const png = await scenePicture(res.plan);
    const r = await fetch(`/api/thumb/${encodeURIComponent(pid)}`, { method: "POST", body: png,
      headers: { "X-Manimator": "1", "Content-Type": "image/png" } });
    if (r.ok) thumbDirty.delete(pid);
  })().catch((e) => console.warn("project picture", e));
  await Promise.race([job, new Promise((r) => { setTimeout(r, timeout); })]);
}

/** A scene's first frame as a PNG (a scene with customizations is pictured in the sandbox). */
async function scenePicture(plan) {
  const { usesKits, openSandbox } = await import("./sandboxed.js");
  if (!usesKits(plan)) return (await import("./engine/thumbs.js")).thumbnailPNG(plan);
  const box = await openSandbox();
  try {
    return await box.thumbnail(plan);
  } finally {
    box.close();
  }
}

/** The open project's picture is missing on the server (the Projects page couldn't load it): make it now. */
export async function remakeThumbnail() {
  if (store.server?.id) thumbDirty.add(store.server.id);
  await sendThumbnail({ timeout: 10000 });
}
