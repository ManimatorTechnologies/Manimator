// A port of Manim's Mobject (manim/mobject/mobject.py) and Group.
//
// Conventions of the port, used by every class in manim/:
// - Method and attribute names are Manim's (snake_case), so the Python can be read side by side.
// - Construction mirrors Python's __init__ order: `Circle.make({radius: 1})` is `new Circle().__init__({...})`, and
//   each __init__ sets its fields, calls `super.__init__(rest)`, then finishes, exactly as the Python does.
// - Points are arrays of [x, y, z]. Python's mob[i] is mob.get(i); iterating a mobject is mob.iter().

import { ManimColor, colorGradient, interpolateColor } from "../core/color.js";
import {
  add as vadd, allZero, angleBetweenVectors, cross, dot, mul, norm, normalize, rotationMatrix, sign, sub,
} from "../core/math.js";
import { config } from "./config.js";
import { DEFAULT_MOBJECT_TO_EDGE_BUFFER, DEFAULT_MOBJECT_TO_MOBJECT_BUFFER, MED_SMALL_BUFF, ORIGIN, OUT, RIGHT,
  TAU, UP } from "./frozen.js";

export const WHITE = "#FFFFFF";

/** copy.deepcopy for the object model: shared sub-objects stay shared within the copy. Functions, colours (never
 *  changed in place) and objects marked `noCopy` (fonts, decoded pictures) are kept as they are. */
export function deepCopy(value, memo = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof ManimColor || value.noCopy) return value;
  if (memo.has(value)) return memo.get(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    memo.set(value, out);
    for (let i = 0; i < value.length; i += 1) out[i] = deepCopy(value[i], memo);
    return out;
  }
  if (ArrayBuffer.isView(value)) return value.slice();
  if (value instanceof Map) {
    const out = new Map();
    memo.set(value, out);
    for (const [k, v] of value) out.set(deepCopy(k, memo), deepCopy(v, memo));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    memo.set(value, out);
    for (const v of value) out.add(deepCopy(v, memo));
    return out;
  }
  const out = Object.create(Object.getPrototypeOf(value));
  memo.set(value, out);
  for (const key of Object.keys(value)) out[key] = deepCopy(value[key], memo);
  return out;
}

/** iterables.remove_list_redundancies: keeps the last copy of each item. */
export function removeListRedundancies(list) {
  const seen = new Set();
  const out = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!seen.has(list[i])) {
      seen.add(list[i]);
      out.push(list[i]);
    }
  }
  return out.reverse();
}

/** iterables.list_update */
export const listUpdate = (l1, l2) => [...l1.filter((e) => !l2.includes(e)), ...l2];

// Classes defined elsewhere that Mobject methods need (set by those modules, avoiding import cycles).
export const lazy = { Line: null, VGroup: null, MathTex: null, BackgroundRectangle: null, Group: null };

export class Mobject {
  /** Python's `Cls(**kwargs)` */
  static make(kw = {}) {
    return new this().__init__(kw);
  }

  __init__({ color = WHITE, name = null, dim = 3, target = null, z_index = 0, ...rest } = {}) {
    void rest; // Mobject swallows nothing in Manim; unknown keys are ignored here
    this.name = name ?? this.constructor.name;
    this.dim = dim;
    this.target = target;
    this.z_index = z_index;
    this.point_hash = null;
    this.submobjects = [];
    this.updaters = [];
    this.updating_suspended = false;
    this.color = ManimColor.parse(color);
    this.reset_points();
    this.generate_points();
    this.init_colors();
    return this;
  }

  get color() {
    return this._color;
  }

  set color(value) {
    this._color = value;
  }

  reset_points() {
    this.points = [];
    return this;
  }

  init_colors() {
    return this;
  }

  generate_points() {
    return this;
  }

  add(...mobjects) {
    const unique = removeListRedundancies(mobjects);
    for (const m of unique) {
      if (!(m instanceof Mobject)) throw new TypeError("Only values of type Mobject can be added as submobjects");
      if (m === this) throw new Error("Cannot add mobject as a submobject of itself");
    }
    this.submobjects = listUpdate(this.submobjects, unique);
    return this;
  }

  insert(index, mobject) {
    this.submobjects.splice(index, 0, mobject);
    return this;
  }

  add_to_back(...mobjects) {
    this.remove(...mobjects);
    this.submobjects = [...new Set(mobjects), ...this.submobjects];
    return this;
  }

