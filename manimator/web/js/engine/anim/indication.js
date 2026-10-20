// Indicate, Flash, Circumscribe and the other attention animations, Homotopy, MoveAlongPath, Rotate: ports of
// manim/animation/indication.py, movement.py and rotation.py.

import { interpolate, inverseInterpolate } from "../core/bezier.js";
import { arange, normalize } from "../core/math.js";
import { linear, smooth, there_and_back, wiggle } from "../core/rates.js";
import { config } from "../manim/config.js";
import { DEFAULT_STROKE_WIDTH, OUT, PI, RIGHT, SMALL_BUFF, TAU, UP } from "../manim/frozen.js";
import { Circle, Dot, Line, PURE_YELLOW, Rectangle, SurroundingRectangle } from "../manim/geometry.js";
import { Mobject } from "../manim/mobject.js";
import { VGroup } from "../manim/vmobject.js";
import { Animation } from "./animation.js";
import { AnimationGroup, Succession } from "./composition.js";
import { Create, ShowPartial, Uncreate } from "./creation.js";
import { FadeIn, FadeOut } from "./fading.js";
import { Transform } from "./transform.js";

const GREY = "#888888";

export class FocusOn extends Transform {
  static SIG = ["focus_point", "opacity", "color", "run_time"];

  __init__({ focus_point, opacity = 0.2, color = GREY, run_time = 2, ...kw } = {}) {
    this.focus_point = focus_point;
    this.color = color;
    this.opacity = opacity;
    const startingDot = Dot.make({ radius: config.frame_x_radius + config.frame_y_radius, stroke_width: 0,
      fill_color: this.color, fill_opacity: 0 });
    super.__init__({ ...kw, mobject: startingDot, run_time, remover: true });
    return this;
  }

  create_target() {
    const littleDot = Dot.make({ radius: 0 });
    littleDot.set_fill(this.color, this.opacity);
    const focus = this.focus_point;
    littleDot.add_updater((d) => d.move_to(focus));
    return littleDot;
  }
}

export class Indicate extends Transform {
  static SIG = ["mobject", "scale_factor", "color", "rate_func"];

  __init__({ mobject, scale_factor = 1.2, color = PURE_YELLOW, rate_func = there_and_back, ...kw } = {}) {
    this.color = color;
    this.scale_factor = scale_factor;
    super.__init__({ ...kw, mobject, rate_func });
    return this;
  }

  create_target() {
    const target = this.mobject.copy();
    target.scale(this.scale_factor);
    target.set_color(this.color);
    return target;
  }
}

export class ShowPassingFlash extends ShowPartial {
  static SIG = ["mobject", "time_width"];

  __init__({ mobject, time_width = 0.1, ...kw } = {}) {
    this.time_width = time_width;
    super.__init__({ ...kw, mobject, remover: true, introducer: true });
    return this;
  }

  _get_bounds(alpha) {
    const tw = this.time_width;
    let upper = interpolate(0, 1 + tw, alpha);
    let lower = upper - tw;
    upper = Math.min(upper, 1);
    lower = Math.max(lower, 0);
    return [lower, upper];
  }

  clean_up_from_scene(scene) {
    super.clean_up_from_scene(scene);
    for (const [submob, start] of this.get_all_families_zipped()) submob.pointwise_become_partial(start, 0, 1);
  }
}

export class Flash extends AnimationGroup {
  static SIG = ["point", "line_length", "num_lines", "flash_radius", "line_stroke_width", "color", "time_width",
    "run_time"];

  __init__({ point, line_length = 0.2, num_lines = 12, flash_radius = 0.1, line_stroke_width = 3, color = PURE_YELLOW,
    time_width = 1, run_time = 1.0, ...kw } = {}) {
    this.point = point instanceof Mobject ? point.get_center() : [Number(point[0]), Number(point[1]), Number(point[2] ?? 0)];
    this.color = color;
    this.line_length = line_length;
    this.num_lines = num_lines;
    this.flash_radius = flash_radius;
    this.line_stroke_width = line_stroke_width;
    this.run_time = run_time;
    this.time_width = time_width;
    this.animation_config = kw;
    this.lines = this.create_lines();
    const animations = this.create_line_anims();
    super.__init__({ animations, group: this.lines });
    return this;
  }

