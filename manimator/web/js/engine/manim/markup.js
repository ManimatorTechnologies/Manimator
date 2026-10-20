// MarkupText: a port of manim's MarkupText (text_mobject.py) with Pango's markup and paragraph layout
// (manimpango MarkupUtils.text2svg: one layout, 500 px wide, the font's own line height).
//
// Markup: <b> <i> <s> <u> <big> <small> <tt> <sub> <sup> and <span> with font/font_desc, font_family/face, size,
// style, weight, foreground/fgcolor/color, underline, strikethrough, rise, alpha/fgalpha; Manim's <color> and
// <gradient> tags. Kerning runs across colour changes (Pango shapes per font item); underline and strikethrough
// are rectangles placed with Pango's pango_quantize_line_geometry.

import { ManimColor } from "../core/color.js";
import { DEFAULT_FONT_SIZE, START_X, START_Y } from "./frozen.js";
import {
  PANGO_SCALE, cairoFixedInt, cairoNumber, emScaler, fontRuns, glyphSegments, pangoSize, resolveFont,
} from "./fonts.js";
import { DEFAULT_LINE_SPACING_SCALE, NORMAL, TEXT2SVG_ADJUSTMENT_FACTOR, TEXT_MOB_SCALE_FACTOR, closeSubpaths } from "./text.js";
import { SVGMobject } from "./svg.js";
import { VGroup, VMobject } from "./vmobject.js";

const PANGO_WIDTH = 500;
const SIZE_WORDS = { "xx-small": -3, "x-small": -2, small: -1, medium: 0, large: 1, "x-large": 2, "xx-large": 3 };
const WEIGHT_WORDS = { thin: 100, ultralight: 200, light: 300, semilight: 350, book: 380, normal: 400, medium: 500,
  semibold: 600, bold: 700, ultrabold: 800, heavy: 900, ultraheavy: 1000 };
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, n) => {
  if (n[0] === "#") return String.fromCodePoint(n[1] === "x" || n[1] === "X" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10));
  if (!(n in ENTITIES)) throw new Error(`Entity '${n}' is not defined`);
  return ENTITIES[n];
});

