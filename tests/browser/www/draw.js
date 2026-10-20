// Draws objects made from [class, args, kwargs, ...method calls] specs with the browser engine, for
// tools/draw_parity.py (which draws the same specs with Manim).

import * as V from "/static/js/engine/manim/vmobject.js";
import * as G from "/static/js/engine/manim/geometry.js";
import * as T from "/static/js/engine/manim/text.js";
import * as X from "/static/js/engine/manim/tex.js";
import * as N from "/static/js/engine/manim/numbers.js";
import { hasTexRequests, renderTexRequests } from "/static/js/engine/manim/texcache.js";
import { ensureFonts, loadFonts, setDefaultFamily } from "/static/js/engine/manim/fonts.js";
import { loadOpentype } from "/static/js/engine/mw/lib.js";
import { pyCall } from "/static/js/engine/manim/pycall.js";
import { callMethod } from "/static/js/engine/manim/pymethods.js";
import { Camera } from "/static/js/engine/render/canvas.js";

const CLASSES = { ...V, ...G, ...T, ...X, ...N };
const FUNCS = { wave: (p) => [p[0] + 0.0, p[1] + 0.3 * Math.sin(2 * p[0]), p[2] + 0.0] };
const value = (v) => (typeof v === "string" && v.endsWith("Tip") ? G.TIP_SHAPES[v] : FUNCS[v] ?? v);
const values = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));

function build([cls, args, kwargs, ...calls]) {
  const mob = pyCall(CLASSES[cls], args.map(value), values(kwargs));
  for (const [method, cargs, ckwargs] of calls) callMethod(mob, method, cargs.map(value), values(ckwargs));
  return mob;
}

// Manim draws with DejaVu Sans (the only font its Pango had on the server)
setDefaultFamily("DejaVu Sans");
await loadFonts("/static/fonts", await loadOpentype());
await ensureFonts({ objects: [{ call: { kwargs: { font: "monospace" } } }, { call: { kwargs: { font: "serif" } } }] });

window.harness = {
  ready: true,
  /** Draws every spec's object in one picture; returns the PNG (a data URL) and each object's box. */
  async draw(specs, { width = 1280, height = 720 } = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const t0 = performance.now();
    let mobs;
    for (;;) { // build; formulas not rendered yet come out empty (and may break a pass): render them and rebuild
      try {
        mobs = specs.map(build);
      } catch (e) {
        if (!hasTexRequests()) throw e;
      }
      if (!hasTexRequests()) break;
      await renderTexRequests();
    }
    new Camera({ pixel_width: width, pixel_height: height }).render(ctx, mobs);
    const ms = performance.now() - t0;
    const boxes = mobs.map((m) => [...m.get_corner([-1, -1, 0]).slice(0, 2), ...m.get_corner([1, 1, 0]).slice(0, 2)]);
    return { png: canvas.toDataURL("image/png"), ms, boxes };
  },
};
document.getElementById("log").textContent = "ready";
