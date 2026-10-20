// MathTex and friends: ports of manim/mobject/text/tex_mobject.py. Manim typesets with LaTeX and reads dvisvgm's SVG
// (units: bp); here MathJax typesets (units: 1/1000 em, where an em is LaTeX's 10 pt) and its SVG is scaled to bp,
// so everything after the file — sizing by font_size, colouring, splitting into parts — is Manim's own code.
//
// Parts: Manim wraps each part in dvisvgm specials (<g id='unique000'>); MathJax gets \manimpartbegin{unique000} /
// \manimpartend instead, which tag the MathML made between them without changing the layout (mw/mathjax.js).

import { ManimColor } from "../core/color.js";
import { config } from "./config.js";
import { DEFAULT_FONT_SIZE, DOWN, LEFT, MED_LARGE_BUFF, MED_SMALL_BUFF, RIGHT, SCALE_FACTOR_PER_FONT_POINT, SMALL_BUFF,
  UP } from "./frozen.js";
import { Line } from "./geometry.js";
import { lazy } from "./mobject.js";
import { SVGMobject, parseXml, svgShapes } from "./svg.js";
import { texRender } from "./texcache.js";
import { VGroup, VMobject } from "./vmobject.js";

export const MATHTEX_SUBSTRING = "substring";
const BP_PER_EM = 10 * (72 / 72.27); // LaTeX's 10 pt in PostScript points, dvisvgm's unit

const MATH_ENVIRONMENTS = new Set(["align", "align*", "equation", "equation*", "gather", "gather*", "multline",
  "multline*", "flalign", "flalign*", "alignat", "alignat*", "eqnarray", "eqnarray*", "displaymath", "math"]);

const pad3 = (n) => String(n).padStart(3, "0");
const isBlack = (c) => c instanceof ManimColor && Math.abs(c.v[0]) < 1e-8 && Math.abs(c.v[1]) < 1e-8
  && Math.abs(c.v[2]) < 1e-8 && Math.abs(c.v[3] - 1) < 1e-8;

// ------------------------------------------------------------------------------------------------ TeX to MathJax

/** Text-mode LaTeX (Tex, BulletedList) as MathJax math: text runs in \text{}, math kept, \\ as array rows. */
export function textModeToMath(expression, align = "c") {
  const lines = [];
  let line = "";
  let i = 0;
  const s = expression;
  const readGroup = (at) => { // a balanced {...} starting at `at`; returns its end (exclusive)
    let depth = 0;
    for (let k = at; k < s.length; k += 1) {
      if (s[k] === "\\") k += 1;
      else if (s[k] === "{") depth += 1;
      else if (s[k] === "}") {
        depth -= 1;
        if (depth === 0) return k + 1;
      }
    }
    return s.length;
  };
  let text = "";
  const flush = () => {
    if (text) line += `\\text{${text}}`;
    text = "";
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === "$") {
      flush();
      const dbl = s[i + 1] === "$";
      const close = s.indexOf(dbl ? "$$" : "$", i + (dbl ? 2 : 1));
      const end = close < 0 ? s.length : close;
      const body = s.slice(i + (dbl ? 2 : 1), end);
      line += dbl ? `{\\displaystyle ${body}}` : `{\\textstyle ${body}}`;
      i = close < 0 ? s.length : end + (dbl ? 2 : 1);
    } else if (ch === "\\") {
      const next = s[i + 1] ?? "";
      if (next === "\\") {
        flush();
        lines.push(line);
        line = "";
        i += 2;
        if (s[i] === "[") i = s.indexOf("]", i) + 1 || s.length;
      } else if (next === "(") {
        flush();
        const close = s.indexOf("\\)", i + 2);
        const end = close < 0 ? s.length : close;
        line += `{\\textstyle ${s.slice(i + 2, end)}}`;
        i = close < 0 ? s.length : end + 2;
      } else if ("%$&#_{}".includes(next) && next) {
        flush();
        line += `\\${next}`;
        i += 2;
      } else {
        const m = /^\\([A-Za-z]+)\s*/.exec(s.slice(i));
        if (!m) {
          text += next;
          i += 2;
          continue;
        }
        flush();
        let end = i + m[0].length;
        let cmd = m[1];
        if (cmd === "manimpartbegin" || ["textbf", "textit", "textrm", "texttt", "textsf", "emph", "textup", "textsl",
          "underline", "mbox", "hbox"].includes(cmd)) {
          if (s[end] === "{") end = readGroup(end);
          let body = s.slice(i + m[0].length, end);
          if (cmd === "emph") cmd = "textit";
          if (cmd === "mbox" || cmd === "hbox") cmd = "text";
          if (cmd === "underline") body = `{${textModeToMath(body.slice(1, -1), align)}}`;
          line += `\\${cmd}${body}`;
        } else {
          line += s.slice(i, end).trimEnd() + (cmd === "manimpartend" ? "" : " ");
        }
        i = end;
      }
    } else if (ch === "~") {
      text += " ";
      i += 1;
    } else if (ch === "{" || ch === "}") {
      flush();
      line += ch;
      i += 1;
    } else if (ch === "%") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl + 1;
    } else {
      const lig = [["---", "—"], ["--", "–"], ["``", "“"], ["''", "”"]].find(([k]) => s.startsWith(k, i));
      if (lig) {
        text += lig[1];
        i += lig[0].length;
      } else {
        text += ch === "\n" || ch === "\t" ? " " : ch;
        i += 1;
      }
    }
  }
  flush();
  lines.push(line);
  while (lines.length > 1 && lines[lines.length - 1].replace(/\\manimpartend/g, "").trim() === "") {
    const tail = lines.pop();
    lines[lines.length - 1] += tail;
  }
  if (lines.length === 1) return lines[0];
  return `\\begin{array}{${align}}${lines.join("\\\\")}\\end{array}`;
}

