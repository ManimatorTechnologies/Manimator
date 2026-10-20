// Every object of the golden "all objects" projects (2D and 3D, default and changed parameters), built from the
// scene plan the browser receives, against the same object made by the generated Python in Manim
// (tools/MakeJsFixtures.py: objects). Objects with TeX are compared by size and place (MathJax lays out like TeX,
// not identically), and so is italic text (the reference Manim runs on Windows, which slants text its own way; see
// text.test.mjs); the rest point by point, within text's tolerance (scaled with the object).
//
// Manim keeps every SVG it made for the rest of the process, and a repeated one isn't flipped as a whole: the
// fixture builds the four projects in one process, so its group's own sheen direction (which draws nothing) isn't
// compared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { close, fixture, loadDejaVu, mobjectState, sameMobject } from "./helpers.mjs";

await loadDejaVu();
const mj = await import("../../manimator/web/js/engine/mw/mathjax.js");
mj.setFontRangeReader(async (url) => JSON.parse(readFileSync(new URL(url), "utf8")));
const { resources } = await import("../../manimator/web/js/engine/manim/resources.js");
const { buildObjects } = await import("../../manimator/web/js/engine/plan/build.js");
const { SVGMobject } = await import("../../manimator/web/js/engine/manim/svg.js");

const data = fixture("objects");
resources.put("text", data.files.SVGMobject, data.svg);
const [w, h] = data.picture;
resources.put("image", data.files.ImageMobject, { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

for (const { variant, three_d: threeD, plan, states } of data.projects) {
  // as the fixture does, each object's state is taken when it is made (a later object may change it: Cutout)
  const made = new Map();
  const built = await buildObjects(plan, {
    onBuilt: (id, mob) => made.set(id, { state: mobjectState(mob), width: mob.width, height: mob.height,
      center: mob.get_center(), svg: mob instanceof SVGMobject }),
  });
  for (const obj of plan.objects) {
    const ref = states[obj.id];
    if (!ref) continue;
    test(`${threeD ? "3D " : ""}${variant ? "changed " : ""}${obj.type} ${obj.id}`, () => {
      const got = built.get(obj.id);
      if (ref.error) {
        assert.ok(got.error, `Manim failed (${ref.error}); the engine didn't`);
        return;
      }
      assert.equal(got.error, null, got.error ?? "");
      const mob = made.get(obj.id);
      const italic = /ITALIC|<i>/.test(JSON.stringify(obj.call));
      if (ref.tex || italic) {
        const tol = (v) => 0.08 + 0.04 * Math.abs(v);
        assert.ok(Math.abs(mob.width - ref.width) < tol(ref.width), `width ${mob.width} vs ${ref.width}`);
        assert.ok(Math.abs(mob.height - ref.height) < tol(ref.height), `height ${mob.height} vs ${ref.height}`);
        close(mob.center, ref.center, 0.1, "center");
        return;
      }
      const state = mob.state.map((m, i) => (i === 0 && mob.svg ? { ...m, sheen_direction: ref.family[0].sheen_direction } : m));
      const scale = Math.max(1, ...(obj.post ?? []).filter((p) => p.call === "scale").map((p) => p.args[0]));
      sameMobject(state, ref.family, 1e-3 * scale, obj.id);
    });
  }
}
