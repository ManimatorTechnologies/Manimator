// Code against Manim (tools/make_js_fixtures.py: code), with the server's Pygments colours as the scene plan
// carries them. Text tolerance as in text.test.mjs.
import { test } from "node:test";
import { fixture, loadDejaVu, mobjectState, sameMobject } from "./helpers.mjs";

await loadDejaVu();
const { Code } = await import("../../manimator/web/js/engine/manim/code.js");

for (const { case: kwargs, highlight, family } of fixture("code")) {
  const label = `Code(${JSON.stringify(kwargs)})`;
  test(label, () => {
    const mob = Code.make({ ...kwargs, highlight, paragraph_config: { font: "DejaVu Sans Mono" } });
    sameMobject(mobjectState(mob), family, 1e-3, label);
  });
}
