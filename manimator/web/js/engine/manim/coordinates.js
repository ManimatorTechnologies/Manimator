// Ports of manim/mobject/graphing: number_line.py, coordinate_systems.py (Axes, ThreeDAxes, NumberPlane,
// PolarPlane, ComplexPlane) and functions.py (ParametricFunction, FunctionGraph, ImplicitFunction).

import { colorGradient } from "../core/color.js";
import { plotIsoline } from "../core/isoline.js";
import { add, angleOfVector, arange, dot, mul, normalize, sub } from "../core/math.js";
import { config } from "./config.js";
import { DEFAULT_ARROW_TIP_LENGTH, DEGREES, DL, DOWN, DR, LEFT, MED_SMALL_BUFF, ORIGIN, OUT, PI, RIGHT, SMALL_BUFF,
  TAU, UP } from "./frozen.js";
import { Arrow, BLUE, Circle, DashedLine, Line, PURE_YELLOW, Rectangle } from "./geometry.js";
import { Group, pt3 } from "./mobject.js";
import { DecimalNumber, formatFixed } from "./numbers.js";
import { MathTex, Tex } from "./tex.js";
import { VGroup, VMobject } from "./vmobject.js";

export const BLUE_D = "#29ABCA";

/** Python's round(): halves to even. */
const pyRound = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
};

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** manim.utils.config_ops.merge_dicts_recursively */
export function mergeDictsRecursively(...dicts) {
  const result = {};
  for (const d of dicts) {
    for (const [k, v] of Object.entries(d ?? {})) {
      result[k] = k in result && isDict(result[k]) && isDict(v) ? mergeDictsRecursively(result[k], v) : v;
    }
  }
  return result;
}

/** manim.utils.config_ops.update_dict_recursively */
export function updateDictRecursively(current, ...others) {
  Object.assign(current, mergeDictsRecursively(current, ...others));
}

const isClose = (a, b) => Math.abs(a - b) <= 1e-8 + 1e-5 * Math.abs(b);

export class LinearBase {
  constructor(scale_factor = 1.0) {
    this.scale_factor = scale_factor;
    this.custom_labels = false;
  }

  function(value) {
    return Array.isArray(value) ? value.map((v) => this.scale_factor * v) : this.scale_factor * value;
  }

  inverse_function(value) {
    return Array.isArray(value) ? value.map((v) => v / this.scale_factor) : value / this.scale_factor;
  }
}

// ------------------------------------------------------------------------------------------------ number_line.py

export class NumberLine extends Line {
  static SIG = ["x_range", "length", "unit_size", "include_ticks", "tick_size", "numbers_with_elongated_ticks",
    "longer_tick_multiple", "exclude_origin_tick", "rotation", "stroke_width", "include_tip", "tip_width",
    "tip_height", "tip_shape", "include_numbers", "font_size", "label_direction", "label_constructor", "scaling",
    "line_to_number_buff", "decimal_number_config", "numbers_to_exclude", "numbers_to_include"];

  __init__({ x_range = null, length = null, unit_size = 1, include_ticks = true, tick_size = 0.1,
    numbers_with_elongated_ticks = null, longer_tick_multiple = 2, exclude_origin_tick = false, rotation = 0,
    stroke_width = 2.0, include_tip = false, tip_width = DEFAULT_ARROW_TIP_LENGTH, tip_height = DEFAULT_ARROW_TIP_LENGTH,
    tip_shape = null, include_numbers = false, font_size = 36, label_direction = DOWN, label_constructor = MathTex,
    scaling = new LinearBase(), line_to_number_buff = MED_SMALL_BUFF, decimal_number_config = null,
    numbers_to_exclude = null, numbers_to_include = null, ...kw } = {}) {
    numbers_to_exclude ??= [];
    numbers_with_elongated_ticks ??= [];
    if (x_range === null) x_range = [pyRound(-config.frame_x_radius), pyRound(config.frame_x_radius), 1];
    else if (x_range.length === 2) x_range = [...x_range, 1];
    decimal_number_config ??= { num_decimal_places: NumberLine._decimal_places_from_step(x_range[2]) };
    this.x_range = x_range.map(Number);
    [this.x_min, this.x_max, this.x_step] = scaling.function(this.x_range);
    this.length = length;
    this.unit_size = unit_size;
    this.include_ticks = include_ticks;
    this.tick_size = tick_size;
    this.numbers_with_elongated_ticks = numbers_with_elongated_ticks;
    this.longer_tick_multiple = longer_tick_multiple;
    this.exclude_origin_tick = exclude_origin_tick;
    this.rotation = rotation;
    this.include_tip = include_tip;
    this.tip_width = tip_width;
    this.tip_height = tip_height;
    this.font_size = font_size;
    this.include_numbers = include_numbers;
    this.label_direction = label_direction;
    this.label_constructor = label_constructor;
    this.line_to_number_buff = line_to_number_buff;
    this.decimal_number_config = decimal_number_config;
    this.numbers_to_exclude = numbers_to_exclude;
    this.numbers_to_include = numbers_to_include;
    this.scaling = scaling;
    super.__init__({ ...kw, start: mul(RIGHT, this.x_range[0]), end: mul(RIGHT, this.x_range[1]), stroke_width });
    if (this.length) {
      this.set_length(this.length);
      this.unit_size = this.get_unit_size();
    } else {
      this.scale(this.unit_size);
    }
    this.center();
    if (this.include_tip) {
      this.add_tip({ tip_length: this.tip_height, tip_width: this.tip_width, tip_shape });
      this.tip.set_stroke(this.stroke_color, this.stroke_width);
    }
    if (this.include_ticks) this.add_ticks();
    this.rotate(this.rotation);
    if (this.include_numbers || this.numbers_to_include !== null) {
      this.add_numbers(this.numbers_to_include, this.numbers_to_exclude, this.font_size);
    }
    return this;
  }

