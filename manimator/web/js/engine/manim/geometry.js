// Ports of manim/mobject/geometry: tips.py, arc.py, line.py, polygram.py, shape_matchers.py and labeled.py.
//
// `static SIG` lists each class's Python positional parameters ("*name" collects the rest), so the scene plan's
// calls can be mapped onto the keyword objects the ports take.

import {
  add, angleBetweenVectors, angleOfVector, cartesianToSpherical, clip, cross, dot, lineIntersection, linspace, midpoint,
  mul, norm, normalize, pymod, regularVertices, rotateVector, sub,
} from "../core/math.js";
import { config } from "./config.js";
import {
  DEFAULT_ARROW_TIP_LENGTH, DEFAULT_DASH_LENGTH, DEFAULT_DOT_RADIUS, DEFAULT_FONT_SIZE, DEGREES, DL, DOWN, DR, LEFT,
  MED_SMALL_BUFF, ORIGIN, OUT, PI, RIGHT, SMALL_BUFF, TAU, UL, UP, UR,
} from "./frozen.js";
import { Group, Mobject, WHITE, lazy, pt3 } from "./mobject.js";
import { BLACK, DashedVMobject, VGroup, VMobject } from "./vmobject.js";

export const RED = "#FC6255";
export const BLUE = "#58C4DD";
export const PURE_YELLOW = "#FFFF00";

const gcd = (a, b) => (b === 0 ? Math.abs(a) : gcd(b, a % b));
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ------------------------------------------------------------------------------------------------ tips

/** tips.ArrowTip's properties, mixed into the shape each tip is made from (Python uses multiple inheritance). */
const ArrowTipMixin = (Base) => class extends Base {
  get is_arrow_tip() {
    return true;
  }

  get base() {
    return this.point_from_proportion(0.5);
  }

  get tip_point() {
    return this.points[0];
  }

  get vector() {
    return sub(this.tip_point, this.base);
  }

  get tip_angle() {
    return angleOfVector(this.vector);
  }

  get length() {
    return norm(this.vector);
  }
};

// ------------------------------------------------------------------------------------------------ arc.py

export class TipableVMobject extends VMobject {
  __init__({ tip_length = DEFAULT_ARROW_TIP_LENGTH, normal_vector = OUT, tip_style = null, ...kw } = {}) {
    this.tip_length = tip_length;
    this.normal_vector = normal_vector;
    this.tip_style = tip_style ?? {};
    return super.__init__(kw);
  }

  add_tip({ tip = null, tip_shape = null, tip_length = null, tip_width = null, at_start = false } = {}) {
    if (tip === null) tip = this.create_tip(tip_shape, tip_length, tip_width, at_start);
    else this.position_tip(tip, at_start);
    this.reset_endpoints_based_on_tip(tip, at_start);
    this.assign_tip_attr(tip, at_start);
    this.add(tip);
    return this;
  }

  create_tip(tip_shape = null, tip_length = null, tip_width = null, at_start = false) {
    const tip = this.get_unpositioned_tip(tip_shape, tip_length, tip_width);
    this.position_tip(tip, at_start);
    return tip;
  }

  get_unpositioned_tip(tip_shape = null, tip_length = null, tip_width = null) {
    const style = {};
    const shape = tip_shape ?? ArrowTriangleFilledTip;
    if (shape === ArrowTriangleFilledTip) style.width = tip_width ?? this.get_default_tip_length();
    const length = tip_length ?? this.get_default_tip_length();
    const color = this.get_color();
    Object.assign(style, { fill_color: color, stroke_color: color }, this.tip_style);
    return shape.make({ length, ...style });
  }

  position_tip(tip, at_start = false) {
    let anchor;
    let handle;
    if (at_start) {
      anchor = this.get_start();
      handle = this.get_first_handle();
    } else {
      handle = this.get_last_handle();
      anchor = this.get_end();
    }
    const angles = cartesianToSpherical(sub(handle, anchor));
    tip.rotate(angles[1] - PI - tip.tip_angle);
    if (this._init_positioning_axis === undefined) {
      const axis = [Math.sin(angles[1]), -Math.cos(angles[1]), 0];
      tip.rotate(-angles[2] + PI / 2, axis);
      this._init_positioning_axis = axis;
    }
    tip.shift(sub(anchor, tip.tip_point));
    return tip;
  }

  reset_endpoints_based_on_tip(tip, at_start) {
    if (this.get_length() === 0) return this;
    if (at_start) this.put_start_and_end_on(tip.base, this.get_end());
    else this.put_start_and_end_on(this.get_start(), tip.base);
    return this;
  }

  assign_tip_attr(tip, at_start) {
    if (at_start) this.start_tip = tip;
    else this.tip = tip;
    return this;
  }

  has_tip() {
    return this.tip !== undefined && this.iter().includes(this.tip);
  }

  has_start_tip() {
    return this.start_tip !== undefined && this.iter().includes(this.start_tip);
  }

  pop_tips() {
    const [start, end] = this.get_start_and_end();
    const result = this.get_group_class().make();
    if (this.has_tip()) {
      result.add(this.tip);
      this.remove(this.tip);
    }
    if (this.has_start_tip()) {
      result.add(this.start_tip);
      this.remove(this.start_tip);
    }
    if (result.submobjects.length) this.put_start_and_end_on(start, end);
    return result;
  }

  get_tips() {
    const result = this.get_group_class().make();
    if (this.tip !== undefined) result.add(this.tip);
    if (this.start_tip !== undefined) result.add(this.start_tip);
    return result;
  }

  get_tip() {
    const tips = this.get_tips();
    if (tips.__len__() === 0) throw new Error("tip not found");
    return tips.get(0);
  }

