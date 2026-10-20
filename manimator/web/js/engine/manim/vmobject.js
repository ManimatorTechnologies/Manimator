// A port of Manim's VMobject and friends (manim/mobject/types/vectorized_mobject.py) for the Cairo renderer:
// cubic Béziers with four points per curve; a new subpath starts where a curve doesn't begin at the last end.

import { ManimColor } from "../core/color.js";
import {
  bezier, bezierRemap, getSmoothCubicBezierHandlePoints, integerInterpolate, partialBezierPoints,
} from "../core/bezier.js";
import {
  add, allclose, interp, linspace, mul, norm, pymod, rotateVector, shoelaceDirection, sub,
} from "../core/math.js";
import { DEFAULT_STROKE_WIDTH, ORIGIN, OUT, PI, RIGHT, UL, UP } from "./frozen.js";
import { Mobject, lazy, pt3 } from "./mobject.js";

export const BLACK = "#000000";
const T_VALUES = linspace(0, 1, 4);

const lerp = (a, b, t) => (1 - t) * a + t * b;
const lerpPoint = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** iterables.stretch_array_to_length (rows copied) */
export function stretchArrayToLength(arr, length) {
  const curr = arr.length;
  if (curr > length) throw new Error("Trying to stretch array to a length shorter than its own");
  return Array.from({ length }, (_, i) => [...arr[Math.trunc((i / length) * curr)]]);
}

/** iterables.make_even */
export function makeEven(a, b) {
  const n = Math.max(a.length, b.length);
  return [Array.from({ length: n }, (_, i) => a[Math.floor((i * a.length) / n)]),
    Array.from({ length: n }, (_, i) => b[Math.floor((i * b.length) / n)])];
}

// iterables.tuplify. A ManimColor isn't Iterable in Python, so it stays one colour; so does an RGB(A) number array.
const isNumberArray = (x) => Array.isArray(x) && x.length > 0 && typeof x[0] === "number";
const tuplifyColors = (x) => (Array.isArray(x) && !isNumberArray(x) ? x : [x]);
const tuplify = (x) => (Array.isArray(x) ? x : [x]);

/** bezier.interpolate on arrays of numbers or of rows, broadcasting a single row as numpy does. */
function interpolateValue(a, b, alpha) {
  if (typeof a === "number") return lerp(a, b, alpha);
  if (Array.isArray(a) && Array.isArray(a[0])) {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => {
      const r1 = a[a.length === 1 ? 0 : i];
      const r2 = b[b.length === 1 ? 0 : i];
      return r1.map((v, j) => lerp(v, r2[j], alpha));
    });
  }
  return a.map((v, j) => lerp(v, b[j], alpha));
}

const cloneValue = (v) => (Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? [...x] : x)) : v);

export class VMobject extends Mobject {
  __init__({
    fill_color = null, fill_opacity = 0.0, stroke_color = null, stroke_opacity = 1.0, stroke_width = DEFAULT_STROKE_WIDTH,
    background_stroke_color = BLACK, background_stroke_opacity = 1.0, background_stroke_width = 0, sheen_factor = 0.0,
    joint_type = null, sheen_direction = UL, close_new_points = false, pre_function_handle_to_anchor_scale_factor = 0.01,
    make_smooth_after_applying_functions = false, background_image = null, shade_in_3d = false,
    tolerance_for_point_equality = 1e-6, n_points_per_cubic_curve = 4, cap_style = "auto", ...kw
  } = {}) {
    this.fill_opacity = fill_opacity;
    this.stroke_opacity = stroke_opacity;
    this.stroke_width = stroke_width;
    if (background_stroke_color !== null) this.background_stroke_color = new ManimColor(background_stroke_color);
    this.background_stroke_opacity = background_stroke_opacity;
    this.background_stroke_width = background_stroke_width;
    this.sheen_factor = sheen_factor;
    this.joint_type = joint_type ?? "auto";
    this.sheen_direction = sheen_direction;
    this.close_new_points = close_new_points;
    this.pre_function_handle_to_anchor_scale_factor = pre_function_handle_to_anchor_scale_factor;
    this.make_smooth_after_applying_functions = make_smooth_after_applying_functions;
    this.background_image = background_image;
    this.shade_in_3d = shade_in_3d;
    this.tolerance_for_point_equality = tolerance_for_point_equality;
    this.n_points_per_cubic_curve = n_points_per_cubic_curve;
    this.cap_style = cap_style;
    super.__init__(kw);
    if (fill_color !== null) this.fill_color = ManimColor.parse(fill_color);
    if (stroke_color !== null) this.stroke_color = ManimColor.parse(stroke_color);
    return this;
  }

  // Python properties: color / fill_color / stroke_color read and write through the style methods.
  get color() {
    return this.get_color();
  }

  set color(v) {
    this.set_color(v);
  }

  get fill_color() {
    return this.get_fill_color();
  }

  set fill_color(v) {
    this.set_fill(v);
  }

  get stroke_color() {
    return this.get_stroke_color();
  }