  rotate_about_zero(angle, axis = OUT, kw = {}) {
    return this.rotate_about_number(0, angle, axis, kw);
  }

  rotate_about_number(number, angle, axis = OUT, kw = {}) {
    return this.rotate(angle, axis, { ...kw, about_point: this.n2p(number) });
  }

  add_ticks() {
    const ticks = VGroup.make();
    const elongated = this.tick_size * this.longer_tick_multiple;
    const offsets = this.numbers_with_elongated_ticks.map((n) => n - this.x_min);
    for (const x of this.get_tick_range()) {
      const size = offsets.some((o) => isClose(x - this.x_min, o)) ? elongated : this.tick_size;
      ticks.add(this.get_tick(x, size));
    }
    this.add(ticks);
    this.ticks = ticks;
    return this;
  }

  get_tick(x, size = null) {
    const s = size ?? this.tick_size;
    const result = Line.make({ start: mul(DOWN, s), end: mul(UP, s) });
    result.rotate(this.get_angle());
    result.move_to(this.number_to_point(x));
    result.match_style(this);
    return result;
  }

  get_tick_marks() {
    return this.ticks;
  }

  get_tick_range() {
    let [xMin, xMax, xStep] = this.x_range;
    if (!this.include_tip) xMax += 1e-6;
    let range;
    if ((xMin < xMax && xMax < 0) || (xMax > xMin && xMin > 0)) {
      range = arange(xMin, xMax, xStep);
    } else {
      const startPoint = this.exclude_origin_tick ? xStep : 0;
      const minSegment = arange(startPoint, Math.abs(xMin) + 1e-6, xStep).map((v) => v * -1);
      const maxSegment = arange(startPoint, xMax, xStep);
      range = [...new Set([...minSegment, ...maxSegment].map((v) => (Object.is(v, -0) ? 0 : v)))].sort((a, b) => a - b);
    }
    return this.scaling.function(range);
  }

  number_to_point(number) {
    const n = this.scaling.inverse_function(number);
    const alpha = (n - this.x_range[0]) / (this.x_range[1] - this.x_range[0]);
    const s = this.get_start();
    const e = this.get_end();
    return [0, 1, 2].map((i) => s[i] * (1 - alpha) + e[i] * alpha);
  }

  point_to_number(point) {
    const p = pt3(point);
    const [start, end] = this.get_start_and_end();
    const unit = normalize(sub(end, start));
    const proportion = dot(sub(p, start), unit) / dot(sub(end, start), unit);
    return this.x_min * (1 - proportion) + this.x_max * proportion;
  }

  n2p(number) {
    return this.number_to_point(number);
  }

  p2n(point) {
    return this.point_to_number(point);
  }

  get_unit_size() {
    return this.get_length() / (this.x_range[1] - this.x_range[0]);
  }

  get_unit_vector() {
    return mul(super.get_unit_vector(), this.unit_size);
  }

  get_number_mobject(x, { direction = null, buff = null, font_size = null, label_constructor = null, ...numberConfig } = {}) {
    const merged = mergeDictsRecursively(this.decimal_number_config, numberConfig);
    const dir = direction ?? this.label_direction;
    const b = buff ?? this.line_to_number_buff;
    const fs = font_size ?? this.font_size;
    const ctor = label_constructor ?? this.label_constructor;
    const num = DecimalNumber.make({ ...merged, number: x, font_size: fs, mob_class: ctor });
    num.next_to(this.number_to_point(x), dir, b);
    if (x < 0 && this.label_direction[0] === 0) num.shift(mul(LEFT, num.get(0).width / 2));
    return num;
  }

  get_number_mobjects(...numbers) {
    const xs = numbers.length ? numbers : this.default_numbers_to_display();
    return VGroup.make({ vmobjects: xs.map((n) => this.get_number_mobject(n)) });
  }

  add_numbers(x_values = null, excluding = null, font_size = null, label_constructor = null, kw = {}) {
    const xs = x_values ?? this.get_tick_range();
    const ex = excluding ?? this.numbers_to_exclude;
    const fs = font_size ?? this.font_size;
    const ctor = label_constructor ?? this.label_constructor;
    const numbers = VGroup.make();
    for (const x of xs) {
      if (ex.some((e) => e === x)) continue;
      numbers.add(this.get_number_mobject(x, { ...kw, font_size: fs, label_constructor: ctor }));
    }
    this.add(numbers);
    this.numbers = numbers;
    return this;
  }

