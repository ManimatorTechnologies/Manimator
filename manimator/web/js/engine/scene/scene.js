// Scene: a port of manim/scene/scene.py with the Cairo renderer's play and drawing logic
// (manim/renderer/cairo_renderer.py), so what is drawn during and after each play is what Manim draws.
//
// Python's Scene.play runs the whole animation, frame by frame. Here play() only starts it (compile, begin, the
// static/moving split); the timeline then moves it with update_to_time(t) and ends it with finish_play(), so any
// moment of it can be drawn.
//
// What Manim draws (CairoRenderer.update_frame): during a play, the "static" objects (those before the first moving
// one) as a still picture, then the moving ones on top (or everything again when nothing moves); otherwise every
// object. Each Wait's empty placeholder object is added to the scene, as Manim does.

import { config } from "../manim/config.js";
import { listUpdate, removeListRedundancies } from "../manim/mobject.js";
import { Camera } from "../render/canvas.js";
import { prepareAnimation, Wait } from "../anim/animation.js";
import { AnimationGroup } from "../anim/composition.js";

/** utils/family.extract_mobject_family_members */
export function extractMobjectFamilyMembers(mobjects, useZIndex = false, onlyThoseWithPoints = false) {
  const all = removeListRedundancies(mobjects.flatMap((m) => (onlyThoseWithPoints ? m.family_members_with_points() : m.get_family())));
  if (!useZIndex) return all;
  return all.map((m, i) => [m, i]).sort((a, b) => a[0].z_index - b[0].z_index || a[1] - b[1]).map(([m]) => m);
}

/** iterables.list_difference_update */
const listDifference = (l1, l2) => {
  const drop = new Set(l2);
  return l1.filter((e) => !drop.has(e));
};

/** parameter_parsing.flatten_iterable_parameters */
const flatten = (items) => items.flatMap((x) => (Array.isArray(x) ? x : [x]));

/** Scene methods a plan calls: [Python parameters, (scene, args by name, other keyword args) -> result].
 *  "*name" takes the rest of the positional arguments. Scene kinds extend this (static METHODS). */
export const SCENE_METHODS = {
  play: [["*args"], (s, a, kw) => s.play(a.args, kw)],
  wait: [["duration", "stop_condition", "frozen_frame"], (s, a) => s.wait(a.duration ?? 1.0, a.stop_condition ?? null, a.frozen_frame ?? null)],
  pause: [["duration"], (s, a) => s.pause(a.duration ?? 1.0)],
  add: [["*mobjects"], (s, a) => s.add(...a.mobjects)],
  remove: [["*mobjects"], (s, a) => s.remove(...a.mobjects)],
  add_foreground_mobject: [["mobject"], (s, a) => s.add_foreground_mobject(a.mobject)],
  add_foreground_mobjects: [["*mobjects"], (s, a) => s.add_foreground_mobjects(...a.mobjects)],
  remove_foreground_mobject: [["mobject"], (s, a) => s.remove_foreground_mobject(a.mobject)],
  remove_foreground_mobjects: [["*mobjects"], (s, a) => s.remove_foreground_mobjects(...a.mobjects)],
  bring_to_front: [["*mobjects"], (s, a) => s.bring_to_front(...a.mobjects)],
  bring_to_back: [["*mobjects"], (s, a) => s.bring_to_back(...a.mobjects)],
  clear: [[], (s) => s.clear()],
};

export class Scene {
  static METHODS = SCENE_METHODS;

  constructor({ camera = null } = {}) {
    this.camera = camera ?? this.make_camera();
    this.always_update_mobjects = false;
    this.animations = null;
    this.stop_condition = null;
    this.moving_mobjects = [];
    this.static_mobjects = [];
    this.duration = 0.0;
    this.last_t = 0.0;
    this.updaters = [];
    this.mobjects = [];
    this.foreground_mobjects = [];
    this.time = 0.0; // the renderer's time: the length of the plays so far
    this.num_plays = 0;
    this.playing = null; // the play in progress: { frozen, static: [...] | null }
  }

  make_camera() {
    return new Camera();
  }

  setup() {}

  // ------------------------------------------------------------------------------------------ the scene's objects

  update_mobjects(dt) {
    for (const mob of this.mobjects) mob.update(dt);
  }

  update_self(dt) {
    for (const func of this.updaters) func(dt);
  }

  should_update_mobjects() {
    const wait = this.animations[0];
    if (wait.is_static_wait === null || wait.is_static_wait === undefined) {
      const shouldUpdate = this.always_update_mobjects || this.updaters.length > 0 || wait.stop_condition !== null
        || this.get_mobject_family_members().some((m) => m.has_time_based_updater());
      wait.is_static_wait = !shouldUpdate;
    }
    return !wait.is_static_wait;
  }

  get_top_level_mobjects() {
    const families = this.mobjects.map((m) => m.get_family());
    return this.mobjects.filter((mob) => families.filter((f) => f.includes(mob)).length === 1);
  }

