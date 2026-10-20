// Manim's scene kinds: ports of manim/scene/moving_camera_scene.py, zoomed_scene.py, three_d_scene.py and
// vector_space_scene.py.
//
// A scene method that plays more than once, or does something after its play (vector_to_coords, move_camera...),
// is a generator: it yields after starting each play, and the timeline resumes it once that play has finished
// (see timeline.js). `static METHODS` lists the methods a plan may call, with their Python parameters.

import { angleOfVector } from "../core/math.js";
import { config } from "../manim/config.js";
import { DEFAULT_MOBJECT_TO_EDGE_BUFFER, DEFAULT_MOBJECT_TO_MOBJECT_BUFFER, DEGREES, DL, DOWN, LEFT, ORIGIN, RIGHT,
  SMALL_BUFF, UP } from "../manim/frozen.js";
import { Arrow, Line, PURE_YELLOW, Rectangle, Vector } from "../manim/geometry.js";
import { Axes, NumberPlane, updateDictRecursively } from "../manim/coordinates.js";
import { Matrix } from "../manim/matrix.js";
import { Group } from "../manim/mobject.js";
import { ValueTracker } from "../manim/numbers.js";
import { MathTex } from "../manim/tex.js";
import { VGroup, VMobject } from "../manim/vmobject.js";
import { Animation, AnimationBuilder } from "../anim/animation.js";
import { Create, DrawBorderThenFill, Write } from "../anim/creation.js";
import { GrowArrow } from "../anim/fading.js";
import { ApplyMethod, ApplyPointwiseFunction, Transform } from "../anim/transform.js";
import { ImageMobjectFromCamera, MovingCamera, MultiCamera, SubCamera, ThreeDCamera } from "./cameras.js";
import { Scene, SCENE_METHODS } from "./scene.js";

const WHITE = "#FFFFFF";
const GREY = "#888888";
const X_COLOR = "#83C167"; // GREEN_C
const Y_COLOR = "#FC6255"; // RED_C
const LARGE_BUFF = 1;

// ------------------------------------------------------------------------------------------ MovingCameraScene

export class MovingCameraScene extends Scene {
  make_camera() {
    return new MovingCamera();
  }

  get_moving_mobjects(...animations) {
    const moving = super.get_moving_mobjects(...animations);
    const all = new Set(moving.flatMap((m) => m.get_family()));
    for (const indicator of this.camera.get_mobjects_indicating_movement()) {
      if (all.has(indicator)) return [...this.mobjects.filter((m) => !moving.includes(m)), ...moving];
    }
    return moving;
  }
}

// ------------------------------------------------------------------------------------------ ZoomedScene

export class ZoomedScene extends MovingCameraScene {
  constructor({ zoomed_display_height = 3, zoomed_display_width = 3, zoomed_display_center = null,
    zoomed_display_corner = [1, 1, 0], zoomed_display_corner_buff = DEFAULT_MOBJECT_TO_EDGE_BUFFER,
    zoomed_camera_config = { default_frame_stroke_width: 2, background_opacity: 1 }, zoomed_camera_image_mobject_config = {},
    zoomed_camera_frame_starting_position = ORIGIN, zoom_factor = 0.15, image_frame_stroke_width = 3, zoom_activated = false,
    ...kw } = {}) {
    super(kw);
    this.zoomed_display_height = zoomed_display_height;
    this.zoomed_display_width = zoomed_display_width;
    this.zoomed_display_center = zoomed_display_center;
    this.zoomed_display_corner = zoomed_display_corner;
    this.zoomed_display_corner_buff = zoomed_display_corner_buff;
    this.zoomed_camera_config = zoomed_camera_config;
    this.zoomed_camera_image_mobject_config = zoomed_camera_image_mobject_config;
    this.zoomed_camera_frame_starting_position = zoomed_camera_frame_starting_position;
    this.zoom_factor = zoom_factor;
    this.image_frame_stroke_width = image_frame_stroke_width;
    this.zoom_activated = zoom_activated;
  }

  make_camera() {
    return new MultiCamera();
  }