  get_default_tip_length() {
    return this.tip_length;
  }

  get_first_handle() {
    return this.points[1];
  }

  get_last_handle() {
    return this.points[this.points.length - 2];
  }

  get_end() {
    return this.has_tip() ? this.tip.get_start() : super.get_end();
  }

  get_start() {
    return this.has_start_tip() ? this.start_tip.get_start() : super.get_start();
  }

  get_length() {
    const [start, end] = this.get_start_and_end();
    return norm(sub(start, end));
  }
}

export class Arc extends TipableVMobject {
  static SIG = ["radius", "start_angle", "angle", "num_components", "arc_center"];

  __init__({ radius = 1.0, start_angle = 0, angle = TAU / 4, num_components = 9, arc_center = ORIGIN, ...kw } = {}) {
    this.radius = radius ?? 1.0;
    this.num_components = num_components;
    this.arc_center = pt3(arc_center);
    this.start_angle = start_angle;
    this.angle = angle;
    this._failed_to_get_center = false;
    return super.__init__(kw);
  }

  generate_points() {
    this._set_pre_positioned_points();
    this.scale(this.radius, { about_point: ORIGIN });
    this.shift(this.arc_center);
    return this;
  }

  init_points() {
    return this.generate_points();
  }

  _set_pre_positioned_points() {
    const anchors = linspace(this.start_angle, this.start_angle + this.angle, this.num_components)
      .map((a) => [Math.cos(a), Math.sin(a), 0]);
    const dTheta = this.angle / (this.num_components - 1.0);
    const tangents = anchors.map((p) => [-p[1], p[0], 0]);
    const factor = (4 / 3) * Math.tan(dTheta / 4);
    const a1 = anchors.slice(0, -1);
    const a2 = anchors.slice(1);
    const h1 = a1.map((a, i) => add(a, mul(tangents[i], factor)));
    const h2 = a2.map((a, i) => sub(a, mul(tangents[i + 1], factor)));
    this.set_anchors_and_handles(a1, h1, h2, a2);
  }

  get_arc_center(warning = true) {
    void warning;
    const [a1, h1, h2, a2] = this.points.slice(0, 4);
    if (samePoint(a1, a2)) return [...a1];
    const n1 = rotateVector(sub(h1, a1), TAU / 4);
    const n2 = rotateVector(sub(h2, a2), TAU / 4);
    try {
      return lineIntersection([a1, add(a1, n1)], [a2, add(a2, n2)]);
    } catch {
      this._failed_to_get_center = true;
      return [0, 0, 0];
    }
  }

  move_arc_center_to(point) {
    this.shift(sub(pt3(point), this.get_arc_center()));
    return this;
  }

  stop_angle() {
    return pymod(angleOfVector(sub(this.points[this.points.length - 1], this.get_arc_center())), TAU);
  }
}

export class ArcBetweenPoints extends Arc {
  static SIG = ["start", "end", "angle", "radius"];

  __init__({ start, end, angle = TAU / 4, radius = null, ...kw } = {}) {
    if (radius !== null && radius !== undefined) {
      this.radius = radius;
      let sign = 2;
      if (radius < 0) {
        sign = -2;
        radius *= -1;
      }
      const halfdist = norm(sub(pt3(start), pt3(end))) / 2;
      if (radius < halfdist) {
        throw new Error("ArcBetweenPoints called with a radius that is smaller than half the distance between the points.");
      }
      const arcHeight = radius - Math.sqrt(radius * radius - halfdist * halfdist);
      angle = Math.acos((radius - arcHeight) / radius) * sign;
    }
    super.__init__({ ...kw, radius, angle });
    if (angle === 0) this.set_points_as_corners([LEFT, RIGHT]);
    this.put_start_and_end_on(start, end);
    if (radius === null || radius === undefined) {
      const center = this.get_arc_center(false);
      this.radius = this._failed_to_get_center ? Infinity : norm(sub(pt3(start), center));
    }
    return this;
  }
}

export class CurvedArrow extends ArcBetweenPoints {
  static SIG = ["start_point", "end_point"];

  __init__({ start_point, end_point, tip_shape = ArrowTriangleFilledTip, ...kw } = {}) {
    super.__init__({ ...kw, start: start_point, end: end_point });
    this.add_tip({ tip_shape });
    return this;
  }
}

export class CurvedDoubleArrow extends CurvedArrow {
  static SIG = ["start_point", "end_point"];

  __init__({ tip_shape_start = ArrowTriangleFilledTip, tip_shape_end, ...kw } = {}) {
    if (tip_shape_end !== undefined) kw.tip_shape = tip_shape_end;
    super.__init__(kw);
    this.add_tip({ at_start: true, tip_shape: tip_shape_start });
    return this;
  }
}

export class Circle extends Arc {
  static SIG = ["radius", "color"];

  __init__({ radius = null, color = RED, ...kw } = {}) {
    return super.__init__({ ...kw, radius, start_angle: 0, angle: TAU, color });
  }

  surround(mobject, dim_to_match = 0, stretch = false, buffer_factor = 1.2) {
    this.replace(mobject, dim_to_match, stretch);
    this.width = Math.sqrt(mobject.width ** 2 + mobject.height ** 2);
    return this.scale(buffer_factor);
  }

  point_at_angle(angle) {
    let proportion = angle / TAU;
    proportion -= Math.floor(proportion);
    return this.point_from_proportion(proportion);
  }

