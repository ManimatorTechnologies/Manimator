import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { rateFunction } from "../../manimator/web/js/engine/core/rates.js";

test("rate functions match Manim's", () => {
  const { t, values } = fixture("rates");
  for (const [name, expected] of Object.entries(values)) {
    const f = rateFunction(name);
    t.forEach((x, i) => {
      assert.ok(Math.abs(f(x) - expected[i]) < 1e-12, `${name}(${x}) = ${f(x)}, Manim ${expected[i]}`);
    });
  }
});
