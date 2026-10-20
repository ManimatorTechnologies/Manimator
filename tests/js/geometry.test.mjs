import { test } from "node:test";
import { fixture, mobjectState, sameMobject } from "./helpers.mjs";
import * as G from "../../manimator/web/js/engine/manim/geometry.js";
import * as V from "../../manimator/web/js/engine/manim/vmobject.js";
import { pyCall } from "../../manimator/web/js/engine/manim/pycall.js";
import { callMethod } from "../../manimator/web/js/engine/manim/pymethods.js";

const CLASSES = { ...V, ...G };
const FUNCS = { wave: (p) => [p[0] + 0.0, p[1] + 0.3 * Math.sin(2 * p[0]), p[2] + 0.0] };
const value = (v) => (typeof v === "string" && v.endsWith("Tip") ? G.TIP_SHAPES[v] : FUNCS[v] ?? v);
const values = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));

for (const { case: [cls, args, kwargs, ...calls], family } of fixture("geometry")) {
  const name = `${cls}(${JSON.stringify(args).slice(1, -1)} ${JSON.stringify(kwargs)})${calls.map((c) => `.${c[0]}`).join("")}`;
  test(name, () => {
    const mob = pyCall(CLASSES[cls], args.map(value), values(kwargs));
    for (const [method, cargs, ckwargs] of calls) callMethod(mob, method, cargs.map(value), values(ckwargs));
    sameMobject(mobjectState(mob), family, 1e-9, name);
  });
}
