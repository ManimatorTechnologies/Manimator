// The browser engine: builds a scene plan (GET /api/plan) with the port of Manim and draws it on a canvas: the
// editor's picture of the scene's start (as the server's preview drew it), or any moment of the video.
//
//   const engine = await createEngine({ canvas });
//   const { boxes, errors, view, scene_error } = await engine.show(plan);
//   engine.drag(id, dx, dy);   // draws an object moved (while it is dragged), until drag(null)
//   engine.renderAt(t);        // draws the video at t seconds now; renderAt(null): the editor's picture again
//   engine.play(from, onTime); // plays from `from` seconds in real time; engine.stop()
//   engine.resize(w, h);       // pixel size; redraws
//   await engine.snapshotPNG({ width: 640, height: 360 });
//   engine.dispose();

import { config, setQuality } from "./manim/config.js";
import { loadFonts } from "./manim/fonts.js";
import { loadOpentype } from "./mw/lib.js";
import { BuildCache, buildObjects, loadPlanAssets } from "./plan/build.js";
import { MovingCamera, ThreeDCamera } from "./scene/cameras.js";
import { Timeline } from "./scene/timeline.js";

let fontsReady = null;
const fonts = (url) => (fontsReady ??= loadOpentype().then((opentype) => loadFonts(url, opentype)));

const defaultFetchAsset = (name) => fetch(`/api/assets/${encodeURIComponent(name)}`, { credentials: "same-origin" });

/** Where an object is drawn, in scene units: [xmin, ymin, xmax, ymax]; through a 3D camera, after projecting it
 *  (as the server's preview measured it). */
function box(mob, camera) {
  let b;
  if (camera instanceof ThreeDCamera) {
    const pts = mob.family_members_with_points().flatMap((m) => camera.transform_points_pre_display(m, m.points));
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  } else {
    const [x0, y0] = mob.get_corner([-1, -1, 0]);
    const [x1, y1] = mob.get_corner([1, 1, 0]);
    b = [x0, y0, x1, y1];
  }
  return b.every(Number.isFinite) ? b : null;
}

/** The part of the scene the picture shows: [centre x, centre y, width] (a moved or zoomed 2D camera). */
function viewOf(camera) {
  if (camera instanceof MovingCamera) {
    const c = camera.frame.get_center();
    return [c[0], c[1], camera.frame.width];
  }
  return [0, 0, config.frame_width];
}