  static from_three_points(p1, p2, p3, kw = {}) {
    const bisector = (a, b) => {
      const direction = cross(sub(a, b), OUT);
      const m = midpoint(a, b);
      return [add(m, direction), sub(m, direction)];
    };
    const [a, b, c] = [p1, p2, p3].map(pt3);
    const center = lineIntersection(bisector(a, b), bisector(b, c));
    return Circle.make({ ...kw, radius: norm(sub(a, center)) }).shift(center);
  }
}

export class Dot extends Circle {
  static SIG = ["point", "radius", "stroke_width", "fill_opacity", "color"];

  __init__({ point = ORIGIN, radius = DEFAULT_DOT_RADIUS, stroke_width = 0, fill_opacity = 1.0, color = WHITE, ...kw } = {}) {
    return super.__init__({ ...kw, arc_center: point, radius, stroke_width, fill_opacity, color });
  }
}

export class AnnotationDot extends Dot {
  static SIG = ["radius", "stroke_width", "stroke_color", "fill_color"];

  __init__({ radius = DEFAULT_DOT_RADIUS * 1.3, stroke_width = 5, stroke_color = WHITE, fill_color = BLUE, ...kw } = {}) {
    return super.__init__({ ...kw, radius, stroke_width, stroke_color, fill_color });
  }
}

export class LabeledDot extends Dot {
  static SIG = ["label", "radius", "buff"];

  __init__({ label, radius = null, buff = SMALL_BUFF, ...kw } = {}) {
    const rendered = typeof label === "string" ? lazy.MathTex.make({ tex_strings: [label], color: BLACK }) : label;
    if (radius === null) {
      const w = rendered.width;
      const h = rendered.height;
      radius = buff + Math.sqrt(w * w + h * h) / 2;
    }
    super.__init__({ ...kw, radius });
    rendered.move_to(this.get_center());
    this.add(rendered);
    return this;
  }
}

export class Ellipse extends Circle {
  static SIG = ["width", "height"];

  __init__({ width = 2, height = 1, ...kw } = {}) {
    super.__init__(kw);
    this.stretch_to_fit_width(width);
    this.stretch_to_fit_height(height);
    return this;
  }
}

export class AnnularSector extends Arc {
  static SIG = ["inner_radius", "outer_radius", "angle", "start_angle", "fill_opacity", "stroke_width", "color"];

  __init__({ inner_radius = 1, outer_radius = 2, angle = TAU / 4, start_angle = 0, fill_opacity = 1, stroke_width = 0,
    color = WHITE, ...kw } = {}) {
    this.inner_radius = inner_radius;
    this.outer_radius = outer_radius;
    return super.__init__({ ...kw, start_angle, angle, fill_opacity, stroke_width, color });
  }

  generate_points() {
    const [innerArc, outerArc] = [this.inner_radius, this.outer_radius].map((radius) => Arc.make({
      start_angle: this.start_angle, angle: this.angle, radius, arc_center: this.arc_center,
    }));
    outerArc.reverse_points();
    this.append_points(innerArc.points);
    this.add_line_to(outerArc.points[0]);
    this.append_points(outerArc.points);
    this.add_line_to(innerArc.points[0]);
    return this;
  }
}

export class Sector extends AnnularSector {
  static SIG = ["radius"];

  __init__({ radius = 1, ...kw } = {}) {
    return super.__init__({ ...kw, inner_radius: 0, outer_radius: radius });
  }
}

export class Annulus extends Circle {
  static SIG = ["inner_radius", "outer_radius", "fill_opacity", "stroke_width", "color", "mark_paths_closed"];

  __init__({ inner_radius = 1, outer_radius = 2, fill_opacity = 1, stroke_width = 0, color = WHITE,
    mark_paths_closed = false, ...kw } = {}) {
    this.mark_paths_closed = mark_paths_closed;
    this.inner_radius = inner_radius;
    this.outer_radius = outer_radius;
    return super.__init__({ ...kw, fill_opacity, stroke_width, color });
  }

  generate_points() {
    this.radius = this.outer_radius;
    const outer = Circle.make({ radius: this.outer_radius });
    const inner = Circle.make({ radius: this.inner_radius });
    inner.reverse_points();
    this.append_points(outer.points);
    this.append_points(inner.points);
    this.shift(this.arc_center);
    return this;
  }
}

export class CubicBezier extends VMobject {
  static SIG = ["start_anchor", "start_handle", "end_handle", "end_anchor"];

  __init__({ start_anchor, start_handle, end_handle, end_anchor, ...kw } = {}) {
    super.__init__(kw);
    this.add_cubic_bezier_curve(start_anchor, start_handle, end_handle, end_anchor);
    return this;
  }
}

export class ArcPolygon extends VMobject {
  static SIG = ["*vertices"];

  __init__({ vertices = [], angle = PI / 4, radius = null, arc_config = null, ...kw } = {}) {
    const n = vertices.length;
    const pairs = vertices.map((v, k) => [v, vertices[(k + 1) % n]]);
    const empty = !arc_config || (typeof arc_config === "object" && Object.keys(arc_config).length === 0);
    let configs;
    if (empty) configs = pairs.map(() => (radius ? { radius } : { angle }));
    else if (!Array.isArray(arc_config)) configs = pairs.map(() => arc_config);
    else {
      if (arc_config.length !== n) throw new Error("ArcPolygon: one arc_config per side");
      configs = arc_config;
    }
    const arcs = pairs.map(([start, end], i) => ArcBetweenPoints.make({ ...configs[i], start, end }));
    super.__init__(kw);
    this.add(...arcs);
    for (const arc of arcs) this.append_points(arc.points);
    this.arcs = arcs;
    return this;
  }
}

// ------------------------------------------------------------------------------------------------ line.py

