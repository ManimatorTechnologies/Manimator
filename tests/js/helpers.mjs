// Shared helpers for the engine's Node tests (node --test tests/js/).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");

/** Reference data written by tools/make_js_fixtures.py (gzipped: some are tens of MB as JSON) or by hand. */
export function fixture(name) {
  const packed = join(HERE, "fixtures", `${name}.json.gz`);
  if (existsSync(packed)) return JSON.parse(gunzipSync(readFileSync(packed)).toString("utf8"));
  return JSON.parse(readFileSync(join(HERE, "fixtures", `${name}.json`), "utf8"));
}

/** Arrays of numbers (any nesting) equal within `tol`. */
export function close(actual, expected, tol = 1e-9, where = "") {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${where}: length ${actual.length} != ${expected.length}`);
    expected.forEach((e, i) => close(actual[i], e, tol, `${where}[${i}]`));
    return;
  }
  if (typeof expected === "number") {
    assert.ok(typeof actual === "number" && (Math.abs(actual - expected) <= tol
      || (Number.isNaN(actual) && Number.isNaN(expected))), `${where}: ${actual} != ${expected}`);
    return;
  }
  assert.deepEqual(actual, expected, where);
}

/** Each family member's class, points and style (tools/make_js_fixtures.py: mobject_state). */
export function mobjectState(mob) {
  return mob.get_family().map((m) => {
    const entry = { cls: m.constructor.name, points: m.points };
    if (m.get_fill_rgbas) {
      Object.assign(entry, {
        fill: m.get_fill_rgbas(), stroke: m.get_stroke_rgbas(), stroke_width: m.get_stroke_width(),
        background_stroke: m.get_stroke_rgbas(true), background_stroke_width: m.get_stroke_width(true),
        sheen_direction: m.sheen_direction,
      });
    }
    return entry;
  });
}

/** Compares mobjectState() with Manim's; class names, point counts and values (within `tol`). */
export function sameMobject(actual, expected, tol = 1e-9, where = "") {
  assert.deepEqual(actual.map((e) => e.cls), expected.map((e) => e.cls), `${where}: family classes`);
  expected.forEach((e, i) => {
    for (const key of Object.keys(e)) {
      if (key !== "cls") close(actual[i][key], e[key], tol, `${where} ${e.cls}#${i}.${key}`);
    }
  });
}

/** Registers bundled font families (the browser fetches them; tests read the files). */
export async function loadFontFamilies(...families) {
  const lib = await import("../../manimator/web/js/engine/mw/lib.js");
  const fonts = await import("../../manimator/web/js/engine/manim/fonts.js");
  const opentype = await lib.loadOpentype();
  for (const family of families) {
    for (const path of fonts.familyPaths(family)) {
      const b = readFileSync(join(ROOT, "manimator", "web", "fonts", path));
      fonts.registerFont(path, opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
    }
  }
  return fonts;
}

/** Registers the DejaVu fonts and makes DejaVu Sans the default again: the expected values come from Manim, whose
 *  Pango had only fonts-dejavu-core (Manimator's own default is Crimson Pro). */
export async function loadDejaVu() {
  const fonts = await loadFontFamilies("DejaVu Sans", "DejaVu Sans Mono", "DejaVu Serif");
  fonts.setDefaultFamily("DejaVu Sans");
}
