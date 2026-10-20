// The cameras of Manim's scene kinds: ports of manim/camera/moving_camera.py, multi_camera.py and three_d_camera.py,
// plus ScreenRectangle (mobject/frame.py) and ImageMobjectFromCamera (mobject/types/image_mobject.py).
//
// They draw like render/canvas.js's Camera (Cairo's model). A camera that other cameras draw into (MultiCamera's
// zoomed camera) draws onto its own canvas, which ImageMobjectFromCamera puts on the main picture.

import { normalize, getUnitNormal, rotationAboutZ, rotationMatrix } from "../core/math.js";
import { config } from "../manim/config.js";
import { DEGREES, DOWN, LEFT, ORIGIN, RIGHT, UP } from "../manim/frozen.js";
import { Rectangle, SurroundingRectangle } from "../manim/geometry.js";
import { AbstractImageMobject } from "../manim/image.js";

import { ValueTracker } from "../manim/numbers.js";
import { Mobject, lazy as vlazy } from "../manim/mobject.js";
import { AnimationBuilder } from "../anim/animation.js";
import { Camera } from "../render/canvas.js";
import { extractMobjectFamilyMembers } from "./scene.js";

const WHITE = "#FFFFFF";

// ------------------------------------------------------------------------------------------ Point

/** A one-point PMobject (mobject/types/point_cloud_mobject.py): ThreeDCamera's frame centre and light source. */
export class Point extends Mobject {
  static SIG = ["location", "color"];

  __init__({ location = ORIGIN, color = "#000000", stroke_width = 4, ...kw } = {}) {
    this.location = [...location];
    this.stroke_width = stroke_width;
    return super.__init__({ ...kw, color });
  }

  reset_points() {
    this.rgbas = [];
    this.points = [];
    return this;
  }

  generate_points() {
    this.points = [[Number(this.location[0]), Number(this.location[1]), Number(this.location[2] ?? 0)]];
    this.rgbas = [[...this.color.to_rgba()]];
    return this;
  }

  get_array_attrs() {
    return ["points", "rgbas"];
  }

  get_stroke_width() {
    return this.stroke_width;
  }

  set_stroke_width(width, family = true) {
    for (const mob of family ? this.family_members_with_points() : [this]) mob.stroke_width = width;
    return this;
  }

  interpolate_color(mobject1, mobject2, alpha) {
    this.rgbas = mobject1.rgbas.map((r, i) => r.map((v, j) => (1 - alpha) * v + alpha * mobject2.rgbas[i][j]));
    this.set_stroke_width((1 - alpha) * mobject1.get_stroke_width() + alpha * mobject2.get_stroke_width());
    return this;
  }

  /** Camera.display_point_cloud: each point a square of pixels (overwritten, not blended). */
  draw_on_camera(ctx, camera) {
    const big = config.pixel_height + config.pixel_width;
    const thickness = Math.trunc(1 + (this.stroke_width - 1) * (big / (camera.pixel_height + camera.pixel_width)));
    const lo = Math.floor(-thickness / 2) + 1;
    const hi = Math.floor(thickness / 2) + 1;
    if (hi <= lo) return;
    const fc = camera.frame_center;
    const pts = camera.transform_points_pre_display(this, this.points);
    pts.forEach((p, i) => {
      const x = Math.trunc((p[0] - fc[0]) * (camera.pixel_width / camera.frame_width) + camera.pixel_width / 2);
      const y = Math.trunc((p[1] - fc[1]) * -(camera.pixel_height / camera.frame_height) + camera.pixel_height / 2);
      const [r, g, b, a] = this.rgbas[i] ?? this.rgbas[0];
      ctx.clearRect(x + lo, y + lo, hi - lo, hi - lo); // the pixels are replaced, as Manim writes them
      ctx.fillStyle = `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${a})`;
      ctx.fillRect(x + lo, y + lo, hi - lo, hi - lo);
    });
  }
}

export class ScreenRectangle extends Rectangle {
  static SIG = ["aspect_ratio", "height"];

  __init__({ aspect_ratio = 16.0 / 9.0, height = 4, ...kw } = {}) {
    return super.__init__({ ...kw, width: aspect_ratio * height, height });
  }

  get aspect_ratio() {
    return this.width / this.height;
  }

  set aspect_ratio(value) {
    this.stretch_to_fit_width(value * this.height);
  }
}

export class FullScreenRectangle extends ScreenRectangle {
  __init__(kw = {}) {
    super.__init__(kw);
    this.height = config.frame_height;
    return this;
  }
}

