// AnimationGroup, Succession, LaggedStart, LaggedStartMap: a port of manim/animation/composition.py.

import { linear } from "../core/rates.js";
import { Group, removeListRedundancies } from "../manim/mobject.js";
import { Animation, prepareAnimation } from "./animation.js";

export const DEFAULT_LAGGED_START_LAG_RATIO = 0.05;

/** parameter_parsing.flatten_iterable_parameters: lists of animations are spread. */
const flatten = (items) => items.flatMap((x) => (Array.isArray(x) ? x : [x]));

export class AnimationGroup extends Animation {
  static SIG = ["*animations"];

  __init__({ animations = [], group = null, run_time = null, rate_func = linear, lag_ratio = 0, ...kw } = {}) {
    this.animations = flatten(animations).map(prepareAnimation);
    this.rate_func = rate_func;
    if (group === null) {
      const mobjects = removeListRedundancies(this.animations.filter((a) => !a.is_introducer()).map((a) => a.mobject));
      this.group = Group.make({ mobjects });
    } else {
      this.group = group;
    }
    super.__init__({ ...kw, mobject: this.group, rate_func: this.rate_func, lag_ratio });
    this.run_time = this.init_run_time(run_time);
    return this;
  }

  get_all_mobjects() {
    return [...this.group.submobjects];
  }

  begin() {
    if (!this.animations.length) {
      throw new Error(`Trying to play ${this} without animations, this is not supported. Please add at least one subanimation.`);
    }
    this.anim_group_time = 0.0;
    if (this.suspend_mobject_updating) this.group.suspend_updating();
    for (const anim of this.animations) anim.begin();
  }

  _setup_scene(scene) {
    for (const anim of this.animations) anim._setup_scene(scene);
  }

  finish() {
    for (const anim of this.animations) anim.finish();
    this.anims_begun.fill(true);
    this.anims_finished.fill(true);
    if (this.suspend_mobject_updating) this.group.resume_updating();
  }

  clean_up_from_scene(scene) {
    this._on_finish(scene);
    for (const anim of this.animations) {
      if (this.remover) anim.remover = this.remover;
      anim.clean_up_from_scene(scene);
    }
  }

  update_mobjects(dt) {
    this.timings.forEach((t, i) => {
      if (this.anims_begun[i] && !this.anims_finished[i]) t.anim.update_mobjects(dt);
    });
  }

  init_run_time(runTime) {
    this.build_animations_with_timings();
    this.max_end_time = this.timings.length ? Math.max(...this.timings.map((t) => t.end)) : 0;
    return runTime === null || runTime === undefined ? this.max_end_time : runTime;
  }

  build_animations_with_timings() {
    const runTimes = this.animations.map((a) => a.run_time);
    this.timings = [];
    this.anims_begun = new Array(runTimes.length).fill(false);
    this.anims_finished = new Array(runTimes.length).fill(false);
    let start = 0;
    this.animations.forEach((anim, i) => {
      // np.add.accumulate of run_times[:-1] * lag_ratio
      if (i > 0) start += runTimes[i - 1] * this.lag_ratio;
      this.timings.push({ anim, start, end: start + runTimes[i] });
    });
  }

  interpolate(alpha) {
    const time = this.rate_func(alpha) * this.max_end_time;
    const goesBack = time < this.anim_group_time;
    const newBegun = this.timings.map((t) => time >= t.start);
    const newFinished = this.timings.map((t) => time > t.end);
    this.timings.forEach((t, i) => {
      if (!((this.anims_begun[i] || newBegun[i]) && (!this.anims_finished[i] || !newFinished[i]))) return;
      let runTime = t.end - t.start;
      const zero = runTime === 0;
      if (zero) runTime = 1;
      let sub = (time - t.start) / runTime;
      if (goesBack) {
        if (sub < 0 || zero) sub = 0;
      } else if (sub > 1 || zero) {
        sub = 1;
      }
      t.anim.interpolate(sub);
    });
    this.anim_group_time = time;
    this.anims_begun = newBegun;
    this.anims_finished = newFinished;
  }
}

export class Succession extends AnimationGroup {
  __init__({ lag_ratio = 1, ...kw } = {}) {
    super.__init__({ ...kw, lag_ratio });
    return this;
  }

  begin() {
    if (!this.animations.length) {
      throw new Error(`Trying to play ${this} without animations, this is not supported. Please add at least one subanimation.`);
    }
    this.update_active_animation(0);
  }

  finish() {
    while (this.active_animation !== null) this.next_animation();
  }

  update_mobjects(dt) {
    if (this.active_animation) this.active_animation.update_mobjects(dt);
  }

  _setup_scene(scene) {
    if (scene === null || scene === undefined) return;
    if (this.is_introducer()) {
      for (const anim of this.animations) {
        if (!anim.is_introducer() && anim.mobject !== null) scene.add(anim.mobject);
      }
    }
    this.scene = scene;
  }

  update_active_animation(index) {
    this.active_index = index;
    if (index >= this.animations.length) {
      this.active_animation = null;
      this.active_start_time = null;
      this.active_end_time = null;
    } else {
      this.active_animation = this.animations[index];
      this.active_animation._setup_scene(this.scene);
      this.active_animation.begin();
      this.active_start_time = this.timings[index].start;
      this.active_end_time = this.timings[index].end;
    }
  }

  next_animation() {
    if (this.active_animation !== null) this.active_animation.finish();
    this.update_active_animation(this.active_index + 1);
  }

  interpolate(alpha) {
    const current = this.rate_func(alpha) * this.max_end_time;
    while (this.active_end_time !== null && current >= this.active_end_time) this.next_animation();
    if (this.active_animation !== null && this.active_start_time !== null) {
      const elapsed = current - this.active_start_time;
      const activeRunTime = this.active_animation.run_time;
      this.active_animation.interpolate(activeRunTime !== 0.0 ? elapsed / activeRunTime : 1.0);
    }
  }
}

export class LaggedStart extends AnimationGroup {
  __init__({ lag_ratio = DEFAULT_LAGGED_START_LAG_RATIO, ...kw } = {}) {
    super.__init__({ ...kw, lag_ratio });
    return this;
  }
}

export class LaggedStartMap extends LaggedStart {
  static SIG = ["animation_class", "mobject", "arg_creator", "run_time", "lag_ratio"];

  __init__({ animation_class, mobject, arg_creator = null, run_time = 2, lag_ratio = DEFAULT_LAGGED_START_LAG_RATIO,
    ...kw } = {}) {
    const creator = arg_creator ?? ((mob) => mob);
    const argsList = mobject.iter().map((submob) => creator(submob));
    const animKw = { ...kw };
    delete animKw.lag_ratio;
    const animations = argsList.map((args) => {
      const list = Array.isArray(args) ? args : [args];
      return animation_class.make({ ...animKw, ...Object.fromEntries((animation_class.SIG ?? []).slice(0, list.length).map((n, i) => [n, list[i]])) });
    });
    super.__init__({ animations, run_time, lag_ratio });
    return this;
  }
}
