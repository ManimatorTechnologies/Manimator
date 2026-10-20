// Text and Paragraph: ports of manim/mobject/text/text_mobject.py. Manim draws a Text with Pango into an SVG file
// (manimpango.text2svg) and reads that back as an SVGMobject; here the same glyph outlines and positions are made
// directly (fonts.js) and handed to the SVGMobject code, so everything after the file is Manim's own logic.

import { ManimColor, colorGradient } from "../core/color.js";
import { config } from "./config.js";
import { DEFAULT_FONT_SIZE, ORIGIN, RIGHT, START_X, START_Y } from "./frozen.js";
import { Dot } from "./geometry.js";
import { PANGO_SCALE, cairoNumber, emScaler, fontRuns, glyphSegments, pangoSize, resolveFont } from "./fonts.js";
import { SVGMobject, VMobjectFromSVGPath } from "./svg.js";
import { VGroup, VMobject } from "./vmobject.js";

export const TEXT_MOB_SCALE_FACTOR = 0.05;
export const DEFAULT_LINE_SPACING_SCALE = 0.3;
export const TEXT2SVG_ADJUSTMENT_FACTOR = 4.8;
export const NORMAL = "NORMAL";

class TextSetting {
  constructor(start, end, { font, slant, weight, line_num = -1, color = null }) {
    Object.assign(this, { start, end, font, slant, weight, line_num, color });
  }

  copy() {
    return new TextSetting(this.start, this.end, this);
  }
}

const isSpace = (ch) => /\s/u.test(ch);
const rgbaBytes = (hex) => {
  const v = new ManimColor(hex).to_rgb();
  return [...v.map((x) => Math.round(x * 255)), 255];
};

/** A run of glyphs as Pango lays it out: positions in Pango units and each glyph's face (the fallback's for
 *  characters the font lacks), the run's width, and the line's ascent (the tallest of the faces used). */
function layoutRun(text, setting, sizePt, ligatures) {
  const { face, oblique, fallback, fallbackOblique } = resolveFont(setting.font, setting.slant, setting.weight);
  const { pixels, scale } = pangoSize(sizePt);
  let ascent = emScaler(scale, face.upem)(face.ascender);
  let x = 0;
  const placed = [];
  for (const part of fontRuns(text, face, fallback)) {
    const f = part.fallback ? fallback : face;
    const em = emScaler(scale, f.upem);
    if (part.fallback) ascent = Math.max(ascent, em(f.ascender));
    const { glyphs, kern } = f.shape(part.text, { ligatures });
    glyphs.forEach((g, i) => {
      placed.push({ gid: g.gid, x, face: f, oblique: part.fallback ? fallbackOblique : oblique });
      x += em(f.advance(g.gid)) + em(kern[i]);
    });
  }
  return { pixels, placed, width: x, ascent };
}

/** The glyphs of laid-out runs as SVG path shapes, positioned the way cairo's <use x y> places them. */
function glyphShapes(run, originX, top, color) {
  const shapes = [];
  const y = cairoNumber(top + run.ascent / PANGO_SCALE);
  for (const g of run.placed) {
    const x = cairoNumber(originX + g.x / PANGO_SCALE);
    const segs = glyphSegments(g.face, g.gid, run.pixels, g.oblique ? 0.2 : 0);
    if (!segs.some((s) => s.type !== "move" && s.type !== "close")) continue;
    const moved = segs.map((s) => {
      const out = { ...s };
      for (const key of ["end", "control1", "control2"]) if (s[key]) out[key] = [s[key][0] + x, s[key][1] + y];
      return out;
    });
    shapes.push({ tag: "path", segments: moved, fill: rgbaBytes(color), stroke: null, stroke_width: 0 });
  }
  return shapes;
}

