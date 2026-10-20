// User actions shared by toolbar, menus, keyboard shortcuts and panels.

import { chooseLocalFile, downloadFromServer, get, post, uploadAsset } from "./api.js";
import { openAnimPicker, SCENE_TARGET } from "./animpicker.js";
import { applyState, emit, mobSpec, project, scene, selected, sendThumbnail, sop, status, store } from "./store.js";
import { alertDialog, confirmDialog } from "./ui.js";
import { sceneActions } from "./util.js";

// ---------------------------------------------------------------- objects
export async function addObject(type, x, y) {
  const spec = mobSpec(type);
  let target = null;
  if (spec.needsTarget) {
    target = store.selectedId;
    if (!target) {
      await alertDialog({
        title: `Add ${type}`,
        message: `A ${type} attaches to another object.\n\nSelect that object on the canvas first, then add the ${type} again.`,
      });
      return;
    }
  } else if (spec.acceptsSelection) target = store.selectedId; // a group starts with the selected object in it
  store.armed = null;
  const kindBefore = scene().kind;
  const id = await sop("add_mobject", { type, x, y, target_id: target });
  if (id) {
    Object.assign(store, { selectedId: id, inspectorTab: "props" });
    status(scene().kind !== kindBefore
      ? `Added ${type}. This scene is now a ${scene().kind}; set its camera in the scene settings (click empty canvas).`
      : `Added ${type}. Drag it to move it, and change its look on the right.`);
    const file = spec.params.find((p) => p.kind === "file");
    if (file) {
      let value = null;
      const chosen = await chooseLocalFile(file.accept === "svg" ? ".svg,image/svg+xml" : "image/*");
      if (chosen) {
        try { value = (await uploadAsset(chosen)).name; } catch (err) { status(err.message, "error"); return; }
      }
      if (value) await sop("set_param", { mob_id: id, name: file.name, value });
      else status(`Added ${type}. Choose its file on the right.`);
    }
  }
}

export async function deleteSelected() {
  const m = selected();
  if (!m) return;
  const removed = await sop("delete_mobject", { mob_id: m.id });
  if (removed) {
    store.selectedId = null;
    const others = removed.filter((n) => n !== m.name);
    status(others.length
      ? `Deleted ${m.name} and ${others.join(", ")}, which ${others.length > 1 ? "were" : "was"} attached to it. Ctrl+Z brings them back.`
      : `Deleted ${m.name}. Ctrl+Z brings it back.`);
  }
}

export async function duplicateSelected() {
  const m = selected();
  if (!m) return;
  const id = await sop("duplicate_mobject", { mob_id: m.id });
  if (id) {
    store.selectedId = id;
    emit();
  }
}

export function moveLayer(delta) {
  const m = selected();
  if (m) sop("move_layer", { mob_id: m.id, delta });
}

export function nudge(dx, dy) {
  const m = selected();
  if (m) sop("nudge", { mob_id: m.id, dx, dy }, `nudge:${m.id}`);
}

// ---------------------------------------------------------------- steps
export async function addStep(anim, method = null, targetId = null) {
  const target = targetId ?? store.selectedId;
  if (!target) {
    status("Select an object on the canvas first.", "error");
    return;
  }
  const index = store.selectedStep == null ? null : store.selectedStep + 1;
  const i = await sop("add_play_step", { anim, target_id: target, index, method });
  if (i !== undefined) {
    Object.assign(store, { selectedStep: i });
    emit();
  }
}

/** A scene action (camera move, grid transformation...) as a new step. `hint` is the object it starts out pointing
 *  at, when it points at one (the object to focus on, for example). */
export async function addAction(anim, hint = store.selectedId) {
  const index = store.selectedStep == null ? null : store.selectedStep + 1;
  const i = await sop("add_play_step", { anim, target_id: hint ?? null, index });
  if (i !== undefined) {
    store.selectedStep = i;
    emit();
  }
}

/** What to animate: the given object (usually the selection), or else the scene. `oneStep` (adding to a step): when
 *  the scene has nothing that can play along with other animations, `fallback` (the step's own object) instead. */
export function animateTarget(targetId, { oneStep = false, fallback = null } = {}) {
  const sc = scene();
  if (sc.mobjects.some((m) => m.id === targetId)) return targetId;
  if (oneStep && !sceneActions(sc).some((a) => a.fixedTime == null) && sc.mobjects.some((m) => m.id === fallback)) {
    return fallback;
  }
  return SCENE_TARGET;
}

/** The animation window for the selected object, or for the scene when nothing is selected (select it by clicking
 *  its tab). The pick becomes a new step. */
export function openAnimateWindow(targetId = store.selectedId) {
  const target = animateTarget(targetId);
  openAnimPicker({
    target,
    sub: "Added as a new step",
    onPick: (anim, method) => (target === SCENE_TARGET ? addAction(anim, null) : addStep(anim, method, target)),
  });
}

export async function addWait() {
  const index = store.selectedStep == null ? null : store.selectedStep + 1;
  const i = await sop("add_wait_step", { index });
  if (i !== undefined) {
    store.selectedStep = i;
    emit();
  }
}

// ---------------------------------------------------------------- files
// Every project lives on the server while you work: new projects are added next to the others,
// and Download gives you a copy.

export function resetView() {
  Object.assign(store, { home: false, sceneId: null, selectedId: null, selectedStep: null, preview: null, armed: null });
}

export async function newProject() {
  await sendThumbnail();
  try {
    const res = await post("/api/file/new");
    resetView();
    applyState(res.state);
    status("Started a new project.");
  } catch (err) {
    status(err.message, "error");
  }
}

