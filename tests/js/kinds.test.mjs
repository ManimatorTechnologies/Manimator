// Every scene kind (the golden actions and settings projects) played by the timeline, frame by frame as Manim
// writes them, against Manim playing the generated Python (tools/make_js_fixtures.py: kinds): at the first, middle
// and last frame of every play, the camera (frame, or 3D angles) and what it draws, object by object: points as the
// camera transforms them (3D projection), colours as it shades them; for a ZoomedScene also the zoomed camera.
//
// Formula pieces are compared as a block by where they are (MathJax lays out like TeX, not identically), and in a
// scene with formulas, objects placed by them get LOOSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { close, fixture, loadDejaVu } from "./helpers.mjs";

await loadDejaVu();
const mj = await import("../../manimator/web/js/engine/mw/mathjax.js");
mj.setFontRangeReader(async (url) => JSON.parse(readFileSync(new URL(url), "utf8")));
const { resources } = await import("../../manimator/web/js/engine/manim/resources.js");
const { config } = await import("../../manimator/web/js/engine/manim/config.js");
const { SingleStringMathTex } = await import("../../manimator/web/js/engine/manim/tex.js");
const { buildObjects } = await import("../../manimator/web/js/engine/plan/build.js");
const { Timeline } = await import("../../manimator/web/js/engine/scene/timeline.js");
const { ThreeDCamera, MultiCamera } = await import("../../manimator/web/js/engine/scene/cameras.js");

const data = fixture("kinds");
const fps = data.fps;
config.frame_rate = fps;
resources.put("text", data.files.SVGMobject, data.svg);
const [pw, ph] = data.picture;
resources.put("image", data.files.ImageMobject, { width: pw, height: ph, data: new Uint8ClampedArray(pw * ph * 4) });

const TOL = 1e-3;
const LOOSE = 0.05;

const texInit = SingleStringMathTex.prototype.__init__;
SingleStringMathTex.prototype.__init__ = function marked(kw) {
  const out = texInit.call(this, kw);
  for (const m of this.get_family()) m._tex = true;
  return out;
};

function cameraState(m, camera) {
  const entry = { cls: m.constructor.name, points: camera.transform_points_pre_display(m, m.points) };
  if (m._tex) entry.tex = true;
  if (m.get_fill_rgbas) {
    Object.assign(entry, { fill: camera.get_fill_rgbas(m), stroke: camera.get_stroke_rgbas(m),
      stroke_width: m.get_stroke_width(), background_stroke: camera.get_stroke_rgbas(m, true),
      background_stroke_width: m.get_stroke_width(true) });
  }
  return entry;
}

function collapse(entries) {
  const out = [];
  for (const e of entries) {
    if (!e.tex) {
      out.push(e);
      continue;
    }
    let last = out[out.length - 1];
    if (!last || last.cls !== "TEX") {
      last = { cls: "TEX", pts: [], fill: e.fill };
      out.push(last);
    }
    last.pts.push(...e.points);
  }
  for (const e of out) {
    if (e.cls !== "TEX") continue;
    const xs = e.pts.map((p) => p[0]);
    const ys = e.pts.map((p) => p[1]);
    e.box = e.pts.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
    delete e.pts;
  }
  return out;
}

function compareList(ours, ref, where, loose) {
  const a = collapse(ours);
  const b = collapse(ref);
  assert.deepEqual(a.map((e) => e.cls), b.map((e) => e.cls), `${where}: drawn objects`);
  b.forEach((e, i) => {
    const g = a[i];
    const at = `${where} #${i} ${e.cls}`;
    if (e.cls === "TEX") {
      if (!e.box || !g.box) return assert.equal(!!g.box, !!e.box, `${at}: has points`);
      // where it is (while a formula is being written, its pieces are their outlines' start points, which
      // differ between the fonts)
      const size = Math.max(e.box[2] - e.box[0], e.box[3] - e.box[1]);
      const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      close(mid(g.box), mid(e.box), 0.35 + 0.04 * size, `${at} centre`);
      return undefined;
    }
    try {
      close(g.points, e.points, TOL, `${at}.points`);
    } catch (err) {
      if (!loose) throw err;
      close(g.points, e.points, LOOSE, `${at}.points (loose)`);
    }
    for (const key of ["fill", "stroke", "stroke_width", "background_stroke", "background_stroke_width"]) {
      if (key in e) close(g[key], e[key], TOL, `${at}.${key}`);
    }
    return undefined;
  });
}