// ------------------------------------------------------------------------------------------ MovingCamera

export class MovingCamera extends Camera {
  constructor({ frame = null, fixed_dimension = 0, default_frame_stroke_color = WHITE, default_frame_stroke_width = 0,
    ...kw } = {}) {
    super(kw);
    this.fixed_dimension = fixed_dimension;
    this.default_frame_stroke_color = default_frame_stroke_color;
    this.default_frame_stroke_width = default_frame_stroke_width;
    let f = frame;
    if (f === null) {
      f = ScreenRectangle.make({ height: config.frame_height });
      f.set_stroke(this.default_frame_stroke_color, this.default_frame_stroke_width);
    }
    this.frame = f;
    // Camera.__init__ sets these through the properties (no change for a new frame)
    if (kw.frame_height !== undefined) this.frame_height = kw.frame_height;
    if (kw.frame_width !== undefined) this.frame_width = kw.frame_width;
    if (kw.frame_center !== undefined) this.frame_center = kw.frame_center;
  }

  get frame_height() {
    return this.frame ? this.frame.height : this._frame_height;
  }

  set frame_height(value) {
    if (this.frame) this.frame.stretch_to_fit_height(value);
    else this._frame_height = value;
  }

  get frame_width() {
    return this.frame ? this.frame.width : this._frame_width;
  }

  set frame_width(value) {
    if (this.frame) this.frame.stretch_to_fit_width(value);
    else this._frame_width = value;
  }

  get frame_center() {
    return this.frame ? this.frame.get_center() : this._frame_center;
  }

  set frame_center(value) {
    if (this.frame) this.frame.move_to(value);
    else this._frame_center = value;
  }

  get_frame() {
    return { width: this.frame.width, height: this.frame.height, center: this.frame.get_center() };
  }

  get_mobjects_indicating_movement() {
    return [this.frame];
  }

  /** Zooms (and moves) the frame onto the mobjects; with `animate`, an `.animate` builder of the frame. */
  auto_zoom(mobjects, margin = 0, only_mobjects_in_frame = false, animate = true) {
    const [left, right, up, down] = this._get_bounding_box(mobjects, only_mobjects_in_frame);
    const x = (left + right) / 2;
    const y = (up + down) / 2;
    const newWidth = Math.abs(left - right);
    const newHeight = Math.abs(up - down);
    const kw = newWidth / this.frame.width > newHeight / this.frame.height
      ? { width: newWidth + margin } : { height: newHeight + margin };
    if (animate) {
      const builder = new AnimationBuilder(this.frame);
      return builder.call("set_x", [x]).call("set_y", [y]).call("set", [], kw);
    }
    return this.frame.set_x(x).set_y(y).set(kw);
  }

  _get_bounding_box(mobjects, onlyInFrame) {
    let located = false;
    let [left, right, up, down] = [0, 1, 1, 0];
    for (const m of mobjects) {
      if (m === this.frame || (onlyInFrame && !this.is_in_frame(m))) continue;
      const l = m.get_critical_point(LEFT)[0];
      const r = m.get_critical_point(RIGHT)[0];
      const u = m.get_critical_point(UP)[1];
      const d = m.get_critical_point(DOWN)[1];
      if (!located) {
        [left, right, up, down] = [l, r, u, d];
        located = true;
      } else {
        if (l < left) left = l;
        if (r > right) right = r;
        if (u > up) up = u;
        if (d < down) down = d;
      }
    }
    if (!located) throw new Error("Could not determine bounding box of the mobjects given to 'auto_zoom'.");
    return [left, right, up, down];
  }

  /** Camera.is_in_frame */
  is_in_frame(mobject) {
    const fc = this.frame_center;
    const fw = this.frame_width;
    const fh = this.frame_height;
    return !(mobject.get_right()[0] < fc[0] - fw / 2 || mobject.get_bottom()[1] > fc[1] + fh / 2
      || mobject.get_left()[0] > fc[0] + fw / 2 || mobject.get_top()[1] < fc[1] - fh / 2);
  }
}

// ------------------------------------------------------------------------------------------ MultiCamera

/** A canvas a sub-camera draws into (none in Node: there it only keeps track of what it would draw). */
function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === "undefined") return null;
  return new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
}

export class MultiCamera extends MovingCamera {
  constructor({ image_mobjects_from_cameras = null, allow_cameras_to_capture_their_own_display = false, ...kw } = {}) {
    super(kw);
    this.image_mobjects_from_cameras = [];
    for (const imfc of image_mobjects_from_cameras ?? []) this.add_image_mobject_from_camera(imfc);
    this.allow_cameras_to_capture_their_own_display = allow_cameras_to_capture_their_own_display;
  }