  add_labels(dictValues, direction = null, buff = null, font_size = null, label_constructor = null) {
    const dir = direction ?? this.label_direction;
    const b = buff ?? this.line_to_number_buff;
    const fs = font_size ?? this.font_size;
    const ctor = label_constructor ?? this.label_constructor;
    const labels = VGroup.make();
    for (const [x, raw] of dictValues instanceof Map ? dictValues : Object.entries(dictValues)) {
      let label;
      if (typeof raw === "string") label = ctor === MathTex ? Tex.make({ tex_strings: [raw] }) : this._create_label_tex(raw, ctor);
      else label = this._create_label_tex(raw, ctor);
      label.font_size = fs;
      label.next_to(this.number_to_point(Number(x)), dir, b);
      labels.add(label);
    }
    this.labels = labels;
    this.add(labels);
    return this;
  }

  _create_label_tex(labelTex, labelConstructor = null) {
    if (labelTex instanceof VMobject) return labelTex;
    const ctor = labelConstructor ?? this.label_constructor;
    return ctor.make({ tex_strings: [String(labelTex)], text: String(labelTex) });
  }

  /** str(step) has a "." for a float: 1 -> 0 places, 0.5 -> 1, 0.25 -> 2. */
  static _decimal_places_from_step(step) {
    const s = String(step);
    if (!s.includes(".")) return 0;
    return s.split(".").pop().length;
  }
}

export class UnitInterval extends NumberLine {
  static SIG = ["unit_size", "numbers_with_elongated_ticks", "decimal_number_config"];

  __init__({ unit_size = 10, numbers_with_elongated_ticks = null, decimal_number_config = null, ...kw } = {}) {
    return super.__init__({ ...kw, x_range: [0, 1, 0.1], unit_size,
      numbers_with_elongated_ticks: numbers_with_elongated_ticks ?? [0, 1],
      decimal_number_config: decimal_number_config ?? { num_decimal_places: 1 } });
  }
}

// ------------------------------------------------------------------------------------------------ functions.py

export class ParametricFunction extends VMobject {
  static SIG = ["function", "t_range", "scaling", "dt", "discontinuities", "use_smoothing", "use_vectorized"];

  __init__({ function: fn, t_range = [0, 1], scaling = new LinearBase(), dt = 1e-8, discontinuities = null,
    use_smoothing = true, use_vectorized = false, ...kw } = {}) {
    this.function = (t) => pt3(fn(t));
    const range = t_range.length === 2 ? [...t_range, 0.01] : t_range;
    this.scaling = scaling;
    this.dt = dt;
    this.discontinuities = discontinuities;
    this.use_smoothing = use_smoothing;
    this.use_vectorized = use_vectorized;
    [this.t_min, this.t_max, this.t_step] = range.map(Number);
    return super.__init__(kw);
  }

  get_function() {
    return this.function;
  }

  get_point_from_function(t) {
    return this.function(t);
  }

  generate_points() {
    let boundary;
    if (this.discontinuities !== null) {
      const ds = this.discontinuities.filter((t) => this.t_min <= t && t <= this.t_max);
      boundary = [this.t_min, this.t_max, ...ds.map((d) => d - this.dt), ...ds.map((d) => d + this.dt)]
        .sort((a, b) => a - b);
    } else {
      boundary = [this.t_min, this.t_max];
    }
    for (let k = 0; k + 1 < boundary.length; k += 2) {
      const [t1, t2] = [boundary[k], boundary[k + 1]];
      const ts = [...this.scaling.function(arange(t1, t2, this.t_step)), this.scaling.function(t2)];
      const points = ts.map((t) => this.function(t));
      this.start_new_path(points[0]);
      this.add_points_as_corners(points.slice(1));
    }
    if (this.use_smoothing) this.make_smooth();
    return this;
  }

  init_points() {
    return this.generate_points();
  }
}

export class FunctionGraph extends ParametricFunction {
  static SIG = ["function", "x_range", "color"];

  __init__({ function: fn, x_range = null, color = PURE_YELLOW, ...kw } = {}) {
    const range = x_range ?? [-config.frame_x_radius, config.frame_x_radius];
    this.x_range = range;
    this.parametric_function = (t) => [t, fn(t), 0];
    this.function = fn; // replaced by ParametricFunction's wrapper, as in Manim
    return super.__init__({ ...kw, function: this.parametric_function, t_range: range, color });
  }

  get_function() {
    return this.function;
  }

  get_point_from_function(x) {
    return this.parametric_function(x);
  }
}

export class ImplicitFunction extends VMobject {
  static SIG = ["func", "x_range", "y_range", "min_depth", "max_quads", "use_smoothing"];