/** Text.__init__'s rewrite of each glyph: every subpath ends with an explicit line back to its start. */
export function closeSubpaths(mobject) {
  const nppc = mobject.n_points_per_curve;
  for (const each of mobject.iter()) {
    if (each.points.length === 0) continue;
    const points = each.points;
    let curveStart = points[0];
    const out = [];
    const addLineTo = (end) => {
      const start = out[out.length - 1];
      out.push(start, [0, 1, 2].map((i) => (start[i] + start[i] + end[i]) / 3),
        [0, 1, 2].map((i) => (start[i] + end[i] + end[i]) / 3), end);
    };
    points.forEach((point, index) => {
      out.push(point);
      const next = points[index + 1];
      if (index !== points.length - 1 && (index + 1) % nppc === 0
        && (point[0] !== next[0] || point[1] !== next[1] || point[2] !== next[2])) {
        addLineTo(curveStart);
        curveStart = next;
      }
    });
    addLineTo(curveStart);
    each.points = out.map((p) => [...p]);
  }
}

export class Text extends SVGMobject {
  static SIG = ["text", "fill_opacity", "stroke_width", "color", "font_size", "line_spacing", "font", "slant", "weight",
    "t2c", "t2f", "t2g", "t2s", "t2w", "gradient", "tab_width", "warn_missing_font", "height", "width",
    "should_center", "disable_ligatures", "use_svg_cache"];

  __init__({ text, fill_opacity = 1.0, stroke_width = 0, color = null, font_size = DEFAULT_FONT_SIZE, line_spacing = -1,
    font = "", slant = NORMAL, weight = NORMAL, t2c = null, t2f = null, t2g = null, t2s = null, t2w = null,
    gradient = null, tab_width = 4, warn_missing_font = true, height = null, width = null, should_center = true,
    disable_ligatures = false, use_svg_cache = false, text2color, text2font, text2gradient, text2slant, text2weight,
    ...kw } = {}) {
    void warn_missing_font;
    this.line_spacing = line_spacing;
    this.font = font.toLowerCase() === "sans-serif" ? "sans" : font;
    this._font_size = Number(font_size);
    this.slant = slant;
    this.weight = weight;
    this.gradient = gradient;
    this.tab_width = tab_width;
    t2c = text2color ?? t2c ?? {};
    t2f = text2font ?? t2f ?? {};
    t2g = text2gradient ?? t2g ?? {};
    t2s = text2slant ?? t2s ?? {};
    t2w = text2weight ?? t2w ?? {};
    this.t2c = Object.fromEntries(Object.entries(t2c).map(([k, v]) => [k, new ManimColor(v).to_hex()]));
    this.t2f = t2f;
    this.t2g = t2g;
    this.t2s = t2s;
    this.t2w = t2w;
    this.original_text = text;
    this.disable_ligatures = disable_ligatures;
    let textWithoutTabs = text;
    if (text.includes("\t")) textWithoutTabs = text.replaceAll("\t", " ".repeat(this.tab_width));
    this.text = textWithoutTabs;
    if (this.line_spacing === -1) this.line_spacing = this._font_size + this._font_size * DEFAULT_LINE_SPACING_SCALE;
    else this.line_spacing = this._font_size + this._font_size * this.line_spacing;
    const parsedColor = color ? new ManimColor(color) : VMobject.make().color;
    this._pango_shapes = this._text2svg(parsedColor.to_hex());
    super.__init__({ ...kw, file_name: null, svg_text: "", fill_opacity, stroke_width, height, width, should_center,
      use_svg_cache });
    this.text = text;
    if (this.disable_ligatures) this.submobjects = [...this._gen_chars().submobjects];
    this.chars = VGroup.make({ vmobjects: [...this.submobjects] });
    this.text = textWithoutTabs.replaceAll(" ", "").replaceAll("\n", "");
    closeSubpaths(this);
    if (height === null && width === null) this.scale(TEXT_MOB_SCALE_FACTOR);
    this.initial_height = this.height;
    return this;
  }

  hash_seed() {
    return JSON.stringify(["Text", this.original_text, this.font, this.slant, this.weight, this.t2c, this.t2f, this.t2s,
      this.t2w, this.t2g, this.gradient, this.line_spacing, this._font_size, this.disable_ligatures]);
  }

  /** The shapes manimpango's SVG file would hold (see generate_mobject). */
  svg_shapes() {
    return this._pango_shapes;
  }

