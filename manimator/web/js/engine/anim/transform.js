// Transform and the animations built on it: a port of manim/animation/transform.py.

import { pathAlongArc, pathAlongCircles } from "../core/paths.js";
import { DEFAULT_POINTWISE_FUNCTION_RUN_TIME, DEGREES, ORIGIN, OUT } from "../manim/frozen.js";
import { Group, Mobject } from "../manim/mobject.js";
import { callMethod } from "../manim/pymethods.js";
import { VGroup } from "../manim/vmobject.js";
import { Animation, builders, zipLists } from "./animation.js";

export class Transform extends Animation {
  static SIG = ["mobject", "target_mobject", "path_func", "path_arc", "path_arc_axis", "path_arc_centers",
    "replace_mobject_with_target_in_scene"];

  __init__({ mobject = null, target_mobject = null, path_func = null, path_arc = 0, path_arc_axis = OUT,
    path_arc_centers = null, replace_mobject_with_target_in_scene = false, ...kw } = {}) {
    this.path_arc_axis = path_arc_axis;
    this.path_arc_centers = path_arc_centers;
    this.path_arc = path_arc;
    if (path_func !== null) this.path_func = path_func;
    else if (this.path_arc_centers !== null) {
      this.path_func = pathAlongCircles(path_arc, this.path_arc_centers, this.path_arc_axis);
    }
    this.replace_mobject_with_target_in_scene = replace_mobject_with_target_in_scene;
    this.target_mobject = target_mobject ?? Mobject.make();
    super.__init__({ ...kw, mobject });
    return this;
  }

  get path_arc() {
    return this._path_arc;
  }

  set path_arc(value) {
    this._path_arc = value;
    this._path_func = pathAlongArc(value, this.path_arc_axis);
  }

  get path_func() {
    return this._path_func;
  }

  set path_func(value) {
    if (value !== null && value !== undefined) this._path_func = value;
  }

  begin() {
    this.target_mobject = this.create_target();
    this.target_copy = this.target_mobject.copy();
    this.mobject.align_data(this.target_copy);
    super.begin();
  }

  create_target() {
    return this.target_mobject;
  }

  clean_up_from_scene(scene) {
    super.clean_up_from_scene(scene);
    if (this.replace_mobject_with_target_in_scene) scene.replace(this.mobject, this.target_mobject);
  }

  get_all_mobjects() {
    return [this.mobject, this.starting_mobject, this.target_mobject, this.target_copy];
  }

  get_all_families_zipped() {
    return zipLists([this.mobject, this.starting_mobject, this.target_copy].map((m) => m.family_members_with_points()), true);
  }

  interpolate_submobject(submobject, startingSubmobject, targetCopy, alpha) {
    submobject.interpolate(startingSubmobject, targetCopy, alpha, this.path_func);
    return this;
  }
}

export class ReplacementTransform extends Transform {
  static SIG = ["mobject", "target_mobject"];

  __init__({ mobject, target_mobject, ...kw } = {}) {
    super.__init__({ ...kw, mobject, target_mobject, replace_mobject_with_target_in_scene: true });
    return this;
  }
}

export class TransformFromCopy extends Transform {
  static SIG = ["mobject", "target_mobject"];

  __init__({ mobject, target_mobject, ...kw } = {}) {
    super.__init__({ ...kw, mobject: target_mobject, target_mobject: mobject });
    return this;
  }

  interpolate(alpha) {
    super.interpolate(1 - alpha);
  }
}

export class ClockwiseTransform extends Transform {
  static SIG = ["mobject", "target_mobject", "path_arc"];

  __init__({ path_arc = -Math.PI, ...kw } = {}) {
    super.__init__({ ...kw, path_arc });
    return this;
  }
}

export class CounterclockwiseTransform extends Transform {
  static SIG = ["mobject", "target_mobject", "path_arc"];

  __init__({ path_arc = Math.PI, ...kw } = {}) {
    super.__init__({ ...kw, path_arc });
    return this;
  }
}

export class MoveToTarget extends Transform {
  static SIG = ["mobject"];

  __init__({ mobject, ...kw } = {}) {
    if (!("target" in mobject) || mobject.target === undefined) {
      throw new Error("MoveToTarget called on mobjectwithout attribute 'target'");
    }
    super.__init__({ ...kw, mobject, target_mobject: mobject.target });
    return this;
  }
}

/** What mobject.animate builds: a MoveToTarget that applies the methods to the object again when it finishes. */
export class MethodAnimation extends MoveToTarget {
  static SIG = ["mobject", "methods"];

  __init__({ mobject, methods = [], ...kw } = {}) {
    this.methods = methods;
    super.__init__({ ...kw, mobject });
    return this;
  }

  finish() {
    for (const item of this.methods) item.apply(this.mobject);
    super.finish();
  }
}
builders.MethodAnimation = MethodAnimation;

/** ApplyMethod(mobject.method, *args): `method` is [mobject, name]; a last dict argument holds keyword arguments. */
export class ApplyMethod extends Transform {
  static SIG = ["method", "*method_args"];

  __init__({ method, method_args = [], ...kw } = {}) {
    if (!Array.isArray(method) || !(method[0] instanceof Mobject)) {
      throw new Error("Whoops, looks like you accidentally invoked the method you want to animate");
    }
    this.method = method;
    this.method_args = method_args;
    super.__init__({ ...kw, mobject: method[0] });
    return this;
  }

  create_target() {
    const [owner, name] = this.method;
    const args = [...this.method_args];
    const last = args[args.length - 1];
    const kwargs = args.length > 0 && last !== null && typeof last === "object" && !Array.isArray(last)
      && !(last instanceof Mobject) ? args.pop() : {};
    const target = owner.copy();
    callMethod(target, name, args, kwargs);
    return target;
  }
}