  setup() {
    super.setup();
    const zoomedCamera = new SubCamera(this.zoomed_camera_config);
    const zoomedDisplay = ImageMobjectFromCamera.make({ camera: zoomedCamera, ...this.zoomed_camera_image_mobject_config });
    zoomedDisplay.add_display_frame();
    for (const mob of [zoomedCamera.frame, zoomedDisplay]) {
      mob.stretch_to_fit_height(this.zoomed_display_height);
      mob.stretch_to_fit_width(this.zoomed_display_width);
    }
    zoomedCamera.frame.scale(this.zoom_factor);
    zoomedCamera.frame.move_to(this.zoomed_camera_frame_starting_position);
    if (this.zoomed_display_center !== null) zoomedDisplay.move_to(this.zoomed_display_center);
    else zoomedDisplay.to_corner(this.zoomed_display_corner, this.zoomed_display_corner_buff);
    this.zoomed_camera = zoomedCamera;
    this.zoomed_display = zoomedDisplay;
  }

  *activate_zooming(animate = false) {
    this.zoom_activated = true;
    this.camera.add_image_mobject_from_camera(this.zoomed_display);
    if (animate) {
      yield* this.play_steps([this.get_zoom_in_animation()]);
      yield* this.play_steps([this.get_zoomed_display_pop_out_animation()]);
    }
    this.add_foreground_mobjects(this.zoomed_camera.frame, this.zoomed_display);
  }

  get_zoom_in_animation(run_time = 2, kw = {}) {
    const { frame } = this.zoomed_camera;
    const fullHeight = this.camera.frame_height;
    const fullWidth = this.camera.frame_width;
    frame.save_state();
    frame.stretch_to_fit_width(fullWidth);
    frame.stretch_to_fit_height(fullHeight);
    frame.center();
    frame.set_stroke(null, 0);
    return ApplyMethod.make({ ...kw, method: [frame, "restore"], run_time });
  }

  get_zoomed_display_pop_out_animation(kw = {}) {
    const display = this.zoomed_display;
    display.save_state();
    display.replace(this.zoomed_camera.frame, 0, true);
    return ApplyMethod.make({ ...kw, method: [display, "restore"] });
  }

  get_zoom_factor() {
    return this.zoomed_camera.frame.height / this.zoomed_display.height;
  }

  static METHODS = {
    ...SCENE_METHODS,
    activate_zooming: [["animate"], (s, a) => s.activate_zooming(a.animate ?? false)],
    get_zoom_in_animation: [["run_time"], (s, a, kw) => s.get_zoom_in_animation(a.run_time ?? 2, kw)],
    get_zoomed_display_pop_out_animation: [[], (s, a, kw) => s.get_zoomed_display_pop_out_animation(kw)],
    get_zoom_factor: [[], (s) => s.get_zoom_factor()],
  };
}

// ------------------------------------------------------------------------------------------ ThreeDScene

let updaterKeys = 0;

export class ThreeDScene extends Scene {
  constructor({ ambient_camera_rotation = null, default_angled_camera_orientation_kwargs = null, ...kw } = {}) {
    super(kw);
    this.ambient_camera_rotation = ambient_camera_rotation;
    this.default_angled_camera_orientation_kwargs = default_angled_camera_orientation_kwargs
      ?? { phi: 70 * DEGREES, theta: -135 * DEGREES };
  }

  make_camera() {
    return new ThreeDCamera();
  }

  set_camera_orientation({ phi = null, theta = null, gamma = null, zoom = null, focal_distance = null,
    frame_center = null } = {}) {
    const c = this.camera;
    if (phi !== null) c.set_phi(phi);
    if (theta !== null) c.set_theta(theta);
    if (focal_distance !== null) c.set_focal_distance(focal_distance);
    if (gamma !== null) c.set_gamma(gamma);
    if (zoom !== null) c.set_zoom(zoom);
    if (frame_center !== null) c._frame_center.move_to(frame_center);
  }

  tracker(about) {
    const name = String(about).toLowerCase();
    const trackers = { theta: this.camera.theta_tracker, phi: this.camera.phi_tracker, gamma: this.camera.gamma_tracker };
    if (!(name in trackers)) throw new Error("Invalid ambient rotation angle.");
    return trackers[name];
  }