  remove(...mobjects) {
    for (const m of mobjects) {
      const i = this.submobjects.indexOf(m);
      if (i >= 0) this.submobjects.splice(i, 1);
    }
    return this;
  }

  set(kw = {}) {
    for (const [k, v] of Object.entries(kw)) {
      if (k === "width") this.width = v;
      else if (k === "height") this.height = v;
      else if (k === "depth") this.depth = v;
      else this[k] = v;
    }
    return this;
  }

  get width() {
    return this.length_over_dim(0);
  }

  set width(v) {
    this.scale_to_fit_width(v);
  }

  get height() {
    return this.length_over_dim(1);
  }

  set height(v) {
    this.scale_to_fit_height(v);
  }

  get depth() {
    return this.length_over_dim(2);
  }

  set depth(v) {
    this.scale_to_fit_depth(v);
  }

  get_array_attrs() {
    return ["points"];
  }

  apply_over_attr_arrays(func) {
    for (const attr of this.get_array_attrs()) this[attr] = func(this[attr]);
    return this;
  }

  copy() {
    return deepCopy(this);
  }

  generate_target() {
    this.target = null;
    this.target = this.copy();
    return this.target;
  }

  apply_to_family(func) {
    for (const mob of this.family_members_with_points()) func(mob);
    return this;
  }

  // ------------------------------------------------------------------ transforming

  shift(...vectors) {
    const v = vectors.reduce((a, b) => vadd(a, pt3(b)), [0, 0, 0]);
    for (const mob of this.family_members_with_points()) {
      mob.points = mob.points.map((p) => [p[0] + v[0], p[1] + v[1], p[2] + v[2]]);
    }
    return this;
  }

  scale(scale_factor, { about_point = null, about_edge = null } = {}) {
    this.apply_points_function_about_point((p) => mul(p, scale_factor), about_point, about_edge);
    return this;
  }

  rotate_about_origin(angle, axis = OUT) {
    return this.rotate(angle, axis, { about_point: ORIGIN });
  }

  rotate(angle, axis = OUT, { about_point = null, about_edge = null } = {}) {
    const m = rotationMatrix(angle, axis);
    this.apply_points_function_about_point((p) => [
      p[0] * m[0][0] + p[1] * m[0][1] + p[2] * m[0][2],
      p[0] * m[1][0] + p[1] * m[1][1] + p[2] * m[1][2],
      p[0] * m[2][0] + p[1] * m[2][1] + p[2] * m[2][2],
    ], about_point, about_edge);
    return this;
  }

  flip(axis = UP, { about_point = null, about_edge = null } = {}) {
    return this.rotate(TAU / 2, axis, { about_point, about_edge });
  }

  stretch(factor, dim, { about_point = null, about_edge = null } = {}) {
    this.apply_points_function_about_point((p) => {
      const q = [...p];
      q[dim] *= factor;
      return q;
    }, about_point, about_edge);
    return this;
  }

  apply_function(fn, { about_point = null, about_edge = null } = {}) {
    if (about_point === null && about_edge === null) about_point = ORIGIN;
    this.apply_points_function_about_point((p) => pt3(fn(p)), about_point, about_edge);
    return this;
  }

  apply_matrix(matrix, { about_point = null, about_edge = null } = {}) {
    if (about_point === null && about_edge === null) about_point = ORIGIN;
    const full = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    matrix.forEach((row, i) => row.forEach((v, j) => { full[i][j] = Number(v); }));
    this.apply_points_function_about_point((p) => [
      p[0] * full[0][0] + p[1] * full[0][1] + p[2] * full[0][2],
      p[0] * full[1][0] + p[1] * full[1][1] + p[2] * full[1][2],
      p[0] * full[2][0] + p[1] * full[2][1] + p[2] * full[2][2],
    ], about_point, about_edge);
    return this;
  }

  reverse_points() {
    for (const mob of this.family_members_with_points()) {
      mob.apply_over_attr_arrays((arr) => [...arr].reverse());
    }
    return this;
  }

  /** `func` maps one point (relative to the about point) to its new place. */
  apply_points_function_about_point(func, about_point = null, about_edge = null) {
    if (about_point === null) {
      if (about_edge === null) about_edge = ORIGIN;
      about_point = this.get_critical_point(about_edge);
    }
    const a = pt3(about_point);
    for (const mob of this.family_members_with_points()) {
      mob.points = mob.points.map((p) => {
        const q = func([p[0] - a[0], p[1] - a[1], p[2] - a[2]]);
        return [q[0] + a[0], q[1] + a[1], q[2] + a[2]];
      });
    }
    return this;
  }