export class ApplyPointwiseFunction extends ApplyMethod {
  static SIG = ["function", "mobject", "run_time"];

  __init__({ function: fn, mobject, run_time = DEFAULT_POINTWISE_FUNCTION_RUN_TIME, ...kw } = {}) {
    super.__init__({ ...kw, method: [mobject, "apply_function"], method_args: [fn], run_time });
    return this;
  }
}

export class FadeToColor extends ApplyMethod {
  static SIG = ["mobject", "color"];

  __init__({ mobject, color, ...kw } = {}) {
    super.__init__({ ...kw, method: [mobject, "set_color"], method_args: [color] });
    return this;
  }
}

export class ScaleInPlace extends ApplyMethod {
  static SIG = ["mobject", "scale_factor"];

  __init__({ mobject, scale_factor, ...kw } = {}) {
    super.__init__({ ...kw, method: [mobject, "scale"], method_args: [scale_factor] });
    return this;
  }
}

export class ShrinkToCenter extends ScaleInPlace {
  static SIG = ["mobject"];

  __init__({ mobject, ...kw } = {}) {
    super.__init__({ ...kw, mobject, scale_factor: 0 });
    return this;
  }
}

export class Restore extends ApplyMethod {
  static SIG = ["mobject"];

  __init__({ mobject, ...kw } = {}) {
    super.__init__({ ...kw, method: [mobject, "restore"] });
    return this;
  }
}

export class ApplyFunction extends Transform {
  static SIG = ["function", "mobject"];

  __init__({ function: fn, mobject, ...kw } = {}) {
    this.function = fn;
    super.__init__({ ...kw, mobject });
    return this;
  }

  create_target() {
    const target = this.function(this.mobject.copy());
    if (!(target instanceof Mobject)) throw new TypeError("Functions passed to ApplyFunction must return object of type Mobject");
    return target;
  }
}

/** A 2x2 or 3x3 matrix as 3x3. */
export function initializeMatrix(matrix) {
  const m = matrix.map((row) => row.map(Number));
  if (m.length === 2 && m.every((r) => r.length === 2)) return [[m[0][0], m[0][1], 0], [m[1][0], m[1][1], 0], [0, 0, 1]];
  if (m.length !== 3 || m.some((r) => r.length !== 3)) throw new Error("Matrix has bad dimensions");
  return m;
}

export class ApplyMatrix extends ApplyPointwiseFunction {
  static SIG = ["matrix", "mobject", "about_point"];

  __init__({ matrix, mobject, about_point = ORIGIN, ...kw } = {}) {
    const m = initializeMatrix(matrix);
    const a = about_point;
    const func = (p) => {
      const q = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      return [
        q[0] * m[0][0] + q[1] * m[0][1] + q[2] * m[0][2] + a[0],
        q[0] * m[1][0] + q[1] * m[1][1] + q[2] * m[1][2] + a[1],
        q[0] * m[2][0] + q[1] * m[2][1] + q[2] * m[2][2] + a[2],
      ];
    };
    super.__init__({ ...kw, function: func, mobject });
    return this;
  }
}

export class CyclicReplace extends Transform {
  static SIG = ["*mobjects"];

  __init__({ mobjects = [], path_arc = 90 * DEGREES, ...kw } = {}) {
    if (mobjects.length === 1 && (mobjects[0] instanceof Group || mobjects[0] instanceof VGroup)) this.group = mobjects[0];
    else this.group = Group.make({ mobjects });
    super.__init__({ ...kw, mobject: this.group, path_arc });
    return this;
  }

  create_target() {
    const target = this.group.copy();
    const subs = target.submobjects;
    const cycled = [subs[subs.length - 1], ...subs.slice(0, -1)];
    cycled.forEach((m1, i) => m1.move_to(this.group.submobjects[i]));
    return target;
  }
}

export class Swap extends CyclicReplace {}

export class FadeTransform extends Transform {
  static SIG = ["mobject", "target_mobject", "stretch", "dim_to_match"];

  __init__({ mobject, target_mobject, stretch = true, dim_to_match = 1, ...kw } = {}) {
    this.to_add_on_completion = target_mobject;
    this.stretch = stretch;
    this.dim_to_match = dim_to_match;
    mobject.save_state();
    const group = Group.make({ mobjects: [mobject, target_mobject.copy()] });
    super.__init__({ ...kw, mobject: group });
    return this;
  }

  begin() {
    this.ending_mobject = this.mobject.copy();
    Animation.prototype.begin.call(this);
    const start = this.starting_mobject;
    const end = this.ending_mobject;
    for (const [m0, m1] of [[start.submobjects[1], start.submobjects[0]], [end.submobjects[0], end.submobjects[1]]]) {
      this.ghost_to(m0, m1);
    }
  }

  ghost_to(source, target) {
    if (target.get_num_points() || target.submobjects.length) {
      source.replace(target, this.dim_to_match, this.stretch);
    }
    source.set_opacity(0);
  }

  get_all_mobjects() {
    return [this.mobject, this.starting_mobject, this.ending_mobject];
  }

  get_all_families_zipped() {
    return Animation.prototype.get_all_families_zipped.call(this);
  }

  clean_up_from_scene(scene) {
    Animation.prototype.clean_up_from_scene.call(this, scene);
    scene.remove(this.mobject);
    this.mobject.submobjects[0].restore();
    scene.add(this.to_add_on_completion);
  }
}

export class FadeTransformPieces extends FadeTransform {
  begin() {
    this.mobject.submobjects[0].align_submobjects(this.mobject.submobjects[1]);
    super.begin();
  }

  ghost_to(source, target) {
    zipLists([source.get_family(), target.get_family()], true).forEach(([sm0, sm1]) => super.ghost_to(sm0, sm1));
  }
}