  // Updaters keep their state on the tracker they move (not in a closure), so a copy of the scene keeps working.
  begin_ambient_camera_rotation(rate = 0.02, about = "theta") {
    const x = this.tracker(about);
    const key = `_ambient${(updaterKeys += 1)}`;
    x[key] = rate;
    x.add_updater((m, dt) => m.increment_value(m[key] * dt));
    this.add(x);
  }

  stop_ambient_camera_rotation(about = "theta") {
    const x = this.tracker(about);
    x.clear_updaters();
    this.remove(x);
  }

  begin_3dillusion_camera_rotation(rate = 1, origin_phi = null, origin_theta = null) {
    const c = this.camera;
    const theta0 = origin_theta ?? c.theta_tracker.get_value();
    const phi0 = origin_phi ?? c.phi_tracker.get_value();
    const kt = `_illusion${(updaterKeys += 1)}`;
    c.theta_tracker[kt] = { tracker: ValueTracker.make({ value: 0 }), rate, origin: theta0 };
    c.theta_tracker.add_updater((m, dt) => {
      const s = m[kt];
      s.tracker.increment_value(dt * s.rate);
      return m.set_value(s.origin + 0.2 * Math.sin(s.tracker.get_value()));
    });
    this.add(c.theta_tracker);
    const kp = `_illusion${(updaterKeys += 1)}`;
    c.phi_tracker[kp] = { tracker: ValueTracker.make({ value: 0 }), rate, origin: phi0 };
    c.phi_tracker.add_updater((m, dt) => {
      const s = m[kp];
      s.tracker.increment_value(dt * s.rate);
      return m.set_value(s.origin + (0.1 * Math.cos(s.tracker.get_value()) - 0.1));
    });
    this.add(c.phi_tracker);
  }

  stop_3dillusion_camera_rotation() {
    const c = this.camera;
    c.theta_tracker.clear_updaters();
    this.remove(c.theta_tracker);
    c.phi_tracker.clear_updaters();
    this.remove(c.phi_tracker);
  }

  *move_camera({ phi = null, theta = null, gamma = null, zoom = null, focal_distance = null, frame_center = null,
    added_anims = [], ...kw } = {}) {
    const c = this.camera;
    const anims = [];
    for (const [value, tracker] of [[phi, c.phi_tracker], [theta, c.theta_tracker], [focal_distance, c.focal_distance_tracker],
      [gamma, c.gamma_tracker], [zoom, c.zoom_tracker]]) {
      if (value !== null) anims.push(new AnimationBuilder(tracker).call("set_value", [value]));
    }
    if (frame_center !== null) anims.push(new AnimationBuilder(c._frame_center).call("move_to", [frame_center]));
    yield* this.play_steps([...anims, ...added_anims], kw);
    if (frame_center !== null) this.remove(c._frame_center);
  }

  get_moving_mobjects(...animations) {
    const moving = super.get_moving_mobjects(...animations);
    const cameraMobjects = [...this.camera.get_value_trackers(), this.camera._frame_center];
    if (cameraMobjects.some((cm) => moving.includes(cm))) return this.mobjects;
    return moving;
  }

  add_fixed_orientation_mobjects(mobjects, opts = {}) {
    this.add(...mobjects);
    this.camera.add_fixed_orientation_mobjects(...mobjects, opts);
  }

  add_fixed_in_frame_mobjects(...mobjects) {
    this.add(...mobjects);
    this.camera.add_fixed_in_frame_mobjects(...mobjects);
  }

  remove_fixed_orientation_mobjects(...mobjects) {
    this.camera.remove_fixed_orientation_mobjects(...mobjects);
  }

  remove_fixed_in_frame_mobjects(...mobjects) {
    this.camera.remove_fixed_in_frame_mobjects(...mobjects);
  }

  set_to_default_angled_camera_orientation(kw = {}) {
    this.set_camera_orientation({ ...this.default_angled_camera_orientation_kwargs, ...kw });
  }