  set stroke_color(v) {
    this.set_stroke(v);
  }

  get n_points_per_curve() {
    return this.n_points_per_cubic_curve;
  }

  get_group_class() {
    return VGroup;
  }

  init_colors(propagate_colors = true) {
    this.set_fill(this.fill_color, this.fill_opacity, propagate_colors);
    this.set_stroke(this.stroke_color, this.stroke_width, this.stroke_opacity, false, propagate_colors);
    this.set_background_stroke({ color: this.background_stroke_color, width: this.background_stroke_width,
      opacity: this.background_stroke_opacity, family: propagate_colors });
    this.set_sheen(this.sheen_factor, this.sheen_direction, propagate_colors);
    if (!propagate_colors) for (const submob of this.submobjects) submob.init_colors(false);
    return this;
  }

  generate_rgbas_array(color, opacity) {
    const colors = tuplifyColors(color).map((c) => (c !== null && c !== undefined ? new ManimColor(c) : new ManimColor(BLACK)));
    const opacities = tuplify(opacity).map((o) => (o !== null && o !== undefined ? o : 0.0));
    const [cs, os] = makeEven(colors, opacities);
    let rgbas = cs.map((c, i) => c.to_rgba_with_alpha(os[i]));
    const sheen = this.get_sheen_factor();
    if (sheen !== 0 && rgbas.length === 1) {
      const light = rgbas.map((r) => [clamp01(r[0] + sheen), clamp01(r[1] + sheen), clamp01(r[2] + sheen), clamp01(r[3])]);
      rgbas = [...rgbas, ...light];
    }
    return rgbas;
  }

  update_rgbas_array(arrayName, color = null, opacity = null) {
    let rgbas = this.generate_rgbas_array(color, opacity);
    if (this[arrayName] === undefined) {
      this[arrayName] = rgbas;
      return this;
    }
    let curr = this[arrayName];
    if (curr.length < rgbas.length) {
      curr = stretchArrayToLength(curr, rgbas.length);
      this[arrayName] = curr;
    } else if (rgbas.length < curr.length) {
      rgbas = stretchArrayToLength(rgbas, curr.length);
    }
    if (color !== null && color !== undefined) curr.forEach((row, i) => { row[0] = rgbas[i][0]; row[1] = rgbas[i][1]; row[2] = rgbas[i][2]; });
    if (opacity !== null && opacity !== undefined) curr.forEach((row, i) => { row[3] = rgbas[i][3]; });
    return this;
  }

  set_fill(color = null, opacity = null, family = true) {
    if (family) for (const submob of this.submobjects) submob.set_fill(color, opacity, family);
    this.update_rgbas_array("fill_rgbas", color, opacity);
    if (opacity !== null && opacity !== undefined) this.fill_opacity = opacity;
    return this;
  }

  set_stroke(color = null, width = null, opacity = null, background = false, family = true) {
    if (family) for (const submob of this.submobjects) submob.set_stroke(color, width, opacity, background, family);
    const [arrayName, widthName, opacityName] = background
      ? ["background_stroke_rgbas", "background_stroke_width", "background_stroke_opacity"]
      : ["stroke_rgbas", "stroke_width", "stroke_opacity"];
    this.update_rgbas_array(arrayName, color, opacity);
    if (width !== null && width !== undefined) this[widthName] = width;
    if (opacity !== null && opacity !== undefined) this[opacityName] = opacity;
    if (color !== null && color !== undefined && background) {
      this.background_stroke_color = Array.isArray(color) && !isNumberArray(color)
        ? color.map((c) => ManimColor.parse(c)) : ManimColor.parse(color);
    }
    return this;
  }

  /** Python keywords for set_stroke: set_stroke_kw({color, width, opacity, background, family}). */
  set_stroke_kw({ color = null, width = null, opacity = null, background = false, family = true } = {}) {
    return this.set_stroke(color, width, opacity, background, family);
  }

  set_cap_style(cap_style) {
    this.cap_style = cap_style;
    return this;
  }

  set_background_stroke({ color = null, width = null, opacity = null, family = true } = {}) {
    return this.set_stroke(color, width, opacity, true, family);
  }

  set_style({ fill_color = null, fill_opacity = null, stroke_color = null, stroke_width = null, stroke_opacity = null,
    background_stroke_color = null, background_stroke_width = null, background_stroke_opacity = null,
    sheen_factor = null, sheen_direction = null, family = true } = {}) {
    this.set_fill(fill_color, fill_opacity, family);
    this.set_stroke(stroke_color, stroke_width, stroke_opacity, false, family);
    this.set_background_stroke({ color: background_stroke_color, width: background_stroke_width,
      opacity: background_stroke_opacity, family });
    if (sheen_factor) this.set_sheen(sheen_factor, sheen_direction, family);
    return this;
  }