/** The MathJax input for tex_to_svg_file(expression, environment). */
export function mathJaxInput(expression, environment) {
  if (environment && MATH_ENVIRONMENTS.has(environment)) {
    if (environment === "displaymath" || environment === "math") return expression;
    return `\\begin{${environment}}${expression}\\end{${environment}}`;
  }
  return textModeToMath(expression, environment === "center" ? "c" : "l");
}

/** MathJax's SVG as dvisvgm would write it: in bp, black glyphs without a stroke, and TeX's order for the bar of a
 *  fraction and the rule of a root (between the parts, where MathJax puts it last). */
export function prepareMathJaxSvg(markup) {
  const start = markup.indexOf("<svg");
  const end = markup.lastIndexOf("</svg>");
  const svg = parseXml(markup.slice(start, end + 6));
  const visit = (node) => {
    const kind = node.attrs["data-mml-node"];
    const kids = node.children;
    if ((kind === "mfrac" || kind === "msqrt") && kids.length === 3 && kids[2].tag === "rect") {
      kids.splice(1, 0, kids.pop());
    } else if (kind === "mroot" && kids.length >= 3) {
      const rect = kids.findIndex((k) => k.tag === "rect");
      if (rect > 1) kids.splice(rect - 1, 0, kids.splice(rect, 1)[0]);
    }
    delete node.attrs.stroke;
    kids.forEach(visit);
  };
  visit(svg);
  return { tag: "svg", attrs: {}, text: "", children: [
    { tag: "g", attrs: { transform: `scale(${BP_PER_EM / 1000})` }, text: "", children: svg.children }] };
}

// ------------------------------------------------------------------------------------------------ classes

export class SingleStringMathTex extends SVGMobject {
  static SIG = ["tex_string", "stroke_width", "should_center", "height", "organize_left_to_right", "tex_environment",
    "tex_template", "font_size", "color"];

