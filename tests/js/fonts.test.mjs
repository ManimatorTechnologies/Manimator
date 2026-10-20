import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFontFamilies } from "./helpers.mjs";

// Manimator's own fonts (the other tests set DejaVu Sans back, as Manim had it): Crimson Pro by default, real italic
// faces where a family has them, and DejaVu for the characters a font lacks.
const fonts = await loadFontFamilies("Crimson Pro", "DejaVu Sans", "DejaVu Serif", "Lato");
const { Text } = await import("../../manimator/web/js/engine/manim/text.js");
const { MarkupText } = await import("../../manimator/web/js/engine/manim/markup.js");

const withDefault = (family, fn) => {
  const before = fonts.getDefaultFamily();
  fonts.setDefaultFamily(family);
  try {
    return fn();
  } finally {
    fonts.setDefaultFamily(before);
  }
};

test("text without a font is Crimson Pro; generic and unknown names are DejaVu, as fontconfig answers them", () => {
  withDefault("Crimson Pro", () => {
    assert.equal(fonts.familyOf(""), "Crimson Pro");
    assert.equal(fonts.familyOf("lato"), "Lato");
    assert.equal(fonts.familyOf("serif"), "DejaVu Serif");
    assert.equal(fonts.familyOf("sans"), "DejaVu Sans");
    assert.equal(fonts.familyOf("Monospace"), "DejaVu Sans Mono");
    assert.equal(fonts.familyOf("Comic Sans MS"), "DejaVu Sans");
    assert.equal(fonts.resolveFont("").face.file, "crimson-pro/CrimsonPro-Regular.ttf");
    assert.equal(fonts.resolveFont("", "NORMAL", "BOLD").face.file, "crimson-pro/CrimsonPro-Bold.ttf");
  });
});

test("italic uses a family's italic face; DejaVu (no italic files) is slanted", () => {
  const it = fonts.resolveFont("Crimson Pro", "ITALIC", "BOLD");
  assert.equal(it.face.file, "crimson-pro/CrimsonPro-BoldItalic.ttf");
  assert.equal(it.oblique, false);
  assert.equal(it.fallback.file, "dejavu/DejaVuSerif-Bold.ttf");
  assert.equal(it.fallbackOblique, true);
  const dv = fonts.resolveFont("DejaVu Sans", "ITALIC");
  assert.equal(dv.face.file, "dejavu/DejaVuSans.ttf");
  assert.equal(dv.oblique, true);
});

test("a family that isn't loaded is drawn with the default one", () => {
  withDefault("Crimson Pro", () => assert.equal(fonts.resolveFont("Inter").face.file, "crimson-pro/CrimsonPro-Regular.ttf"));
});

test("characters the font lacks come from its fallback, one glyph each, on the same line", () => {
  const { face, fallback } = fonts.resolveFont("Crimson Pro");
  assert.deepEqual(fonts.fontRuns("θ = 30° → x", face, fallback).map((r) => [r.text, r.fallback]),
    [["θ", true], [" = 30° ", false], ["→", true], [" x", false]]);
  withDefault("Crimson Pro", () => {
    const t = Text.make({ text: "αβγ = θ" });
    assert.equal(t.submobjects.length, 5);
    const heights = t.submobjects.map((m) => m.height);
    assert.ok(heights.every((h) => h > 0.05), "every glyph is drawn (no empty boxes)");
    const m = MarkupText.make({ text: "<b>θ</b> and π" });
    assert.equal(m.submobjects.length, 5);
  });
});

test("Crimson Pro draws smaller and narrower than DejaVu Sans at the same font_size", () => {
  const sample = "The two legs squared add up to the hypotenuse";
  const [crimson, dejavu] = ["Crimson Pro", "DejaVu Sans"].map((f) => withDefault(f, () => Text.make({ text: sample })));
  assert.ok(crimson.width < dejavu.width * 0.85);
  assert.ok(crimson.width > dejavu.width * 0.7);
});

test("line_spacing spreads the lines of a Text", () => {
  withDefault("Crimson Pro", () => {
    const pitch = (t) => t.chars.submobjects[0].get_center()[1] - t.chars.submobjects[1].get_center()[1];
    const tight = Text.make({ text: "H\nH", font_size: 36 });
    const loose = Text.make({ text: "H\nH", font_size: 36, line_spacing: 0.75 });
    assert.ok(Math.abs(pitch(loose) / pitch(tight) - 1.75 / 1.3) < 1e-6);
  });
});