export async function createEngine({ canvas = null, fontsUrl = "/static/fonts", fetchAsset = defaultFetchAsset } = {}) {
  await fonts(fontsUrl.replace(/\/dejavu\/?$/, "")); // (older pages named the DejaVu folder)
  const cache = new BuildCache();
  let target = canvas;
  let shown = null; // { plan, timeline, layout (the editor's picture), view }
  let dragging = null; // { id, applied: [dx, dy] }
  let time = null; // null: the editor's picture; else the moment of the video drawn
  let frameRequest = 0;
  let token = 0;
  let player = null; // { raf, start, from, onTime }

  /** Draws at the next screen refresh (once, however often it is asked). */
  function drawSoon() {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      draw();
    });
  }

  function draw(cnv = target, { width = cnv?.width, height = cnv?.height, layout = time === null } = {}) {
    if (!cnv || !shown || !width || !height) return;
    const ctx = cnv.getContext("2d");
    if (layout) Timeline.renderLayout(shown.layout, ctx, width, height);
    else shown.timeline.render(ctx, width, height);
  }

  function stopPlayer() {
    if (player) cancelAnimationFrame(player.raf);
    player = null;
  }

  const engine = {
    get canvas() {
      return target;
    },

    /** The shown scene's length in seconds. */
    get duration() {
      return shown?.timeline.duration ?? 0;
    },

    /** The moment drawn (null: the editor's picture). */
    get time() {
      return time;
    },

    get playing() {
      return player !== null;
    },

    /** The video quality (l, m, h, p, k): its frame rate is the one animations are stepped at. */
    setQuality(q) {
      setQuality(q);
    },

    /** Draws onto `cnv` from now on. */
    attach(cnv) {
      target = cnv;
      draw();
    },

    /** Builds the plan's objects and draws the scene's starting layout (`draw: false`: draws nothing, the canvas
     *  keeps its picture until renderAt(), as presenting wants). Resolves with what the editor needs:
     *  each object's box and error, the part of the scene shown ([center x, center y, width]), the scene's error.
     *  Resolves with null when a newer show() started meanwhile. */
    async show(plan, { draw = true } = {}) {
      const mine = ++token;
      try {
        await loadPlanAssets(plan, fetchAsset);
      } catch (e) {
        // a missing upload: the objects using it report it when they are built
        console.warn("engine: assets", e);
      }
      const built = await buildObjects(plan, { cache });
      if (mine !== token) return null;
      const timeline = new Timeline(plan, built);
      await timeline.prepare({ all: false }); // formulas the scene's own setup makes
      if (mine !== token) return null;
      const layout = timeline.layoutWorld();
      const { camera } = layout.scene;
      camera.reset_rotation_matrix?.();
      const errors = {};
      const boxes = {};
      for (const [id, entry] of built) {
        if (entry.error) errors[id] = entry.error;
        else if (entry.mobject) {
          try {
            const b = box(layout.objects.get(id), camera);
            if (b) boxes[id] = b;
          } catch {
            // no box: it can't be picked on the canvas
          }
        }
      }
      stopPlayer();
      shown = { plan, timeline, layout, view: viewOf(camera), ready: null };
      dragging = null;
      time = null;
      if (draw) drawSoon(); // after the editor has had a chance to move a dragged object (drag())
      return { scene_id: plan.scene?.id, boxes, errors, view: shown.view, scene_error: timeline.setupError,
        duration: timeline.duration };
    },

    /** Draws object `id` moved by (dx, dy) scene units from where the shown plan has it (null: as built), at most
     *  once per screen refresh. It stays moved until drag(null) or the next show(). */
    drag(id, dx = 0, dy = 0) {
      if (!shown) return;
      const move = (entry, x, y) => shown.layout.objects.get(entry.id)?.shift([x, y, 0]);
      if (dragging && (id !== dragging.id || id == null)) {
        move(dragging, -dragging.applied[0], -dragging.applied[1]);
        dragging = null;
      }
      if (id != null) {
        dragging ??= { id, applied: [0, 0] };
        move(dragging, dx - dragging.applied[0], dy - dragging.applied[1]);
        dragging.applied = [dx, dy];
      }
      if (time === null) drawSoon();
    },

    /** Renders the formulas the video makes as it plays (once per shown plan); call before playing or seeking. */
    prepare() {
      if (!shown) return Promise.resolve();
      shown.ready ??= shown.timeline.prepare();
      return shown.ready;
    },

    /** Draws the video at `t` seconds now (null: the editor's picture). */
    renderAt(t) {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      time = t === null || t === undefined ? null : Math.min(Math.max(0, t), engine.duration);
      if (shown && time !== null) shown.timeline.seek(time);
      draw();
    },

    /** Plays the video from `from` seconds, in real time; onTime(t, ended) after each frame drawn. */
    play(from = 0, onTime = () => {}) {
      stopPlayer();
      if (!shown) return;
      const start = performance.now();
      const startAt = from >= engine.duration ? 0 : from;
      const tick = () => {
        const t = startAt + (performance.now() - start) / 1000;
        const ended = t >= engine.duration;
        engine.renderAt(ended ? engine.duration : t);
        if (ended) player = null;
        else player.raf = requestAnimationFrame(tick);
        onTime(time, ended);
      };
      player = { raf: requestAnimationFrame(tick) };
    },

    stop() {
      stopPlayer();
    },

    /** What is on screen at `t` seconds (it becomes the moment drawn): each of the plan's objects drawn then, with its
     *  box, and the part of the scene the camera shows. For checking a video's layout (server/renderer.py). */
    onScreen(t) {
      if (!shown) return null;
      engine.renderAt(t);
      const { scene, objects } = shown.timeline.world;
      const { camera } = scene;
      const drawn = new Set();
      for (const m of [...scene.mobjects, ...scene.foreground_mobjects]) for (const f of m.get_family()) drawn.add(f);
      const items = [];
      for (const [id, mob] of objects) {
        if (!drawn.has(mob)) continue;
        try {
          const b = box(mob, camera);
          if (b) items.push({ id, box: b });
        } catch {
          // nothing to measure
        }
      }
      return { objects: items, view: viewOf(camera) };
    },

    /** The canvas's pixel size. */
    resize(width, height) {
      if (!target) return;
      if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
      }
      draw();
    },

    /** The editor's picture of the scene's start as a PNG blob at another size (project thumbnails). */
    async snapshotPNG({ width = 640, height = 360 } = {}) {
      if (!shown) return null;
      const off = new OffscreenCanvas(width, height);
      draw(off, { width, height, layout: true });
      return off.convertToBlob({ type: "image/png" });
    },

    /** Frees the built objects. */
    dispose() {
      stopPlayer();
      if (frameRequest) cancelAnimationFrame(frameRequest);
      shown = null;
      target = null;
      cache.map.clear();
    },
  };
  return engine;
}