  get_style(simple = false) {
    const ret = { stroke_opacity: this.get_stroke_opacity(), stroke_width: this.get_stroke_width() };
    if (simple) {
      ret.fill_color = this.get_fill_color();
      ret.fill_opacity = this.get_fill_opacity();
      ret.stroke_color = this.get_stroke_color();
    } else {
      ret.fill_color = this.get_fill_colors();
      ret.fill_opacity = this.get_fill_opacities();
      ret.stroke_color = this.get_stroke_colors();
      ret.background_stroke_color = this.get_stroke_colors(true);
      ret.background_stroke_width = this.get_stroke_width(true);
      ret.background_stroke_opacity = this.get_stroke_opacity(true);
      ret.sheen_factor = this.get_sheen_factor();
      ret.sheen_direction = this.get_sheen_direction();
    }
    return ret;
  }

  match_style(vmobject, family = true) {
    this.set_style({ ...vmobject.get_style(), family: false });
    if (family) {
      const s1 = this.submobjects;
      let s2 = vmobject.submobjects;
      if (s1.length === 0) return this;
      if (s2.length === 0) s2 = [vmobject];
      const [a, b] = makeEven(s1, s2);
      a.forEach((sm1, i) => sm1.match_style(b[i]));
    }
    return this;
  }

  set_color(color, family = true) {
    this.set_fill(color, null, family);
    this.set_stroke(color, null, null, false, family);
    return this;
  }

  set_opacity(opacity, family = true) {
    this.set_fill(null, opacity, family);
    this.set_stroke(null, null, opacity, false, family);
    this.set_stroke(null, null, opacity, true, family);
    return this;
  }

  scale(scale_factor, { scale_stroke = false, about_point = null, about_edge = null } = {}) {
    if (scale_stroke) {
      for (const mob of this.get_family()) {
        if (mob instanceof VMobject) {
          mob.set_stroke(null, Math.abs(scale_factor) * mob.get_stroke_width(), null, false, false);
          mob.set_stroke(null, Math.abs(scale_factor) * mob.get_stroke_width(true), null, true, false);
        }
      }
    }
    super.scale(scale_factor, { about_point, about_edge });
    return this;
  }

  fade(darkness = 0.5, family = true) {
    const factor = 1.0 - darkness;
    this.set_fill(null, factor * this.get_fill_opacity(), false);
    this.set_stroke(null, null, factor * this.get_stroke_opacity(), false, false);
    this.set_background_stroke({ opacity: factor * this.get_stroke_opacity(true), family: false });
    super.fade(darkness, family);
    return this;
  }

  get_fill_rgbas() {
    return this.fill_rgbas ?? [[0, 0, 0, 0]];
  }

  get_fill_color() {
    return this.get_fill_colors()[0];
  }

  get_fill_opacity() {
    return this.get_fill_opacities()[0];
  }

  get_fill_colors() {
    return this.get_fill_rgbas().map((r) => (r.some((v) => v !== 0) ? new ManimColor(r.slice(0, 3)) : null));
  }

  get_fill_opacities() {
    return this.get_fill_rgbas().map((r) => r[3]);
  }

  get_stroke_rgbas(background = false) {
    return (background ? this.background_stroke_rgbas : this.stroke_rgbas) ?? [[0, 0, 0, 0]];
  }

  get_stroke_color(background = false) {
    return this.get_stroke_colors(background)[0];
  }

  get_stroke_width(background = false) {
    const width = background ? this.background_stroke_width : this.stroke_width;
    return Math.max(0.0, Number(width));
  }

  get_stroke_opacity(background = false) {
    return this.get_stroke_opacities(background)[0];
  }

  get_stroke_colors(background = false) {
    return this.get_stroke_rgbas(background).map((r) => (r.some((v) => v !== 0) ? new ManimColor(r.slice(0, 3)) : null));
  }

  get_stroke_opacities(background = false) {
    return this.get_stroke_rgbas(background).map((r) => r[3]);
  }

  get_color() {
    if (this.get_fill_opacities().every((o) => o === 0)) return this.get_stroke_color();
    return this.get_fill_color();
  }

  nonempty_submobjects() {
    return this.submobjects.filter((m) => m.submobjects.length !== 0 || m.points.length !== 0);
  }

  set_sheen_direction(direction, family = true) {
    const d = pt3(direction);
    if (family) for (const submob of this.get_family()) submob.sheen_direction = [...d];
    else this.sheen_direction = d;
    return this;
  }

  rotate_sheen_direction(angle, axis = OUT, family = true) {
    if (family) {
      for (const submob of this.get_family()) submob.sheen_direction = rotateVector(submob.sheen_direction, angle, axis);
    } else {
      this.sheen_direction = rotateVector(this.sheen_direction, angle, axis);
    }
    return this;
  }

  set_sheen(factor, direction = null, family = true) {
    if (family) for (const submob of this.submobjects) submob.set_sheen(factor, direction, family);
    this.sheen_factor = factor;
    if (direction !== null && direction !== undefined) this.set_sheen_direction(direction, false);
    if (factor !== 0) {
      this.set_stroke(this.get_stroke_color(), null, null, false, family);
      this.set_fill(this.get_fill_color(), null, family);
    }
    return this;
  }

  get_sheen_direction() {
    return pt3(this.sheen_direction);
  }