  __init__({ func, x_range = null, y_range = null, min_depth = 5, max_quads = 1500, use_smoothing = true, ...kw } = {}) {
    this.function = func;
    this.min_depth = min_depth;
    this.max_quads = max_quads;
    this.use_smoothing = use_smoothing;
    this.x_range = x_range ?? [-config.frame_width / 2, config.frame_width / 2];
    this.y_range = y_range ?? [-config.frame_height / 2, config.frame_height / 2];
    return super.__init__(kw);
  }

  generate_points() {
    const curves = plotIsoline((u) => this.function(u[0], u[1]), [this.x_range[0], this.y_range[0]],
      [this.x_range[1], this.y_range[1]], this.min_depth, this.max_quads).filter((c) => c.length);
    for (const curve of curves) {
      const pts = curve.map((p) => [p[0], p[1], 0]);
      this.start_new_path(pts[0]);
      this.add_points_as_corners(pts.slice(1));
    }
    if (this.use_smoothing) this.make_smooth();
    return this;
  }

  init_points() {
    return this.generate_points();
  }
}

// ------------------------------------------------------------------------------------------------ coordinate_systems.py

/** CoordinateSystem's methods, for Axes (Python: class Axes(VGroup, CoordinateSystem)). */
const CoordinateSystemMixin = (Base) => class extends Base {
  _cs_init(x_range = null, y_range = null, x_length = null, y_length = null, dimension = 2) {
    this.dimension = dimension;
    const defaultStep = 1;
    if (x_range === null) x_range = [pyRound(-config.frame_x_radius), pyRound(config.frame_x_radius), defaultStep];
    else if (x_range.length === 2) x_range = [...x_range, defaultStep];
    if (y_range === null) y_range = [pyRound(-config.frame_y_radius), pyRound(config.frame_y_radius), defaultStep];
    else if (y_range.length === 2) y_range = [...y_range, defaultStep];
    this.x_range = x_range;
    this.y_range = y_range;
    this.x_length = x_length;
    this.y_length = y_length;
    this.num_sampled_graph_points_per_tick = 10;
  }

  polar_to_point(radius, azimuth) {
    return this.coords_to_point(radius * Math.cos(azimuth), radius * Math.sin(azimuth));
  }

  point_to_polar(point) {
    const [x, y] = this.point_to_coords(point);
    return [Math.sqrt(x ** 2 + y ** 2), Math.atan2(y, x)];
  }

  c2p(...coords) {
    return this.coords_to_point(...coords);
  }

  p2c(point) {
    return this.point_to_coords(point);
  }

  pr2pt(radius, azimuth) {
    return this.polar_to_point(radius, azimuth);
  }

  pt2pr(point) {
    return this.point_to_polar(point);
  }

  get_axis(index) {
    return this.get_axes().get(index);
  }

  get_origin() {
    return this.coords_to_point(0, 0);
  }

  get_x_axis() {
    return this.get_axis(0);
  }

  get_y_axis() {
    return this.get_axis(1);
  }

  get_z_axis() {
    return this.get_axis(2);
  }

  get_x_unit_size() {
    return this.get_x_axis().get_unit_size();
  }

  get_y_unit_size() {
    return this.get_y_axis().get_unit_size();
  }

  add_coordinates(...axesNumbers) {
    this.coordinate_labels = VGroup.make();
    const values = axesNumbers.length ? axesNumbers : Array.from({ length: this.dimension }, () => null);
    this.axes.submobjects.forEach((axis, i) => {
      if (i >= values.length) return;
      const v = values[i];
      let labels;
      if (v !== null && !Array.isArray(v) && typeof v === "object") {
        axis.add_labels(v);
        labels = axis.labels;
      } else {
        axis.add_numbers(v);
        labels = axis.numbers;
      }
      this.coordinate_labels.add(labels);
    });
    return this;
  }

  get_vertical_line(point, kw = {}) {
    return this.get_line_from_axis_to_point(0, point, kw);
  }

  get_horizontal_line(point, kw = {}) {
    return this.get_line_from_axis_to_point(1, point, kw);
  }

  get_line_from_axis_to_point(index, point, { line_func = null, line_config = null, color = null, stroke_width = 2 } = {}) {
    const cfg = { ...(line_config ?? {}), color: color ?? VMobject.make().color, stroke_width };
    const axis = this.get_axis(index);
    const Fn = line_func ?? DashedLine;
    return Fn.make({ ...cfg, start: axis.get_projection(point), end: point });
  }

  plot(fn, { x_range = null, ...kw } = {}) {
    const tRange = this.x_range.map(Number);
    if (x_range !== null) x_range.forEach((v, i) => { tRange[i] = v; });
    if (x_range === null || x_range.length < 3) tRange[2] /= this.num_sampled_graph_points_per_tick;
    const graph = ParametricFunction.make({ ...kw, function: (t) => this.coords_to_point(t, fn(t)), t_range: tRange,
      scaling: this.x_axis.scaling });
    graph.underlying_function = fn;
    return graph;
  }

  plot_parametric_curve(fn, kw = {}) {
    const dim = this.dimension;
    const graph = ParametricFunction.make({ ...kw, function: (t) => this.coords_to_point(...fn(t).slice(0, dim)) });
    graph.underlying_function = fn;
    return graph;
  }

  plot_polar_graph(rFunc, theta_range = null, kw = {}) {
    return ParametricFunction.make({ ...kw, function: (th) => this.pr2pt(rFunc(th), th), t_range: theta_range ?? [0, 2 * PI] });
  }

  input_to_graph_point(x, graph) {
    return graph.underlying_function ? this.coords_to_point(x, graph.underlying_function(x)) : null;
  }

  i2gp(x, graph) {
    return this.input_to_graph_point(x, graph);
  }
};