  get_mobject_family_members() {
    return extractMobjectFamilyMembers(this.mobjects, this.camera.use_z_index);
  }

  add(...mobjects) {
    const newAndForeground = [...mobjects, ...this.foreground_mobjects];
    this.restructure_mobjects(newAndForeground);
    this.mobjects.push(...newAndForeground);
    if (this.moving_mobjects.length) {
      this.restructure_mobjects(newAndForeground, "moving_mobjects");
      this.moving_mobjects.push(...newAndForeground);
    }
    return this;
  }

  add_mobjects_from_animations(animations) {
    const current = new Set(this.get_mobject_family_members());
    for (const animation of animations) {
      if (animation.is_introducer()) continue;
      const mob = animation.mobject;
      if (mob !== null && mob !== undefined && !current.has(mob)) {
        this.add(mob);
        for (const m of mob.get_family()) current.add(m);
      }
    }
  }

  remove(...mobjects) {
    for (const listName of ["mobjects", "foreground_mobjects"]) this.restructure_mobjects(mobjects, listName, false);
    return this;
  }

  replace(oldMobject, newMobject) {
    if (!oldMobject || !newMobject) throw new Error("Specified mobjects cannot be None");
    const replaceInList = (list, oldM, newM) => {
      const at = list.indexOf(newM);
      if (at >= 0) {
        if (oldM === newM) return true;
        list.splice(at, 1);
      }
      for (let i = 0; i < list.length; i += 1) {
        if (list[i] === oldM) {
          list[i] = newM;
          return true;
        }
      }
      return list.some((mob) => replaceInList(mob.submobjects, oldM, newM));
    };
    const replaced = replaceInList(this.mobjects, oldMobject, newMobject)
      || replaceInList(this.foreground_mobjects, oldMobject, newMobject);
    if (!replaced) throw new Error(`Could not find ${oldMobject.constructor.name} in scene`);
  }

  add_updater(func) {
    this.updaters.push(func);
  }

  remove_updater(func) {
    this.updaters = this.updaters.filter((f) => f !== func);
  }

  restructure_mobjects(toRemove, listName = "mobjects", extractFamilies = true) {
    const remove = extractFamilies ? extractMobjectFamilyMembers(toRemove, this.camera.use_z_index) : toRemove;
    this[listName] = this.get_restructured_mobject_list(this[listName], remove);
    return this;
  }

  get_restructured_mobject_list(mobjects, toRemove) {
    const out = [];
    const addSafe = (list, setToRemove) => {
      for (const mob of list) {
        if (setToRemove.has(mob)) continue;
        const intersect = new Set(mob.get_family().filter((m) => setToRemove.has(m)));
        if (intersect.size) addSafe(mob.submobjects, intersect);
        else out.push(mob);
      }
    };
    addSafe(mobjects, new Set(toRemove));
    return out;
  }

  add_foreground_mobjects(...mobjects) {
    this.foreground_mobjects = listUpdate(this.foreground_mobjects, mobjects);
    this.add(...mobjects);
    return this;
  }

  add_foreground_mobject(mobject) {
    return this.add_foreground_mobjects(mobject);
  }

  remove_foreground_mobjects(...toRemove) {
    this.restructure_mobjects(toRemove, "foreground_mobjects");
    return this;
  }

  remove_foreground_mobject(mobject) {
    return this.remove_foreground_mobjects(mobject);
  }

  bring_to_front(...mobjects) {
    this.add(...mobjects);
    return this;
  }

  bring_to_back(...mobjects) {
    this.remove(...mobjects);
    this.mobjects = [...mobjects, ...this.mobjects];
    return this;
  }

  clear() {
    this.mobjects = [];
    this.foreground_mobjects = [];
    return this;
  }

  // ------------------------------------------------------------------------------------------ playing

  get_moving_mobjects(...animations) {
    const collect = (anims) => anims.flatMap((anim) => [
      ...anim.mobject.get_family(),
      ...(anim instanceof AnimationGroup ? collect(anim.animations) : []),
    ]);
    const animationMobjects = new Set(collect(animations));
    const foreground = new Set(this.foreground_mobjects);
    const mobjects = this.get_mobject_family_members();
    for (let i = 0; i < mobjects.length; i += 1) {
      const mob = mobjects[i];
      if (animationMobjects.has(mob) || mob.get_family_updaters().length > 0 || foreground.has(mob)) return mobjects.slice(i);
    }
    return [];
  }

  get_moving_and_static_mobjects(animations) {
    const all = listUpdate(this.mobjects, this.foreground_mobjects);
    const allFamilies = extractMobjectFamilyMembers(all, this.camera.use_z_index, true);
    const moving = this.get_moving_mobjects(...animations);
    const movingFamilies = extractMobjectFamilyMembers(moving, this.camera.use_z_index);
    return [movingFamilies, listDifference(allFamilies, movingFamilies)];
  }