  __init__({ tex_string, stroke_width = 0, should_center = true, height = null, organize_left_to_right = false,
    tex_environment = "align*", tex_template = null, font_size = DEFAULT_FONT_SIZE, color = null, ...kw } = {}) {
    if (color === null) color = VMobject.make().color;
    this._font_size = font_size;
    this.organize_left_to_right = organize_left_to_right;
    this.tex_environment = tex_environment;
    this.tex_template = tex_template;
    this.tex_string = tex_string;
    this._mathjax_input = mathJaxInput(this._get_modified_expression(tex_string), this.tex_environment);
    super.__init__({ ...kw, file_name: null, svg_text: "", should_center, stroke_width, height, color,
      path_string_config: { should_subdivide_sharp_curves: true, should_remove_null_curves: true } });
    this.init_colors();
    this.initial_height = this.height;
    if (height === null) this.font_size = this._font_size;
    if (this.organize_left_to_right) this._organize_submobjects_left_to_right();
    return this;
  }

  hash_seed() {
    return JSON.stringify([this.constructor.name, this.svg_default, this.path_string_config, this._mathjax_input]);
  }

  svg_shapes() {
    const markup = texRender(this._mathjax_input);
    if (markup === null) {
      this.svg_incomplete = true;
      return [];
    }
    return svgShapes(prepareMathJaxSvg(markup), this.generate_config_style_dict());
  }

  get font_size() {
    return this.height / this.initial_height / SCALE_FACTOR_PER_FONT_POINT;
  }

  set font_size(value) {
    if (value <= 0) throw new Error("font_size must be greater than 0.");
    else if (this.height > 0) this.scale(value / this.font_size);
  }

  _get_modified_expression(tex) {
    return this._modify_special_strings(tex.trim());
  }

  _modify_special_strings(input) {
    let tex = input.trim();
    const filler = tex === "\\over" || tex === "\\overline" || tex === "\\sqrt" || tex === "\\sqrt{" || tex.endsWith("_")
      || tex.endsWith("^") || tex.endsWith("dot");
    if (filler) tex += "{\\quad}";
    if (tex === "\\substack") tex = "\\quad";
    if (tex === "") tex = "\\quad";
    if (tex.startsWith("\\\\")) tex = tex.replaceAll("\\\\", "\\quad\\\\");
    const count = (sub) => tex.split(sub).slice(1).filter((p) => p && "(){}[]|.\\".includes(p[0])).length;
    if (count("\\left") !== count("\\right")) {
      tex = tex.replaceAll("\\left", "\\big").replaceAll("\\right", "\\big");
    }
    tex = this._remove_stray_braces(tex);
    for (const context of ["array"]) {
      const begin = tex.includes(`\\begin{${context}}`);
      const end = tex.includes(`\\end{${context}}`);
      if (begin !== end) tex = "";
    }
    return tex;
  }

  _remove_stray_braces(input) {
    let tex = input;
    const occurrences = (sub) => tex.split(sub).length - 1;
    let lefts = occurrences("{") - occurrences("\\{") + occurrences("\\\\{");
    let rights = occurrences("}") - occurrences("\\}") + occurrences("\\\\}");
    while (rights > lefts) {
      tex = `{${tex}`;
      lefts += 1;
    }
    while (lefts > rights) {
      tex = `${tex}}`;
      rights += 1;
    }
    return tex;
  }

  _organize_submobjects_left_to_right() {
    this.sort((p) => p[0]);
    return this;
  }

  get_tex_string() {
    return this.tex_string;
  }

  init_colors(propagate_colors = true) {
    for (const sub of this.submobjects) {
      if (!isBlack(sub.color)) continue;
      sub.color = this.color;
      sub.init_colors(propagate_colors);
    }
    return this;
  }
}

export class MathTexPart extends VMobject {
  static SIG = [];
}

export class MathTex extends SingleStringMathTex {
  static SIG = ["*tex_strings"];

  __init__({ tex_strings = [], arg_separator = " ", substrings_to_isolate = null, tex_to_color_map = null,
    tex_environment = "align*", tex_template = null, ...kw } = {}) {
    this.tex_template = tex_template;
    this.arg_separator = arg_separator;
    this.substrings_to_isolate = substrings_to_isolate ? [...substrings_to_isolate] : [];
    this.tex_to_color_map = tex_to_color_map ?? {};
    this.substrings_to_isolate.push(...Object.keys(this.tex_to_color_map));
    this.tex_environment = tex_environment;
    this.brace_notation_split_occurred = false;
    this.tex_strings = this._prepare_tex_strings(tex_strings);
    this.matched_strings_and_ids = [];
    const joined = this._join_tex_strings_with_unique_deliminters(this.tex_strings, this.substrings_to_isolate);
    super.__init__({ ...kw, tex_string: joined, tex_environment: this.tex_environment, tex_template });
    this.tex_string = this.tex_strings.join(this.arg_separator);
    this._break_up_by_substrings();
    this.set_color_by_tex_to_color_map(this.tex_to_color_map);
    if (this.organize_left_to_right) this._organize_submobjects_left_to_right();
    return this;
  }