export class Axes extends CoordinateSystemMixin(VGroup) {
  static SIG = ["x_range", "y_range", "x_length", "y_length", "axis_config", "x_axis_config", "y_axis_config", "tips"];

  __init__({ x_range = null, y_range = null, x_length = Math.round(14.222222222222221) - 2,
    y_length = Math.round(8.0) - 2, axis_config = null, x_axis_config = null, y_axis_config = null, tips = true,
    ...kw } = {}) {
    super.__init__(kw);
    this._cs_init(x_range, y_range, x_length, y_length);
    this.axis_config = { include_tip: tips, numbers_to_exclude: [0] };
    this.x_axis_config = {};
    this.y_axis_config = { rotation: 90 * DEGREES, label_direction: LEFT };
    Axes._update_default_configs([this.axis_config, this.x_axis_config, this.y_axis_config],
      [axis_config, x_axis_config, y_axis_config]);
    this.x_axis_config = mergeDictsRecursively(this.axis_config, this.x_axis_config);
    this.y_axis_config = mergeDictsRecursively(this.axis_config, this.y_axis_config);
    for (const cfg of [this.x_axis_config, this.y_axis_config]) {
      cfg.exclude_origin_tick = cfg.scaling === undefined || cfg.scaling === null || cfg.scaling instanceof LinearBase;
    }
    this.x_axis = this._create_axis(this.x_range, this.x_axis_config, this.x_length);
    this.y_axis = this._create_axis(this.y_range, this.y_axis_config, this.y_length);
    this.axes = VGroup.make({ vmobjects: [this.x_axis, this.y_axis] });
    this.add(...this.axes.submobjects);
    const center = this.axes.submobjects.map((axis) => axis.scaling.function((axis.x_range[1] + axis.x_range[0]) / 2));
    this.shift(mul(this.coords_to_point(...center), -1));
    return this;
  }

  static _update_default_configs(defaults, passed) {
    defaults.forEach((d, i) => {
      if (passed[i] !== null && passed[i] !== undefined) updateDictRecursively(d, passed[i]);
    });
  }

  _create_axis(rangeTerms, axisConfig, length) {
    axisConfig.length = length;
    const axis = NumberLine.make({ ...axisConfig, x_range: rangeTerms });
    axis.shift(mul(axis.number_to_point(Axes._origin_shift([axis.x_min, axis.x_max])), -1));
    return axis;
  }

  coords_to_point(...coords) {
    const flat = coords.length === 1 && Array.isArray(coords[0]) ? coords[0] : coords;
    const origin = this.x_axis.number_to_point(Axes._origin_shift([this.x_axis.x_min, this.x_axis.x_max]));
    let point = this.x_axis.number_to_point(flat[0]);
    const others = this.axes.submobjects.slice(1);
    others.forEach((axis, i) => {
      if (i + 1 < flat.length) point = add(point, sub(axis.number_to_point(flat[i + 1]), origin));
    });
    return point;
  }

  point_to_coords(point) {
    return this.get_axes().submobjects.map((axis) => axis.point_to_number(point));
  }

  get_axes() {
    return this.axes;
  }

  static _origin_shift(range) {
    if (range[0] > 0) return range[0];
    if (range[1] < 0) return range[1];
    return 0;
  }
}

export class ThreeDAxes extends Axes {
  static SIG = ["x_range", "y_range", "z_range", "x_length", "y_length", "z_length", "z_axis_config", "z_normal",
    "num_axis_pieces", "light_source", "depth", "gloss"];

