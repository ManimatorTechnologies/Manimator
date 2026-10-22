// Customizations: the example packages' kit.js (tests/Kits/) registered the way the sandbox registers them, built
// from a scene plan and played; their objects and animations match Manim's (the same examples' kit.py), and the
// "manimator" module they import is current. Fixture: tools/MakeKit.py --fixture.
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
const { registerKitClass, registerKits } = await import("../../manimator/web/js/engine/kits.js");
const { buildObjects } = await import("../../manimator/web/js/engine/plan/build.js");
const { CLASSES } = await import("../../manimator/web/js/engine/plan/names.js");
const { pyCall } = await import("../../manimator/web/js/engine/manim/pycall.js");
const { Timeline } = await import("../../manimator/web/js/engine/scene/timeline.js");

const API = pathToFileURL(join(ROOT, "manimator", "web", "js", "engine", "KitApi.js")).href;
const { DEGREES } = await import(API);
const dir = mkdtempSync(join(tmpdir(), "kits-"));
let files = 0;

/** kit.js text as a module (the browser maps "manimator" with an import map; here it is rewritten). */
async function moduleFrom(source) {
  const file = join(dir, `kit${(files += 1)}.mjs`);
  writeFileSync(file, source.replaceAll('from "manimator"', `from "${API}"`));
  return import(pathToFileURL(file).href);
}

const exampleSource = (folder) => readFileSync(join(ROOT, "tests", "Kits", folder, "kit.js"), "utf8");
const exampleModule = (folder) => moduleFrom(exampleSource(folder));

const { plan, manim, refraction_cases: cases, refraction } = fixture("kits");
const battery = await exampleModule("Battery");
for (const kit of plan.kits) registerKitClass(kit, battery[kit.export ?? "default"]);

test("the manimator module is current with the engine", () => {
  assert.equal(readFileSync(new URL(API), "utf8"), apiNow, "run: node tools/MakeKitApi.mjs");
});

test("a package's object and animation come from its one kit.js, by their export names", () => {
  assert.deepEqual(plan.kits.map((k) => [k.class, k.kind, k.export]),
    [["Battery", "object", "Battery"], ["PopIn", "animation", "PopIn"]]);
  assert.equal(plan.kits[0].js_sha256, plan.kits[1].js_sha256);
  assert.equal(plan.kits[1].type, `${plan.kits[0].type}:PopIn`);
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

test("Refraction's Shine and Sweep angle play as in Manim", async () => {
  const kit = await exampleModule("Refraction");
  for (const [name, settings, methods, anim, animSettings, alphas] of cases) {
    const kwargs = { ...settings, labels: false };
    if ("theta" in kwargs) kwargs.theta *= DEGREES;
    const mob = pyCall(kit.Refraction, [], kwargs);
    for (const [method, args] of methods) mob[method](...args.map((a) => (method === "rotate" ? a * DEGREES : a)));
    const animation = pyCall(kit[anim], [mob], Object.fromEntries(Object.entries(animSettings)
      .map(([k, v]) => [k, v * DEGREES])));
    animation.begin();
    const states = alphas.map((alpha) => {
      animation.interpolate(alpha);
      return mobjectState(mob);
    });
    if (alphas.at(-1) === 1) {
      animation.finish();
      states.push(mobjectState(mob));
    }
    assert.equal(states.length, refraction[name].length, name);
    states.forEach((state, i) => sameMobject(state, refraction[name][i], 1e-9, `${name} #${i}`));
  }
});

test("a sweep starts from where the last one left the angle", async () => {
  const kit = await exampleModule("Refraction");
  const mob = pyCall(kit.Refraction, [], { labels: false });
  for (const to of [70, 10]) {
    const sweep = pyCall(kit.SweepAngle, [mob], { to: to * DEGREES });
    sweep.begin();
    sweep.interpolate(0);
    sweep.finish();
    assert.ok(Math.abs(mob.settings.theta - to * DEGREES) < 1e-12, `left at ${to}`);
  }
  const fresh = pyCall(kit.Refraction, [], { labels: false, theta: 10 * DEGREES });
  sameMobject(mobjectState(mob), mobjectState(fresh), 1e-9, "as if made at 10 degrees");
});

test("each kit.js is imported once: an animation's object is its own module's class", async () => {
  const source = exampleSource("Refraction");
  const sha = "f".repeat(64);
  const kits = [{ type: "kit:abcdefabcdef:1", class: "Refraction", kind: "object", export: "Refraction", js_sha256: sha },
    { type: "kit:abcdefabcdef:1:Shine", class: "Shine", kind: "animation", export: "Shine", js_sha256: sha },
    { type: "kit:abcdefabcdef:1:SweepAngle", class: "SweepAngle", kind: "animation", export: "SweepAngle",
      js_sha256: sha }];
  let loads = 0;
  const load = (text) => { loads += 1; return moduleFrom(text); };
  await registerKits(kits, { [kits[0].type]: source }, load); // the animations share the object's text
  assert.equal(loads, 1);
  const mod = await moduleFrom(source);
  assert.notEqual(CLASSES.Refraction, mod.Refraction, "a second import is another class");
  const made = pyCall(CLASSES.Refraction, [], { labels: false });
  const sweep = pyCall((await import("../../manimator/web/js/engine/anim/index.js")).ANIMATIONS.SweepAngle, [made],
    { to: 0 });
  assert.ok(made instanceof CLASSES.Refraction && sweep.mobject === made);
});

test("a first-format package's class is its default export", async () => {
  const mod = await moduleFrom(readFileSync(join(ROOT, "tests", "OldKits", "PopIn", "kit.js"), "utf8"));
  const kit = { type: "kit:0123456789ab:1", class: "OldPopIn", kind: "animation", js_sha256: "e".repeat(64) };
  assert.equal(registerKitClass(kit, mod.default), false);
  await assert.rejects(registerKits([{ ...kit, class: "OldPopIn2", js_sha256: "d".repeat(64) }], {},
    () => Promise.resolve(mod)), /code didn't arrive/);
});

test("only a class of the right kind can be registered", () => {
  assert.throws(() => registerKitClass({ kind: "object", class: "Bad", type: "kit:x:1" }, class {}), /extends a Manim object/);
  assert.throws(() => registerKitClass({ kind: "animation", class: "Bad", type: "kit:x:1" }, Object), /extends Animation/);
  assert.throws(() => registerKitClass({ kind: "object", class: "Bad", type: "kit:x:1", export: "Bad" }, undefined),
    /export class Bad/);
});