  static METHODS = {
    ...SCENE_METHODS,
    set_camera_orientation: [["phi", "theta", "gamma", "zoom", "focal_distance", "frame_center"],
      (s, a) => s.set_camera_orientation(a)],
    begin_ambient_camera_rotation: [["rate", "about"], (s, a) => s.begin_ambient_camera_rotation(a.rate ?? 0.02, a.about ?? "theta")],
    stop_ambient_camera_rotation: [["about"], (s, a) => s.stop_ambient_camera_rotation(a.about ?? "theta")],
    begin_3dillusion_camera_rotation: [["rate", "origin_phi", "origin_theta"],
      (s, a) => s.begin_3dillusion_camera_rotation(a.rate ?? 1, a.origin_phi ?? null, a.origin_theta ?? null)],
    stop_3dillusion_camera_rotation: [[], (s) => s.stop_3dillusion_camera_rotation()],
    move_camera: [["phi", "theta", "gamma", "zoom", "focal_distance", "frame_center", "added_anims"],
      (s, a, kw) => s.move_camera({ ...a, ...kw })],
    add_fixed_orientation_mobjects: [["*mobjects"], (s, a, kw) => s.add_fixed_orientation_mobjects(a.mobjects, kw)],
    add_fixed_in_frame_mobjects: [["*mobjects"], (s, a) => s.add_fixed_in_frame_mobjects(...a.mobjects)],
    remove_fixed_orientation_mobjects: [["*mobjects"], (s, a) => s.remove_fixed_orientation_mobjects(...a.mobjects)],
    remove_fixed_in_frame_mobjects: [["*mobjects"], (s, a) => s.remove_fixed_in_frame_mobjects(...a.mobjects)],
    set_to_default_angled_camera_orientation: [[], (s, a, kw) => s.set_to_default_angled_camera_orientation(kw)],
  };
}

/** SpecialThreeDScene's __init__ fails in Manim 0.21 (it reads self.renderer before Scene makes it); the generated
 *  Python falls back to ThreeDScene.__init__, so it is a ThreeDScene with these settings and methods. */
export class SpecialThreeDScene extends ThreeDScene {
  constructor(kw = {}) {
    super(kw);
    this.cut_axes_at_radius = true;
    this.default_angled_camera_position = { phi: 70 * DEGREES, theta: -110 * DEGREES };
  }

  get_default_camera_position() {
    return this.default_angled_camera_position;
  }

  set_camera_to_default_position() {
    this.set_camera_orientation(this.default_angled_camera_position);
  }

  static METHODS = {
    ...ThreeDScene.METHODS,
    set_camera_to_default_position: [[], (s) => s.set_camera_to_default_position()],
    get_default_camera_position: [[], (s) => s.get_default_camera_position()],
  };
}

// ------------------------------------------------------------------------------------------ VectorScene

/** Vector.coordinate_label: the vector's end as a column Matrix next to it. */
export function coordinateLabel(vector, { integer_labels = true, n_dim = 2, color = null, ...kw } = {}) {
  let vect = [...vector.get_end()];
  if (integer_labels) vect = vect.map(roundHalfEven);
  const label = Matrix.make({ ...kw, matrix: vect.slice(0, n_dim).map((v) => [v]) });
  label.scale(LARGE_BUFF - 0.2);
  const shift = [...vector.get_end()];
  const edge = shift[0] >= 0 ? label.get_left() : label.get_right();
  const dir = shift[0] >= 0 ? LEFT : RIGHT;
  for (let i = 0; i < 3; i += 1) shift[i] -= edge[i] + DEFAULT_MOBJECT_TO_MOBJECT_BUFFER * dir[i];
  label.shift(shift);
  if (color !== null) label.set_color(color);
  return label;
}