  __init__({ x_range = [-6, 6, 1], y_range = [-5, 5, 1], z_range = [-4, 4, 1], x_length = 8.0 + 2.5,
    y_length = 8.0 + 2.5, z_length = 8.0 - 1.5, z_axis_config = null, z_normal = DOWN, num_axis_pieces = 20,
    light_source = [-7, -9, 10], depth = null, gloss = 0.5, ...kw } = {}) {
    void depth;
    void gloss;
    super.__init__({ ...kw, x_range, x_length, y_range, y_length });
    this.z_range = z_range;
    this.z_length = z_length;
    this.z_axis_config = {};
    Axes._update_default_configs([this.z_axis_config], [z_axis_config]);
    this.z_axis_config = mergeDictsRecursively(this.axis_config, this.z_axis_config);
    this.z_normal = z_normal;
    this.num_axis_pieces = num_axis_pieces;
    this.light_source = pt3(light_source);
    this.dimension = 3;
    const zs = this.z_axis_config.scaling;
    this.z_axis_config.exclude_origin_tick = zs === undefined || zs === null || zs instanceof LinearBase;
    const zAxis = this._create_axis(this.z_range, this.z_axis_config, this.z_length);
    const zOrigin = Axes._origin_shift([zAxis.x_min, zAxis.x_max]);
    zAxis.rotate_about_number(zOrigin, -PI / 2, UP);
    zAxis.rotate_about_number(zOrigin, angleOfVector(this.z_normal));
    zAxis.shift(mul(zAxis.number_to_point(zOrigin), -1));
    zAxis.shift(this.x_axis.number_to_point(Axes._origin_shift([this.x_axis.x_min, this.x_axis.x_max])));
    this.axes.add(zAxis);
    this.add(zAxis);
    this.z_axis = zAxis;
    this._add_3d_pieces();
    this._set_axis_shading();
    return this;
  }

  _add_3d_pieces() {
    for (const axis of this.axes.submobjects) {
      axis.pieces = VGroup.make({ vmobjects: axis.get_pieces(this.num_axis_pieces).submobjects });
      axis.add(axis.pieces);
      axis.set_stroke(null, 0, null, false, false);
      axis.set_shade_in_3d(true);
    }
  }

  _set_axis_shading() {
    const light = this.light_source;
    for (const axis of this.iter()) {
      for (const submob of axis.family_members_with_points()) {
        submob.get_gradient_start_and_end_points = () => [axis.get_edge_center(mul(light, -1)), axis.get_edge_center(light)];
        submob.get_unit_normal = () => [1, 1, 1];
        submob.set_sheen(0.2);
      }
    }
  }
}

export class NumberPlane extends Axes {
  static SIG = ["x_range", "y_range", "x_length", "y_length", "background_line_style", "faded_line_style",
    "faded_line_ratio", "make_smooth_after_applying_functions"];

  __init__({ x_range = [-config.frame_x_radius, config.frame_x_radius, 1],
    y_range = [-config.frame_y_radius, config.frame_y_radius, 1], x_length = null, y_length = null,
    background_line_style = null, faded_line_style = null, faded_line_ratio = 1,
    make_smooth_after_applying_functions = true, axis_config = null, y_axis_config = null, ...kw } = {}) {
    this.axis_config = { stroke_width: 2, include_ticks: false, include_tip: false, line_to_number_buff: SMALL_BUFF,
      label_direction: DR, font_size: 24 };
    this.y_axis_config = { label_direction: DR };
    this.background_line_style = { stroke_color: BLUE_D, stroke_width: 2, stroke_opacity: 1 };
    Axes._update_default_configs([this.axis_config, this.y_axis_config, this.background_line_style],
      [axis_config, y_axis_config, background_line_style]);
    this.faded_line_style = faded_line_style;
    this.faded_line_ratio = faded_line_ratio;
    this.make_smooth_after_applying_functions = make_smooth_after_applying_functions;
    super.__init__({ ...kw, x_range, y_range, x_length, y_length, axis_config: this.axis_config,
      y_axis_config: this.y_axis_config });
    this._init_background_lines();
    return this;
  }

  _init_background_lines() {
    if (this.faded_line_style === null) {
      const style = { ...this.background_line_style };
      for (const key of Object.keys(style)) if (typeof style[key] === "number") style[key] *= 0.5;
      this.faded_line_style = style;
    }
    [this.background_lines, this.faded_lines] = this._get_lines();
    this.background_lines.set_style(this.background_line_style);
    this.faded_lines.set_style(this.faded_line_style);
    this.add_to_back(this.faded_lines, this.background_lines);
  }

  _get_lines() {
    const xAxis = this.get_x_axis();
    const yAxis = this.get_y_axis();
    const [x1, x2] = this._get_lines_parallel_to_axis(xAxis, yAxis, this.y_axis.x_range[2], this.faded_line_ratio);
    const [y1, y2] = this._get_lines_parallel_to_axis(yAxis, xAxis, this.x_axis.x_range[2], this.faded_line_ratio);
    this.x_lines = x1;
    this.y_lines = y1;
    return [VGroup.make({ vmobjects: [...x1.submobjects, ...y1.submobjects] }),
      VGroup.make({ vmobjects: [...x2.submobjects, ...y2.submobjects] })];
  }

  _get_lines_parallel_to_axis(parallelTo, perpendicularTo, freq, ratio) {
    const line = Line.make({ start: parallelTo.get_start(), end: parallelTo.get_end() });
    const r = ratio === 0 ? 1 : ratio;
    const step = (1 / r) * freq;
    const lines1 = VGroup.make();
    const lines2 = VGroup.make();
    const unit = perpendicularTo.get_unit_vector();
    let [xMin, xMax] = perpendicularTo.x_range;
    if (perpendicularTo.x_min > 0 && xMin < 0) [xMin, xMax] = [0, Math.abs(xMin) + Math.abs(xMax)];
    const ranges = [[0], arange(step, Math.min(xMax - xMin, xMax), step), arange(-step, Math.max(xMin - xMax, xMin), -step)];
    for (const inputs of ranges) {
      inputs.forEach((x, k) => {
        const l = line.copy();
        l.shift(mul(unit, x));
        if ((k + 1) % r === 0) lines1.add(l);
        else lines2.add(l);
      });
    }
    return [lines1, lines2];
  }