  get font_size() {
    return (((this.height / this.initial_height / TEXT_MOB_SCALE_FACTOR) * 2.4 * this._font_size) / DEFAULT_FONT_SIZE);
  }

  set font_size(value) {
    if (value <= 0) throw new Error("font_size must be greater than 0.");
    this.scale(value / this.font_size);
  }

  _gen_chars() {
    const chars = VGroup.make();
    let index = 0;
    for (let i = 0; i < this.text.length; i += 1) {
      if (isSpace(this.text[i])) {
        const space = Dot.make({ radius: 0, fill_opacity: 0, stroke_opacity: 0 });
        space.move_to(this.submobjects[i === 0 ? index : index - 1].get_center());
        chars.add(space);
      } else {
        if (index >= this.submobjects.length) {
          throw new Error(`Text ${JSON.stringify(this.original_text)} rendered fewer glyph(s) than its non-space characters`);
        }
        chars.add(this.submobjects[index]);
        index += 1;
      }
    }
    return chars;
  }

  _find_indexes(word, text) {
    const m = /^\[([0-9-]*):([0-9-]*)\]/.exec(word);
    if (m) {
      let start = m[1] !== "" ? parseInt(m[1], 10) : 0;
      let end = m[2] !== "" ? parseInt(m[2], 10) : text.length;
      start = start < 0 ? text.length + start : start;
      end = end < 0 ? text.length + end : end;
      return [[start, end]];
    }
    const out = [];
    let index = text.indexOf(word);
    while (index !== -1 && word.length > 0) {
      out.push([index, index + word.length]);
      index = text.indexOf(word, index + word.length);
    }
    return out;
  }

  _merge_settings(left, right, defaults) {
    const contained = right.end < left.end;
    const created = contained ? left.copy() : right.copy();
    created.start = contained ? right.end : left.end;
    left.end = right.start;
    if (!contained) right.end = created.start;
    for (const arg of Object.keys(defaults)) {
      const l = left[arg];
      const r = right[arg];
      const d = defaults[arg];
      if (l !== d && r !== d) {
        throw new Error(`Ambiguous style for text '${this.text.slice(right.start, right.end)}': '${arg}' cannot be both '${l}' and '${r}'.`);
      }
      right[arg] = l !== d ? l : r;
    }
    return created;
  }

  _text2settings(color) {
    const t2xs = [[this.t2f, "font"], [this.t2s, "slant"], [this.t2w, "weight"], [this.t2c, "color"]];
    const defaults = { font: this.font, slant: this.slant, weight: this.weight, color };
    const settings = [];
    const words = new Set(t2xs.flatMap(([t2x]) => Object.keys(t2x)));
    for (const word of words) {
      const args = Object.fromEntries(t2xs.map(([t2x, arg]) => [arg, word in t2x ? String(t2x[word]) : defaults[arg]]));
      for (const [start, end] of this._find_indexes(word, this.text)) settings.push(new TextSetting(start, end, args));
    }
    const args = { ...defaults };
    if (this.gradient) {
      const colors = colorGradient(this.gradient, this.text.length);
      for (let i = 0; i < this.text.length; i += 1) {
        args.color = colors[i].to_hex();
        settings.push(new TextSetting(i, i + 1, args));
      }
    }
    for (const [word, gradient] of Object.entries(this.t2g)) {
      const colors = colorGradient(gradient, word.length);
      for (const [start, end] of this._find_indexes(word, this.text)) {
        for (let i = start; i < end; i += 1) {
          args.color = colors[i - start].to_hex();
          settings.push(new TextSetting(i, i + 1, args));
        }
      }
    }
    const byStart = (a, b) => a.start - b.start;
    settings.sort(byStart);
    for (let index = 0; index + 1 < settings.length; index += 1) {
      const setting = settings[index];
      const next = settings[index + 1];
      if (setting.end > next.start) {
        const created = this._merge_settings(setting, next, defaults);
        let at = index + 1;
        while (at < settings.length && settings[at].start < created.start) at += 1;
        settings.splice(at, 0, created);
      }
    }
    const filled = [...settings];
    let start = 0;
    for (const s of settings) {
      if (s.start !== start) filled.push(new TextSetting(start, s.start, defaults));
      start = s.end;
    }
    if (start !== this.text.length) filled.push(new TextSetting(start, this.text.length, defaults));
    let out = filled.sort(byStart);
    let lineNum = 0;
    if (this.text.includes("\n")) {
      for (const [forStart, forEnd] of this._find_indexes("\n", this.text)) {
        for (const setting of out) {
          if (setting.line_num === -1) setting.line_num = lineNum;
          if (forStart < setting.end) {
            lineNum += 1;
            const created = setting.copy();
            setting.end = forEnd;
            created.start = forEnd;
            created.line_num = lineNum;
            out.push(created);
            out = out.sort(byStart);
            break;
          }
        }
      }
    }
    for (const setting of out) if (setting.line_num === -1) setting.line_num = lineNum;
    return out;
  }