  get_sheen_factor() {
    return this.sheen_factor ?? 0;
  }

  get_gradient_start_and_end_points() {
    if (this.shade_in_3d && lazy.gradientPoints3d) return lazy.gradientPoints3d(this);
    const direction = this.get_sheen_direction();
    const c = this.get_center();
    const bases = [RIGHT, UP, OUT].map((v) => sub(this.get_edge_center(v), c));
    // np.dot(bases.T, direction): column j of bases.T is bases[j]
    const offset = [0, 1, 2].map((i) => bases[0][i] * direction[0] + bases[1][i] * direction[1] + bases[2][i] * direction[2]);
    return [sub(c, offset), add(c, offset)];
  }

  set_shade_in_3d(value = true, z_index_as_group = false) {
    for (const submob of this.get_family()) {
      submob.shade_in_3d = value;
      if (z_index_as_group) submob.z_index_group = this;
    }
    return this;
  }

  // ------------------------------------------------------------------ points

  set_points(points) {
    this.points = points.map(pt3);
    return this;
  }

  set_anchors_and_handles(anchors1, handles1, handles2, anchors2) {
    const out = [];
    for (let i = 0; i < anchors1.length; i += 1) out.push(pt3(anchors1[i]), pt3(handles1[i]), pt3(handles2[i]), pt3(anchors2[i]));
    this.points = out;
    return this;
  }

  clear_points() {
    this.points = [];
    return this;
  }

  append_points(newPoints) {
    this.points = this.points.concat(newPoints.map(pt3));
    return this;
  }

  start_new_path(point) {
    const n = this.points.length;
    const nppc = this.n_points_per_curve;
    if (n % nppc !== 0) {
      const starts = this.get_start_anchors();
      const last = starts[starts.length - 1];
      const closure = Array.from({ length: nppc - (n % nppc) }, () => [...last]);
      this.append_points([...closure, point]);
    } else {
      this.append_points([point]);
    }
    return this;
  }

  add_cubic_bezier_curve(anchor1, handle1, handle2, anchor2) {
    this.append_points([anchor1, handle1, handle2, anchor2]);
    return this;
  }

  add_cubic_bezier_curve_to(handle1, handle2, anchor) {
    this.throw_error_if_no_points();
    const newPoints = [handle1, handle2, anchor];
    if (this.has_new_path_started()) this.append_points(newPoints);
    else this.append_points([this.get_last_point(), ...newPoints]);
    return this;
  }

  add_quadratic_bezier_curve_to(handle, anchor) {
    const last = this.get_last_point();
    const h = pt3(handle);
    const a = pt3(anchor);
    this.add_cubic_bezier_curve_to(add(mul(h, 2 / 3), mul(last, 1 / 3)), add(mul(h, 2 / 3), mul(a, 1 / 3)), a);
    return this;
  }

  add_line_to(point) {
    const last = this.get_last_point();
    const p = pt3(point);
    this.add_cubic_bezier_curve_to(...T_VALUES.slice(1).map((t) => lerpPoint(last, p, t)));
    return this;
  }

  add_smooth_curve_to(...points) {
    let handle2 = null;
    let newAnchor;
    if (points.length === 1) newAnchor = pt3(points[0]);
    else if (points.length === 2) [handle2, newAnchor] = points.map(pt3);
    else throw new Error("Only call add_smooth_curve_to with 1 or 2 points");
    if (this.has_new_path_started()) {
      this.add_line_to(newAnchor);
    } else {
      this.throw_error_if_no_points();
      const n = this.points.length;
      const lastH2 = this.points[n - 2];
      const lastA2 = this.points[n - 1];
      const lastTangent = sub(lastA2, lastH2);
      const handle1 = add(lastA2, lastTangent);
      if (handle2 === null) {
        const toAnchor = sub(newAnchor, lastA2);
        const newTangent = rotateVector(lastTangent, PI, toAnchor);
        handle2 = sub(newAnchor, newTangent);
      }
      this.append_points([lastA2, handle1, handle2, newAnchor]);
    }
    return this;
  }

  has_new_path_started() {
    return this.points.length % this.n_points_per_cubic_curve === 1;
  }

  get_last_point() {
    return this.points[this.points.length - 1];
  }

  is_closed() {
    return this.consider_points_equals(this.points[0], this.points[this.points.length - 1]);
  }

  close_path() {
    if (!this.is_closed()) {
      const subpaths = this.get_subpaths();
      this.add_line_to(subpaths[subpaths.length - 1][0]);
    }
    return this;
  }

  add_points_as_corners(points) {
    this.throw_error_if_no_points();
    const pts = points.map(pt3);
    if (pts.length === 0) return this;
    const starts = [this.points[this.points.length - 1], ...pts.slice(0, -1)];
    if (this.has_new_path_started()) this.points = this.points.slice(0, -1);
    const newPoints = [];
    starts.forEach((s, i) => { for (const t of T_VALUES) newPoints.push(lerpPoint(s, pts[i], t)); });
    this.append_points(newPoints);
    return this;
  }

