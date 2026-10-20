import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, fixture, mobjectState, sameMobject } from "./helpers.mjs";
import { SVGMobject } from "../../manimator/web/js/engine/manim/svg.js";

const folder = join(ROOT, "tests", "js", "fixtures", "svg");

for (const { case: [name, kwargs], family } of fixture("svg")) {
  const label = `SVGMobject(${name}, ${JSON.stringify(kwargs)})`;
  test(label, () => {
    const mob = SVGMobject.make({ ...kwargs, file_name: name, svg_text: readFileSync(join(folder, name), "utf8") });
    sameMobject(mobjectState(mob), family, 1e-9, label);
  });
}
