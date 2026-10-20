// Customizations: the example packages' kit.js (examples/kits/) registered the way the sandbox registers them, built
// from a scene plan and played; their objects match Manim's (the same examples' kit.py), and the "manimator" module
// they import is current. Fixture: tools/MakeKit.py --fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, fixture, loadFontFamilies, mobjectState, sameMobject } from "./helpers.mjs";

await loadFontFamilies("DejaVu Sans");
const { kitApiSource } = await import("../../tools/MakeKitApi.mjs");
const apiNow = kitApiSource(); // before the examples join the engine's tables below
const { registerKitClass } = await import("../../manimator/web/js/engine/kits.js");
const { buildObjects } = await import("../../manimator/web/js/engine/plan/build.js");
const { CLASSES } = await import("../../manimator/web/js/engine/plan/names.js");
const { pyCall } = await import("../../manimator/web/js/engine/manim/pycall.js");
const { Timeline } = await import("../../manimator/web/js/engine/scene/timeline.js");

const API = pathToFileURL(join(ROOT, "manimator", "web", "js", "engine", "KitApi.js")).href;
const dir = mkdtempSync(join(tmpdir(), "kits-"));

/** An example's kit.js as a module (the browser maps "manimator" with an import map; here it is rewritten). */
async function exampleClass(folder) {
  const source = readFileSync(join(ROOT, "examples", "kits", folder, "kit.js"), "utf8");
  const file = join(dir, `${folder}.mjs`);
  writeFileSync(file, source.replaceAll('from "manimator"', `from "${API}"`));
  return (await import(pathToFileURL(file).href)).default;
}

const { plan, manim } = fixture("kits");
for (const kit of plan.kits) registerKitClass(kit, await exampleClass(kit.class === "Battery" ? "battery" : "PopIn"));

test("the manimator module is current with the engine", () => {
  assert.equal(readFileSync(new URL(API), "utf8"), apiNow, "run: node tools/MakeKitApi.mjs");
});

test("the example Battery is Manim's Battery", async () => {
  const built = await buildObjects(plan);
  assert.ok(plan.objects.every((o) => built.get(o.id).error === null && built.get(o.id).mobject));
  // made as the plan makes them (Battery(charge=...)), before the scene places them
  sameMobject(mobjectState(pyCall(CLASSES.Battery, [], { charge: 0.7 })), manim.battery_full, 1e-9, "full");
  sameMobject(mobjectState(pyCall(CLASSES.Battery, [], { charge: 0.15 })), manim.battery_low, 1e-9, "low");
});

test("Pop in brings each battery in, growing past its size", async () => {
  const built = await buildObjects(plan);
  const timeline = new Timeline(plan, built);
  await timeline.prepare();
  const [fullId] = plan.objects.map((o) => o.id);
  const width = (t) => {
    timeline.seek(t);
    const drawn = new Set(timeline.world.scene.mobjects.flatMap((m) => m.get_family()));
    const mob = timeline.world.objects.get(fullId);
    return drawn.has(mob) ? mob.width : null;
  };
  assert.equal(plan.duration, 1.6);
  const final = width(1.6);
  assert.ok(final > 2 && final < 2.2, `full size ${final}`);
  assert.ok(width(0.05) < final * 0.5, "starts small");
  const widest = Math.max(...[0.3, 0.4, 0.5, 0.6, 0.7].map(width));
  assert.ok(widest > final * 1.02, `goes past full size (${widest} vs ${final})`);
});

test("only a class of the right kind can be registered", () => {
  assert.throws(() => registerKitClass({ kind: "object", class: "Bad", type: "kit:x:1" }, class {}), /extends a Manim object/);
  assert.throws(() => registerKitClass({ kind: "animation", class: "Bad", type: "kit:x:1" }, Object), /extends Animation/);
});
