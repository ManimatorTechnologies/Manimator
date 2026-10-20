// Coordinate systems, function graphs, braces and tables against Manim (tools/MakeJsFixtures.py: graphing).
// No TeX is involved, so points are compared closely; text (table entries) within 1e-3 as in text.test.mjs.
import { test } from "node:test";
import { fixture, loadDejaVu, mobjectState, sameMobject } from "./helpers.mjs";

await loadDejaVu();
const C = await import("../../manimator/web/js/engine/manim/coordinates.js");
const B = await import("../../manimator/web/js/engine/manim/brace.js");
const M = await import("../../manimator/web/js/engine/manim/matrix.js");
const G = await import("../../manimator/web/js/engine/manim/geometry.js");
const { pyCall } = await import("../../manimator/web/js/engine/manim/pycall.js");

const CLASSES = { ...C, ...B, ...M };
const FUNCTIONS = {
  sin: (x) => Math.sin(x),
  square: (x) => x ** 2 / 4,
  lissajous: (t) => [2 * Math.sin(3 * t), 2 * Math.sin(2 * t), 0],
  circle: (x, y) => x ** 2 + y ** 2 - 4,
  hyperbola: (x, y) => x * y - 1,
};

for (const { case: [cls, args, kwargs], family } of fixture("graphing")) {
  const label = `${cls}(${JSON.stringify(args).slice(1, -1)} ${JSON.stringify(kwargs)})`;
  test(label, () => {
    const values = cls === "Table" ? args : args.map((a) => {
      if (a === "square" && cls.startsWith("Brace")) return G.Square.make();
      return typeof a === "string" ? FUNCTIONS[a] : a;
    });
    const mob = pyCall(CLASSES[cls], values, cls === "Table" ? { ...kwargs, element_to_mobject_config: { font: "DejaVu Sans" } } : kwargs);
    sameMobject(mobjectState(mob), family, cls === "Table" ? 1e-3 : 1e-6, label);
  });
}