export class Line extends TipableVMobject {
  static SIG = ["start", "end", "buff", "path_arc"];

  __init__({ start = LEFT, end = RIGHT, buff = 0, path_arc = 0, ...kw } = {}) {
    this.dim = 3;
    this.buff = buff;
    this.path_arc = path_arc;
    this._set_start_and_end_attrs(start, end);
    return super.__init__(kw);
  }

  generate_points() {
    return this.set_points_by_ends(this.start, this.end, this.buff, this.path_arc);
  }

  set_points_by_ends(start, end, buff = 0, path_arc = 0) {
    this._set_start_and_end_attrs(start, end);
    if (path_arc) {
      const arc = ArcBetweenPoints.make({ start: this.start, end: this.end, angle: this.path_arc });
      this.set_points(arc.points);
    } else {
      this.set_points_as_corners([this.start, this.end]);
    }
    this._account_for_buff(buff);
    return this;
  }

  init_points() {
    return this.generate_points();
  }

  _account_for_buff(buff) {
    if (buff <= 0) return;
    const length = this.path_arc === 0 ? this.get_length() : this.get_arc_length();
    if (length < 2 * buff) return;
    const proportion = buff / length;
    this.pointwise_become_partial(this, proportion, 1 - proportion);
  }

  _set_start_and_end_attrs(start, end) {
    const vect = normalize(sub(this._pointify(end), this._pointify(start)));
    this.start = this._pointify(start, vect);
    this.end = this._pointify(end, [-vect[0], -vect[1], -vect[2]]);
  }

  _pointify(mobOrPoint, direction = null) {
    if (mobOrPoint instanceof Mobject) {
      return direction === null ? mobOrPoint.get_center() : mobOrPoint.get_boundary_point(direction);
    }
    return pt3(mobOrPoint);
  }

  set_path_arc(value) {
    this.path_arc = value;
    this.init_points();
    return this;
  }

  put_start_and_end_on(start, end) {
    const [currStart, currEnd] = this.get_start_and_end();
    if (samePoint(currStart, currEnd)) {
      this.start = pt3(start);
      this.end = pt3(end);
      this.generate_points();
    }
    return super.put_start_and_end_on(start, end);
  }

  get_vector() {
    return sub(this.get_end(), this.get_start());
  }

  get_unit_vector() {
    return normalize(this.get_vector());
  }

  get_angle() {
    return angleOfVector(this.get_vector());
  }

  get_projection(point) {
    const start = this.get_start();
    const unit = normalize(sub(this.get_end(), start));
    return add(start, mul(unit, dot(sub(pt3(point), start), unit)));
  }

  get_slope() {
    return Math.tan(this.get_angle());
  }

  set_angle(angle, about_point = null) {
    this.rotate(angle - this.get_angle(), OUT, { about_point: about_point ?? this.get_start() });
    return this;
  }

  set_length(length) {
    return this.scale(length / this.get_length());
  }
}

export class DashedLine extends Line {
  static SIG = ["start", "end"];

  __init__({ dash_length = DEFAULT_DASH_LENGTH, dashed_ratio = 0.5, ...kw } = {}) {
    this.dash_length = dash_length;
    this.dashed_ratio = dashed_ratio;
    super.__init__(kw);
    const dashes = DashedVMobject.make({ vmobject: this, num_dashes: this._calculate_num_dashes(), dashed_ratio });
    this.clear_points();
    this.add(...dashes.iter());
    return this;
  }

  _calculate_num_dashes() {
    return Math.max(2, Math.trunc(Math.ceil((this.get_length() / this.dash_length) * this.dashed_ratio)));
  }

  get_start() {
    return this.submobjects.length > 0 ? this.submobjects[0].get_start() : super.get_start();
  }

  get_end() {
    return this.submobjects.length > 0 ? this.submobjects[this.submobjects.length - 1].get_end() : super.get_end();
  }

  get_first_handle() {
    return this.submobjects[0].points[1];
  }

  get_last_handle() {
    return this.submobjects[this.submobjects.length - 1].points[2];
  }
}

export class TangentLine extends Line {
  static SIG = ["vmob", "alpha", "length", "d_alpha"];

  __init__({ vmob, alpha, length = 1, d_alpha = 1e-6, ...kw } = {}) {
    this.length = length;
    this.d_alpha = d_alpha;
    const a1 = clip(alpha - d_alpha, 0, 1);
    const a2 = clip(alpha + d_alpha, 0, 1);
    super.__init__({ ...kw, start: vmob.point_from_proportion(a1), end: vmob.point_from_proportion(a2) });
    this.scale(this.length / this.get_length());
    return this;
  }
}

export class Elbow extends VMobject {
  static SIG = ["width", "angle"];

  __init__({ width = 0.2, angle = 0, ...kw } = {}) {
    this.angle = angle;
    super.__init__(kw);
    this.set_points_as_corners([UP, add(UP, RIGHT), RIGHT]);
    this.scale_to_fit_width(width, { about_point: ORIGIN });
    this.rotate(this.angle, OUT, { about_point: ORIGIN });
    return this;
  }
}

export class Arrow extends Line {
  static SIG = ["start", "end"];

  __init__({ stroke_width = 6, buff = MED_SMALL_BUFF, max_tip_length_to_length_ratio = 0.25,
    max_stroke_width_to_length_ratio = 5, tip_shape = ArrowTriangleFilledTip, ...kw } = {}) {
    this.max_tip_length_to_length_ratio = max_tip_length_to_length_ratio;
    this.max_stroke_width_to_length_ratio = max_stroke_width_to_length_ratio;
    super.__init__({ ...kw, buff, stroke_width });
    this.initial_stroke_width = this.stroke_width;
    this.add_tip({ tip_shape });
    this._set_stroke_width_from_length();
    return this;
  }