  expected_group_ids() {
    return this.matched_strings_and_ids.map(([, id]) => id);
  }

  _prepare_tex_strings(texStrings) {
    const validated = texStrings.map((s) => (typeof s === "string" ? s : String(s)));
    const split = validated.flatMap((s) => MathTex._split_double_braces(s));
    if (split.length > validated.length) this.brace_notation_split_occurred = true;
    return split.filter((s) => s.length > 0);
  }

  static _split_double_braces(tex) {
    const segments = [];
    let current = "";
    let i = 0;
    let inside = false;
    let depth = 0;
    while (i < tex.length) {
      if (tex[i] === "\\" && i + 1 < tex.length) {
        const next = tex[i + 1];
        if (next === "\\" || "{}".includes(next)) {
          current += tex.slice(i, i + 2);
          i += 2;
          continue;
        }
      }
      if (!inside) {
        if (tex.slice(i, i + 2) === "{{" && (i === 0 || /\s/.test(tex[i - 1]))) {
          segments.push(current);
          current = "";
          inside = true;
          depth = 0;
          i += 2;
        } else {
          current += tex[i];
          i += 1;
        }
      } else if (tex[i] === "{") {
        depth += 1;
        current += tex[i];
        i += 1;
      } else if (tex[i] === "}" && depth === 0 && tex.slice(i, i + 2) === "}}") {
        segments.push(current);
        current = "";
        inside = false;
        i += 2;
      } else if (tex[i] === "}") {
        depth -= 1;
        current += tex[i];
        i += 1;
      } else {
        current += tex[i];
        i += 1;
      }
    }
    segments.push(current);
    return segments;
  }

  _join_tex_strings_with_unique_deliminters(texStrings, substrings) {
    let joined = "";
    let ssIdx = 0;
    texStrings.forEach((tex, idx) => {
      let part = `\\manimpartbegin{unique${pad3(idx)}}`;
      this.matched_strings_and_ids.push([tex, `unique${pad3(idx)}`]);
      let unprocessed = String(tex);
      let processed = "";
      while (unprocessed.length > 0) {
        const match = this._locate_first_match(substrings, unprocessed);
        if (match) {
          const [pre, matched, post] = match;
          const id = `unique${pad3(ssIdx)}${MATHTEX_SUBSTRING}`;
          this.matched_strings_and_ids.push([matched, id]);
          processed += `${pre}\\manimpartbegin{${id}}${matched}\\manimpartend `;
          unprocessed = post;
          ssIdx += 1;
        } else {
          processed += unprocessed;
          unprocessed = "";
        }
      }
      part += processed;
      if (idx < texStrings.length - 1) part += this.arg_separator;
      part += "\\manimpartend ";
      joined += part;
    });
    return joined;
  }

  _locate_first_match(substrings, s) {
    let best = null;
    for (const sub of substrings) {
      if (!sub) continue;
      const at = s.indexOf(sub);
      if (at < 0) continue;
      if (best === null || at < best[0].length || (at === best[0].length && sub.length > best[1].length)) {
        best = [s.slice(0, at), sub, s.slice(at + sub.length)];
      }
    }
    return best;
  }

  get _substring_matches() {
    return this.matched_strings_and_ids.filter(([, id]) => id.endsWith(MATHTEX_SUBSTRING));
  }

  get _main_matches() {
    return this.matched_strings_and_ids.filter(([, id]) => !id.endsWith(MATHTEX_SUBSTRING));
  }

