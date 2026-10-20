// Ports of manim/mobject/text/numbers.py (DecimalNumber, Integer, Variable) and
// manim/mobject/value_tracker.py (ValueTracker).

import { DEFAULT_FONT_SIZE, DOWN, LEFT, ORIGIN, RIGHT, UP } from "./frozen.js";
import { Mobject, straightPath } from "./mobject.js";
import { MathTex, SingleStringMathTex } from "./tex.js";
import { VMobject } from "./vmobject.js";

/** Python's format(x, ".{digits}f"): exact rounding, halves to even. */
export function formatFixed(x, digits) {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const neg = x < 0 || Object.is(x, -0);
  const s = Math.abs(x).toFixed(Math.min(100, digits + 30));
  const dot = s.indexOf(".");
  const intPart = s.slice(0, dot);
  const frac = s.slice(dot + 1);
  const keep = frac.slice(0, digits);
  const rest = frac.slice(digits);
  const half = `5${"0".repeat(rest.length - 1)}`;
  const lastDigit = Number((intPart + keep).slice(-1));
  const up = rest > half || (rest === half && lastDigit % 2 === 1);
  let body = intPart + keep;
  if (up) {
    const d = body.split("").map(Number);
    let i = d.length - 1;
    while (i >= 0 && d[i] === 9) {
      d[i] = 0;
      i -= 1;
    }
    if (i < 0) d.unshift(1);
    else d[i] += 1;
    body = d.join("");
  }
  const whole = body.slice(0, body.length - digits) || "0";
  const out = digits > 0 ? `${whole}.${body.slice(body.length - digits)}` : whole;
  return (neg ? "-" : "") + out;
}

/** "{:+,.Nf}"-style formatting as DecimalNumber's formatter does it. */
function formatNumber(x, { include_sign, group_with_commas, num_decimal_places }) {
  let s = formatFixed(x, num_decimal_places);
  let sign = "";
  if (s.startsWith("-")) {
    sign = "-";
    s = s.slice(1);
  } else if (include_sign) sign = "+";
  if (group_with_commas) {
    const [whole, frac] = s.split(".");
    s = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac !== undefined ? `.${frac}` : "");
  }
  return sign + s;
}

/** np.round(x, decimals) */
const npRound = (x, decimals) => {
  const f = 10 ** decimals;
  const y = x * f;
  let r = Math.round(y);
  if (Math.abs(y % 1) === 0.5) r = 2 * Math.round(y / 2);
  return r / f;
};

const stringToMobMap = new Map();

export class DecimalNumber extends VMobject {
  static SIG = ["number", "num_decimal_places", "mob_class", "include_sign", "group_with_commas",
    "digit_buff_per_font_unit", "show_ellipsis", "unit", "unit_buff_per_font_unit", "include_background_rectangle",
    "edge_to_fix", "font_size", "stroke_width", "fill_opacity"];

  __init__({ number = 0, num_decimal_places = 2, mob_class = MathTex, include_sign = false, group_with_commas = true,
    digit_buff_per_font_unit = 0.001, show_ellipsis = false, unit = null, unit_buff_per_font_unit = 0,
    include_background_rectangle = false, edge_to_fix = LEFT, font_size = DEFAULT_FONT_SIZE, stroke_width = 0,
    fill_opacity = 1.0, ...kw } = {}) {
    super.__init__({ ...kw, fill_opacity, stroke_width });
    this.number = number;
    this.num_decimal_places = num_decimal_places;
    this.include_sign = include_sign;
    this.mob_class = mob_class;
    this.group_with_commas = group_with_commas;
    this.digit_buff_per_font_unit = digit_buff_per_font_unit;
    this.show_ellipsis = show_ellipsis;
    this.unit = unit;
    this.unit_buff_per_font_unit = unit_buff_per_font_unit;
    this.include_background_rectangle = include_background_rectangle;
    this.edge_to_fix = edge_to_fix;
    this._font_size = font_size;
    this.fill_opacity = fill_opacity;
    this.initial_config = { ...kw, num_decimal_places, include_sign, group_with_commas, digit_buff_per_font_unit,
      show_ellipsis, unit, unit_buff_per_font_unit, include_background_rectangle, edge_to_fix, font_size, stroke_width,
      fill_opacity };
    this._set_submobjects_from_number(number);
    this.init_colors();
    return this;
  }

  get font_size() {
    return (this.height / this.initial_height) * this._font_size;
  }

  set font_size(value) {
    if (value <= 0) throw new Error("font_size must be greater than 0.");
    else if (this.height > 0) this.scale(value / this.font_size);
  }