  scale(factor, { scale_tips = false, ...kw } = {}) {
    if (this.get_length() === 0) return this;
    if (scale_tips) {
      super.scale(factor, kw);
      this._set_stroke_width_from_length();
      return this;
    }
    const hasTip = this.has_tip();
    const hasStartTip = this.has_start_tip();
    let oldTips = null;
    if (hasTip || hasStartTip) oldTips = this.pop_tips();
    super.scale(factor, kw);
    this._set_stroke_width_from_length();
    if (hasTip) this.add_tip({ tip: oldTips.get(0) });
    if (hasStartTip) this.add_tip({ tip: oldTips.get(1), at_start: true });
    return this;
  }

  get_normal_vector() {
    const [p0, p1, p2] = this.tip.get_start_anchors().slice(0, 3);
    return normalize(cross(sub(p2, p1), sub(p1, p0)));
  }

  reset_normal_vector() {
    this.normal_vector = this.get_normal_vector();
    return this;
  }

  get_default_tip_length() {
    return Math.min(this.tip_length, this.max_tip_length_to_length_ratio * this.get_length());
  }

  _set_stroke_width_from_length() {
    const width = Math.min(this.initial_stroke_width, this.max_stroke_width_to_length_ratio * this.get_length());
    this.set_stroke(null, width, null, false, false);
    return this;
  }
}

export class Vector extends Arrow {
  static SIG = ["direction", "buff"];

  __init__({ direction = RIGHT, buff = 0, ...kw } = {}) {
    this.buff = buff;
    return super.__init__({ ...kw, start: ORIGIN, end: pt3(direction), buff });
  }
}

export class DoubleArrow extends Arrow {
  static SIG = ["start", "end"];

  __init__({ tip_shape_start = ArrowTriangleFilledTip, tip_shape_end, ...kw } = {}) {
    if (tip_shape_end !== undefined) kw.tip_shape = tip_shape_end;
    super.__init__(kw);
    this.add_tip({ at_start: true, tip_shape: tip_shape_start });
    return this;
  }
}

export class Angle extends VMobject {
  static SIG = ["line1", "line2", "radius", "quadrant", "other_angle", "dot", "dot_radius", "dot_distance", "dot_color",
    "elbow"];

  __init__({ line1, line2, radius = null, quadrant = [1, 1], other_angle = false, dot = false, dot_radius = null,
    dot_distance = 0.55, dot_color = WHITE, elbow = false, ...kw } = {}) {
    super.__init__(kw);
    this.lines = [line1, line2];
    this.quadrant = quadrant;
    this.dot_distance = dot_distance;
    this.elbow = elbow;
    let inter;
    try {
      inter = lineIntersection([line1.get_start(), line1.get_end()], [line2.get_start(), line2.get_end()]);
    } catch (err) {
      const inPlane = [line1, line2].every((l) => l.get_start()[2] === 0 && l.get_end()[2] === 0);
      const parallel = cross(line1.get_vector(), line2.get_vector())[2] === 0;
      if (!(inPlane && parallel)) throw err;
      this.angle_value = 0.0;
      return this;
    }
    if (radius === null) {
      const d1 = norm(sub(quadrant[0] === 1 ? line1.get_end() : line1.get_start(), inter));
      const d2 = norm(sub(quadrant[1] === 1 ? line2.get_end() : line2.get_start(), inter));
      const m = Math.min(d1, d2);
      radius = m < 0.6 ? (2 / 3) * m : 0.4;
    } else {
      this.radius = radius;
    }
    const u1 = line1.get_unit_vector();
    const u2 = line2.get_unit_vector();
    const anchor1 = add(inter, mul(u1, quadrant[0] * radius));
    const anchor2 = add(inter, mul(u2, quadrant[1] * radius));
    let angleMobject;
    if (elbow) {
      const middle = add(add(inter, mul(u1, quadrant[0] * radius)), mul(u2, quadrant[1] * radius));
      angleMobject = Elbow.make(kw);
      angleMobject.set_points_as_corners([anchor1, middle, anchor2]);
    } else {
      const angle1 = angleOfVector(sub(anchor1, inter));
      const angle2 = angleOfVector(sub(anchor2, inter));
      let angleFin;
      if (!other_angle) angleFin = angle2 > angle1 ? angle2 - angle1 : 2 * Math.PI - (angle1 - angle2);
      else angleFin = angle2 < angle1 ? -angle1 + angle2 : -2 * Math.PI + (angle2 - angle1);
      this.angle_value = angleFin;
      angleMobject = Arc.make({ ...kw, radius, angle: this.angle_value, start_angle: angle1, arc_center: inter });
      if (dot) {
        if (dot_radius === null) dot_radius = radius / 10;
        else this.dot_radius = dot_radius;
        const rightDot = Dot.make({ point: ORIGIN, radius: dot_radius, color: dot_color });
        const toCenter = sub(angleMobject.get_center(), inter);
        const n = norm(toCenter);
        rightDot.move_to(toCenter.map((v, i) => inter[i] + ((v / n) * radius) * dot_distance));
        this.add(rightDot);
      }
    }
    this.set_points(angleMobject.points);
    return this;
  }

  get_lines() {
    return VGroup.of(...this.lines);
  }

  get_value(degrees = false) {
    return degrees ? this.angle_value / DEGREES : this.angle_value;
  }

  static from_three_points(A, B, C, kw = {}) {
    return Angle.make({ ...kw, line1: Line.make({ start: B, end: A }), line2: Line.make({ start: B, end: C }) });
  }
}