  // ------------------------------------------------------------------ positioning

  center() {
    this.shift(mul(this.get_center(), -1));
    return this;
  }

  align_on_border(direction, buff = DEFAULT_MOBJECT_TO_EDGE_BUFFER) {
    const d = pt3(direction);
    const target = [sign(d[0]) * config.frame_x_radius, sign(d[1]) * config.frame_y_radius, sign(d[2]) * 0];
    const pointToAlign = this.get_critical_point(d);
    let shiftVal = sub(sub(target, pointToAlign), mul(d, buff));
    shiftVal = shiftVal.map((v, i) => v * Math.abs(sign(d[i])));
    this.shift(shiftVal);
    return this;
  }

  to_corner(corner = [-1, -1, 0], buff = DEFAULT_MOBJECT_TO_EDGE_BUFFER) {
    return this.align_on_border(corner, buff);
  }

  to_edge(edge = [-1, 0, 0], buff = DEFAULT_MOBJECT_TO_EDGE_BUFFER) {
    return this.align_on_border(edge, buff);
  }

  next_to(mobject_or_point, direction = RIGHT, buff = DEFAULT_MOBJECT_TO_MOBJECT_BUFFER,
    { aligned_edge = ORIGIN, submobject_to_align = null, index_of_submobject_to_align = null,
      coor_mask = [1, 1, 1] } = {}) {
    const dir = pt3(direction);
    const edge = pt3(aligned_edge);
    let target;
    if (mobject_or_point instanceof Mobject) {
      const mob = mobject_or_point;
      const aligner = index_of_submobject_to_align !== null ? mob.get(index_of_submobject_to_align) : mob;
      target = aligner.get_critical_point(vadd(edge, dir));
    } else {
      target = pt3(mobject_or_point);
    }
    let aligner = this;
    if (submobject_to_align !== null) aligner = submobject_to_align;
    else if (index_of_submobject_to_align !== null) aligner = this.get(index_of_submobject_to_align);
    const pointToAlign = aligner.get_critical_point(sub(edge, dir));
    const shiftVal = vadd(sub(target, pointToAlign), mul(dir, buff));
    this.shift([shiftVal[0] * coor_mask[0], shiftVal[1] * coor_mask[1], shiftVal[2] * coor_mask[2]]);
    return this;
  }

  rescale_to_fit(length, dim, stretch = false, kw = {}) {
    const old = this.length_over_dim(dim);
    if (old === 0) return this;
    if (stretch) this.stretch(length / old, dim, kw);
    else this.scale(length / old, kw);
    return this;
  }

  scale_to_fit_width(width, kw = {}) {
    return this.rescale_to_fit(width, 0, false, kw);
  }

  stretch_to_fit_width(width, kw = {}) {
    return this.rescale_to_fit(width, 0, true, kw);
  }

  scale_to_fit_height(height, kw = {}) {
    return this.rescale_to_fit(height, 1, false, kw);
  }

  stretch_to_fit_height(height, kw = {}) {
    return this.rescale_to_fit(height, 1, true, kw);
  }

  scale_to_fit_depth(depth, kw = {}) {
    return this.rescale_to_fit(depth, 2, false, kw);
  }

  stretch_to_fit_depth(depth, kw = {}) {
    return this.rescale_to_fit(depth, 2, true, kw);
  }

  set_coord(value, dim, direction = ORIGIN) {
    const curr = this.get_coord(dim, direction);
    const v = [0, 0, 0];
    v[dim] = value - curr;
    this.shift(v);
    return this;
  }

  set_x(x, direction = ORIGIN) {
    return this.set_coord(x, 0, direction);
  }

  set_y(y, direction = ORIGIN) {
    return this.set_coord(y, 1, direction);
  }

  set_z(z, direction = ORIGIN) {
    return this.set_coord(z, 2, direction);
  }

  move_to(point_or_mobject, aligned_edge = ORIGIN, coor_mask = [1, 1, 1]) {
    const target = point_or_mobject instanceof Mobject
      ? point_or_mobject.get_critical_point(aligned_edge) : pt3(point_or_mobject);
    const pointToAlign = this.get_critical_point(aligned_edge);
    const d = sub(target, pointToAlign);
    this.shift([d[0] * coor_mask[0], d[1] * coor_mask[1], d[2] * coor_mask[2]]);
    return this;
  }