function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export class VectorScene extends Scene {
  constructor({ basis_vector_stroke_width = 6.0, ...kw } = {}) {
    super(kw);
    this.basis_vector_stroke_width = basis_vector_stroke_width;
  }

  *add_plane(animate = false, kw = {}) {
    const plane = NumberPlane.make(kw);
    if (animate) yield* this.play_steps([Create.make({ mobject: plane, lag_ratio: 0.5 })]);
    this.add(plane);
    return plane;
  }

  *add_axes(animate = false, color = WHITE) {
    const axes = Axes.make({ color, axis_config: { unit_size: 1 } });
    if (animate) yield* this.play_steps([Create.make({ mobject: axes })]);
    this.add(axes);
    return axes;
  }

  get_vector(numericalVector, kw = {}) {
    return Arrow.make({ ...kw, start: this.plane.coords_to_point(0, 0),
      end: this.plane.coords_to_point(...numericalVector.slice(0, 2)), buff: 0 });
  }

  *add_vector(vector, color = PURE_YELLOW, animate = true, kw = {}) {
    let v = vector;
    if (!(v instanceof Arrow)) v = Vector.make({ ...kw, direction: v, color });
    if (animate) yield* this.play_steps([GrowArrow.make({ arrow: v })]);
    this.add(v);
    return v;
  }

  get_basis_vectors(i_hat_color = X_COLOR, j_hat_color = Y_COLOR) {
    return VGroup.make({ vmobjects: [[[1, 0], i_hat_color], [[0, 1], j_hat_color]].map(([vect, color]) => Vector.make({
      direction: vect, color, stroke_width: this.basis_vector_stroke_width })) });
  }

  get_basis_vector_labels(kw = {}) {
    const iHat = this.get_basis_vectors().submobjects[0];
    const jHat = this.get_basis_vectors().submobjects[1];
    return VGroup.make({ vmobjects: [[iHat, String.raw`\hat{\imath}`, X_COLOR], [jHat, String.raw`\hat{\jmath}`, Y_COLOR]]
      .map(([vect, label, color]) => this.get_vector_label(vect, label, { color, label_scale_factor: 1, ...kw })) });
  }

  get_vector_label(vector, label, { at_tip = false, direction = "left", rotate = false, color = null,
    label_scale_factor = LARGE_BUFF - 0.2 } = {}) {
    let l = label;
    if (typeof l === "string") {
      if (l.length === 1) l = `\\vec{\\textbf{${l}}}`;
      l = MathTex.make({ tex_strings: [l] });
      l.set_color(color ?? vector.get_color());
    }
    l.scale(label_scale_factor);
    l.add_background_rectangle();
    if (at_tip) {
      const v = vector.get_vector();
      const n = Math.hypot(...v);
      l.next_to(vector.get_end(), v.map((x) => x / n), SMALL_BUFF);
    } else {
      const angle = vector.get_angle();
      if (!rotate) l.rotate(-angle, undefined, { about_point: ORIGIN });
      if (direction === "left") {
        const b = l.get_bottom();
        l.shift([-b[0] + 0.1 * UP[0], -b[1] + 0.1 * UP[1], -b[2] + 0.1 * UP[2]]);
      } else {
        const t = l.get_top();
        l.shift([-t[0] + 0.1 * DOWN[0], -t[1] + 0.1 * DOWN[1], -t[2] + 0.1 * DOWN[2]]);
      }
      l.rotate(angle, undefined, { about_point: ORIGIN });
      const s = vector.get_start();
      const e = vector.get_end();
      l.shift([(e[0] - s[0]) / 2, (e[1] - s[1]) / 2, (e[2] - s[2]) / 2]);
    }
    return l;
  }

  position_x_coordinate(xCoord, xLine, vector) {
    const s = -Math.sign(vector[1]);
    xCoord.next_to(xLine, [s * UP[0], s * UP[1], s * UP[2]]);
    xCoord.set_color(X_COLOR);
    return xCoord;
  }

  position_y_coordinate(yCoord, yLine, vector) {
    const s = Math.sign(vector[0]);
    yCoord.next_to(yLine, [s * RIGHT[0], s * RIGHT[1], s * RIGHT[2]]);
    yCoord.set_color(Y_COLOR);
    return yCoord;
  }

  *vector_to_coords(vector, integer_labels = true, clean_up = true) {
    const startingMobjects = [...this.mobjects];
    let showCreation = false;
    let arrow;
    let v = vector;
    if (v instanceof Arrow) {
      arrow = v;
      v = arrow.get_end().slice(0, 2);
    } else {
      arrow = Vector.make({ direction: v });
      showCreation = true;
    }
    const array = coordinateLabel(arrow, { integer_labels });
    const xLine = Line.make({ start: ORIGIN, end: [v[0] * RIGHT[0], 0, 0] });
    const yLine = Line.make({ start: xLine.get_end(), end: arrow.get_end() });
    xLine.set_color(X_COLOR);
    yLine.set_color(Y_COLOR);
    const temp = array.get_entries();
    const xCoord = temp.submobjects[0];
    const yCoord = temp.submobjects[1];
    const xStart = this.position_x_coordinate(xCoord.copy(), xLine, v);
    const yStart = this.position_y_coordinate(yCoord.copy(), yLine, v);
    const brackets = array.get_brackets();
    if (showCreation) yield* this.play_steps([Create.make({ mobject: arrow })]);
    yield* this.play_steps([Create.make({ mobject: xLine }), Write.make({ vmobject: xStart })], { run_time: 1 });
    yield* this.play_steps([Create.make({ mobject: yLine }), Write.make({ vmobject: yStart })], { run_time: 1 });
    yield* this.wait_steps();
    yield* this.play_steps([
      Transform.make({ mobject: xStart, target_mobject: xCoord, lag_ratio: 0 }),
      Transform.make({ mobject: yStart, target_mobject: yCoord, lag_ratio: 0 }),
      Write.make({ vmobject: brackets, run_time: 1 }),
    ]);
    yield* this.wait_steps();
    this.remove(xStart, yStart, brackets);
    this.add(array);
    if (clean_up) {
      this.clear();
      this.add(...startingMobjects);
    }
    return [array, xLine, yLine];
  }

  static METHODS = {
    ...SCENE_METHODS,
    add_plane: [["animate"], (s, a, kw) => s.add_plane(a.animate ?? false, kw)],
    add_axes: [["animate", "color"], (s, a) => s.add_axes(a.animate ?? false, a.color ?? WHITE)],
    add_vector: [["vector", "color", "animate"], (s, a, kw) => s.add_vector(a.vector, a.color ?? PURE_YELLOW, a.animate ?? true, kw)],
    get_basis_vectors: [["i_hat_color", "j_hat_color"], (s, a) => s.get_basis_vectors(a.i_hat_color ?? X_COLOR, a.j_hat_color ?? Y_COLOR)],
    get_basis_vector_labels: [[], (s, a, kw) => s.get_basis_vector_labels(kw)],
    get_vector_label: [["vector", "label"], (s, a, kw) => s.get_vector_label(a.vector, a.label, kw)],
    vector_to_coords: [["vector", "integer_labels", "clean_up"],
      (s, a) => s.vector_to_coords(a.vector, a.integer_labels ?? true, a.clean_up ?? true)],
  };
}