export class RightAngle extends Angle {
  static SIG = ["line1", "line2", "length"];

  __init__({ length = null, ...kw } = {}) {
    return super.__init__({ ...kw, radius: length, elbow: true });
  }
}

// ------------------------------------------------------------------------------------------------ polygram.py

export class Polygram extends VMobject {
  static SIG = ["*vertex_groups"];

  __init__({ vertex_groups = [], color = BLUE, ...kw } = {}) {
    super.__init__({ ...kw, color });
    for (const group of vertex_groups) {
      const [first, ...rest] = group.map(pt3);
      this.start_new_path(first);
      this.add_points_as_corners([...rest, first]);
    }
    return this;
  }

  get_vertices() {
    return this.get_start_anchors();
  }

  get_vertex_groups() {
    const groups = [];
    let group = [];
    const ends = this.get_end_anchors();
    this.get_start_anchors().forEach((start, i) => {
      group.push(start);
      if (this.consider_points_equals(ends[i], group[0])) {
        groups.push(group);
        group = [];
      }
    });
    return groups;
  }

  round_corners(radius = 0.5, evenly_distribute_anchors = false, components_per_rounded_corner = 2) {
    if (radius === 0) return this;
    const newPoints = [];
    for (const group of this.get_vertex_groups()) {
      const n = group.length;
      let radii;
      if (typeof radius === "number") radii = group.map(() => radius);
      else radii = Array.from({ length: Math.ceil(n / radius.length) }, () => radius).flat();
      if (radii.length !== n) throw new Error("round_corners: the radius list doesn't fit the corners");
      let arcs = group.map((_, i) => {
        const [v1, v2, v3] = [group[i], group[(i + 1) % n], group[(i + 2) % n]];
        const r = radii[i];
        const vect1 = sub(v2, v1);
        const vect2 = sub(v3, v2);
        const unit1 = normalize(vect1);
        const unit2 = normalize(vect2);
        let angle = angleBetweenVectors(vect1, vect2);
        angle *= Math.sign(r);
        const maxCut = Math.min(norm(vect1), norm(vect2)) / 2;
        const cut = clip(r * Math.tan(angle / 2), -maxCut, maxCut);
        const sign = Math.sign(cross(vect1, vect2)[2]);
        return ArcBetweenPoints.make({ start: sub(v2, mul(unit1, cut)), end: add(v2, mul(unit2, cut)),
          angle: sign * angle, num_components: components_per_rounded_corner });
      });
      let average = 1.0;
      if (evenly_distribute_anchors) {
        const nonzero = arcs.filter((arc) => arc.points.length > 4);
        if (nonzero.length > 0) {
          const total = nonzero.reduce((s, arc) => s + arc.get_arc_length(), 0);
          const curves = nonzero.reduce((s, arc) => s + arc.points.length, 0) / 4;
          average = total / curves;
        }
      }
      arcs = [arcs[arcs.length - 1], ...arcs.slice(0, -1)];
      arcs.forEach((arc1, i) => {
        const arc2 = arcs[(i + 1) % arcs.length];
        newPoints.push(...arc1.points);
        const line = Line.make({ start: arc1.get_end(), end: arc2.get_start() });
        if (evenly_distribute_anchors) line.insert_n_curves(Math.ceil(line.get_length() / average));
        newPoints.push(...line.points);
      });
    }
    this.set_points(newPoints);
    return this;
  }
}

export class Polygon extends Polygram {
  static SIG = ["*vertices"];

  __init__({ vertices = [], ...kw } = {}) {
    return super.__init__({ ...kw, vertex_groups: [vertices] });
  }
}

export class RegularPolygram extends Polygram {
  static SIG = ["num_vertices"];

  __init__({ num_vertices, density = 2, radius = 1, start_angle = null, ...kw } = {}) {
    const numGons = gcd(num_vertices, density);
    const nv = Math.floor(num_vertices / numGons);
    const d = Math.floor(density / numGons);
    const gen = (startAngle) => {
      const [reg, angle] = regularVertices(nv, { radius, startAngle });
      const vertices = [];
      let i = 0;
      for (;;) {
        vertices.push(reg[i]);
        i += d;
        i %= nv;
        if (i === 0) break;
      }
      return [vertices, angle];
    };
    const [first, angle] = gen(start_angle);
    this.start_angle = angle;
    const groups = [first];
    for (let i = 1; i < numGons; i += 1) groups.push(gen(this.start_angle + ((i / numGons) * TAU) / nv)[0]);
    return super.__init__({ ...kw, vertex_groups: groups });
  }
}

export class RegularPolygon extends RegularPolygram {
  static SIG = ["n"];

  __init__({ n = 6, ...kw } = {}) {
    return super.__init__({ ...kw, num_vertices: n, density: 1 });
  }
}

export class Star extends Polygon {
  static SIG = ["n"];

  __init__({ n = 5, outer_radius = 1, inner_radius = null, density = 2, start_angle = TAU / 4, ...kw } = {}) {
    const innerAngle = TAU / (2 * n);
    if (inner_radius === null) {
      if (density <= 0 || density >= n / 2) throw new Error(`Incompatible density ${density} for number of points ${n}`);
      const outerAngle = (TAU * density) / n;
      const inverseX = 1 - Math.tan(innerAngle) * ((Math.cos(outerAngle) - 1) / Math.sin(outerAngle));
      inner_radius = outer_radius / (Math.cos(innerAngle) * inverseX);
    }
    const [outer, angle] = regularVertices(n, { radius: outer_radius, startAngle: start_angle });
    this.start_angle = angle;
    const [inner] = regularVertices(n, { radius: inner_radius, startAngle: this.start_angle + innerAngle });
    const vertices = [];
    outer.forEach((v, i) => vertices.push(v, inner[i]));
    return super.__init__({ ...kw, vertices });
  }
}