  add_image_mobject_from_camera(imfc) {
    if (!(imfc.camera instanceof MovingCamera)) throw new Error("ImageMobjectFromCamera needs a MovingCamera");
    this.image_mobjects_from_cameras.push(imfc);
  }

  /** The sub-cameras' pixel sizes follow their displays' sizes (reset_pixel_shape also clears them). */
  update_sub_cameras() {
    for (const imfc of this.image_mobjects_from_cameras) {
      imfc.camera.reset_pixel_shape(Math.trunc((this.pixel_height * imfc.height) / this.frame_height),
        Math.trunc((this.pixel_width * imfc.width) / this.frame_width));
    }
  }

  reset(ctx) {
    for (const imfc of this.image_mobjects_from_cameras) imfc.camera.reset_own();
    super.reset(ctx);
  }

  capture_mobjects(ctx, mobjects) {
    this.update_sub_cameras();
    for (const imfc of this.image_mobjects_from_cameras) {
      let toAdd = [...mobjects];
      if (!this.allow_cameras_to_capture_their_own_display) {
        const own = new Set(imfc.get_family());
        toAdd = toAdd.filter((m) => !own.has(m));
      }
      imfc.camera.capture_own(toAdd);
    }
    super.capture_mobjects(ctx, mobjects);
  }

  get_mobjects_indicating_movement() {
    return [this.frame, ...this.image_mobjects_from_cameras.map((imfc) => imfc.camera.frame)];
  }
}

/** A MovingCamera with a canvas of its own (the zoomed camera). The canvas isn't copied with the camera. */
export class SubCamera extends MovingCamera {
  reset_pixel_shape(height, width) {
    this.pixel_width = width;
    this.pixel_height = height;
    this.reset_own();
  }

  get canvas() {
    const c = this._canvas;
    if (c && c.width === Math.max(1, this.pixel_width) && c.height === Math.max(1, this.pixel_height)) return c;
    Object.defineProperty(this, "_canvas", { value: makeCanvas(this.pixel_width, this.pixel_height), writable: true,
      configurable: true, enumerable: false });
    return this._canvas;
  }

  reset_own() {
    const c = this.canvas;
    if (c) this.reset(c.getContext("2d"));
  }

  capture_own(mobjects) {
    const c = this.canvas;
    if (c) this.capture_mobjects(c.getContext("2d"), mobjects);
  }
}

export class ImageMobjectFromCamera extends AbstractImageMobject {
  static SIG = ["camera", "default_display_frame_config"];

  __init__({ camera, default_display_frame_config = null, ...kw } = {}) {
    this.camera = camera;
    this.default_display_frame_config = default_display_frame_config ?? { stroke_width: 3, stroke_color: WHITE, buff: 0 };
    super.__init__({ ...kw, scale_to_resolution: false });
    return this;
  }

  /** The camera's picture size (the points start as a 3-unit-high frame of its aspect). */
  get_pixel_array() {
    return { width: this.camera.pixel_width, height: this.camera.pixel_height, canvas: this.camera.canvas };
  }

  _canvas() {
    return this.camera.canvas;
  }

  add_display_frame(kw = {}) {
    this.display_frame = SurroundingRectangle.make({ mobjects: [this], ...this.default_display_frame_config, ...kw });
    this.add(this.display_frame);
    return this;
  }

  interpolate_color() {
    return this; // the picture is the camera's, whatever the copies hold
  }

  draw_on_camera(ctx, camera) {
    if (!this.camera.canvas) return;
    super.draw_on_camera(ctx, camera);
  }
}

// ------------------------------------------------------------------------------------------ ThreeDCamera

/** three_d_utils: corners and normals that 3D shading and gradients use. */
const startCornerIndex = () => 0;
const endCornerIndex = (vmob) => Math.trunc((vmob.points.length - 1) / 6) * 3;
const startCorner = (vmob) => (vmob.get_num_points() === 0 ? [...ORIGIN] : vmob.points[0]);
const endCorner = (vmob) => (vmob.get_num_points() === 0 ? [...ORIGIN] : vmob.points[endCornerIndex(vmob)]);