// ------------------------------------------------------------------------------------------ LinearTransformationScene

/** numpy.linalg.inv for a 2x2 or 3x3 matrix. */
function inverse(m) {
  if (m.length === 2) {
    const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    if (det === 0) throw new Error("Singular matrix");
    return [[m[1][1] / det, -m[0][1] / det], [-m[1][0] / det, m[0][0] / det]];
  }
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0) throw new Error("Singular matrix");
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

const transpose = (m) => m[0].map((_, j) => m.map((row) => row[j]));

export class LinearTransformationScene extends VectorScene {
  constructor({ include_background_plane = true, include_foreground_plane = true, background_plane_kwargs = null,
    foreground_plane_kwargs = null, show_coordinates = false, show_basis_vectors = true, basis_vector_stroke_width = 6,
    i_hat_color = X_COLOR, j_hat_color = Y_COLOR, leave_ghost_vectors = false, ...kw } = {}) {
    super(kw);
    this.include_background_plane = include_background_plane;
    this.include_foreground_plane = include_foreground_plane;
    this.show_coordinates = show_coordinates;
    this.show_basis_vectors = show_basis_vectors;
    this.basis_vector_stroke_width = basis_vector_stroke_width;
    this.i_hat_color = i_hat_color;
    this.j_hat_color = j_hat_color;
    this.leave_ghost_vectors = leave_ghost_vectors;
    this.background_plane_kwargs = { color: GREY, axis_config: { color: GREY },
      background_line_style: { stroke_color: GREY, stroke_width: 1 } };
    this.ghost_vectors = VGroup.make();
    this.foreground_plane_kwargs = { x_range: [-config.frame_width, config.frame_width, 1.0],
      y_range: [-config.frame_width, config.frame_width, 1.0], faded_line_ratio: 1 };
    if (foreground_plane_kwargs) updateDictRecursively(this.foreground_plane_kwargs, foreground_plane_kwargs);
    if (background_plane_kwargs) updateDictRecursively(this.background_plane_kwargs, background_plane_kwargs);
  }

