// MarkupText against Manim (tools/MakeJsFixtures.py: markup). Tolerance as for Text; italic is slanted differently
// on Windows (see text.test.mjs), so text with <i> is compared by its classes and size only. Underlines and
// strikethroughs span a run's max(ink, logical) width: on Linux that is the logical width (what the engine draws),
// while Windows' ink boxes stick out by up to a pixel, so those cases get 0.05.
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, fixture, loadDejaVu, mobjectState, sameMobject } from "./helpers.mjs";

await loadDejaVu();
const { MarkupText } = await import("../../manimator/web/js/engine/manim/markup.js");

for (const { case: kwargs, family } of fixture("markup")) {
  const label = `MarkupText(${JSON.stringify(kwargs)})`;
  test(label, () => {
    const ours = mobjectState(MarkupText.make({ font: "DejaVu Sans", ...kwargs }));
    if (!kwargs.text.includes("<i>")) {
      sameMobject(ours, family, /<[us]>/.test(kwargs.text) ? 0.05 : 1e-3, label);
      return;
    }
    assert.deepEqual(ours.map((e) => e.cls), family.map((e) => e.cls), label);
    const box = (s) => [0, 1].flatMap((d) => [Math.min(...s.flatMap((e) => e.points).map((p) => p[d])),
      Math.max(...s.flatMap((e) => e.points).map((p) => p[d]))]);
    close(box(ours), box(family), 0.06, `${label} box`);
  });
}