  set_points_as_corners(points) {
    const pts = points.map(pt3);
    const out = [];
    for (let i = 0; i + 1 < pts.length; i += 1) for (const t of T_VALUES) out.push(lerpPoint(pts[i], pts[i + 1], t));
    this.points = out;
    return this;
  }

  set_points_smoothly(points) {
    this.set_points_as_corners(points);
    this.make_smooth();
    return this;
  }

  change_anchor_mode(mode) {
    const nppcc = this.n_points_per_cubic_curve;
    for (const submob of this.family_members_with_points()) {
      const subpaths = submob.get_subpaths();
      submob.clear_points();
      for (const subpath of subpaths) {
        const anchors = [...subpath.filter((_, i) => i % nppcc === 0), subpath[subpath.length - 1]];
        let h1;
        let h2;
        if (mode === "smooth") {
          [h1, h2] = getSmoothCubicBezierHandlePoints(anchors);
        } else {
          const a1 = anchors.slice(0, -1);
          const a2 = anchors.slice(1);
          h1 = a1.map((a, i) => lerpPoint(a, a2[i], 1.0 / 3));
          h2 = a1.map((a, i) => lerpPoint(a, a2[i], 2.0 / 3));
        }
        const newSubpath = subpath.map((p) => [...p]);
        for (let k = 0; k * nppcc + 1 < newSubpath.length && k < h1.length; k += 1) newSubpath[k * nppcc + 1] = [...h1[k]];
        for (let k = 0; k * nppcc + 2 < newSubpath.length && k < h2.length; k += 1) newSubpath[k * nppcc + 2] = [...h2[k]];
        submob.append_points(newSubpath);
      }
    }
    return this;
  }

  make_smooth() {
    return this.change_anchor_mode("smooth");
  }

  make_jagged() {
    return this.change_anchor_mode("jagged");
  }

  add_subpath(points) {
    this.append_points(points);
    return this;
  }

  append_vectorized_mobject(vmob) {
    if (this.has_new_path_started()) this.points = this.points.slice(0, -1);
    this.append_points(vmob.points);
    return this;
  }

  apply_function(fn) {
    const factor = this.pre_function_handle_to_anchor_scale_factor;
    this.scale_handle_to_anchor_distances(factor);
    super.apply_function(fn);
    this.scale_handle_to_anchor_distances(1.0 / factor);
    if (this.make_smooth_after_applying_functions) this.make_smooth();
    return this;
  }

  rotate(angle, axis = OUT, { about_point = null, about_edge = null } = {}) {
    this.rotate_sheen_direction(angle, axis);
    super.rotate(angle, axis, { about_point, about_edge });
    return this;
  }

  scale_handle_to_anchor_distances(factor) {
    for (const submob of this.family_members_with_points()) {
      if (submob.points.length < this.n_points_per_cubic_curve) continue;
      const [a1, h1, h2, a2] = submob.get_anchors_and_handles();
      submob.set_anchors_and_handles(a1, a1.map((a, i) => add(a, mul(sub(h1[i], a), factor))),
        h2.map((h, i) => add(a2[i], mul(sub(h, a2[i]), factor))), a2);
    }
    return this;
  }

  consider_points_equals(p0, p1) {
    return allclose(p0, p1, this.tolerance_for_point_equality);
  }

  consider_points_equals_2d(p0, p1) {
    const rtol = 1.0e-5;
    const atol = this.tolerance_for_point_equality;
    if (Math.abs(p0[0] - p1[0]) > atol + rtol * Math.abs(p1[0])) return false;
    if (Math.abs(p0[1] - p1[1]) > atol + rtol * Math.abs(p1[1])) return false;
    return true;
  }

  // ------------------------------------------------------------------ curves and subpaths

  get_cubic_bezier_tuples_from_points(points) {
    const nppcc = this.n_points_per_cubic_curve;
    const usable = points.length - (points.length % nppcc);
    const out = [];
    for (let i = 0; i < usable; i += nppcc) out.push(points.slice(i, i + nppcc));
    return out;
  }

  get_cubic_bezier_tuples() {
    return this.get_cubic_bezier_tuples_from_points(this.points);
  }

  _gen_subpaths_from_points(points, splitAt) {
    const nppcc = this.n_points_per_cubic_curve;
    const splits = [0];
    for (let n = nppcc; n < points.length; n += nppcc) if (splitAt(n)) splits.push(n);
    splits.push(points.length);
    const out = [];
    for (let i = 0; i + 1 < splits.length; i += 1) {
      if (splits[i + 1] - splits[i] >= nppcc) out.push(points.slice(splits[i], splits[i + 1]));
    }
    return out;
  }

  get_subpaths_from_points(points) {
    return this._gen_subpaths_from_points(points, (n) => !this.consider_points_equals(points[n - 1], points[n]));
  }

  gen_subpaths_from_points_2d(points) {
    return this._gen_subpaths_from_points(points, (n) => !this.consider_points_equals_2d(points[n - 1], points[n]));
  }