  replace(mobject, dim_to_match = 0, stretch = false) {
    if (!mobject.get_num_points() && !mobject.submobjects.length) {
      throw new Error("Attempting to replace mobject with no points");
    }
    if (stretch) {
      this.stretch_to_fit_width(mobject.width);
      this.stretch_to_fit_height(mobject.height);
    } else {
      this.rescale_to_fit(mobject.length_over_dim(dim_to_match), dim_to_match, false);
    }
    this.shift(sub(mobject.get_center(), this.get_center()));
    return this;
  }

  surround(mobject, dim_to_match = 0, stretch = false, buff = MED_SMALL_BUFF) {
    this.replace(mobject, dim_to_match, stretch);
    const length = mobject.length_over_dim(dim_to_match);
    this.scale((length + buff) / length);
    return this;
  }

  put_start_and_end_on(start, end) {
    const [currentStart, currentEnd] = this.get_start_and_end();
    const currentVector = sub(currentEnd, currentStart);
    if (allZero(currentVector)) {
      this.shift(sub(pt3(start), currentStart));
      return this;
    }
    const targetVector = sub(pt3(end), pt3(start));
    const c = cross(currentVector, targetVector);
    const axis = norm(c) !== 0 ? normalize(c) : OUT;
    this.scale(norm(targetVector) / norm(currentVector), { about_point: currentStart });
    this.rotate(angleBetweenVectors(currentVector, targetVector), axis, { about_point: currentStart });
    this.shift(sub(pt3(start), currentStart));
    return this;
  }

  // ------------------------------------------------------------------ colour

  set_color(color = "#FFFF00", family = true) {
    if (family) for (const submob of this.submobjects) submob.set_color(color, family);
    this.color = ManimColor.parse(color);
    return this;
  }

  set_color_by_gradient(...colors) {
    this.set_submobject_colors_by_gradient(...colors);
    return this;
  }

  set_submobject_colors_by_gradient(...colors) {
    if (colors.length === 0) throw new Error("Need at least one color");
    if (colors.length === 1) return this.set_color(colors[0]);
    const mobs = this.family_members_with_points();
    const newColors = colorGradient(colors, mobs.length);
    mobs.forEach((mob, i) => mob.set_color(newColors[i], false));
    return this;
  }

  fade_to(color, alpha, family = true) {
    if (this.get_num_points() > 0) {
      this.set_color(interpolateColor(this.get_color(), new ManimColor(color), alpha), false);
    }
    if (family) for (const submob of this.submobjects) submob.fade_to(color, alpha);
    return this;
  }

  fade(darkness = 0.5, family = true) {
    if (family) for (const submob of this.submobjects) submob.fade(darkness, family);
    return this;
  }

  get_color() {
    return this.color;
  }

  save_state() {
    this.saved_state = null;
    this.saved_state = this.copy();
    return this;
  }

  restore() {
    if (!this.saved_state) throw new Error("Trying to restore without having saved");
    this.become(this.saved_state);
    return this;
  }

  // ------------------------------------------------------------------ measuring

  reduce_across_dimension(reduce, dim) {
    if (this.submobjects.length === 0 && this.points.length === 0) return null;
    let rv = this.points.length === 0 ? null : reduce(this.points.map((p) => p[dim]));
    for (const mob of this.submobjects) {
      const value = mob.reduce_across_dimension(reduce, dim);
      if (rv === null) rv = value;
      else if (value !== null) rv = reduce([value, rv]);
    }
    return rv;
  }

  nonempty_submobjects() {
    return this.submobjects.filter((m) => m.submobjects.length !== 0 || m.points.length !== 0);
  }

  get_merged_array(attr) {
    let result = [...this[attr]];
    for (const submob of this.submobjects) result = result.concat(submob.get_merged_array(attr));
    return result;
  }

  get_all_points() {
    return this.get_merged_array("points");
  }

  get_points_defining_boundary() {
    return this.get_all_points();
  }

  get_num_points() {
    return this.points.length;
  }