export class Triangle extends RegularPolygon {
  static SIG = [];

  __init__(kw = {}) {
    return super.__init__({ ...kw, n: 3 });
  }
}

export class Rectangle extends Polygon {
  static SIG = ["color", "height", "width", "grid_xstep", "grid_ystep", "mark_paths_closed", "close_new_points"];

  __init__({ color = WHITE, height = 2.0, width = 4.0, grid_xstep = null, grid_ystep = null, mark_paths_closed = true,
    close_new_points = true, ...kw } = {}) {
    void mark_paths_closed;
    void close_new_points;
    super.__init__({ ...kw, vertices: [UR, UL, DL, DR], color });
    this.stretch_to_fit_width(width);
    this.stretch_to_fit_height(height);
    const v = this.get_vertices();
    this.grid_lines = VGroup.make();
    const range = (count) => Array.from({ length: Math.max(0, count - 1) }, (_, k) => k + 1);
    if (grid_xstep) {
      const step = Math.abs(grid_xstep);
      this.grid_lines.add(VGroup.of(...range(Math.trunc(width / step)).map((i) => {
        const top = add(v[1], mul(RIGHT, i * step));
        return Line.make({ start: top, end: add(top, mul(DOWN, height)), color });
      })));
    }
    if (grid_ystep) {
      const step = Math.abs(grid_ystep);
      this.grid_lines.add(VGroup.of(...range(Math.trunc(height / step)).map((i) => {
        const left = add(v[1], mul(DOWN, i * step));
        return Line.make({ start: left, end: add(left, mul(RIGHT, width)), color });
      })));
    }
    if (this.grid_lines.__len__() > 0) this.add(this.grid_lines);
    return this;
  }
}

export class Square extends Rectangle {
  static SIG = ["side_length"];

  __init__({ side_length = 2.0, ...kw } = {}) {
    return super.__init__({ ...kw, height: side_length, width: side_length });
  }

  get side_length() {
    const v = this.get_vertices();
    return norm(sub(v[0], v[1]));
  }

  set side_length(value) {
    this.scale(value / this.side_length);
  }
}

export class RoundedRectangle extends Rectangle {
  static SIG = ["corner_radius"];

  __init__({ corner_radius = 0.5, ...kw } = {}) {
    super.__init__(kw);
    this.corner_radius = corner_radius;
    this.round_corners(this.corner_radius);
    return this;
  }
}

export class Cutout extends VMobject {
  static SIG = ["main_shape", "*mobjects"];

  __init__({ main_shape, mobjects = [], ...kw } = {}) {
    super.__init__(kw);
    this.append_points(main_shape.points);
    const subDirection = main_shape.get_direction() === "CW" ? "CCW" : "CW";
    for (const mob of mobjects) this.append_points(mob.force_direction(subDirection).points);
    return this;
  }
}

// ------------------------------------------------------------------------------------------------ tips.py

export class StealthTip extends ArrowTipMixin(VMobject) {
  static SIG = [];

  __init__({ fill_opacity = 1, stroke_width = 3, length = DEFAULT_ARROW_TIP_LENGTH / 2, start_angle = PI, ...kw } = {}) {
    this.start_angle = start_angle;
    super.__init__({ ...kw, fill_opacity, stroke_width });
    this.set_points_as_corners([[2, 0, 0], [-1.2, 1.6, 0], [0, 0, 0], [-1.2, -1.6, 0], [2, 0, 0]]);
    this.scale(length / this.length);
    return this;
  }

  get length() {
    return norm(this.vector) * 1.6;
  }
}

export class ArrowTriangleTip extends ArrowTipMixin(Triangle) {
  static SIG = [];

  __init__({ fill_opacity = 0, stroke_width = 3, length = DEFAULT_ARROW_TIP_LENGTH, width = DEFAULT_ARROW_TIP_LENGTH,
    start_angle = PI, ...kw } = {}) {
    super.__init__({ ...kw, fill_opacity, stroke_width, start_angle });
    this.width = width;
    this.stretch_to_fit_width(length);
    this.stretch_to_fit_height(width);
    return this;
  }
}

export class ArrowTriangleFilledTip extends ArrowTriangleTip {
  __init__({ fill_opacity = 1, stroke_width = 0, ...kw } = {}) {
    return super.__init__({ ...kw, fill_opacity, stroke_width });
  }
}

export class ArrowCircleTip extends ArrowTipMixin(Circle) {
  static SIG = [];

  __init__({ fill_opacity = 0, stroke_width = 3, length = DEFAULT_ARROW_TIP_LENGTH, start_angle = PI, ...kw } = {}) {
    this.start_angle = start_angle;
    super.__init__({ ...kw, fill_opacity, stroke_width });
    this.width = length;
    this.stretch_to_fit_height(length);
    return this;
  }
}

export class ArrowCircleFilledTip extends ArrowCircleTip {
  __init__({ fill_opacity = 1, stroke_width = 0, ...kw } = {}) {
    return super.__init__({ ...kw, fill_opacity, stroke_width });
  }
}

export class ArrowSquareTip extends ArrowTipMixin(Square) {
  static SIG = [];

  __init__({ fill_opacity = 0, stroke_width = 3, length = DEFAULT_ARROW_TIP_LENGTH, start_angle = PI, ...kw } = {}) {
    this.start_angle = start_angle;
    super.__init__({ ...kw, fill_opacity, stroke_width, side_length: length });
    this.width = length;
    this.stretch_to_fit_height(length);
    return this;
  }
}