function infoNow(timeline) {
  const { scene } = timeline.world;
  const { camera } = scene;
  const [still, over] = scene.frame_layers();
  let cam;
  if (camera instanceof ThreeDCamera) {
    camera.reset_rotation_matrix();
    cam = { phi: camera.get_phi(), theta: camera.get_theta(), gamma: camera.get_gamma(), zoom: camera.get_zoom(),
      focal: camera.get_focal_distance(), center: [...camera.frame_center] };
  } else {
    cam = { center: [...camera.frame_center], width: camera.frame_width, height: camera.frame_height };
  }
  const show = (list) => (list ? camera.get_mobjects_to_display(list).map((m) => cameraState(m, camera)) : []);
  const out = { camera: cam, layers: [show(still), show(over)] };
  if (camera instanceof MultiCamera) {
    out.zoomed = camera.image_mobjects_from_cameras.map((imfc) => {
      const sub = imfc.camera;
      const own = new Set(imfc.get_family());
      const toAdd = over.filter((m) => !own.has(m));
      return { center: [...sub.frame_center], width: sub.frame_width, height: sub.frame_height,
        drawn: sub.get_mobjects_to_display(toAdd).map((m) => cameraState(m, sub)) };
    });
  }
  return out;
}

function compareInfo(ours, ref, where, loose) {
  for (const [k, v] of Object.entries(ref.camera)) close(ours.camera[k], v, 1e-6, `${where} camera.${k}`);
  compareList(ours.layers[0], ref.layers[0], `${where} still`, loose);
  compareList(ours.layers[1], ref.layers[1], `${where} over`, loose);
  if (ref.zoomed) {
    assert.equal(ours.zoomed?.length, ref.zoomed.length, `${where}: zoomed cameras`);
    ref.zoomed.forEach((z, i) => {
      const g = ours.zoomed[i];
      for (const k of ["center", "width", "height"]) close(g[k], z[k], 1e-6, `${where} zoomed.${k}`);
      compareList(g.drawn, z.drawn, `${where} zoomed`, loose);
    });
  }
}

for (const sc of data.scenes) {
  const loose = JSON.stringify(sc.frames).includes('"tex":true') || JSON.stringify(sc.end).includes('"tex":true');
  test(`${sc.name} (${sc.kind})`, async (t) => {
    const built = await buildObjects(sc.plan);
    const timeline = new Timeline(sc.plan, built);
    await timeline.prepare();
    const wanted = new Map(sc.frames.map((f) => [`${f[0]}:${f[1]}`, f]));
    const seen = new Set();
    let checked = 0;
    for (const f of timeline.frames(fps)) {
      const key = `${f.play}:${f.frame}`;
      const ref = wanted.get(key);
      if (!ref || seen.has(key)) continue;
      seen.add(key);
      const where = `play ${f.play} frame ${f.frame}/${ref[2]}`;
      if (f.count === 1) {
        const n = Math.ceil(timeline.world.scene.duration / (1 / fps));
        assert.equal(n, ref[2], `${where}: frames in the play`);
      } else {
        assert.equal(f.count, ref[2], `${where}: still frames`);
      }
      compareInfo(infoNow(timeline), ref[3], where, loose);
      checked += 1;
    }
    assert.deepEqual(Object.values(timeline.errors), [], "step errors");
    assert.equal(checked, sc.frames.length, `frames checked (missing: ${[...wanted.keys()].filter((k) => !seen.has(k)).join(" ")})`);
    // the end: after every step
    timeline.world.scene.playing = null;
    compareInfo(infoNow(timeline), sc.end, "end", loose);
    t.diagnostic(`${checked} frames`);
  });
}