  get_subpaths() {
    return this.get_subpaths_from_points(this.points);
  }

  get_nth_curve_points(n) {
    const nppcc = this.n_points_per_cubic_curve;
    return this.points.slice(nppcc * n, nppcc * (n + 1));
  }

  get_nth_curve_function(n) {
    return bezier(this.get_nth_curve_points(n));
  }

  get_nth_curve_length_pieces(n, sample_points = null) {
    const samples = sample_points ?? 10;
    const curve = this.get_nth_curve_function(n);
    const pts = linspace(0, 1, samples).map((a) => curve(a));
    const norms = [];
    for (let i = 1; i < pts.length; i += 1) norms.push(norm(sub(pts[i], pts[i - 1])));
    return norms;
  }

  get_nth_curve_length(n, sample_points = null) {
    return this.get_nth_curve_length_pieces(n, sample_points).reduce((s, v) => s + v, 0);
  }

  get_num_curves() {
    return Math.floor(this.points.length / this.n_points_per_cubic_curve);
  }

  get_curve_functions_with_lengths(sample_points = null) {
    const out = [];
    for (let n = 0; n < this.get_num_curves(); n += 1) {
      out.push([this.get_nth_curve_function(n), this.get_nth_curve_length(n, sample_points)]);
    }
    return out;
  }

  point_from_proportion(alpha) {
    if (alpha < 0 || alpha > 1) throw new Error(`Alpha ${alpha} not between 0 and 1.`);
    this.throw_error_if_no_points();
    if (alpha === 1) return [...this.points[this.points.length - 1]];
    const cl = this.get_curve_functions_with_lengths();
    const target = alpha * cl.reduce((s, [, l]) => s + l, 0);
    let current = 0;
    for (const [curve, length] of cl) {
      if (current + length >= target) {
        const residue = length !== 0 ? (target - current) / length : 0;
        return curve(residue);
      }
      current += length;
    }
    throw new Error("point_from_proportion: not reached");
  }

  get_anchors_and_handles() {
    const nppcc = this.n_points_per_cubic_curve;
    return Array.from({ length: nppcc }, (_, i) => this.points.filter((_p, k) => k % nppcc === i));
  }

  get_start_anchors() {
    const nppcc = this.n_points_per_cubic_curve;
    return this.points.filter((_p, k) => k % nppcc === 0);
  }

  get_end_anchors() {
    const nppcc = this.n_points_per_cubic_curve;
    return this.points.filter((_p, k) => k % nppcc === nppcc - 1);
  }

  get_anchors() {
    if (this.points.length === 1) return this.points;
    const s = this.get_start_anchors();
    const e = this.get_end_anchors();
    const out = [];
    for (let i = 0; i < Math.min(s.length, e.length); i += 1) out.push(s[i], e[i]);
    return out;
  }

  get_points_defining_boundary() {
    const out = [];
    for (const sm of this.get_family()) {
      if (sm.get_anchors) out.push(...sm.get_anchors());
      else out.push(...sm.points);
    }
    return out;
  }

  get_arc_length(sample_points_per_curve = null) {
    return this.get_curve_functions_with_lengths(sample_points_per_curve).reduce((s, [, l]) => s + l, 0);
  }

  // ------------------------------------------------------------------ morphing

  align_points(vmobject) {
    this.align_rgbas(vmobject);
    if (this.get_num_points() === vmobject.get_num_points()) return this;
    for (const mob of [this, vmobject]) {
      if (mob.has_no_points()) mob.start_new_path(mob.get_center());
      if (mob.has_new_path_started()) mob.add_line_to(mob.get_last_point());
    }
    const subpaths1 = this.get_subpaths();
    const subpaths2 = vmobject.get_subpaths();
    const nSubpaths = Math.max(subpaths1.length, subpaths2.length);
    const nppcc = this.n_points_per_cubic_curve;
    const nth = (list, n) => {
      if (n >= list.length) {
        if (list.length === 0) return Array.from({ length: nppcc }, () => [0, 0, 0]);
        const lastPath = list[list.length - 1];
        return Array.from({ length: nppcc }, () => [...lastPath[lastPath.length - 1]]);
      }
      let path = list[n];
      while (path.length > nppcc) {
        const ref = path[path.length - nppcc - 1];
        if (path.slice(-nppcc).every((p) => allclose(p, ref, this.tolerance_for_point_equality))) {
          path = path.slice(0, -nppcc);
        } else break;
      }
      return path;
    };
    let path1 = [];
    let path2 = [];
    for (let n = 0; n < nSubpaths; n += 1) {
      let sp1 = nth(subpaths1, n);
      let sp2 = nth(subpaths2, n);
      const diff1 = Math.max(0, Math.floor((sp2.length - sp1.length) / nppcc));
      const diff2 = Math.max(0, Math.floor((sp1.length - sp2.length) / nppcc));
      sp1 = this.insert_n_curves_to_point_list(diff1, sp1);
      sp2 = this.insert_n_curves_to_point_list(diff2, sp2);
      path1 = path1.concat(sp1);
      path2 = path2.concat(sp2);
    }
    this.set_points(path1);
    vmobject.set_points(path2);
    return this;
  }