function unitNormalAt(vmob, i) {
  const n = vmob.get_num_points();
  if (vmob.get_anchors().length <= 2) return [...UP];
  const im3 = i > 2 ? i - 3 : n - 4;
  const ip3 = i < n - 3 ? i + 3 : 3;
  const p = vmob.points;
  const v1 = [p[ip3][0] - p[i][0], p[ip3][1] - p[i][1], p[ip3][2] - p[i][2]];
  const v2 = [p[im3][0] - p[i][0], p[im3][1] - p[i][1], p[im3][2] - p[i][2]];
  const u = getUnitNormal(v1, v2);
  return u[0] === 0 && u[1] === 0 && u[2] === 0 ? [...UP] : u;
}

vlazy.gradientPoints3d = (vmob) => [startCorner(vmob), endCorner(vmob)];

/** color.get_shaded_rgb */
function shadedRgb(rgb, point, normal, light) {
  const toSun = normalize([light[0] - point[0], light[1] - point[1], light[2] - point[2]]);
  let lightness = 0.5 * (normal[0] * toSun[0] + normal[1] * toSun[1] + normal[2] * toSun[2]) ** 3;
  if (lightness < 0) lightness *= 0.5;
  return [rgb[0] + lightness, rgb[1] + lightness, rgb[2] + lightness];
}

const matmul = (a, b) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));

export class ThreeDCamera extends Camera {
  constructor({ focal_distance = 20.0, shading_factor = 0.2, default_distance = 5.0,
    light_source_start_point = [-7, -9, 10], should_apply_shading = true, exponential_projection = false, phi = 0,
    theta = -90 * DEGREES, gamma = 0, zoom = 1, ...kw } = {}) {
    super(kw);
    this._frame_center_point = [...(kw.frame_center ?? ORIGIN)];
    this.focal_distance = focal_distance;
    this.phi = phi;
    this.theta = theta;
    this.gamma = gamma;
    this.zoom = zoom;
    this.shading_factor = shading_factor;
    this.default_distance = default_distance;
    this.light_source_start_point = light_source_start_point;
    this.light_source = [...light_source_start_point];
    this.should_apply_shading = should_apply_shading;
    this.exponential_projection = exponential_projection;
    this.max_allowable_norm = 3 * config.frame_width;
    this.phi_tracker = ValueTracker.make({ value: this.phi });
    this.theta_tracker = ValueTracker.make({ value: this.theta });
    this.focal_distance_tracker = ValueTracker.make({ value: this.focal_distance });
    this.gamma_tracker = ValueTracker.make({ value: this.gamma });
    this.zoom_tracker = ValueTracker.make({ value: this.zoom });
    // Manim's frame centre is a Point (so it can be animated)
    this._frame_center = Point.make({ location: this._frame_center_point, stroke_width: 0 });
    this.fixed_orientation_mobjects = new Map(); // mobject -> { of: mobject } | { point } (what its centre follows)
    this.fixed_in_frame_mobjects = new Set();
    this.reset_rotation_matrix();
  }

  get frame_center() {
    return this._frame_center ? this._frame_center.points[0] : this._frame_center_point;
  }

  set frame_center(point) {
    if (this._frame_center) this._frame_center.move_to(point);
    else this._frame_center_point = [...point];
  }

  /** Manim draws through a Cairo context made at the first frame and kept (the projection has already taken the
   *  frame centre away; the context offsets by the centre it had then, normally the origin). */
  get_frame() {
    this._context_center ??= [...this.frame_center];
    return { width: this.frame_width, height: this.frame_height, center: this._context_center };
  }

  capture_mobjects(ctx, mobjects) {
    this.reset_rotation_matrix();
    super.capture_mobjects(ctx, mobjects);
  }

  get_value_trackers() {
    return [this.phi_tracker, this.theta_tracker, this.focal_distance_tracker, this.gamma_tracker, this.zoom_tracker];
  }

  modified_rgbas(vmobject, rgbas) {
    if (!this.should_apply_shading) return rgbas;
    if (vmobject.shade_in_3d && vmobject.get_num_points() > 0) {
      const light = this.light_source;
      const shaded = rgbas.length < 2 ? [[...rgbas[0]], [...rgbas[0]]] : [[...rgbas[0]], [...rgbas[1]]];
      const a = shadedRgb(shaded[0], startCorner(vmobject), unitNormalAt(vmobject, startCornerIndex(vmobject)), light);
      const b = shadedRgb(shaded[1], endCorner(vmobject), unitNormalAt(vmobject, endCornerIndex(vmobject)), light);
      shaded[0] = [...a, shaded[0][3]];
      shaded[1] = [...b, shaded[1][3]];
      return shaded;
    }
    return rgbas;
  }

  get_stroke_rgbas(vmobject, background = false) {
    return this.modified_rgbas(vmobject, vmobject.get_stroke_rgbas(background));
  }