  get_extremum_along_dim(points = null, dim = 0, key = 0) {
    const pts = points ?? this.get_points_defining_boundary();
    let lo = Infinity;
    let hi = -Infinity;
    let nan = false; // np.min / np.max: any NaN makes the result NaN
    for (const p of pts) {
      const v = p[dim];
      if (Number.isNaN(v)) nan = true;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (nan) lo = hi = NaN;
    if (key < 0) return lo;
    if (key === 0) return (lo + hi) / 2;
    return hi;
  }

  get_critical_point(direction) {
    const result = [0, 0, 0];
    const all = this.get_points_defining_boundary();
    if (all.length === 0) return result;
    for (let d = 0; d < this.dim; d += 1) result[d] = this.get_extremum_along_dim(all, d, direction[d] ?? 0);
    return result;
  }

  get_edge_center(direction) {
    return this.get_critical_point(direction);
  }

  get_corner(direction) {
    return this.get_critical_point(direction);
  }

  get_center() {
    return this.get_critical_point([0, 0, 0]);
  }

  get_center_of_mass() {
    const pts = this.get_all_points();
    return [0, 1, 2].map((d) => pts.reduce((s, p) => s + p[d], 0) / pts.length);
  }

  get_boundary_point(direction) {
    const pts = this.get_points_defining_boundary();
    let best = 0;
    let bestValue = -Infinity;
    pts.forEach((p, i) => {
      const v = dot(p, direction);
      if (v > bestValue) {
        bestValue = v;
        best = i;
      }
    });
    return [...pts[best]];
  }

  get_midpoint() {
    return this.point_from_proportion(0.5);
  }

  get_top() {
    return this.get_edge_center([0, 1, 0]);
  }

  get_bottom() {
    return this.get_edge_center([0, -1, 0]);
  }

  get_right() {
    return this.get_edge_center([1, 0, 0]);
  }

  get_left() {
    return this.get_edge_center([-1, 0, 0]);
  }

  get_zenith() {
    return this.get_edge_center([0, 0, 1]);
  }

  get_nadir() {
    return this.get_edge_center([0, 0, -1]);
  }

  length_over_dim(dim) {
    const max = this.reduce_across_dimension(npMax, dim);
    const min = this.reduce_across_dimension(npMin, dim);
    if (max === null || min === null) return 0;
    return max - min;
  }

  get_coord(dim, direction = ORIGIN) {
    return this.get_extremum_along_dim(null, dim, direction[dim]);
  }

  get_x(direction = ORIGIN) {
    return this.get_coord(0, direction);
  }

  get_y(direction = ORIGIN) {
    return this.get_coord(1, direction);
  }

  get_z(direction = ORIGIN) {
    return this.get_coord(2, direction);
  }

  get_start() {
    this.throw_error_if_no_points();
    return [...this.points[0]];
  }

  get_end() {
    this.throw_error_if_no_points();
    return [...this.points[this.points.length - 1]];
  }

  get_start_and_end() {
    return [this.get_start(), this.get_end()];
  }

  point_from_proportion() {
    throw new Error("Please override in a child class.");
  }

  get_z_index_reference_point() {
    return (this.z_index_group ?? this).get_center();
  }

  has_points() {
    return this.points.length > 0;
  }

  has_no_points() {
    return !this.has_points();
  }

  match_color(mobject) {
    return this.set_color(mobject.get_color());
  }

  match_dim_size(mobject, dim, kw = {}) {
    return this.rescale_to_fit(mobject.length_over_dim(dim), dim, false, kw);
  }

  match_width(mobject, kw) {
    return this.match_dim_size(mobject, 0, kw);
  }

  match_height(mobject, kw) {
    return this.match_dim_size(mobject, 1, kw);
  }

  match_depth(mobject, kw) {
    return this.match_dim_size(mobject, 2, kw);
  }

  match_coord(mobject, dim, direction = ORIGIN) {
    return this.set_coord(mobject.get_coord(dim, direction), dim, direction);
  }

  match_x(mobject, direction = ORIGIN) {
    return this.match_coord(mobject, 0, direction);
  }

  match_y(mobject, direction = ORIGIN) {
    return this.match_coord(mobject, 1, direction);
  }

  align_to(mobject_or_point, direction = ORIGIN) {
    const d = pt3(direction);
    const point = mobject_or_point instanceof Mobject
      ? mobject_or_point.get_critical_point(d) : pt3(mobject_or_point);
    for (let dim = 0; dim < this.dim; dim += 1) {
      if (d[dim] !== 0) this.set_coord(point[dim], dim, d);
    }
    return this;
  }

  throw_error_if_no_points() {
    if (this.has_no_points()) throw new Error(`Cannot call this method for a ${this.constructor.name} with no points`);
  }

  // ------------------------------------------------------------------ family

  /** Python's mob[i]: with points of its own, index 0 is the mobject itself. */
  get(index) {
    const n = this.__len__();
    const i = index < 0 ? index + n : index;
    if (i < 0 || i >= n) throw new RangeError("index out of range");
    if (this.has_no_points()) return this.submobjects[i];
    return i === 0 ? this : this.submobjects[i - 1];
  }

  /** Python's mob[a:b] (a step of 1) for a mobject without points of its own. */
  slice(a = 0, b = undefined) {
    const Cls = this.get_group_class();
    const items = this.iter().slice(a, b);
    return Cls === lazy.VGroup ? Cls.make({ vmobjects: items }) : Cls.make({ mobjects: items });
  }

  iter() {
    return [...(this.has_points() ? [this] : []), ...this.submobjects];
  }

  /** Python's len(mob). (Not a `length` getter: tips and TangentLine have a `length` of their own.) */
  __len__() {
    return this.submobjects.length + (this.has_points() ? 1 : 0);
  }

  get_group_class() {
    return Group;
  }

  split() {
    return [...(this.points.length > 0 ? [this] : []), ...this.submobjects];
  }

  get_family() {
    const all = [this];
    for (const m of this.submobjects) all.push(...m.get_family());
    return removeListRedundancies(all);
  }

  family_members_with_points() {
    return this.get_family().filter((m) => m.get_num_points() > 0);
  }

  arrange(direction = RIGHT, buff = DEFAULT_MOBJECT_TO_MOBJECT_BUFFER, center = true, kw = {}) {
    for (let i = 1; i < this.submobjects.length; i += 1) {
      this.submobjects[i].next_to(this.submobjects[i - 1], direction, buff, kw);
    }
    if (center) this.center();
    return this;
  }

  arrange_in_grid({ rows = null, cols = null, buff = MED_SMALL_BUFF, cell_alignment = ORIGIN, row_alignments = null,
    col_alignments = null, row_heights = null, col_widths = null, flow_order = "rd" } = {}) {
    const mobs = [...this.submobjects];
    const startPos = this.get_center();
    const initSize = (num, alignments, sizes) => num ?? alignments?.length ?? sizes?.length ?? null;
    cols = initSize(cols, col_alignments, col_widths);
    rows = initSize(rows, row_alignments, row_heights);
    if (rows === null && cols === null) cols = Math.ceil(Math.sqrt(mobs.length));
    if (rows === null) rows = Math.ceil(mobs.length / cols);
    if (cols === null) cols = Math.ceil(mobs.length / rows);
    if (rows * cols < mobs.length) throw new Error("Too few rows and columns to fit all submobjetcs.");
    const [buffX, buffY] = Array.isArray(buff) ? buff : [buff, buff];
    const initAlignments = (alignments, num, map, dir) => {
      if (alignments === null) return Array.from({ length: num }, () => cell_alignment.map((v, i) => v * dir[i]));
      return [...alignments].map((ch) => map[ch]);
    };
    const rowDirs = initAlignments(row_alignments, rows, { u: [0, 1, 0], c: [0, 0, 0], d: [0, -1, 0] }, [1, 0, 0]);
    const colDirs = initAlignments(col_alignments, cols, { l: [-1, 0, 0], c: [0, 0, 0], r: [1, 0, 0] }, [0, 1, 0]);
    const mapper = {
      dr: (r, c) => rows - r - 1 + c * rows, dl: (r, c) => rows - r - 1 + (cols - c - 1) * rows,
      ur: (r, c) => r + c * rows, ul: (r, c) => r + (cols - c - 1) * rows,
      rd: (r, c) => (rows - r - 1) * cols + c, ld: (r, c) => (rows - r - 1) * cols + (cols - c - 1),
      ru: (r, c) => r * cols + c, lu: (r, c) => r * cols + (cols - c - 1),
    };
    const index = mapper[flow_order];
    if (!index) throw new Error("flow_order must be one of dr, rd, ld, dl, ru, ur, lu, ul");
    rowDirs.reverse();
    const rowHeightsList = row_heights ? [...row_heights].reverse() : [];
    const colWidthsList = col_widths ? [...col_widths] : [];
    const placeholder = Mobject.make();
    while (mobs.length < rows * cols) mobs.push(placeholder);
    const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (__, c) => mobs[index(r, c)]));
    const measuredHeights = grid.map((row) => Math.max(...row.map((m) => m.height)));
    const measuredWidths = Array.from({ length: cols }, (_, c) => Math.max(...grid.map((row) => row[c].width)));
    const initSizes = (sizes, num, measures) => {
      const s = sizes.length ? sizes : Array(num).fill(null);
      if (s.length !== num) throw new Error("mismatching size");
      return s.map((v, i) => v ?? measures[i]);
    };
    const heights = initSizes(rowHeightsList, rows, measuredHeights);
    const widths = initSizes(colWidthsList, cols, measuredWidths);
    let y = 0.0;
    for (let r = 0; r < rows; r += 1) {
      let x = 0;
      for (let c = 0; c < cols; c += 1) {
        if (grid[r][c] !== placeholder) {
          const alignment = vadd(rowDirs[r], colDirs[c]);
          const line = lazy.Line.make({ start: [x, y, 0], end: [x + widths[c], y + heights[r], 0] });
          grid[r][c].move_to(line, alignment);
        }
        x += widths[c] + buffX;
      }
      y += heights[r] + buffY;
    }
    this.move_to(startPos);
    return this;
  }

  sort(pointToNum = (p) => p[0], submobFunc = null) {
    const key = submobFunc ?? ((m) => pointToNum(m.get_center()));
    const keyed = this.submobjects.map((m, i) => [key(m), i, m]);
    keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    this.submobjects = keyed.map((k) => k[2]);
    return this;
  }

  // ------------------------------------------------------------------ morphing

  invert(recursive = false) {
    if (recursive) for (const submob of this.submobjects) submob.invert(true);
    this.submobjects.reverse();
    return this;
  }

  align_data(mobject, skip_point_alignment = false) {
    this.null_point_align(mobject);
    this.align_submobjects(mobject);
    if (!skip_point_alignment) this.align_points(mobject);
    if (this.submobjects.length !== mobject.submobjects.length) {
      throw new Error("align_data: submobject counts differ");
    }
    this.submobjects.forEach((m1, i) => m1.align_data(mobject.submobjects[i]));
    return this;
  }

  get_point_mobject() {
    throw new Error(`get_point_mobject not implemented for ${this.constructor.name}`);
  }

  align_points(mobject) {
    const c1 = this.get_num_points();
    const c2 = mobject.get_num_points();
    if (c1 < c2) this.align_points_with_larger(mobject);
    else if (c2 < c1) mobject.align_points_with_larger(this);
    return this;
  }

  align_points_with_larger() {
    throw new Error("Please override in a child class.");
  }

  align_submobjects(mobject) {
    const n1 = this.submobjects.length;
    const n2 = mobject.submobjects.length;
    this.add_n_more_submobjects(Math.max(0, n2 - n1));
    mobject.add_n_more_submobjects(Math.max(0, n1 - n2));
    return this;
  }

  null_point_align(mobject) {
    for (const [m1, m2] of [[this, mobject], [mobject, this]]) {
      if (m1.has_no_points() && m2.has_points()) m2.push_self_into_submobjects();
    }
    return this;
  }

  push_self_into_submobjects() {
    const copy = this.copy();
    copy.submobjects = [];
    this.reset_points();
    this.add(copy);
    return this;
  }

  add_n_more_submobjects(n) {
    if (n === 0) return null;
    const curr = this.submobjects.length;
    if (curr === 0) {
      this.submobjects = Array.from({ length: n }, () => this.get_point_mobject());
      return null;
    }
    const target = curr + n;
    const splitFactors = new Array(curr).fill(0);
    for (let i = 0; i < target; i += 1) splitFactors[Math.floor((i * curr) / target)] += 1;
    const out = [];
    this.submobjects.forEach((submob, i) => {
      out.push(submob);
      for (let k = 1; k < splitFactors[i]; k += 1) out.push(submob.copy().fade(1));
    });
    this.submobjects = out;
    return this;
  }

  repeat_submobject(submob) {
    return submob.copy();
  }

  interpolate(mobject1, mobject2, alpha, path_func = straightPath()) {
    this.points = path_func(mobject1.points, mobject2.points, alpha);
    this.interpolate_color(mobject1, mobject2, alpha);
    return this;
  }

  interpolate_color() {
    throw new Error("Please override in a child class.");
  }

  become(mobject, { match_height = false, match_width = false, match_depth = false, match_center = false,
    stretch = false } = {}) {
    let m = mobject;
    if (stretch || match_height || match_width || match_depth || match_center) {
      m = mobject.copy();
      if (stretch) {
        m.stretch_to_fit_height(this.height);
        m.stretch_to_fit_width(this.width);
        m.stretch_to_fit_depth(this.depth);
      } else {
        if (match_height) m.match_height(this);
        if (match_width) m.match_width(this);
        if (match_depth) m.match_depth(this);
      }
      if (match_center) m.move_to(this.get_center());
    }
    this.align_data(m, true);
    const f1 = this.get_family();
    const f2 = m.get_family();
    if (f1.length !== f2.length) throw new Error("become: families differ");
    f1.forEach((sm1, i) => {
      sm1.points = f2[i].points.map((p) => [...p]);
      sm1.interpolate_color(sm1, f2[i], 1);
    });
    return this;
  }

  match_points(mobject) {
    const f2 = mobject.get_family();
    this.get_family().forEach((sm1, i) => {
      if (i < f2.length) sm1.points = f2[i].points.map((p) => [...p]);
    });
    return this;
  }

  // ------------------------------------------------------------------ updaters

  /** Python passes dt to updaters that name it; a JS updater takes it as its second parameter. */
  static updaterTakesDt(fn) {
    return fn.takesDt ?? fn.length >= 2;
  }

  get_time_based_updaters() {
    return this.updaters.filter((u) => Mobject.updaterTakesDt(u));
  }

  has_time_based_updater() {
    return this.updaters.some((u) => Mobject.updaterTakesDt(u));
  }

  get_updaters() {
    return this.updaters;
  }

  get_family_updaters() {
    return this.get_family().flatMap((m) => m.updaters);
  }

  add_updater(update_function, index = null, call_updater = false) {
    if (index === null) this.updaters.push(update_function);
    else this.updaters.splice(index, 0, update_function);
    if (call_updater) {
      if (Mobject.updaterTakesDt(update_function)) update_function(this, 0);
      else update_function(this);
    }
    return this;
  }

  remove_updater(update_function) {
    this.updaters = this.updaters.filter((u) => u !== update_function);
    return this;
  }

  clear_updaters(recursive = true) {
    this.updaters = [];
    if (recursive) for (const submob of this.submobjects) submob.clear_updaters();
    return this;
  }

  match_updaters(mobject) {
    this.clear_updaters();
    for (const u of mobject.get_updaters()) this.add_updater(u);
    return this;
  }

  suspend_updating(recursive = true) {
    this.updating_suspended = true;
    if (recursive) for (const submob of this.submobjects) submob.suspend_updating(recursive);
    return this;
  }

  resume_updating(recursive = true) {
    this.updating_suspended = false;
    if (recursive) for (const submob of this.submobjects) submob.resume_updating(recursive);
    this.update(0, recursive);
    return this;
  }

  update(dt = 0, recursive = true) {
    if (this.updating_suspended) return this;
    for (const updater of this.updaters) {
      if (Mobject.updaterTakesDt(updater)) updater(this, dt);
      else updater(this);
    }
    if (recursive) for (const submob of this.submobjects) submob.update(dt, recursive);
    return this;
  }

  add_background_rectangle(kw = {}) {
    this.background_rectangle = lazy.BackgroundRectangle.make({ ...kw, mobjects: [this] });
    this.add_to_back(this.background_rectangle);
    return this;
  }

  set_z_index(z_index_value, family = true) {
    if (family) for (const submob of this.submobjects) submob.set_z_index(z_index_value, family);
    this.z_index = z_index_value;
    return this;
  }
}

export class Group extends Mobject {
  static SIG = ["*mobjects"];

  __init__({ mobjects = [], ...kw } = {}) {
    super.__init__(kw);
    this.add(...mobjects);
    return this;
  }
}

lazy.Group = Group;

/** [x, y] or [x, y, z] (numbers or numeric strings) as [x, y, z]. */
export function pt3(p) {
  return [Number(p[0]), Number(p[1]), Number(p[2] ?? 0)];
}

/** max/min as Python's builtins on a list of numbers (NaN compares false, so it never wins). */
function npMax(values) {
  let m = values[0];
  for (let i = 1; i < values.length; i += 1) if (values[i] > m) m = values[i];
  return m;
}

function npMin(values) {
  let m = values[0];
  for (let i = 1; i < values.length; i += 1) if (values[i] < m) m = values[i];
  return m;
}

/** paths.straight_path(): interpolate every point. */
export function straightPath() {
  return (starts, ends, alpha) => starts.map((p, i) => {
    const q = ends[i];
    return [(1 - alpha) * p[0] + alpha * q[0], (1 - alpha) * p[1] + alpha * q[1], (1 - alpha) * p[2] + alpha * q[2]];
  });
}
