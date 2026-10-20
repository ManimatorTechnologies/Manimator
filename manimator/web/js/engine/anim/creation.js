// Create, Write, DrawBorderThenFill and the letter-by-letter animations: a port of manim/animation/creation.py.

import { integerInterpolate } from "../core/bezier.js";
import { double_smooth, linear } from "../core/rates.js";
import { config } from "../manim/config.js";
import { Group } from "../manim/mobject.js";
import { VMobject } from "../manim/vmobject.js";
import { Animation } from "./animation.js";

export class ShowPartial extends Animation {
  __init__({ mobject = null, ...kw } = {}) {
    if (typeof mobject?.pointwise_become_partial !== "function") {
      throw new TypeError(`${this.constructor.name} only works for VMobjects.`);
    }
    super.__init__({ ...kw, mobject });
    return this;
  }

  interpolate_submobject(submobject, startingSubmobject, alpha) {
    const [a, b] = this._get_bounds(alpha);
    submobject.pointwise_become_partial(startingSubmobject, a, b);
  }

  _get_bounds() {
    throw new Error("Please use Create or ShowPassingFlash");
  }
}

export class Create extends ShowPartial {
  static SIG = ["mobject", "lag_ratio", "introducer"];

  __init__({ mobject, lag_ratio = 1.0, introducer = true, ...kw } = {}) {
    super.__init__({ ...kw, mobject, lag_ratio, introducer });
    return this;
  }

  _get_bounds(alpha) {
    return [0, alpha];
  }
}

export class Uncreate extends Create {
  static SIG = ["mobject", "reverse_rate_function", "remover"];

  __init__({ mobject, reverse_rate_function = true, remover = true, ...kw } = {}) {
    super.__init__({ ...kw, mobject, reverse_rate_function, introducer: false, remover });
    return this;
  }
}

export class DrawBorderThenFill extends Animation {
  static SIG = ["vmobject", "run_time", "rate_func", "stroke_width", "stroke_color", "introducer"];

  __init__({ vmobject, run_time = 2, rate_func = double_smooth, stroke_width = 2, stroke_color = null, introducer = true,
    ...kw } = {}) {
    this._typecheck_input(vmobject);
    super.__init__({ ...kw, mobject: vmobject, run_time, introducer, rate_func });
    this.stroke_width = stroke_width;
    this.stroke_color = stroke_color;
    this.outline = this.get_outline();
    return this;
  }

  _typecheck_input(vmobject) {
    if (!(vmobject instanceof VMobject)) throw new TypeError(`${this.constructor.name} only works for vectorized Mobjects`);
  }

  begin() {
    this.outline = this.get_outline();
    super.begin();
  }

  get_outline() {
    const outline = this.mobject.copy();
    outline.set_fill(null, 0);
    for (const sm of outline.family_members_with_points()) {
      sm.set_stroke(this.get_stroke_color(sm), this.stroke_width);
    }
    return outline;
  }

  get_stroke_color(vmobject) {
    if (this.stroke_color) return this.stroke_color;
    if (vmobject.get_stroke_width() > 0) return vmobject.get_stroke_color();
    return vmobject.get_color();
  }

  get_all_mobjects() {
    return [...super.get_all_mobjects(), this.outline];
  }

  interpolate_submobject(submobject, startingSubmobject, outline, alpha) {
    const [index, subalpha] = integerInterpolate(0, 2, alpha);
    if (index === 0) {
      submobject.pointwise_become_partial(outline, 0, subalpha);
      submobject.match_style(outline);
    } else {
      submobject.interpolate(outline, startingSubmobject, subalpha);
    }
  }
}

export class Write extends DrawBorderThenFill {
  static SIG = ["vmobject", "rate_func", "reverse"];

  __init__({ vmobject, rate_func = linear, reverse = false, ...kw } = {}) {
    const rest = { ...kw };
    const runTime = rest.run_time ?? null;
    const lagRatio = rest.lag_ratio ?? null;
    delete rest.run_time;
    delete rest.lag_ratio;
    const [run_time, lag_ratio] = this._set_default_config_from_length(vmobject, runTime, lagRatio);
    this.reverse = reverse;
    if (!("remover" in rest)) rest.remover = reverse;
    super.__init__({ ...rest, vmobject, rate_func, run_time, lag_ratio, introducer: !reverse });
    return this;
  }