  setup() {
    if (this.has_already_setup) return;
    this.has_already_setup = true;
    this.background_mobjects = [];
    this.foreground_mobjects = [];
    this.transformable_mobjects = [];
    this.moving_vectors = [];
    this.transformable_labels = [];
    this.moving_mobjects = [];
    this.background_plane = NumberPlane.make(this.background_plane_kwargs);
    if (this.show_coordinates) this.background_plane.add_coordinates();
    if (this.include_background_plane) this.add_background_mobject(this.background_plane);
    if (this.include_foreground_plane) {
      this.plane = NumberPlane.make(this.foreground_plane_kwargs);
      this.add_transformable_mobject(this.plane);
    }
    if (this.show_basis_vectors) {
      this.basis_vectors = this.get_basis_vectors(this.i_hat_color, this.j_hat_color);
      this.moving_vectors.push(...this.basis_vectors.submobjects);
      [this.i_hat, this.j_hat] = this.basis_vectors.submobjects;
      this.add(this.basis_vectors);
    }
  }

  add_special_mobjects(list, ...mobs) {
    for (const mobject of mobs) {
      if (!list.includes(mobject)) {
        list.push(mobject);
        this.add(mobject);
      }
    }
  }

  add_background_mobject(...mobjects) {
    this.add_special_mobjects(this.background_mobjects, ...mobjects);
  }

  add_foreground_mobject(...mobjects) {
    this.add_special_mobjects(this.foreground_mobjects, ...mobjects);
  }

  add_transformable_mobject(...mobjects) {
    this.add_special_mobjects(this.transformable_mobjects, ...mobjects);
  }

  add_moving_mobject(mobject, targetMobject = null) {
    mobject.target = targetMobject;
    this.add_special_mobjects(this.moving_mobjects, mobject);
  }

  get_unit_square(color = PURE_YELLOW, opacity = 0.3, strokeWidth = 3) {
    const square = Rectangle.make({ color, width: this.plane.get_x_unit_size(), height: this.plane.get_y_unit_size(),
      stroke_color: color, stroke_width: strokeWidth, fill_color: color, fill_opacity: opacity });
    this.square = square;
    square.move_to(this.plane.coords_to_point(0, 0), DL);
    return square;
  }

  *add_unit_square(animate = false, kw = {}) {
    const square = this.get_unit_square(kw.color ?? PURE_YELLOW, kw.opacity ?? 0.3, kw.stroke_width ?? 3);
    if (animate) {
      yield* this.play_steps([DrawBorderThenFill.make({ vmobject: square }),
        Animation.make({ mobject: Group.make({ mobjects: this.moving_vectors }) })]);
    }
    this.add_transformable_mobject(square);
    this.bring_to_front(...this.moving_vectors);
    this.square = square;
    return this;
  }

  *add_vector(vector, color = PURE_YELLOW, animate = false, kw = {}) {
    const v = yield* super.add_vector(vector, color, animate, kw);
    this.moving_vectors.push(v);
    return v;
  }

  get_transposed_matrix_transformation(transposed) {
    let m = transposed.map((row) => row.map(Number));
    if (m.length === 2) m = [[m[0][0], m[0][1], 0], [m[1][0], m[1][1], 0], [0, 0, 1]];
    else if (m.length !== 3) throw new Error("Matrix has bad dimensions");
    // np.dot(point, m)
    return (p) => [0, 1, 2].map((j) => p[0] * m[0][j] + p[1] * m[1][j] + p[2] * m[2][j]);
  }

  get_piece_movement(pieces) {
    const vPieces = pieces.filter((p) => p instanceof VMobject);
    const start = VGroup.make({ vmobjects: vPieces });
    const target = VGroup.make({ vmobjects: vPieces.map((m) => m.target) });
    if (this.leave_ghost_vectors && start.submobjects.length) {
      this.ghost_vectors.add(start.copy().fade(0.7));
      this.add(this.ghost_vectors.submobjects[this.ghost_vectors.submobjects.length - 1]);
    }
    return Transform.make({ mobject: start, target_mobject: target, lag_ratio: 0 });
  }