export class ArrowSquareFilledTip extends ArrowSquareTip {
  __init__({ fill_opacity = 1, stroke_width = 0, ...kw } = {}) {
    return super.__init__({ ...kw, fill_opacity, stroke_width });
  }
}

// ------------------------------------------------------------------------------------------------ shape_matchers.py

export class SurroundingRectangle extends RoundedRectangle {
  static SIG = ["*mobjects"];

  __init__({ mobjects = [], color = PURE_YELLOW, buff = SMALL_BUFF, corner_radius = 0.0, ...kw } = {}) {
    for (const m of mobjects) {
      if (!(m instanceof Mobject)) throw new TypeError("Expected all inputs for parameter mobjects to be a Mobjects");
    }
    const [bx, by] = Array.isArray(buff) ? buff : [buff, buff];
    const group = Group.make({ mobjects });
    super.__init__({ ...kw, color, width: group.width + 2 * bx, height: group.height + 2 * by, corner_radius });
    this.buff = buff;
    this.move_to(group);
    return this;
  }
}

export class BackgroundRectangle extends SurroundingRectangle {
  static SIG = ["*mobjects"];

  __init__({ color = null, stroke_width = 0, stroke_opacity = 0, fill_opacity = 0.75, buff = 0, ...kw } = {}) {
    super.__init__({ ...kw, color: color ?? config.background_color, stroke_width, stroke_opacity, fill_opacity, buff });
    this.original_fill_opacity = this.fill_opacity;
    return this;
  }

  pointwise_become_partial(mobject, a, b) {
    this.set_fill(null, b * this.original_fill_opacity);
    return this;
  }

  set_style({ fill_opacity } = {}) {
    return super.set_style({ stroke_color: BLACK, stroke_width: 0, fill_color: BLACK, fill_opacity });
  }
}

export class Cross extends VGroup {
  static SIG = ["mobject", "stroke_color", "stroke_width", "scale_factor"];

  __init__({ mobject = null, stroke_color = RED, stroke_width = 6.0, scale_factor = 1.0, ...kw } = {}) {
    super.__init__({ ...kw, vmobjects: [Line.make({ start: add(UP, LEFT), end: add(DOWN, RIGHT) }),
      Line.make({ start: add(UP, RIGHT), end: add(DOWN, LEFT) })] });
    if (mobject !== null) this.replace(mobject, 0, true);
    this.scale(scale_factor);
    this.set_stroke(stroke_color, stroke_width);
    return this;
  }
}

export class Underline extends Line {
  static SIG = ["mobject", "buff"];

  __init__({ mobject, buff = SMALL_BUFF, ...kw } = {}) {
    super.__init__({ ...kw, start: LEFT, end: RIGHT, buff });
    this.match_width(mobject);
    this.next_to(mobject, DOWN, this.buff);
    return this;
  }
}

// ------------------------------------------------------------------------------------------------ labeled.py

export class Label extends VGroup {
  static SIG = ["label", "label_config", "box_config", "frame_config"];

  __init__({ label, label_config = null, box_config = null, frame_config = null, ...kw } = {}) {
    super.__init__(kw);
    const labelConfig = { color: WHITE, font_size: DEFAULT_FONT_SIZE, ...(label_config ?? {}) };
    const boxConfig = { color: null, buff: 0.05, fill_opacity: 1, stroke_width: 0.5, ...(box_config ?? {}) };
    const frameConfig = { color: WHITE, buff: 0.05, stroke_width: 0.5, ...(frame_config ?? {}) };
    this.rendered_label = typeof label === "string"
      ? lazy.MathTex.make({ tex_strings: [label], ...labelConfig }) : label;
    this.background_rect = BackgroundRectangle.make({ ...boxConfig, mobjects: [this.rendered_label] });
    this.frame = SurroundingRectangle.make({ ...frameConfig, mobjects: [this.rendered_label] });
    this.add(this.background_rect, this.rendered_label, this.frame);
    return this;
  }
}

function attachLabel(line, { label, label_position, label_config, box_config, frame_config }) {
  line.label = Label.make({ label, label_config, box_config, frame_config });
  const [start, end] = line.get_start_and_end();
  line.label.move_to(add(start, mul(sub(end, start), label_position)));
  line.add(line.label);
}

const LABELED_SIG = ["label", "label_position", "label_config", "box_config", "frame_config", "start", "end"];

export class LabeledLine extends Line {
  static SIG = LABELED_SIG;

  __init__({ label, label_position = 0.5, label_config = null, box_config = null, frame_config = null, ...kw } = {}) {
    super.__init__(kw);
    attachLabel(this, { label, label_position, label_config, box_config, frame_config });
    return this;
  }
}

/** Python's LabeledArrow(LabeledLine, Arrow): the arrow is made first, then labelled. */
export class LabeledArrow extends Arrow {
  static SIG = LABELED_SIG;

  __init__({ label, label_position = 0.5, label_config = null, box_config = null, frame_config = null, ...kw } = {}) {
    super.__init__(kw);
    attachLabel(this, { label, label_position, label_config, box_config, frame_config });
    return this;
  }
}

export const TIP_SHAPES = {
  StealthTip, ArrowTriangleTip, ArrowTriangleFilledTip, ArrowCircleTip, ArrowCircleFilledTip, ArrowSquareTip,
  ArrowSquareFilledTip,
};

lazy.Line = Line;
lazy.BackgroundRectangle = BackgroundRectangle;