  insert_n_curves(n) {
    const newPathPoint = this.has_new_path_started() ? this.get_last_point() : null;
    this.set_points(this.insert_n_curves_to_point_list(n, this.points));
    if (newPathPoint !== null) this.append_points([newPathPoint]);
    return this;
  }

  insert_n_curves_to_point_list(n, points) {
    if (points.length === 1) return Array.from({ length: this.n_points_per_cubic_curve * n }, () => [...points[0]]);
    const tuples = this.get_cubic_bezier_tuples_from_points(points);
    if (n === 0) return tuples.flat().map((p) => [...p]);
    return bezierRemap(tuples, tuples.length + n).flat();
  }

  align_rgbas(vmobject) {
    for (const attr of ["fill_rgbas", "stroke_rgbas", "background_stroke_rgbas"]) {
      const a1 = this[attr];
      const a2 = vmobject[attr];
      if (a1.length > a2.length) vmobject[attr] = stretchArrayToLength(a2, a1.length);
      else if (a2.length > a1.length) this[attr] = stretchArrayToLength(a1, a2.length);
    }
    return this;
  }

  get_point_mobject(center = null) {
    const point = VectorizedPoint.make({ location: center ?? this.get_center() });
    point.match_style(this);
    return point;
  }

  interpolate_color(mobject1, mobject2, alpha) {
    for (const attr of ["fill_rgbas", "stroke_rgbas", "background_stroke_rgbas", "stroke_width",
      "background_stroke_width", "sheen_direction", "sheen_factor"]) {
      this[attr] = interpolateValue(mobject1[attr], mobject2[attr], alpha);
      if (alpha === 1.0) this[attr] = cloneValue(mobject2[attr]);
    }
    return this;
  }

  pointwise_become_partial(vmobject, a, b) {
    if (!(vmobject instanceof VMobject)) throw new TypeError("Expected a VMobject");
    if (a <= 0 && b >= 1) {
      this.set_points(vmobject.points);
      return this;
    }
    const numCurves = vmobject.get_num_curves();
    if (numCurves === 0) return this;
    const [lowerIndex, lowerResidue] = integerInterpolate(0, numCurves, a);
    const [upperIndex, upperResidue] = integerInterpolate(0, numCurves, b);
    const nppc = this.n_points_per_curve;
    const pts = vmobject.points;
    const curve = (i) => pts.slice(nppc * i, nppc * (i + 1));
    if (lowerIndex === upperIndex) {
      this.points = partialBezierPoints(curve(lowerIndex), lowerResidue, upperResidue);
    } else {
      this.points = [
        ...partialBezierPoints(curve(lowerIndex), lowerResidue, 1),
        ...pts.slice(nppc * (lowerIndex + 1), nppc * upperIndex).map((p) => [...p]),
        ...partialBezierPoints(curve(upperIndex), 0, upperResidue),
      ];
    }
    return this;
  }

  get_subcurve(a, b) {
    let vmob;
    if (this.is_closed() && a > b) {
      vmob = this.copy();
      vmob.pointwise_become_partial(this, a, 1);
      const vmob2 = this.copy();
      vmob2.pointwise_become_partial(this, 0, b);
      vmob.append_vectorized_mobject(vmob2);
    } else {
      vmob = this.copy();
      vmob.pointwise_become_partial(this, a, b);
    }
    return vmob;
  }

  get_pieces(n_pieces) {
    const template = this.copy();
    template.submobjects = [];
    const alphas = linspace(0, 1, n_pieces + 1);
    const pieces = alphas.slice(0, -1).map((a1, i) => template.copy().pointwise_become_partial(this, a1, alphas[i + 1]));
    return lazy.Group.make({ mobjects: pieces });
  }

  get_direction() {
    return shoelaceDirection(this.get_start_anchors());
  }

  reverse_direction() {
    this.points = [...this.points].reverse();
    return this;
  }

  force_direction(target) {
    if (this.get_direction() !== target) this.reverse_direction();
    return this;
  }
}

export class VGroup extends VMobject {
  static SIG = ["*vmobjects"];

  __init__({ vmobjects = [], ...kw } = {}) {
    super.__init__(kw);
    this.add(...vmobjects);
    return this;
  }

  add(...vmobjects) {
    const valid = [];
    for (const v of vmobjects) {
      if (v instanceof VMobject) valid.push(v);
      else if (Array.isArray(v)) {
        for (const w of v) {
          if (!(w instanceof VMobject)) throw new TypeError("Only values of type VMobject can be added as submobjects of VGroup");
          valid.push(w);
        }
      } else {
        throw new TypeError(`Only values of type VMobject can be added as submobjects of VGroup, not ${v?.constructor?.name}`);
      }
    }
    return super.add(...valid);
  }

  /** VGroup(*mobjects) */
  static of(...vmobjects) {
    return VGroup.make({ vmobjects });
  }
}