  create_lines() {
    const lines = VGroup.make();
    const p = this.point;
    for (const angle of arange(0, TAU, TAU / this.num_lines)) {
      const line = Line.make({ start: p, end: [p[0] + this.line_length * RIGHT[0], p[1], p[2]] });
      line.shift([this.flash_radius * RIGHT[0], 0, 0]);
      line.rotate(angle, OUT, { about_point: p });
      lines.add(line);
    }
    lines.set_color(this.color);
    lines.set_stroke(null, this.line_stroke_width);
    return lines;
  }

  create_line_anims() {
    return this.lines.submobjects.map((line) => ShowPassingFlash.make({ ...this.animation_config, mobject: line,
      time_width: this.time_width, run_time: this.run_time }));
  }
}

export class Homotopy extends Animation {
  static SIG = ["homotopy", "mobject", "run_time", "apply_function_kwargs"];

  __init__({ homotopy, mobject, run_time = 3, apply_function_kwargs = null, ...kw } = {}) {
    this.homotopy = homotopy;
    this.apply_function_kwargs = apply_function_kwargs ?? {};
    super.__init__({ ...kw, mobject, run_time });
    return this;
  }

  function_at_time_t(t) {
    return (p) => this.homotopy(p[0], p[1], p[2], t);
  }

  interpolate_submobject(submobject, startingSubmobject, alpha) {
    submobject.points = startingSubmobject.points.map((p) => [...p]); // Python shares the array; nothing changes it
    submobject.apply_function(this.function_at_time_t(alpha), this.apply_function_kwargs);
    return this;
  }
}

export class ApplyWave extends Homotopy {
  static SIG = ["mobject", "direction", "amplitude", "wave_func", "time_width", "ripples", "run_time"];

  __init__({ mobject, direction = UP, amplitude = 0.2, wave_func = smooth, time_width = 1, ripples = 1, run_time = 2,
    ...kw } = {}) {
    const xMin = mobject.get_left()[0];
    const xMax = mobject.get_right()[0];
    const n = normalize(direction);
    const vect = [amplitude * n[0], amplitude * n[1], amplitude * n[2]];
    const wave = (t0) => {
      let t = 1 - t0;
      if (t >= 1 || t <= 0) return 0;
      const phases = ripples * 2;
      let phase = Math.trunc(t * phases);
      if (phase === 0) return wave_func(t * phases);
      if (phase === phases - 1) {
        t -= phase / phases;
        return (1 - wave_func(t * phases)) * (2 * (ripples % 2) - 1);
      }
      phase = Math.trunc((phase - 1) / 2);
      t -= (2 * phase + 1) / phases;
      return (1 - 2 * wave_func(t * ripples)) * (1 - 2 * (phase % 2));
    };
    const homotopy = (x, y, z, t) => {
      const upper = interpolate(0, 1 + time_width, t);
      const lower = upper - time_width;
      const relativeX = inverseInterpolate(xMin, xMax, x);
      const wavePhase = inverseInterpolate(lower, upper, relativeX);
      const w = wave(wavePhase);
      return [x + w * vect[0], y + w * vect[1], z + w * vect[2]];
    };
    super.__init__({ ...kw, homotopy, mobject, run_time });
    return this;
  }
}

export class Wiggle extends Animation {
  static SIG = ["mobject", "scale_value", "rotation_angle", "n_wiggles", "scale_about_point", "rotate_about_point",
    "run_time"];

  __init__({ mobject, scale_value = 1.1, rotation_angle = 0.01 * TAU, n_wiggles = 6, scale_about_point = null,
    rotate_about_point = null, run_time = 2, ...kw } = {}) {
    this.scale_value = scale_value;
    this.rotation_angle = rotation_angle;
    this.n_wiggles = n_wiggles;
    this.scale_about_point = scale_about_point;
    this.rotate_about_point = rotate_about_point;
    super.__init__({ ...kw, mobject, run_time });
    return this;
  }

  get_scale_about_point() {
    return this.scale_about_point ?? this.mobject.get_center();
  }

  get_rotate_about_point() {
    return this.rotate_about_point ?? this.mobject.get_center();
  }

