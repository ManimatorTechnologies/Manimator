// MathTex and friends against Manim with real LaTeX. MathJax lays formulas out like TeX but not identically: its
// font is New Computer Modern (LaTeX's is Latin Modern: same glyphs, a few different metrics), and where TeX builds
// a symbol from pieces (\neq, \notin, \iff, \ldots, \iint, extensible delimiters, arrows and braces) MathJax uses
// one glyph. So sizes are compared within TOL units and part boxes within BOX units, glyph counts and colours must
// match, and the formulas with built-up symbols (KNOWN) only need to come out about the right size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./helpers.mjs";

const mj = await import("../../manimator/web/js/engine/mw/mathjax.js");
mj.setFontRangeReader(async (url) => JSON.parse(readFileSync(new URL(url), "utf8")));
const T = await import("../../manimator/web/js/engine/manim/tex.js");
const { pyCall } = await import("../../manimator/web/js/engine/manim/pycall.js");
const { hasTexRequests, renderTexRequests } = await import("../../manimator/web/js/engine/manim/texcache.js");

const TOL = 0.06;
const BOX = 0.1;
const KNOWN = /\\(iint|vmatrix|vec|overrightarrow|underbrace|neq|notin|iff|ldots|cdots|xrightarrow|left|lVert|begin\{cases|begin\{aligned|pm|binom|sum|lim|nabla|prod|bigcup)|\{(vmatrix|cases|aligned)\}/;
const cases = fixture("tex");

/** Builds every case, rendering the formulas they ask for, until nothing is missing (the engine's build loop). */
async function buildAll() {
  for (;;) {
    const built = cases.map(({ case: [cls, args, kwargs] }) => {
      try {
        return pyCall(T[cls], args, kwargs);
      } catch (e) {
        return e;
      }
    });
    if (!hasTexRequests()) return built;
    await renderTexRequests();
  }
}
const built = await buildAll();

cases.forEach((ref, i) => {
  const label = `${ref.case[0]}(${JSON.stringify(ref.case[1]).slice(1, -1)})`;
  test(label, () => {
    const mob = built[i];
    if (ref.error) {
      assert.ok(mob instanceof Error, `Manim failed (${ref.error}); the engine didn't`);
      return;
    }
    assert.ok(!(mob instanceof Error), `${mob?.message}`);
    if (KNOWN.test(ref.case[1].join(" "))) {
      assert.ok(Math.abs(mob.width / ref.width - 1) < 0.15, `width ${mob.width} vs ${ref.width}`);
      assert.ok(Math.abs(mob.height / ref.height - 1) < 0.3, `height ${mob.height} vs ${ref.height}`);
      return;
    }
    assert.equal(mob.family_members_with_points().length, ref.glyphs, "glyphs");
    const tol = (size) => Math.max(TOL, 0.03 * size);
    assert.ok(Math.abs(mob.width - ref.width) < tol(ref.width), `width ${mob.width} vs ${ref.width}`);
    assert.ok(Math.abs(mob.height - ref.height) < tol(ref.height), `height ${mob.height} vs ${ref.height}`);
    assert.equal(mob.submobjects.length, ref.parts.length, "parts");
    mob.submobjects.forEach((p, k) => {
      const box = [...p.get_corner([-1, -1, 0]).slice(0, 2), ...p.get_corner([1, 1, 0]).slice(0, 2)];
      box.forEach((v, j) => assert.ok(Math.abs(v - ref.parts[k][j]) < BOX, `part ${k} box ${box} vs ${ref.parts[k]}`));
    });
    assert.deepEqual(mob.family_members_with_points().map((m) => m.get_fill_color().to_hex()), ref.colors, "colours");
  });
});