  _set_submobjects_from_number(number) {
    this.number = number;
    this.submobjects = [];
    const numString = this._get_num_string(number);
    this.add(...[...numString].map((c) => this._string_to_mob(c)));
    if (this.show_ellipsis) this.add(this._string_to_mob("\\dots", SingleStringMathTex, { color: this.color }));
    this.arrange(RIGHT, this.digit_buff_per_font_unit * this._font_size, true, { aligned_edge: DOWN });
    if (this.unit !== null && this.unit !== undefined) {
      this.unit_sign = this._string_to_mob(this.unit, SingleStringMathTex);
      this.add(this.unit_sign.next_to(this, RIGHT, (this.unit_buff_per_font_unit + this.digit_buff_per_font_unit)
        * this._font_size, { aligned_edge: DOWN }));
    }
    this.move_to(ORIGIN);
    [...numString].forEach((c, i) => {
      if (c === "-" && numString.length > i + 1) {
        this.get(i).align_to(this.get(i + 1), UP);
        this.get(i).shift(DOWN.map((v) => (v * this.get(i + 1).height) / 2));
      } else if (c === ",") {
        this.get(i).shift(DOWN.map((v) => (v * this.get(i).height) / 2));
      }
    });
    if (this.unit && this.unit.startsWith("^")) this.unit_sign.align_to(this, UP);
    this.initial_height = this.height;
    if (this.include_background_rectangle) this.add_background_rectangle();
  }

  _get_num_string(number) {
    const cfg = { include_sign: this.include_sign, group_with_commas: this.group_with_commas,
      num_decimal_places: this.num_decimal_places };
    let s;
    if (typeof number === "object" && number !== null && "re" in number) {
      s = `${formatNumber(number.re, cfg)}${formatNumber(number.im, { ...cfg, include_sign: true })}i`;
      return s;
    }
    s = formatNumber(Number(number), cfg);
    if (s.startsWith("-") && npRound(Number(number), this.num_decimal_places) === 0) {
      s = this.include_sign ? `+${s.slice(1)}` : s.slice(1);
    }
    return s;
  }

  _string_to_mob(string, mob_class = null, kw = {}) {
    const Cls = mob_class ?? this.mob_class;
    let cached = stringToMobMap.get(string);
    if (cached === undefined) {
      cached = Cls.make({ ...kw, tex_strings: [string], tex_string: string });
      if (!cached.svg_incomplete) stringToMobMap.set(string, cached);
    }
    const mob = cached.copy();
    mob.font_size = this._font_size;
    return mob;
  }

  set_value(number) {
    const oldFamily = this.get_family();
    const oldFontSize = this.font_size;
    const moveToPoint = this.get_edge_center(this.edge_to_fix);
    const oldSubmobjects = this.submobjects;
    this._set_submobjects_from_number(number);
    this.font_size = oldFontSize;
    this.move_to(moveToPoint, this.edge_to_fix);
    this.submobjects.forEach((sm1, i) => {
      if (i < oldSubmobjects.length) sm1.match_style(oldSubmobjects[i]);
    });
    for (const mob of oldFamily) {
      for (const p of mob.points) {
        p[0] = 0;
        p[1] = 0;
        p[2] = 0;
      }
    }
    this.init_colors();
    return this;
  }

  get_value() {
    return this.number;
  }

  increment_value(delta_t = 1) {
    return this.set_value(this.get_value() + delta_t);
  }
}

export class Integer extends DecimalNumber {
  static SIG = ["number", "num_decimal_places"];

  __init__({ number = 0, num_decimal_places = 0, ...kw } = {}) {
    return super.__init__({ ...kw, number, num_decimal_places });
  }

  get_value() {
    return Math.trunc(npRound(super.get_value(), 0));
  }
}

export class ValueTracker extends Mobject {
  static SIG = ["value"];

  __init__({ value = 0, ...kw } = {}) {
    super.__init__(kw);
    this.points = [[0, 0, 0]];
    this.set_value(value);
    return this;
  }

  get_value() {
    return this.points[0][0];
  }

  set_value(value) {
    this.points[0][0] = value;
    return this;
  }

  increment_value(d_value) {
    return this.set_value(this.get_value() + d_value);
  }

  interpolate(mobject1, mobject2, alpha, path_func = straightPath()) {
    this.points = path_func(mobject1.points, mobject2.points, alpha);
    return this;
  }
}

export class Variable extends VMobject {
  static SIG = ["var", "label", "var_type", "num_decimal_places"];

  __init__({ var: value, label, var_type = DecimalNumber, num_decimal_places = 2, ...kw } = {}) {
    this.label = typeof label === "string" ? MathTex.make({ tex_strings: [label] }) : label;
    const equals = MathTex.make({ tex_strings: ["="] }).next_to(this.label, RIGHT);
    this.label.add(equals);
    this.tracker = ValueTracker.make({ value });
    if (var_type === Integer) this.value = Integer.make({ number: this.tracker.get_value() });
    else this.value = DecimalNumber.make({ number: this.tracker.get_value(), num_decimal_places });
    const self = this;
    this.value.add_updater((v) => v.set_value(self.tracker.get_value())).next_to(this.label, RIGHT);
    super.__init__(kw);
    this.add(this.label, this.value);
    return this;
  }
}

export { ORIGIN };
