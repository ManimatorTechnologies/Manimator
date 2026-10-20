// 3D objects against Manim (tools/MakeJsFixtures.py: three_d): every face's points and style, and shade_in_3d.
import { test } from "node:test";
import { fixture, mobjectState, sameMobject } from "./helpers.mjs";

const D = await import("../../manimator/web/js/engine/manim/ThreeD.js");
const { pyCall } = await import("../../manimator/web/js/engine/manim/pycall.js");

const FUNCTIONS = { saddle: (u, v) => [u, v, 0.25 * (u ** 2 - v ** 2)] };

for (const { case: [cls, args, kwargs], family } of fixture("three_d")) {
  const label = `${cls}(${JSON.stringify(args).slice(1, -1)} ${JSON.stringify(kwargs)})`;
  test(label, () => {
    const mob = pyCall(D[cls], args.map((a) => FUNCTIONS[a] ?? a), kwargs);
    const state = mobjectState(mob).map((e, i) => ({ ...e, shade_in_3d: Boolean(mob.get_family()[i].shade_in_3d) }));
    sameMobject(state, family, 1e-6, label);
  });
}