  interpolate_submobject(submobject, startingSubmobject, alpha) {
    submobject.points = startingSubmobject.points.map((p) => [...p]);
    submobject.scale(interpolate(1, this.scale_value, there_and_back(alpha)), { about_point: this.get_scale_about_point() });
    submobject.rotate(wiggle(alpha, this.n_wiggles) * this.rotation_angle, OUT, { about_point: this.get_rotate_about_point() });
    return this;
  }
}

export class Circumscribe extends Succession {
  static SIG = ["mobject", "shape", "fade_in", "fade_out", "time_width", "buff", "color", "run_time", "stroke_width"];

  __init__({ mobject, shape = Rectangle, fade_in = false, fade_out = false, time_width = 0.3, buff = SMALL_BUFF,
    color = PURE_YELLOW, run_time = 1, stroke_width = DEFAULT_STROKE_WIDTH, ...kw } = {}) {
    let frame;
    if (shape === Rectangle) {
      frame = SurroundingRectangle.make({ mobjects: [mobject], color, buff, stroke_width });
    } else if (shape === Circle) {
      frame = Circle.make({ color, stroke_width }).surround(mobject, 0, false, 1);
      const radius = frame.width / 2;
      frame.scale((radius + buff) / radius);
    } else {
      throw new Error("shape should be either Rectangle or Circle.");
    }
    let animations;
    if (fade_in && fade_out) {
      animations = [FadeIn.make({ mobjects: [frame], run_time: run_time / 2 }), FadeOut.make({ mobjects: [frame], run_time: run_time / 2 })];
    } else if (fade_in) {
      frame.reverse_direction();
      animations = [FadeIn.make({ mobjects: [frame], run_time: run_time / 2 }), Uncreate.make({ mobject: frame, run_time: run_time / 2 })];
    } else if (fade_out) {
      animations = [Create.make({ mobject: frame, run_time: run_time / 2 }), FadeOut.make({ mobjects: [frame], run_time: run_time / 2 })];
    } else {
      animations = [ShowPassingFlash.make({ mobject: frame, time_width, run_time })];
    }
    super.__init__({ ...kw, animations });
    return this;
  }
}

export class MoveAlongPath extends Animation {
  static SIG = ["mobject", "path", "suspend_mobject_updating"];

  __init__({ mobject, path, suspend_mobject_updating = false, ...kw } = {}) {
    this.path = path;
    super.__init__({ ...kw, mobject, suspend_mobject_updating });
    return this;
  }

  interpolate_mobject(alpha) {
    this.mobject.move_to(this.path.point_from_proportion(this.rate_func(alpha)));
  }
}

export class Rotating extends Animation {
  static SIG = ["mobject", "angle", "axis", "about_point", "about_edge", "run_time", "rate_func"];

  __init__({ mobject, angle = TAU, axis = OUT, about_point = null, about_edge = null, run_time = 5, rate_func = linear,
    ...kw } = {}) {
    this.angle = angle;
    this.axis = axis;
    this.about_point = about_point;
    this.about_edge = about_edge;
    super.__init__({ ...kw, mobject, run_time, rate_func });
    return this;
  }

  interpolate_mobject(alpha) {
    this.mobject.become(this.starting_mobject);
    this.mobject.rotate(this.rate_func(alpha) * this.angle, this.axis, { about_point: this.about_point, about_edge: this.about_edge });
  }
}

export class Rotate extends Transform {
  static SIG = ["mobject", "angle", "axis", "about_point", "about_edge"];

  __init__({ mobject, angle = PI, axis = OUT, about_point = null, about_edge = null, ...kw } = {}) {
    const rest = { ...kw };
    if (!("path_arc" in rest)) rest.path_arc = angle;
    if (!("path_arc_axis" in rest)) rest.path_arc_axis = axis;
    this.angle = angle;
    this.axis = axis;
    this.about_edge = about_edge;
    this.about_point = about_point ?? mobject.get_center();
    super.__init__({ ...rest, mobject, path_arc_centers: this.about_point });
    return this;
  }

  create_target() {
    const target = this.mobject.copy();
    target.rotate(this.angle, this.axis, { about_point: this.about_point, about_edge: this.about_edge });
    return target;
  }
}