  get_vector(coords, kw = {}) {
    return Arrow.make({ ...kw, buff: 0, start: this.coords_to_point(0, 0), end: this.coords_to_point(...coords) });
  }

  prepare_for_nonlinear_transform(num_inserted_curves = 50) {
    for (const mob of this.family_members_with_points()) {
      const n = mob.get_num_curves();
      if (num_inserted_curves > n) mob.insert_n_curves(num_inserted_curves - n);
    }
    return this;
  }
}

export class PolarPlane extends Axes {
  static SIG = ["radius_max", "size", "radius_step", "azimuth_step", "azimuth_units", "azimuth_compact_fraction",
    "azimuth_offset", "azimuth_direction", "azimuth_label_buff", "azimuth_label_font_size", "radius_config",
    "background_line_style", "faded_line_style", "faded_line_ratio", "make_smooth_after_applying_functions"];

  __init__({ radius_max = config.frame_y_radius, size = null, radius_step = 1, azimuth_step = null,
    azimuth_units = "PI radians", azimuth_compact_fraction = true, azimuth_offset = 0, azimuth_direction = "CCW",
    azimuth_label_buff = SMALL_BUFF, azimuth_label_font_size = 24, radius_config = null, background_line_style = null,
    faded_line_style = null, faded_line_ratio = 1, make_smooth_after_applying_functions = true, ...kw } = {}) {
    if (!["PI radians", "TAU radians", "degrees", "gradians", null].includes(azimuth_units)) {
      throw new Error("Invalid azimuth units. Expected one of: PI radians, TAU radians, degrees, gradians or None.");
    }
    this.azimuth_units = azimuth_units;
    if (!["CW", "CCW"].includes(azimuth_direction)) throw new Error("Invalid azimuth units. Expected one of: CW, CCW.");
    this.azimuth_direction = azimuth_direction;
    this.radius_config = { stroke_width: 2, include_ticks: false, include_tip: false, line_to_number_buff: SMALL_BUFF,
      label_direction: DL, font_size: 24 };
    this.background_line_style = { stroke_color: BLUE_D, stroke_width: 2, stroke_opacity: 1 };
    const steps = { "PI radians": 20, "TAU radians": 20, degrees: 36, gradians: 40 };
    this.azimuth_step = azimuth_step ?? (azimuth_units === null ? 1 : steps[azimuth_units]);
    Axes._update_default_configs([this.radius_config, this.background_line_style], [radius_config, background_line_style]);
    this.faded_line_style = faded_line_style;
    this.faded_line_ratio = faded_line_ratio;
    this.make_smooth_after_applying_functions = make_smooth_after_applying_functions;
    this.azimuth_offset = azimuth_offset;
    this.azimuth_label_buff = azimuth_label_buff;
    this.azimuth_label_font_size = azimuth_label_font_size;
    this.azimuth_compact_fraction = azimuth_compact_fraction;
    super.__init__({ ...kw, x_range: [-radius_max, radius_max, radius_step], y_range: [-radius_max, radius_max, radius_step],
      x_length: size, y_length: size, axis_config: this.radius_config });
    this._init_background_lines();
    return this;
  }

  _init_background_lines() {
    NumberPlane.prototype._init_background_lines.call(this);
  }

  _get_lines() {
    const center = this.get_origin();
    const r = this.faded_line_ratio === 0 ? 1 : this.faded_line_ratio;
    const offset = this.azimuth_offset;
    const rstep = (1 / r) * this.x_axis.x_range[2];
    const astep = (1 / r) * (TAU * (1 / this.azimuth_step));
    const [rlines1, rlines2, alines1, alines2] = [VGroup.make(), VGroup.make(), VGroup.make(), VGroup.make()];
    const rinput = arange(0, this.x_axis.x_range[1] + rstep, rstep);
    const ainput = arange(0, TAU, astep);
    const unit = this.x_axis.get_unit_vector()[0];
    rinput.forEach((x, k) => {
      const c = Circle.make({ radius: x * unit });
      if (k % r === 0) alines1.add(c);
      else alines2.add(c);
    });
    const line = Line.make({ start: center, end: this.get_x_axis().get_end() });
    ainput.forEach((x, k) => {
      const l = line.copy();
      l.rotate(x + offset, OUT, { about_point: center });
      if (k % r === 0) rlines1.add(l);
      else rlines2.add(l);
    });
    return [VGroup.make({ vmobjects: [...rlines1.submobjects, ...alines1.submobjects] }),
      VGroup.make({ vmobjects: [...rlines2.submobjects, ...alines2.submobjects] })];
  }