  _set_default_config_from_length(vmobject, runTime, lagRatio) {
    const length = vmobject.family_members_with_points().length;
    return [runTime ?? (length < 15 ? 1 : 2), lagRatio ?? Math.min(4.0 / Math.max(1.0, length), 0.2)];
  }

  reverse_submobjects() {
    this.mobject.invert(true);
  }

  begin() {
    if (this.reverse) this.reverse_submobjects();
    super.begin();
  }

  finish() {
    super.finish();
    if (this.reverse) this.reverse_submobjects();
  }
}

export class Unwrite extends Write {
  static SIG = ["vmobject", "rate_func", "reverse"];

  __init__({ vmobject, rate_func = linear, reverse = true, ...kw } = {}) {
    const rest = { ...kw };
    const [run_time, lag_ratio] = this._set_default_config_from_length(vmobject, rest.run_time ?? null, rest.lag_ratio ?? null);
    delete rest.run_time;
    delete rest.lag_ratio;
    super.__init__({ ...rest, vmobject, rate_func, run_time, lag_ratio, reverse_rate_function: true, reverse });
    return this;
  }
}

export class ShowIncreasingSubsets extends Animation {
  static SIG = ["group", "suspend_mobject_updating", "int_func", "reverse_rate_function"];

  __init__({ group, suspend_mobject_updating = false, int_func = Math.floor, reverse_rate_function = false, ...kw } = {}) {
    this.all_submobs = [...group.submobjects];
    this.int_func = int_func;
    for (const mobj of this.all_submobs) mobj.set_opacity(0);
    super.__init__({ ...kw, mobject: group, suspend_mobject_updating, reverse_rate_function });
    return this;
  }

  interpolate_mobject(alpha) {
    const n = this.all_submobs.length;
    const value = this.reverse_rate_function ? 1 - this.rate_func(alpha) : this.rate_func(alpha);
    this.update_submobject_list(Math.trunc(this.int_func(value * n)));
  }

  update_submobject_list(index) {
    // Python slices: a negative index counts from the end
    const i = index < 0 ? Math.max(0, this.all_submobs.length + index) : index;
    for (const mobj of this.all_submobs.slice(0, i)) mobj.set_opacity(1);
    for (const mobj of this.all_submobs.slice(i)) mobj.set_opacity(0);
  }
}

export class AddTextLetterByLetter extends ShowIncreasingSubsets {
  static SIG = ["text", "suspend_mobject_updating", "int_func", "rate_func", "time_per_char", "run_time",
    "reverse_rate_function", "introducer"];

  __init__({ text, suspend_mobject_updating = false, int_func = Math.ceil, rate_func = linear, time_per_char = 0.1,
    run_time = null, reverse_rate_function = false, introducer = true, ...kw } = {}) {
    this.time_per_char = time_per_char;
    if (!text.family_members_with_points().length) {
      throw new Error(`The text mobject ${text.constructor.name} does not seem to contain any characters.`);
    }
    const rt = run_time ?? Math.max(1 / config.frame_rate, this.time_per_char) * text.__len__();
    super.__init__({ ...kw, group: text, suspend_mobject_updating, int_func, rate_func, run_time: rt,
      reverse_rate_function, introducer });
    return this;
  }
}

export class RemoveTextLetterByLetter extends AddTextLetterByLetter {
  __init__({ reverse_rate_function = true, introducer = false, remover = true, ...kw } = {}) {
    super.__init__({ ...kw, reverse_rate_function, introducer, remover });
    return this;
  }
}

export class ShowSubmobjectsOneByOne extends ShowIncreasingSubsets {
  static SIG = ["group", "int_func"];

  __init__({ group, int_func = Math.ceil, ...kw } = {}) {
    super.__init__({ ...kw, group: Group.make({ mobjects: [...group] }), int_func });
    return this;
  }

  update_submobject_list(index) {
    const current = this.all_submobs.slice(0, index);
    for (const mobj of current.slice(0, -1)) mobj.set_opacity(0);
    if (current.length > 0) current[current.length - 1].set_opacity(1);
  }
}
