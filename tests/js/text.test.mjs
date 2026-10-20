import { test } from "node:test";
import assert from "node:assert/strict";
import { close, fixture, loadDejaVu, mobjectState, sameMobject } from "./helpers.mjs";

await loadDejaVu();
const { Text } = await import("../../manimator/web/js/engine/manim/text.js");

// The reference is Manim on Windows, whose Pango uses the Windows font backend. Its outlines sit on the same 1/256 px
// grid with an occasional step's difference, and the width it gives each styled run differs by a few 1/1024 px, so
// points are compared within 1e-3 (0.15 px at 1080p). Windows also slants italic text its own way, where the
// server's fontconfig (and the engine) shears by 0.2: italic cases are compared by size only. It also rounds the
// offsets of composite glyphs (accented letters) to whole pixels, which the server's unhinted FreeType doesn't.
for (const { case: kwargs, family } of fixture("text")) {
  const label = `Text(${JSON.stringify(kwargs)})`;
  const italic = JSON.stringify(kwargs).includes("ITALIC");
  const tol = /[éàüñç]/.test(kwargs.text) ? 3e-3 : 1e-3;
  test(label, () => {
    const ours = mobjectState(Text.make({ font: "DejaVu Sans", ...kwargs }));
    if (!italic) {
      sameMobject(ours, family, tol, label);
      return;
    }
    assert.deepEqual(ours.map((e) => e.cls), family.map((e) => e.cls), label);
    const box = (pts) => [0, 1].flatMap((d) => [Math.min(...pts.map((p) => p[d])), Math.max(...pts.map((p) => p[d]))]);
    const all = (state) => state.flatMap((e) => e.points);
    close(box(all(ours)), box(all(family)), 0.03, `${label} box`);
  });
}