  get_moving_mobject_movement(func) {
    for (const m of this.moving_mobjects) {
      if (m.target === null || m.target === undefined) m.target = m.copy();
      m.target.move_to(func(m.get_center()));
    }
    return this.get_piece_movement(this.moving_mobjects);
  }

  get_vector_movement(func) {
    for (const v of this.moving_vectors) {
      v.target = Vector.make({ direction: func(v.get_end()), color: v.get_color() });
      const norm = Math.hypot(...v.target.get_end());
      if (norm < 0.1) v.target.get_tip().scale(norm);
    }
    return this.get_piece_movement(this.moving_vectors);
  }

  get_transformable_label_movement() {
    for (const label of this.transformable_labels) {
      label.target = this.get_vector_label(label.vector.target, label.target_text, label.kwargs);
    }
    return this.get_piece_movement(this.transformable_labels);
  }

  *apply_matrix(matrix, kw = {}) {
    yield* this.apply_transposed_matrix(transpose(matrix), kw);
  }

  *apply_inverse(matrix, kw = {}) {
    yield* this.apply_matrix(inverse(matrix.map((r) => r.map(Number))), kw);
  }

  *apply_transposed_matrix(transposed, kw = {}) {
    const func = this.get_transposed_matrix_transformation(transposed);
    const k = { ...kw };
    if (!("path_arc" in k)) k.path_arc = (angleOfVector(func(RIGHT)) + (angleOfVector(func(UP)) - Math.PI / 2)) / 2;
    yield* this.apply_function(func, k);
  }

  *apply_nonlinear_transformation(func, kw = {}) {
    this.plane.prepare_for_nonlinear_transform();
    yield* this.apply_function(func, kw);
  }

  *apply_function(func, { added_anims = [], ...kw } = {}) {
    const k = { ...kw };
    if (!("run_time" in k)) k.run_time = 3;
    const anims = [
      ...this.transformable_mobjects.map((t) => ApplyPointwiseFunction.make({ function: func, mobject: t })),
      this.get_vector_movement(func),
      this.get_transformable_label_movement(),
      this.get_moving_mobject_movement(func),
      ...this.foreground_mobjects.map((f) => Animation.make({ mobject: f })),
      ...added_anims,
    ];
    yield* this.play_steps(anims, k);
  }

  static METHODS = {
    ...VectorScene.METHODS,
    add_background_mobject: [["*mobjects"], (s, a) => s.add_background_mobject(...a.mobjects)],
    add_foreground_mobject: [["*mobjects"], (s, a) => s.add_foreground_mobject(...a.mobjects)],
    add_transformable_mobject: [["*mobjects"], (s, a) => s.add_transformable_mobject(...a.mobjects)],
    add_moving_mobject: [["mobject", "target_mobject"], (s, a) => s.add_moving_mobject(a.mobject, a.target_mobject ?? null)],
    add_unit_square: [["animate"], (s, a, kw) => s.add_unit_square(a.animate ?? false, kw)],
    add_vector: [["vector", "color", "animate"], (s, a, kw) => s.add_vector(a.vector, a.color ?? PURE_YELLOW, a.animate ?? false, kw)],
    apply_matrix: [["matrix"], (s, a, kw) => s.apply_matrix(a.matrix, kw)],
    apply_inverse: [["matrix"], (s, a, kw) => s.apply_inverse(a.matrix, kw)],
    apply_transposed_matrix: [["transposed_matrix"], (s, a, kw) => s.apply_transposed_matrix(a.transposed_matrix, kw)],
    apply_nonlinear_transformation: [["function"], (s, a, kw) => s.apply_nonlinear_transformation(a.function, kw)],
    apply_function: [["function"], (s, a, kw) => s.apply_function(a.function, kw)],
  };
}

/** The scene class for a plan's scene kind. */
export const SCENE_KINDS = { Scene, MovingCameraScene, ZoomedScene, ThreeDScene, SpecialThreeDScene, VectorScene,
  LinearTransformationScene };