  _break_up_by_substrings() {
    const parts = [];
    for (const [tex, id] of this._main_matches) {
      const group = this.id_to_vgroup_dict[id];
      if (!group) {
        parts.push(this.id_to_vgroup_dict.root);
        break;
      }
      const part = MathTexPart.make();
      part.tex_string = tex;
      part.add(...group.submobjects);
      parts.push(part);
    }
    this.submobjects = parts;
    return this;
  }

  get_part_by_tex(tex) {
    for (const [str, id] of this.matched_strings_and_ids) if (str === tex) return this.id_to_vgroup_dict[id];
    return null;
  }

  set_color_by_tex(tex, color) {
    for (const [str, id] of this.matched_strings_and_ids) if (str === tex) this.id_to_vgroup_dict[id].set_color(color);
    return this;
  }

  set_opacity_by_tex(tex, opacity = 0.5, remaining_opacity = null) {
    if (remaining_opacity !== null) this.set_opacity(remaining_opacity);
    for (const [str, id] of this.matched_strings_and_ids) {
      if (str === tex) this.id_to_vgroup_dict[id].set_opacity(opacity);
    }
    return this;
  }

  set_color_by_tex_to_color_map(map) {
    for (const [tex, color] of Object.entries(map)) {
      for (const [str, id] of this.matched_strings_and_ids) if (str === tex) this.id_to_vgroup_dict[id].set_color(color);
    }
    return this;
  }

  index_of_part(part) {
    const index = this.iter().indexOf(part);
    if (index < 0) throw new Error("Trying to get index of part not in MathTex");
    return index;
  }

  sort_alphabetically() {
    this.submobjects.sort((a, b) => (a.get_tex_string() < b.get_tex_string() ? -1 : 1));
    return this;
  }
}

export class Tex extends MathTex {
  static SIG = ["*tex_strings"];

  __init__({ arg_separator = "", tex_environment = "center", ...kw } = {}) {
    return super.__init__({ ...kw, arg_separator, tex_environment });
  }
}

export class BulletedList extends Tex {
  static SIG = ["*items"];

  __init__({ items = [], buff = MED_LARGE_BUFF, dot_scale_factor = 2, tex_environment = null, dot_buff = SMALL_BUFF,
    ...kw } = {}) {
    this.buff = buff;
    this.dot_scale_factor = dot_scale_factor;
    this.tex_environment = tex_environment;
    super.__init__({ ...kw, tex_strings: items.map((s) => `${s}\\\\`), tex_environment });
    for (const part of this.iter()) {
      const dot = MathTex.make({ tex_strings: ["\\cdot"] }).scale(this.dot_scale_factor);
      dot.next_to(part.get(0), LEFT, dot_buff);
      part.add_to_back(dot);
    }
    this.arrange(DOWN, this.buff, true, { aligned_edge: LEFT });
    return this;
  }

  fade_all_but(indexOrString, opacity = 0.5) {
    const part = typeof indexOrString === "string" ? this.get_part_by_tex(indexOrString) : this.submobjects[indexOrString];
    if (!part) throw new Error(`Could not locate part by provided tex string '${indexOrString}'.`);
    for (const other of this.submobjects) other.set_fill(null, other === part ? 1 : opacity);
    return this;
  }
}

export class Title extends Tex {
  static SIG = ["*text_parts"];

  __init__({ text_parts = [], include_underline = true, match_underline_width_to_text = false,
    underline_buff = MED_SMALL_BUFF, ...kw } = {}) {
    this.include_underline = include_underline;
    this.match_underline_width_to_text = match_underline_width_to_text;
    this.underline_buff = underline_buff;
    super.__init__({ ...kw, tex_strings: text_parts });
    this.to_edge(UP);
    if (this.include_underline) {
      const underlineWidth = config.frame_width - 2;
      const underline = Line.make({ start: LEFT, end: RIGHT });
      underline.next_to(this, DOWN, this.underline_buff);
      if (this.match_underline_width_to_text) underline.match_width(this);
      else underline.width = underlineWidth;
      this.add(underline);
      this.underline = underline;
    }
    return this;
  }
}

lazy.MathTex = MathTex;
export { VGroup };
