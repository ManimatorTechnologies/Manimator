// Animation, Wait, Add and Mobject.animate: a port of manim/animation/animation.py and the _AnimationBuilder of
// manim/mobject/mobject.py.
//
// Animations follow the object model's conventions (manim/mobject.js): `Create.make({mobject})` is Python's
// `Create(mobject)`, `static SIG` names the positional parameters, and attributes keep Manim's names, because
// Scene.play sets them by name (run_time, rate_func, ...).

import { linear, smooth } from "../core/rates.js";
import { Group, Mobject } from "../manim/mobject.js";
import { callMethod } from "../manim/pymethods.js";

export const DEFAULT_ANIMATION_RUN_TIME = 1.0;
export const DEFAULT_ANIMATION_LAG_RATIO = 0.0;

/** zip(*lists): stops at the shortest, like Python's zip (or throws, like strict=True). */
export function zipLists(lists, strict = false) {
  const n = Math.min(...lists.map((l) => l.length));
  if (strict && lists.some((l) => l.length !== n)) throw new Error("zip() arguments have different lengths");
  return Array.from({ length: n }, (_, i) => lists.map((l) => l[i]));
}

export class Animation {
  static SIG = ["mobject", "lag_ratio", "run_time", "rate_func", "reverse_rate_function", "name", "remover",
    "suspend_mobject_updating", "introducer"];

  /** Python's `Cls(**kwargs)` */
  static make(kw = {}) {
    return new this().__init__(kw);
  }

  __init__({ mobject = null, lag_ratio = DEFAULT_ANIMATION_LAG_RATIO, run_time = DEFAULT_ANIMATION_RUN_TIME,
    rate_func = smooth, reverse_rate_function = false, name = null, remover = false, suspend_mobject_updating = true,
    introducer = false, _on_finish = () => {}, use_override = true } = {}) { // eslint-disable-line no-unused-vars
    this._typecheck_input(mobject);
    this.run_time = run_time;
    this.rate_func = rate_func;
    this.reverse_rate_function = reverse_rate_function;
    this.name = name;
    this.remover = remover;
    this.introducer = introducer;
    this.suspend_mobject_updating = suspend_mobject_updating;
    this.lag_ratio = lag_ratio;
    this._on_finish = _on_finish;
    this.starting_mobject = Mobject.make();
    this.mobject = mobject ?? Mobject.make();
    return this;
  }

  get run_time() {
    return this._run_time;
  }

  set run_time(value) {
    if (value < 0) {
      throw new Error(`The run_time of ${this.constructor.name} cannot be negative. The given value was ${value}.`);
    }
    this._run_time = value;
  }

  _typecheck_input(mobject) {
    if (mobject !== null && mobject !== undefined && !(mobject instanceof Mobject)) {
      throw new TypeError("Animation only works on Mobjects");
    }
  }

  toString() {
    return this.name || `${this.constructor.name}(${this.mobject?.constructor?.name})`;
  }

  begin() {
    this.starting_mobject = this.create_starting_mobject();
    if (this.suspend_mobject_updating) this.mobject.suspend_updating();
    this.interpolate(0);
  }

  finish() {
    this.interpolate(1);
    if (this.suspend_mobject_updating && this.mobject !== null) this.mobject.resume_updating();
  }

  clean_up_from_scene(scene) {
    this._on_finish(scene);
    if (this.is_remover()) scene.remove(this.mobject);
  }

  _setup_scene(scene) {
    if (scene === null || scene === undefined) return;
    if (this.is_introducer() && !scene.get_mobject_family_members().includes(this.mobject)) scene.add(this.mobject);
  }

  create_starting_mobject() {
    return this.mobject.copy();
  }

  get_all_mobjects() {
    return [this.mobject, this.starting_mobject];
  }

  get_all_families_zipped() {
    return zipLists(this.get_all_mobjects().map((m) => m.family_members_with_points()));
  }

  update_mobjects(dt) {
    for (const mob of this.get_all_mobjects_to_update()) mob.update(dt);
  }

  get_all_mobjects_to_update() {
    return this.get_all_mobjects().filter((m) => m !== this.mobject);
  }

  interpolate(alpha) {
    this.interpolate_mobject(alpha);
  }