  get_vector(coords, kw = {}) {
    return Arrow.make({ ...kw, buff: 0, start: this.coords_to_point(0, 0), end: this.coords_to_point(...coords) });
  }

  prepare_for_nonlinear_transform(n = 50) {
    return NumberPlane.prototype.prepare_for_nonlinear_transform.call(this, n);
  }
}

export class ComplexPlane extends NumberPlane {
  static SIG = [];

  number_to_point(number) {
    const z = typeof number === "number" ? { re: number, im: 0 } : number;
    return this.coords_to_point(z.re, z.im);
  }

  n2p(number) {
    return this.number_to_point(number);
  }

  point_to_number(point) {
    const [x, y] = this.point_to_coords(point);
    return { re: x, im: y };
  }

  p2n(point) {
    return this.point_to_number(point);
  }
}

// ------------------------------------------------------------------------------------------------ probability.py

export class BarChart extends Axes {
  static SIG = ["values", "bar_names", "y_range", "x_length", "y_length", "bar_colors", "bar_width", "bar_fill_opacity",
    "bar_stroke_width"];

  __init__({ values, bar_names = null, y_range = null, x_length = null, y_length = null,
    bar_colors = ["#003f5c", "#58508d", "#bc5090", "#ff6361", "#ffa600"], bar_width = 0.6, bar_fill_opacity = 0.7,
    bar_stroke_width = 3, x_axis_config = null, tips = false, ...kw } = {}) {
    const yLength = y_length ?? config.frame_height - 4;
    this.values = [...values];
    this.bar_names = bar_names;
    this.bar_colors = typeof bar_colors === "string" ? [...bar_colors] : bar_colors;
    this.bar_width = bar_width;
    this.bar_fill_opacity = bar_fill_opacity;
    this.bar_stroke_width = bar_stroke_width;
    const round2 = (x) => Number(formatFixed(x, 2));
    const xRange = [0, this.values.length, 1];
    let yRange = y_range;
    if (yRange === null) {
      yRange = [Math.min(0, ...this.values), Math.max(0, ...this.values), round2(Math.max(...this.values) / yLength)];
    } else if (yRange.length === 2) yRange = [...yRange, round2(Math.max(...this.values) / yLength)];
    const xLength = x_length ?? Math.min(this.values.length, config.frame_width - 2);
    const xAxisConfig = { font_size: 24, label_constructor: Tex };
    Axes._update_default_configs([xAxisConfig], [x_axis_config]);
    this.bars = VGroup.make();
    this.x_labels = null;
    this.bar_labels = null;
    super.__init__({ ...kw, x_range: xRange, y_range: yRange, x_length: xLength, y_length: yLength,
      x_axis_config: xAxisConfig, tips });
    this._add_bars();
    if (this.bar_names !== null) this._add_x_axis_labels();
    this.y_axis.add_numbers();
    return this;
  }

  _update_colors() {
    this.bars.set_color_by_gradient(...this.bar_colors);
  }

  _add_x_axis_labels() {
    const valRange = arange(0.5, this.bar_names.length, 1);
    if (valRange.length !== this.bar_names.length) throw new Error("zip() arguments have different lengths");
    if (this.bar_names.length > this.values.length) throw new Error("list index out of range");
    const labels = VGroup.make();
    valRange.forEach((value, i) => {
      const direction = this.values[i] < 0 ? UP : DOWN;
      const label = this.x_axis.label_constructor.make({ tex_strings: [this.bar_names[i]], text: this.bar_names[i] });
      label.font_size = this.x_axis.font_size;
      label.next_to(this.x_axis.number_to_point(value), direction, this.x_axis.line_to_number_buff);
      labels.add(label);
    });
    this.x_axis.labels = labels;
    this.x_axis.add(labels);
  }

  _create_bar(barNumber, value) {
    const h = Math.abs(this.c2p(0, value)[1] - this.c2p(0, 0)[1]);
    const w = this.c2p(this.bar_width, 0)[0] - this.c2p(0, 0)[0];
    const bar = Rectangle.make({ height: h, width: w, stroke_width: this.bar_stroke_width, fill_opacity: this.bar_fill_opacity });
    bar.next_to(this.c2p(barNumber + 0.5, 0), value >= 0 ? UP : DOWN, 0);
    return bar;
  }

  _add_bars() {
    this.values.forEach((value, i) => this.bars.add(this._create_bar(i, value)));
    this._update_colors();
    this.add_to_back(this.bars);
  }

  get_bar_labels({ color = null, font_size = 24, buff = MED_SMALL_BUFF, label_constructor = Tex } = {}) {
    const labels = VGroup.make();
    this.bars.submobjects.forEach((bar, i) => {
      if (i >= this.values.length) return;
      const value = this.values[i];
      const label = label_constructor.make({ tex_strings: [String(value)], text: String(value) });
      label.set_color(color ?? bar.get_fill_color());
      label.font_size = font_size;
      label.next_to(bar, value >= 0 ? UP : DOWN, buff);
      labels.add(label);
    });
    return labels;
  }
}

export { BLUE, Group, colorGradient, RIGHT, ORIGIN };