  compile_animations(args, kwargs = {}) {
    const animations = flatten(args).map((arg) => {
      try {
        return prepareAnimation(arg);
      } catch {
        throw new TypeError(`Unexpected argument ${arg?.constructor?.name ?? arg} passed to Scene.play().`);
      }
    });
    for (const animation of animations) {
      for (const [k, v] of Object.entries(kwargs)) animation[k] = v;
    }
    return animations;
  }

  static validate_run_time(runTime, method, parameterName = "run_time") {
    if (runTime <= 0) {
      throw new Error(`Scene.${method}() has a ${parameterName} of ${runTime} <= 0 seconds which Manim cannot render. `
        + `The ${parameterName} must be a positive number.`);
    }
    const secondsPerFrame = 1 / config.frame_rate;
    return runTime < secondsPerFrame ? secondsPerFrame : runTime;
  }

  get_run_time(animations) {
    const runTime = Math.max(...animations.map((a) => a.run_time));
    return Scene.validate_run_time(runTime, "play", "total run_time");
  }

  /** Starts playing `args` (animations, or `.animate` builders); `kwargs` are set on each (run_time, rate_func). */
  play(args, kwargs = {}) {
    if (this.playing) throw new Error("A play is already in progress");
    this.compile_animation_data(args, kwargs);
    this.begin_animations();
    // save_static_frame_data: the static objects as they are now
    this.playing = { frozen: this.is_current_animation_frozen_frame(), static: this.static_mobjects.length ? [...this.static_mobjects] : null };
  }

  wait(duration = 1.0, stopCondition = null, frozenFrame = null) {
    const d = Scene.validate_run_time(duration, "wait", "duration");
    this.play([Wait.make({ run_time: d, stop_condition: stopCondition, frozen_frame: frozenFrame })]);
  }

  pause(duration = 1.0) {
    this.wait(Scene.validate_run_time(duration, "pause", "duration"), null, true);
  }

  /** In a scene method that is a generator: plays, and goes on once the play has finished. */
  *play_steps(args, kwargs = {}) {
    this.play(args, kwargs);
    yield;
  }

  /** In a scene method that is a generator: self.wait(duration). */
  *wait_steps(duration = 1.0) {
    this.wait(duration);
    yield;
  }

  compile_animation_data(args, kwargs = {}) {
    if (!flatten(args).length) throw new Error("Called Scene.play with no animations");
    this.animations = this.compile_animations(args, kwargs);
    this.add_mobjects_from_animations(this.animations);
    this.last_t = 0;
    this.stop_condition = null;
    this.moving_mobjects = [];
    this.static_mobjects = [];
    this.duration = this.get_run_time(this.animations);
    if (this.animations.length === 1 && this.animations[0] instanceof Wait) {
      if (this.should_update_mobjects()) {
        this.update_mobjects(0);
        this.stop_condition = this.animations[0].stop_condition;
      } else {
        this.animations[0].is_static_wait = true;
        return null;
      }
    }
    return this;
  }

  begin_animations() {
    for (const animation of this.animations) {
      animation._setup_scene(this);
      animation.begin();
    }
    [this.moving_mobjects, this.static_mobjects] = this.get_moving_and_static_mobjects(this.animations);
  }

  is_current_animation_frozen_frame() {
    return this.animations.length === 1 && this.animations[0] instanceof Wait && this.animations[0].is_static_wait === true;
  }

  update_to_time(t) {
    if (!this.playing || this.playing.frozen) return;
    const dt = t - this.last_t;
    this.last_t = t;
    for (const animation of this.animations) {
      animation.update_mobjects(dt);
      animation.interpolate(t / animation.run_time);
    }
    this.update_mobjects(dt);
    this.update_self(dt);
  }

  /** Ends the play in progress, as the end of Scene.play_internal (a still Wait just ends). */
  finish_play() {
    if (!this.playing) return;
    if (!this.playing.frozen) {
      for (const animation of this.animations) {
        animation.finish();
        animation.clean_up_from_scene(this);
      }
      this.update_mobjects(0);
    }
    this.time += this.duration;
    this.num_plays += 1;
    this.playing = null;
    this.animations = null; // (Python keeps them; nothing reads them afterwards)
  }

  // ------------------------------------------------------------------------------------------ drawing

  /** What CairoRenderer.update_frame draws now: [still objects or null, objects drawn over them]. */
  frame_layers() {
    const everything = () => listUpdate(this.mobjects, this.foreground_mobjects);
    if (!this.playing) return [null, everything()];
    return [this.playing.static, this.moving_mobjects.length ? this.moving_mobjects : everything()];
  }

  /** Draws the scene as it is now onto a 2D context of the camera's pixel size. */
  render(ctx) {
    const [still, over] = this.frame_layers();
    this.camera.reset(ctx);
    if (still) this.camera.capture_mobjects(ctx, still);
    this.camera.capture_mobjects(ctx, over);
  }
}