  /** manimpango.text2svg: each setting is laid out on its own, after the previous one on its line. */
  _text2svg(color) {
    const size = this._font_size / TEXT2SVG_ADJUSTMENT_FACTOR;
    const lineSpacing = this.line_spacing / TEXT2SVG_ADJUSTMENT_FACTOR;
    const shapes = [];
    let offsetX = 0;
    let lastLine = 0;
    for (const setting of this._text2settings(color)) {
      const str = [...this.text].slice(setting.start, setting.end).join("").replaceAll("\n", " ");
      if (setting.line_num !== lastLine) {
        offsetX = 0;
        lastLine = setting.line_num;
      }
      const run = layoutRun(str, setting, size, !this.disable_ligatures);
      shapes.push(...glyphShapes(run, START_X + offsetX, START_Y + lineSpacing * setting.line_num, setting.color));
      offsetX += run.width / PANGO_SCALE;
    }
    void config;
    return shapes;
  }
}

export class Paragraph extends VGroup {
  static SIG = ["*text"];

  __init__({ text = [], line_spacing = -1, alignment = null, ...kw } = {}) {
    this.line_spacing = line_spacing;
    this.alignment = alignment;
    this.consider_spaces_as_chars = kw.disable_ligatures ?? false;
    super.__init__();
    const linesStr = text.join("\n");
    this.lines_text = Text.make({ ...kw, text: linesStr, line_spacing });
    const lines = linesStr.split("\n");
    this.chars = this._gen_chars(lines);
    this.lines_chars = [...this.chars.submobjects];
    this.lines_alignments = this.lines_chars.map(() => this.alignment);
    this.lines_initial_positions = this.lines_chars.map((line) => line.get_center());
    this.add(...this.lines_chars);
    this.move_to(ORIGIN);
    if (this.alignment) this._set_all_lines_alignments(this.alignment);
    return this;
  }

  _gen_chars(lines) {
    let counter = 0;
    const chars = VGroup.make();
    const glyphs = this.lines_text.chars.submobjects;
    lines.forEach((line, lineNo) => {
      const count = this.consider_spaces_as_chars ? [...line].length : [...line].filter((c) => !isSpace(c)).length;
      chars.add(VGroup.make());
      chars.submobjects[lineNo].add(...glyphs.slice(counter, counter + count));
      counter += count;
      if (this.consider_spaces_as_chars) counter += 1;
    });
    return chars;
  }

  _set_all_lines_alignments(alignment) {
    for (let i = 0; i < this.lines_chars.length; i += 1) this._change_alignment_for_a_line(alignment, i);
    return this;
  }

  _change_alignment_for_a_line(alignment, lineNo) {
    this.lines_alignments[lineNo] = alignment;
    const line = this.get(lineNo);
    if (alignment === "center") line.move_to([this.get_center()[0], line.get_center()[1], 0]);
    else if (alignment === "right") line.move_to([this.get_right()[0] - line.width / 2, line.get_center()[1], 0]);
    else if (alignment === "left") line.move_to([this.get_left()[0] + line.width / 2, line.get_center()[1], 0]);
  }
}

export { RIGHT, VMobjectFromSVGPath };