export class VectorizedPoint extends VMobject {
  static SIG = ["location", "color", "fill_opacity", "stroke_width", "artificial_width", "artificial_height"];

  __init__({ location = ORIGIN, color = BLACK, fill_opacity = 0, stroke_width = 0, artificial_width = 0.01,
    artificial_height = 0.01, ...kw } = {}) {
    this.artificial_width = artificial_width;
    this.artificial_height = artificial_height;
    super.__init__({ color, fill_opacity, stroke_width, ...kw });
    this.set_points([pt3(location)]);
    return this;
  }

  get width() {
    return this.artificial_width;
  }

  set width(v) {
    this.scale_to_fit_width(v);
  }

  get height() {
    return this.artificial_height;
  }

  set height(v) {
    this.scale_to_fit_height(v);
  }

  get_location() {
    return [...this.points[0]];
  }

  set_location(loc) {
    this.set_points([pt3(loc)]);
    return this;
  }
}

export class CurvesAsSubmobjects extends VGroup {
  static SIG = ["vmobject"];

  __init__({ vmobject, ...kw } = {}) {
    super.__init__(kw);
    for (const tup of vmobject.get_cubic_bezier_tuples()) {
      const part = VMobject.make();
      part.set_points(tup);
      part.match_style(vmobject);
      this.add(part);
    }
    return this;
  }

  point_from_proportion(alpha) {
    if (alpha < 0 || alpha > 1) throw new Error(`Alpha ${alpha} not between 0 and 1.`);
    const parts = this.submobjects.filter((p) => p.points.length > 0);
    if (!parts.length) throw new Error("CurvesAsSubmobjects with no points");
    if (alpha === 1) {
      const last = parts[parts.length - 1];
      return [...last.points[last.points.length - 1]];
    }
    const lengths = parts.map((p) => p.get_arc_length());
    const target = alpha * lengths.reduce((s, l) => s + l, 0);
    let current = 0;
    for (let i = 0; i < parts.length; i += 1) {
      if (current + lengths[i] >= target) return parts[i].point_from_proportion((target - current) / lengths[i]);
      current += lengths[i];
    }
    return null;
  }
}

export class DashedVMobject extends VMobject {
  static SIG = ["vmobject", "num_dashes", "dashed_ratio", "dash_offset", "color", "equal_lengths"];

  __init__({ vmobject, num_dashes = 15, dashed_ratio = 0.5, dash_offset = 0, color = "#FFFFFF", equal_lengths = true,
    ...kw } = {}) {
    this.dashed_ratio = dashed_ratio;
    this.num_dashes = num_dashes;
    super.__init__({ color, ...kw });
    const base = vmobject;
    const vmob = base.copy();
    let tips = null;
    if (typeof vmob.pop_tips === "function") {
      const popped = vmob.pop_tips();
      if (popped.submobjects.length > 0) tips = popped;
    }
    const r = this.dashed_ratio;
    const n = this.num_dashes;
    if (n > 0) {
      const closed = vmob.is_closed();
      const dashLen = r / n;
      const voidLen = closed ? (1 - r) / n : n === 1 ? 1 - r : (1 - r) / (n - 1);
      const period = dashLen + voidLen;
      const phaseShift = pymod(dash_offset, 1) * period;
      const patternLen = closed ? 1 : 1 + voidLen;
      const starts = Array.from({ length: n }, (_, i) => pymod(i * period + phaseShift, patternLen));
      const ends = Array.from({ length: n }, (_, i) => pymod(i * period + dashLen + phaseShift, patternLen));
      if (!closed) {
        if (ends[ends.length - 1] > 1 && starts[starts.length - 1] > 1) {
          ends.pop();
          starts.pop();
        } else if (ends[ends.length - 1] < dashLen) {
          if (starts[starts.length - 1] < 1) {
            starts.push(0);
            ends.push(ends[ends.length - 1]);
            ends[ends.length - 2] = 1;
          } else {
            starts[starts.length - 1] = 0;
          }
        } else if (starts[starts.length - 1] > 1 - dashLen) {
          ends[ends.length - 1] = 1;
        }
      }
      if (equal_lengths) {
        let norms = [0];
        for (let k = 0; k < vmob.get_num_curves(); k += 1) norms = norms.concat(vmob.get_nth_curve_length_pieces(k));
        const lengthVals = [];
        norms.reduce((s, v) => { lengthVals.push(s + v); return s + v; }, 0);
        const refPoints = linspace(0, 1, lengthVals.length);
        const curveLength = lengthVals[lengthVals.length - 1];
        for (let i = 0; i < starts.length; i += 1) {
          this.add(vmob.get_subcurve(interp(starts[i] * curveLength, lengthVals, refPoints),
            interp(ends[i] * curveLength, lengthVals, refPoints)));
        }
      } else {
        for (let i = 0; i < starts.length; i += 1) this.add(vmob.get_subcurve(starts[i], ends[i]));
      }
    }
    this.match_style(base, false);
    if (tips !== null) this.add(...tips.submobjects);
    return this;
  }
}

lazy.VGroup = VGroup;