  get_fill_rgbas(vmobject) {
    return this.modified_rgbas(vmobject, vmobject.get_fill_rgbas());
  }

  get_mobjects_to_display(mobjects) {
    const all = super.get_mobjects_to_display(mobjects);
    const r = this.get_rotation_matrix();
    const key = (mob) => {
      if (!mob.shade_in_3d) return Infinity;
      const p = mob.get_z_index_reference_point();
      return p[0] * r[2][0] + p[1] * r[2][1] + p[2] * r[2][2];
    };
    // Python's sorted is stable: equal keys keep their order
    return all.map((m, i) => [key(m), i, m]).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0])).map((e) => e[2]);
  }

  get_phi() { return this.phi_tracker.get_value(); }

  get_theta() { return this.theta_tracker.get_value(); }

  get_focal_distance() { return this.focal_distance_tracker.get_value(); }

  get_gamma() { return this.gamma_tracker.get_value(); }

  get_zoom() { return this.zoom_tracker.get_value(); }

  set_phi(value) { this.phi_tracker.set_value(value); }

  set_theta(value) { this.theta_tracker.set_value(value); }

  set_focal_distance(value) { this.focal_distance_tracker.set_value(value); }

  set_gamma(value) { this.gamma_tracker.set_value(value); }

  set_zoom(value) { this.zoom_tracker.set_value(value); }

  reset_rotation_matrix() {
    this.rotation_matrix = this.generate_rotation_matrix();
  }

  get_rotation_matrix() {
    return this.rotation_matrix;
  }

  generate_rotation_matrix() {
    const matrices = [rotationAboutZ(-this.get_theta() - 90 * DEGREES), rotationMatrix(-this.get_phi(), RIGHT),
      rotationAboutZ(this.get_gamma())];
    let result = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (const m of matrices) result = matmul(m, result);
    return result;
  }

  project_points(points) {
    const fc = this.frame_center;
    const f = this.get_focal_distance();
    const zoom = this.get_zoom();
    const r = this.get_rotation_matrix();
    return points.map((p0) => {
      const p = [p0[0] - fc[0], p0[1] - fc[1], p0[2] - fc[2]];
      const q = [0, 1, 2].map((i) => p[0] * r[i][0] + p[1] * r[i][1] + p[2] * r[i][2]);
      const z = q[2];
      let factor;
      if (this.exponential_projection) factor = z < 0 ? f / (f - z) : Math.exp(z / f);
      else factor = f - z < 0 ? 10 ** 6 : f / (f - z);
      // Manim multiplies x, then y, by factor * zoom
      return [q[0] * (factor * zoom), q[1] * (factor * zoom), z];
    });
  }

  project_point(point) {
    return this.project_points([point])[0];
  }

  transform_points_pre_display(mobject, points) {
    const pts = super.transform_points_pre_display(mobject, points);
    if (this.fixed_in_frame_mobjects.has(mobject)) return pts;
    const fixed = this.fixed_orientation_mobjects.get(mobject);
    if (fixed) {
      const center = fixed.of ? fixed.of.get_center() : fixed.func ? fixed.func() : fixed.point;
      const c = this.project_point(center);
      const d = [c[0] - center[0], c[1] - center[1], c[2] - center[2]];
      return pts.map((p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
    }
    return this.project_points(pts);
  }

  add_fixed_orientation_mobjects(...args) {
    const last = args[args.length - 1];
    const opts = last && !(last instanceof Mobject) && typeof last === "object" && !Array.isArray(last) ? args.pop() : {};
    const { use_static_center_func = false, center_func = null } = opts;
    for (const mobject of args) {
      let entry;
      if (center_func) entry = { func: center_func };
      else if (use_static_center_func) entry = { point: mobject.get_center() };
      else entry = { of: mobject };
      for (const submob of mobject.get_family()) this.fixed_orientation_mobjects.set(submob, entry);
    }
  }

  add_fixed_in_frame_mobjects(...mobjects) {
    for (const m of extractMobjectFamilyMembers(mobjects)) this.fixed_in_frame_mobjects.add(m);
  }

  remove_fixed_orientation_mobjects(...mobjects) {
    for (const m of extractMobjectFamilyMembers(mobjects)) this.fixed_orientation_mobjects.delete(m);
  }

  remove_fixed_in_frame_mobjects(...mobjects) {
    for (const m of extractMobjectFamilyMembers(mobjects)) this.fixed_in_frame_mobjects.delete(m);
  }
}