export function save() {
  const filename = `${store.server.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60) || "project"}.manimator`;
  downloadFromServer("/api/file/download", filename);
  setTimeout(async () => {
    try { applyState(await get("/api/state")); } catch { /* the next edit refreshes it */ }
  }, 400);
  status(`Downloaded ${filename}.`, "ok");
}

/** The project as a zip that renders with Manim: scene.py with the pictures and fonts it uses, and a README. When it
 *  uses other people's customizations, their Python comes with it: say so first. */
export async function exportPython() {
  const kits = store.server?.kits ?? {};
  const others = new Map([...(kits.mobjects ?? []), ...(kits.animations ?? [])]
    .filter((s) => s.kit && s.kit.mine === false && !s.blocked)
    .map((s) => [s.kit.id, `${s.kit.name} by ${s.kit.author || "someone"}`]));
  if (others.size) {
    const ok = await confirmDialog({ title: "This project uses other people's code",
      message: `${[...others.values()].join(", ")}.\n\nThe download has their Python code in its customizations folder. `
        + "Manim runs it on your computer when you render, like any program: read it first if you don't know it.",
      ok: "Download" });
    if (!ok) return;
  }
  const filename = `${store.server.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60) || "project"}.zip`;
  downloadFromServer("/api/file/export.zip", filename);
  status(`Downloaded ${filename}. Unzip it and render with Manim: manim -pq${project().settings.quality} scene.py ${scene().name}`, "ok");
}

// ---------------------------------------------------------------- rendering
// The videos are made here, in the browser (engine/export.js): one per scene, kept as blob URLs that the render
// window plays and downloads. Leaving the page while one is being made asks first.
let renderAbort = null;

export const cancelRender = () => renderAbort?.abort();

const warnLeaving = (e) => {
  e.preventDefault();
  e.returnValue = "";
};

function revokeVideos() {
  for (const v of store.render.videos ?? []) if (v.url) URL.revokeObjectURL(v.url);
}

export async function startRender(scope) {
  if (renderAbort) return; // one at a time
  renderAbort = new AbortController(); // taken before anything is awaited, so a second click can't start another
  let exporter;
  try {
    exporter = await import("./engine/export.js");
  } catch (err) {
    renderAbort = null;
    status(`Render failed: ${err?.message ?? err}`, "error");
    return;
  }
  const sc = scene();
  const label = { preview: `Previewing ${sc.name} (480p)`, scene: `Rendering ${sc.name}`, all: "Rendering all scenes" }[scope];
  revokeVideos();
  if (!exporter.canMakeVideos()) {
    renderAbort = null;
    store.render = { state: "failed", label, step: "", progress: 0, videos: [], lines: [exporter.UNSUPPORTED] };
    store.renderOpen = true;
    emit();
    status(exporter.UNSUPPORTED, "error");
    return;
  }
  const quality = scope === "preview" ? "l" : project().settings.quality;
  store.render = { state: "running", label, step: "Getting the scene ready…", progress: 0, videos: [], lines: [] };
  store.renderOpen = true;
  emit();
  window.addEventListener("beforeunload", warnLeaving);
  let lastEmit = 0;
  let sandbox = null;
  try {
    const res = scope === "all" ? await get("/api/plan?all=1") : await get(`/api/plan?scene_id=${encodeURIComponent(sc.id)}`);
    const plans = scope === "all" ? res.plan.scenes : [res.plan];
    const { BuildCache } = await import("./engine/plan/build.js");
    const { openSandbox, usesKits } = await import("./sandboxed.js");
    sandbox = plans.some(usesKits) ? await openSandbox() : null; // customizations' code runs only there
    const cache = new BuildCache();
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      store.render.step = plans.length > 1 ? `${plan.scene.name} (${i + 1} of ${plans.length})` : "Making the video…";
      emit();
      const options = {
        signal: renderAbort.signal,
        cache,
        fetchAsset: (name) => fetch(`/api/assets/${encodeURIComponent(name)}`, { credentials: "same-origin" }),
        onProgress: (fraction) => {
          store.render.progress = Math.round((100 * (i + fraction)) / plans.length);
          if (performance.now() - lastEmit > 200) {
            lastEmit = performance.now();
            emit();
          }
        },
      };
      const video = usesKits(plan) ? await sandbox.video(plan, quality, options)
        : await exporter.makeVideo(plan, quality, options);
      store.render.videos = [...store.render.videos, { index: i, name: plan.scene.name, url: URL.createObjectURL(video.blob), blob: video.blob,
        filename: `${plan.scene.name}.${video.ext}` }];
    }
    store.render = { ...store.render, state: "done", step: "", progress: 100 };
    store.renderNonce += 1;
    status("Render finished.", "ok");
  } catch (err) {
    const cancelled = err?.name === "AbortError";
    store.render = { ...store.render, state: cancelled ? "cancelled" : "failed", step: "",
      lines: cancelled ? [] : [err?.message ?? String(err)] };
    status(cancelled ? "Render cancelled." : `Render failed: ${err?.message ?? err}`, cancelled ? "info" : "error");
  } finally {
    sandbox?.close();
    renderAbort = null;
    window.removeEventListener("beforeunload", warnLeaving);
    // the editor's engine shares the quality setting: back to the project's
    import("./store.js").then(({ loadEngine }) => loadEngine()).then((e) => e.setQuality(project()?.settings?.quality ?? "h"));
    emit();
  }
}