/** Pango markup as runs [{text, attrs}] (attrs: family, slant, weight, sizeFactor/absolute size, color, ...). */
export function parsePangoMarkup(markup, base) {
  const runs = [];
  const stack = [{ ...base }];
  const re = /<\s*(\/?)\s*([a-zA-Z]+)((?:\s+[a-zA-Z_]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  let pos = 0;
  while ((m = re.exec(markup)) !== null) {
    if (m.index !== pos) throw new Error(`Error on line 1: unexpected character at ${pos}`);
    pos = re.lastIndex;
    if (m[5] !== undefined) {
      runs.push({ text: decode(m[5]), attrs: { ...stack[stack.length - 1] } });
      continue;
    }
    const [, closing, rawTag, rawAttrs, selfClosing] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (stack.length <= 1 || stack[stack.length - 1].tag !== tag) throw new Error(`Element '${tag}' was closed, but the currently open element is '${stack[stack.length - 1].tag ?? ""}'`);
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    const a = { ...top, tag };
    switch (tag) {
      case "markup": break;
      case "b": a.weight = 700; break;
      case "i": a.slant = "ITALIC"; break;
      case "s": a.strikethrough = true; break;
      case "u": a.underline = "single"; break;
      case "big": a.scale *= 1.2; break;
      case "small": a.scale /= 1.2; break;
      case "tt": a.family = "monospace"; break;
      case "sup": a.script = "sup"; break;
      case "sub": a.script = "sub"; break;
      case "span": {
        for (const [, key, v1, v2] of rawAttrs.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          spanAttribute(a, key.toLowerCase(), decode(v1 ?? v2));
        }
        break;
      }
      default: throw new Error(`Unknown tag '${tag}' on line 1`);
    }
    if (!selfClosing) stack.push(a);
  }
  if (pos !== markup.length) throw new Error("Error on line 1: unexpected end of markup");
  if (stack.length !== 1) throw new Error(`Element '${stack[stack.length - 1].tag}' was not closed`);
  return runs;
}

function spanAttribute(a, key, value) {
  switch (key) {
    case "font": case "font_desc": {
      const words = value.trim().split(/\s+/);
      const families = [];
      for (const w of words) {
        const lw = w.toLowerCase().replace(/,$/, "");
        if (lw in WEIGHT_WORDS) a.weight = WEIGHT_WORDS[lw];
        else if (lw === "italic" || lw === "oblique") a.slant = "ITALIC";
        else if (/^\d+(\.\d+)?(px)?$/.test(lw)) a.points = parseFloat(lw);
        else families.push(w);
      }
      if (families.length) a.family = families.join(" ").replace(/,$/, "");
      break;
    }
    case "font_family": case "face": a.family = value; break;
    case "size": case "font_size": {
      const v = value.trim().toLowerCase();
      if (v in SIZE_WORDS) {
        a.points = null;
        a.scale = a.baseScale * 1.2 ** SIZE_WORDS[v];
      } else if (v === "larger") a.scale *= 1.2;
      else if (v === "smaller") a.scale /= 1.2;
      else if (v.endsWith("%")) a.scale *= parseFloat(v) / 100;
      else if (v.endsWith("pt")) a.points = parseFloat(v);
      else a.points = parseFloat(v) / PANGO_SCALE;
      break;
    }
    case "style": a.slant = value.toLowerCase() === "normal" ? "NORMAL" : "ITALIC"; break;
    case "weight": {
      const v = value.toLowerCase();
      a.weight = v in WEIGHT_WORDS ? WEIGHT_WORDS[v] : parseInt(v, 10) || 400;
      break;
    }
    case "foreground": case "fgcolor": case "color": a.color = value; break;
    case "underline": a.underline = value === "none" || value === "false" ? null : value; break;
    case "strikethrough": a.strikethrough = value === "true"; break;
    case "underline_color": a.underline_color = value; break;
    case "strikethrough_color": a.strikethrough_color = value; break;
    case "rise": a.rise = value.endsWith("pt") ? parseFloat(value) * PANGO_SCALE : parseFloat(value); break;
    case "alpha": case "fgalpha": a.alpha = value.endsWith("%") ? parseFloat(value) / 100 : parseInt(value, 10) / 65535; break;
    default: break; // background, letter_spacing, variant, stretch, lang, font_features...: no change to shapes here
  }
}

/** pango_quantize_line_geometry on Pango units (thickness, position of the top above the baseline). */
function quantize(thickness, position) {
  let px = Math.trunc((thickness + PANGO_SCALE / 2) / PANGO_SCALE);
  if (px === 0) px = 1;
  let center;
  if (px & 1) center = ((position - Math.trunc(thickness / 2)) & ~(PANGO_SCALE - 1)) + PANGO_SCALE / 2;
  else center = (position - Math.trunc(thickness / 2) + PANGO_SCALE / 2) & ~(PANGO_SCALE - 1);
  return [px * PANGO_SCALE, center + (PANGO_SCALE * px) / 2];
}

/** The layout: lines of shaped items, as manimpango's MarkupText draws them. */
function layoutMarkup(runs, sizePt, ligatures) {
  // font items: consecutive characters with the same font, size and baseline shift
  const chars = [];
  for (const run of runs) for (const ch of run.text) chars.push({ ch, attrs: run.attrs });
  const fontKey = (a) => JSON.stringify([a.family, a.slant, a.weight, a.scale, a.points, a.script, a.rise]);
  const paragraphs = [[]];
  for (const c of chars) {
    if (c.ch === "\n") paragraphs.push([]);
    else paragraphs[paragraphs.length - 1].push(c);
  }
  const lines = [];
  for (const para of paragraphs) {
    const items = [];
    for (const c of para) {
      const last = items[items.length - 1];
      if (last && fontKey(last.attrs) === fontKey(c.attrs)) last.chars.push(c);
      else items.push({ attrs: c.attrs, chars: [c] });
    }
    const glyphs = [];
    for (const item of items) {
      const a = item.attrs;
      const resolved = resolveFont(a.family, a.slant, a.weight);
      let points = a.points ?? sizePt * a.scale;
      let rise = a.rise ?? 0;
      const main = resolved.face;
      if (a.script) {
        const os2 = main.font.tables.os2;
        const basePx = pangoSize(points).pixels;
        rise += ((a.script === "sup" ? os2.ySuperscriptYOffset : -os2.ySubscriptYOffset) * basePx * PANGO_SCALE) / main.upem;
        points *= (a.script === "sup" ? os2.ySuperscriptYSize : os2.ySubscriptYSize) / main.upem;
      }
      const { pixels, scale } = pangoSize(points);
      let at = 0; // the item's characters before this font run
      for (const part of fontRuns(item.chars.map((c) => c.ch).join(""), main, resolved.fallback)) {
        const face = part.fallback ? resolved.fallback : main;
        const oblique = part.fallback ? resolved.fallbackOblique : resolved.oblique;
        const os2 = face.font.tables.os2;
        const em = emScaler(scale, face.upem);
        const chars = item.chars.slice(at, at + [...part.text].length);
        at += chars.length;
        const { glyphs: shaped, kern } = face.shape(part.text, { ligatures });
        shaped.forEach((g, i) => {
          const src = chars[g.cluster];
          glyphs.push({ gid: g.gid, face, oblique, pixels, advance: em(face.advance(g.gid)) + em(kern[i]),
            rise: Math.round(rise), ascent: em(face.ascender), descent: -em(face.descender), attrs: src.attrs,
            isSpace: /\s/u.test(src.ch),
            underline: [em(face.font.tables.post.underlineThickness), em(face.font.tables.post.underlinePosition)],
            strike: [em(os2.yStrikeoutSize), em(os2.yStrikeoutPosition)] });
        });
      }
    }
    // Pango's word wrap at the layout width
    let line = [];
    let width = 0;
    let breakAt = -1;
    const limit = PANGO_WIDTH * PANGO_SCALE;
    for (const g of glyphs) {
      if (width + g.advance > limit && !g.isSpace && breakAt >= 0) {
        lines.push(line.slice(0, breakAt + 1));
        line = line.slice(breakAt + 1);
        width = line.reduce((s, x) => s + x.advance, 0);
        breakAt = -1;
      }
      line.push(g);
      width += g.advance;
      if (g.isSpace) breakAt = line.length - 1;
    }
    lines.push(line);
    if (!glyphs.length) {
      const { face } = resolveFont(runs[0]?.attrs.family ?? "", "NORMAL", 400);
      const em = emScaler(pangoSize(sizePt).scale, face.upem);
      lines[lines.length - 1] = [];
      lines[lines.length - 1].empty = { ascent: em(face.ascender), descent: -em(face.descender) };
    }
  }
  return lines;
}

function colorBytes(color, alpha) {
  const c = new ManimColor(color).to_rgb().map((v) => Math.round(v * 255));
  return [...c, alpha === undefined ? 255 : Math.round(alpha * 255)];
}

/** The SVG shapes manimpango would write. As in pango_renderer_draw_layout_line, each run's glyphs are drawn,
 *  its underline / strikethrough extend the pending one, and a pending decoration is drawn after the glyphs of the
 *  first run without it (or at the end of the line). */
function markupShapes(lines) {
  const shapes = [];
  let top = START_Y;
  const rect = (baseline, d) => {
    const f = (v) => cairoNumber(cairoFixedInt(v) / 256);
    const x0 = f(START_X + d.start / PANGO_SCALE);
    const x1 = f(START_X + d.end / PANGO_SCALE);
    const y0 = f(baseline - d.pos / PANGO_SCALE);
    const y1 = f(baseline - (d.pos - d.thick) / PANGO_SCALE);
    shapes.push({ tag: "path", fill: colorBytes(d.color, d.alpha), stroke: null, stroke_width: 0, segments: [
      { type: "move", end: [x0, y0] }, { type: "line", end: [x1, y0] }, { type: "line", end: [x1, y1] },
      { type: "line", end: [x0, y1] }, { type: "close" }] });
  };
  for (const line of lines) {
    const ascent = line.empty ? line.empty.ascent : Math.max(...line.map((g) => g.ascent + g.rise));
    const descent = line.empty ? line.empty.descent : Math.max(...line.map((g) => g.descent - g.rise));
    const baseline = top + ascent / PANGO_SCALE;
    const runs = [];
    for (const g of line) {
      const last = runs[runs.length - 1];
      if (last && last.attrs === g.attrs) last.glyphs.push(g);
      else runs.push({ attrs: g.attrs, glyphs: [g] });
    }
    let x = 0;
    const pending = { u: null, s: null };
    for (const run of runs) {
      const runStart = x;
      for (const g of run.glyphs) {
        const gx = cairoNumber(START_X + x / PANGO_SCALE);
        const gy = cairoNumber(baseline - g.rise / PANGO_SCALE);
        const segs = glyphSegments(g.face, g.gid, g.pixels, g.oblique ? 0.2 : 0);
        if (segs.some((sg) => sg.type !== "move" && sg.type !== "close")) {
          const moved = segs.map((sg) => {
            const out = { ...sg };
            for (const key of ["end", "control1", "control2"]) if (sg[key]) out[key] = [sg[key][0] + gx, sg[key][1] + gy];
            return out;
          });
          shapes.push({ tag: "path", segments: moved, fill: colorBytes(g.attrs.color, g.attrs.alpha), stroke: null,
            stroke_width: 0 });
        }
        x += g.advance;
      }
      const g0 = run.glyphs[0];
      for (const [kind, on, metric, colorKey] of [["u", run.attrs.underline, g0.underline, "underline_color"],
        ["s", run.attrs.strikethrough, g0.strike, "strikethrough_color"]]) {
        if (!on) continue;
        const [thick, pos] = quantize(metric[0], metric[1] + g0.rise);
        const color = run.attrs[colorKey] ?? run.attrs.color;
        const p = pending[kind];
        if (p && p.end === runStart && p.pos === pos && p.thick === thick && p.color === color) p.end = x;
        else {
          if (p) rect(baseline, p);
          pending[kind] = { start: runStart, end: x, pos, thick, color, alpha: run.attrs.alpha };
        }
      }
      if (!run.attrs.underline && pending.u) {
        rect(baseline, pending.u);
        pending.u = null;
      }
      if (!run.attrs.strikethrough && pending.s) {
        rect(baseline, pending.s);
        pending.s = null;
      }
    }
    if (pending.u) rect(baseline, pending.u);
    if (pending.s) rect(baseline, pending.s);
    top += (ascent + descent) / PANGO_SCALE;
  }
  return shapes;
}

/** Manim's _count_real_chars: characters outside tags, entities counted once, spaces and tabs not counted. */
function countRealChars(s) {
  let count = 0;
  let level = 0;
  for (const c of s.replace(/&[^;]+;/g, "x")) {
    if (c === "<") level += 1;
    if (c === ">" && level > 0) level -= 1;
    else if (c !== " " && c !== "\t" && level === 0) count += 1;
  }
  return count;
}

export class MarkupText extends SVGMobject {
  static SIG = ["text", "fill_opacity", "stroke_width", "color", "font_size", "line_spacing", "font", "slant", "weight",
    "justify", "gradient", "tab_width", "height", "width", "should_center", "disable_ligatures", "warn_missing_font"];

  __init__({ text, fill_opacity = 1, stroke_width = 0, color = null, font_size = DEFAULT_FONT_SIZE, line_spacing = -1,
    font = "", slant = NORMAL, weight = NORMAL, justify = false, gradient = null, tab_width = 4, height = null,
    width = null, should_center = true, disable_ligatures = false, warn_missing_font = true, ...kw } = {}) {
    void warn_missing_font;
    this.text = text;
    this.line_spacing = line_spacing;
    this.font = font.toLowerCase() === "sans-serif" ? "sans" : font;
    this._font_size = Number(font_size);
    this.slant = slant;
    this.weight = weight;
    this.gradient = gradient;
    this.tab_width = tab_width;
    this.justify = justify;
    this.original_text = text;
    this.disable_ligatures = disable_ligatures;
    let withoutTabs = text;
    if (text.includes("\t")) withoutTabs = text.replaceAll("\t", " ".repeat(this.tab_width));
    const colormap = this._extract_color_tags();
    const gradientmap = this._extract_gradient_tags();
    if (this.line_spacing === -1) this.line_spacing = this._font_size + this._font_size * DEFAULT_LINE_SPACING_SCALE;
    else this.line_spacing = this._font_size + this._font_size * this.line_spacing;
    const parsedColor = color ? new ManimColor(color) : VMobject.make().color;
    this._pango_shapes = this._text2svg(parsedColor);
    super.__init__({ ...kw, file_name: null, svg_text: "", fill_opacity, stroke_width, height, width, should_center });
    this.chars = VGroup.make({ vmobjects: [...this.submobjects] });
    this.text = withoutTabs.replaceAll(" ", "").replaceAll("\n", "");
    closeSubpaths(this);
    if (this.gradient) this.set_color_by_gradient(...this.gradient);
    for (const col of colormap) {
      this.chars.slice(col.start - col.start_offset, col.end - col.start_offset - col.end_offset)
        .set_color(this._parse_color(col.color));
    }
    for (const g of gradientmap) {
      this.chars.slice(g.start - g.start_offset, g.end - g.start_offset - g.end_offset)
        .set_color_by_gradient(this._parse_color(g.from), this._parse_color(g.to));
    }
    if (height === null && width === null) this.scale(TEXT_MOB_SCALE_FACTOR);
    this.initial_height = this.height;
    return this;
  }

  hash_seed() {
    return JSON.stringify(["MarkupText", this.text, this.font, this.slant, this.weight, this.line_spacing, this._font_size,
      this.disable_ligatures, this.justify]);
  }

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

  _text2svg(color) {
    const size = this._font_size / TEXT2SVG_ADJUSTMENT_FACTOR;
    const base = { family: this.font, slant: this.slant, weight: WEIGHT_WORDS[String(this.weight).toLowerCase()] ?? 400,
      scale: 1, baseScale: 1, points: null, color: "#FFFFFF" };
    const finalText = `<span foreground="${color.to_hex()}">${this.text}</span>`;
    const runs = parsePangoMarkup(finalText, base);
    return markupShapes(layoutMarkup(runs, size, !this.disable_ligatures));
  }

  _parse_color(col) {
    return /^#[0-9a-f]{6}/.test(col) ? col : new ManimColor(col).to_hex();
  }

  _extract_gradient_tags() {
    const out = [];
    const re = /<gradient\s+from="([^"]+)"\s+to="([^"]+)"(\s+offset="([^"]+)")?>([\s\S]+?)<\/gradient>/g;
    for (const m of this.original_text.matchAll(re)) {
      const start = countRealChars(this.original_text.slice(0, m.index));
      const end = start + countRealChars(m[5]);
      const offsets = m[4] ? m[4].split(",") : ["0"];
      out.push({ start, end, from: m[1], to: m[2], start_offset: offsets[0] ? parseInt(offsets[0], 10) : 0,
        end_offset: offsets.length === 2 && offsets[1] ? parseInt(offsets[1], 10) : 0 });
    }
    this.text = this.text.replace(/<gradient[^>]+>([\s\S]+?)<\/gradient>/g, "$1");
    return out;
  }

  _extract_color_tags() {
    const out = [];
    const re = /<color\s+col="([^"]+)"(\s+offset="([^"]+)")?>([\s\S]+?)<\/color>/g;
    for (const m of this.original_text.matchAll(re)) {
      const start = countRealChars(this.original_text.slice(0, m.index));
      const end = start + countRealChars(m[4]);
      const offsets = m[3] ? m[3].split(",") : ["0"];
      out.push({ start, end, color: m[1], start_offset: offsets[0] ? parseInt(offsets[0], 10) : 0,
        end_offset: offsets.length === 2 && offsets[1] ? parseInt(offsets[1], 10) : 0 });
    }
    this.text = this.text.replace(/<color[^>]+>([\s\S]+?)<\/color>/g, "$1");
    return out;
  }
}
