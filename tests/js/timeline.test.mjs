// Golden projects played by the timeline (scene/timeline.js) against Manim playing their generated Python
// (tools/make_js_fixtures.py: timeline): at the first, middle and last frame of every step, and at the end, what is
// drawn — the still picture's objects, then the objects over it — object by object, in drawing order.
//
// Formula pieces (MathJax lays out like TeX, not identically) are compared as a block by their extent; the rest
// point by point and colour by colour, within text's tolerance. In a scene with formulas, objects placed by them
// (a box around one, axes with numbers) may be off by as much as the formulas are: those get LOOSE.
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

const data = fixture("timeline");
const fps = data.fps;
config.frame_rate = fps;
resources.put("text", data.files.SVGMobject, data.svg);
const [pw, ph] = data.picture;
resources.put("image", data.files.ImageMobject, { width: pw, height: ph, data: new Uint8ClampedArray(pw * ph * 4) });

const TOL = 1e-3;
const LOOSE = 0.05;

// Formula pieces are marked when made; copies keep the mark (as the fixture marks them in Manim).
const texInit = SingleStringMathTex.prototype.__init__;
SingleStringMathTex.prototype.__init__ = function marked(kw) {
  const out = texInit.call(this, kw);
  for (const m of this.get_family()) m._tex = true;
  return out;
};
let looseUsed = 0;
const looseWhere = new Map();

function drawState(m, tex) {
  const entry = { cls: m.constructor.name, points: m.points };
  if (tex) entry.tex = true;
  if (m.get_fill_rgbas) {
    Object.assign(entry, { fill: m.get_fill_rgbas(), stroke: m.get_stroke_rgbas(), stroke_width: m.get_stroke_width(),
      background_stroke: m.get_stroke_rgbas(true), background_stroke_width: m.get_stroke_width(true) });
  }
  return entry;
}

/** Runs of formula pieces become one entry: their extent and how many there are. */
function collapse(entries) {
  const out = [];
  for (const e of entries) {
    if (!e.tex) {
      out.push(e);
      continue;
    }
    let last = out[out.length - 1];
    if (!last || last.cls !== "TEX") {
      last = { cls: "TEX", pts: [], n: 0, fill: e.fill };
      out.push(last);
    }
    last.pts.push(...e.points);
    last.n += 1;
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

function compareLayer(ours, ref, where, loose = false) {
  const a = collapse(ours);
  const b = collapse(ref);
  assert.deepEqual(a.map((e) => e.cls), b.map((e) => e.cls), `${where}: drawn objects`);
  b.forEach((e, i) => {
    const g = a[i];
    const at = `${where} #${i} ${e.cls}`;
    if (e.cls === "TEX") {
      if (!e.box || !g.box) return assert.equal(!!g.box, !!e.box, `${at}: has points`);
      const size = Math.max(e.box[2] - e.box[0], e.box[3] - e.box[1]);
      close(g.box, e.box, 0.08 + 0.04 * size, `${at} box`);
      if (e.fill) close(g.fill[0], e.fill[0], 0.02, `${at} fill`);
      return undefined;
    }
    try {
      close(g.points, e.points, TOL, `${at}.points`);
    } catch (err) {
      if (!loose) throw err;
      close(g.points, e.points, LOOSE, `${at}.points (loose)`);
      looseUsed += 1;
      looseWhere.set(`${where.split(" ")[0]} ${e.cls}`, (looseWhere.get(`${where.split(" ")[0]} ${e.cls}`) ?? 0) + 1);
    }
    for (const key of ["fill", "stroke", "stroke_width", "background_stroke", "background_stroke_width"]) {
      if (key in e) close(g[key], e[key], TOL, `${at}.${key}`);
    }
    return undefined;
  });
}

function layersNow(timeline) {
  const { scene } = timeline.world;
  const [still, over] = scene.frame_layers();
  const show = (list) => (list ? scene.camera.get_mobjects_to_display(list).map((m) => drawState(m, m._tex === true)) : []);
  return [show(still), show(over)];
}

for (const sc of data.scenes) {
  const built = await buildObjects(sc.plan);
  const timeline = new Timeline(sc.plan, built);
  await timeline.prepare();
  const loose = JSON.stringify(sc.frames).includes('"tex":true');
  const steps = sc.plan.steps.length;
  for (const [play, frame, n, layers] of steps ? sc.frames : []) {
    test(`${sc.name} step ${play} frame ${frame}/${n}`, () => {
      timeline.goto(play, frame * (1 / fps)); // np.arange: i * step
      const { scene } = timeline.world;
      assert.equal(timeline.errors[play], undefined, `step error: ${timeline.errors[play]}`);
      const frozen = scene.playing?.frozen;
      const count = frozen ? Math.trunc(scene.duration / (1 / fps)) : Math.ceil(scene.duration / (1 / fps));
      assert.equal(count, n, "frames in the step");
      const [still, over] = layersNow(timeline);
      compareLayer(still, layers[0], `${sc.name}:${play} still`, loose);
      compareLayer(over, layers[1], `${sc.name}:${play} over`, loose);
    });
  }
  test(`${sc.name} end`, () => {
    timeline.seek(timeline.duration);
    const [, over] = layersNow(timeline);
    compareLayer(over, sc.end[1], "end", loose);
  });
}
test("objects compared loosely", () => console.log(`${looseUsed} drawn objects needed the loose tolerance`, [...looseWhere]));

// The order objects are drawn in before each step and at the end equals the plan's (ops.screen_orders, itself
// checked against Manim by tests/test_screen_orders.py).
const { extractMobjectFamilyMembers } = await import("../../manimator/web/js/engine/scene/scene.js");
for (const sc of data.scenes) {
  test(`${sc.name} drawing order`, async () => {
    const built = await buildObjects(sc.plan);
    const timeline = new Timeline(sc.plan, built);
    const tops = [...new Set(sc.plan.screen_orders.flat())];
    const order = (world) => {
      const family = extractMobjectFamilyMembers(world.scene.mobjects, false);
      const where = new Map();
      for (const id of tops) {
        const at = family.indexOf(world.objects.get(id));
        if (at >= 0) where.set(id, at);
      }
      return [...where.keys()].sort((a, b) => where.get(a) - where.get(b));
    };
    const states = [order(timeline.startWorld())];
    for (let k = 0; k < sc.plan.steps.length; k += 1) {
      timeline.goto(k, 0);
      timeline.finishStep(timeline.world);
      states.push(order(timeline.world));
    }
    assert.deepEqual(states, sc.plan.screen_orders);
  });
}