  interpolate_mobject(alpha) {
    const families = this.get_all_families_zipped();
    families.forEach((mobs, i) => {
      const subAlpha = this.get_sub_alpha(alpha, i, families.length);
      this.interpolate_submobject(...mobs, subAlpha);
    });
  }

  interpolate_submobject() {}

  get_sub_alpha(alpha, index, numSubmobjects) {
    const lagRatio = this.lag_ratio;
    const fullLength = (numSubmobjects - 1) * lagRatio + 1;
    const value = alpha * fullLength;
    const lower = index * lagRatio;
    if (this.reverse_rate_function) return this.rate_func(1 - (value - lower));
    return this.rate_func(value - lower);
  }

  set_run_time(runTime) {
    this.run_time = runTime;
    return this;
  }

  get_run_time() {
    return this.run_time;
  }

  set_rate_func(rateFunc) {
    this.rate_func = rateFunc;
    return this;
  }

  get_rate_func() {
    return this.rate_func;
  }

  is_remover() {
    return this.remover;
  }

  is_introducer() {
    return this.introducer;
  }
}

/** Scene.play's argument as an animation: an `.animate` builder is built. */
export function prepareAnimation(anim) {
  if (anim instanceof AnimationBuilder) return anim.build();
  if (anim instanceof Animation) return anim;
  throw new TypeError(`Object ${anim} cannot be converted to an animation`);
}

export class Wait extends Animation {
  static SIG = ["run_time", "stop_condition", "frozen_frame", "rate_func"];

  __init__({ run_time = 1, stop_condition = null, frozen_frame = null, rate_func = linear, ...kw } = {}) {
    if (stop_condition && frozen_frame) throw new Error("A static Wait animation cannot have a stop condition.");
    this.duration = run_time;
    this.stop_condition = stop_condition;
    this.is_static_wait = frozen_frame;
    super.__init__({ ...kw, mobject: null, run_time, rate_func });
    return this;
  }

  begin() {}

  finish() {}

  clean_up_from_scene() {}

  update_mobjects() {}

  interpolate() {}
}

export class Add extends Animation {
  static SIG = ["*mobjects"];

  __init__({ mobjects = [], run_time = 0.0, ...kw } = {}) {
    const mobject = mobjects.length === 1 ? mobjects[0] : Group.make({ mobjects });
    super.__init__({ ...kw, mobject, run_time, introducer: true });
    return this;
  }

  begin() {}

  finish() {}

  clean_up_from_scene() {}

  update_mobjects() {}

  interpolate() {}
}

/** A method call recorded by `.animate`, replayed on the mobject when the animation finishes. */
export class MethodWithArgs {
  constructor(name, args = [], kwargs = {}) {
    this.name = name;
    this.args = args;
    this.kwargs = kwargs;
  }

  apply(mobject) {
    return callMethod(mobject, this.name, this.args, this.kwargs);
  }
}

/** mobject.animate: each method call is applied to the target now and recorded; build() makes the animation. */
export class AnimationBuilder {
  constructor(mobject) {
    this.mobject = mobject;
    this.mobject.generate_target();
    this.overridden_animation = null;
    this.is_chaining = false;
    this.methods = [];
    this.cannot_pass_args = false;
    this.anim_args = {};
  }

  /** mobject.animate(**kwargs) */
  withArgs(kwargs = {}) {
    if (this.cannot_pass_args) {
      throw new Error("Animation arguments must be passed before accessing methods and can only be passed once");
    }
    this.anim_args = kwargs;
    this.cannot_pass_args = true;
    return this;
  }

  /** mobject.animate.<name>(*args, **kwargs) */
  call(name, args = [], kwargs = {}) {
    this.is_chaining = true;
    this.cannot_pass_args = true;
    this.methods.push(new MethodWithArgs(name, args, kwargs));
    callMethod(this.mobject.target, name, args, kwargs);
    return this;
  }

  build() {
    // eslint-disable-next-line no-use-before-define
    const anim = this.overridden_animation ?? builders.MethodAnimation.make({ mobject: this.mobject, methods: this.methods });
    for (const [attr, value] of Object.entries(this.anim_args)) anim[attr] = value;
    return anim;
  }
}

/** Classes AnimationBuilder needs from other modules (set by them, avoiding an import cycle). */
export const builders = { MethodAnimation: null };
