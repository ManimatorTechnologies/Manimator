// Ports of manim/mobject/svg/brace.py: Brace, BraceLabel, BraceText, BraceBetweenPoints.

import { norm, sub } from "../core/math.js";
import { DEFAULT_FONT_SIZE, DEFAULT_MOBJECT_TO_MOBJECT_BUFFER, DOWN, LEFT, ORIGIN, OUT, RIGHT, UP } from "./frozen.js";
import { Line } from "./geometry.js";
import { pyKwargs } from "./pycall.js";
import { pt3 } from "./mobject.js";
import { VMobjectFromSVGPath, parsePathData } from "./svg.js";
import { MathTex, Tex } from "./tex.js";
import { Text } from "./text.js";
import { BLACK, VMobject } from "./vmobject.js";

const PATH_TEMPLATE = "m0.01216 0c-0.01152 0-0.01216 6.103e-4 -0.01216 0.01311v0.007762c0.06776 "
  + "0.122 0.1799 0.1455 0.2307 0.1455h{0}c0.03046 3.899e-4 0.07964 0.00449 "
  + "0.1246 0.02636 0.0537 0.02695 0.07418 0.05816 0.08648 0.07769 0.001562 "
  + "0.002538 0.004539 0.002563 0.01098 0.002563 0.006444-2e-8 0.009421-2.47e-"
  + "5 0.01098-0.002563 0.0123-0.01953 0.03278-0.05074 0.08648-0.07769 0.04491"
  + "-0.02187 0.09409-0.02597 0.1246-0.02636h{0}c0.05077 0 0.1629-0.02346 "
  + "0.2307-0.1455v-0.007762c-1.78e-6 -0.0125-6.365e-4 -0.01311-0.01216-0.0131"
  + "1-0.006444-3.919e-8 -0.009348 2.448e-5 -0.01091 0.002563-0.0123 0.01953-"
  + "0.03278 0.05074-0.08648 0.07769-0.04491 0.02187-0.09416 0.02597-0.1246 "
  + "0.02636h{1}c-0.04786 0-0.1502 0.02094-0.2185 0.1256-0.06833-0.1046-0.1706"
  + "-0.1256-0.2185-0.1256h{1}c-0.03046-3.899e-4 -0.07972-0.004491-0.1246-0.02"
  + "636-0.0537-0.02695-0.07418-0.05816-0.08648-0.07769-0.001562-0.002538-"
  + "0.004467-0.002563-0.01091-0.002563z";
const DEFAULT_MIN_WIDTH = 0.90552;

/** Python's str() of a float (repr); 0 from max(0, ...) is the int 0. */
const pyNumber = (x) => (x === 0 ? "0" : String(x));

export class Brace extends VMobjectFromSVGPath {
  static SIG = ["mobject", "direction", "buff", "sharpness", "stroke_width", "fill_opacity", "background_stroke_width",
    "background_stroke_color"];

  __init__({ mobject, direction = DOWN, buff = 0.2, sharpness = 2, stroke_width = 0, fill_opacity = 1.0,
    background_stroke_width = 0, background_stroke_color = BLACK, ...kw } = {}) {
    this.buff = buff;
    const dir = pt3(direction);
    const angle = -Math.atan2(dir[0], dir[1]) + Math.PI;
    mobject.rotate(-angle, OUT, { about_point: ORIGIN });
    const left = mobject.get_corner(sub(DOWN, RIGHT));
    const right = mobject.get_corner([1, -1, 0]);
    const targetWidth = right[0] - left[0];
    const linear = Math.max(0, (targetWidth * sharpness - DEFAULT_MIN_WIDTH) / 2);
    const d = PATH_TEMPLATE.replaceAll("{0}", pyNumber(linear)).replaceAll("{1}", pyNumber(-linear));
    super.__init__({ ...kw, path_obj: parsePathData(d), stroke_width, fill_opacity, background_stroke_width,
      background_stroke_color });
    this.flip(RIGHT);
    this.stretch_to_fit_width(targetWidth);
    const corner = this.get_corner([-1, 1, 0]);
    this.shift([left[0] - corner[0] + this.buff * DOWN[0], left[1] - corner[1] + this.buff * DOWN[1],
      left[2] - corner[2] + this.buff * DOWN[2]]);
    for (const mob of [mobject, this]) mob.rotate(angle, OUT, { about_point: ORIGIN });
    return this;
  }

  put_at_tip(mob, { use_next_to = true, ...kw } = {}) {
    if (use_next_to) {
      const d = this.get_direction().map((v) => Math.round(v));
      mob.next_to(this.get_tip(), d, kw.buff ?? DEFAULT_MOBJECT_TO_MOBJECT_BUFFER, kw);
    } else {
      mob.move_to(this.get_tip());
      const buff = kw.buff ?? DEFAULT_MOBJECT_TO_MOBJECT_BUFFER;
      const dist = mob.width / 2.0 + buff;
      mob.shift(this.get_direction().map((v) => v * dist));
    }
    return this;
  }

  get_text(...text) {
    const mob = Tex.make({ tex_strings: text });
    this.put_at_tip(mob);
    return mob;
  }

  get_tex(...tex) {
    const mob = MathTex.make({ tex_strings: tex });
    this.put_at_tip(mob);
    return mob;
  }

  get_tip() {
    return this.points[28];
  }

  get_direction() {
    const v = sub(this.get_tip(), this.get_center());
    const n = norm(v);
    return v.map((x) => x / n);
  }
}

export class BraceLabel extends VMobject {
  static SIG = ["obj", "text", "brace_direction", "label_constructor", "font_size", "buff", "brace_config"];

  __init__({ obj, text, brace_direction = DOWN, label_constructor = MathTex, font_size = DEFAULT_FONT_SIZE, buff = 0.2,
    brace_config = null, ...kw } = {}) {
    this.label_constructor = label_constructor;
    super.__init__(kw);
    this.brace_direction = brace_direction;
    this.brace = Brace.make({ ...(brace_config ?? {}), mobject: obj, direction: brace_direction, buff });
    const make = (args, extra) => label_constructor.make(pyKwargs(label_constructor, args, extra));
    this.label = Array.isArray(text) ? make(text, { ...kw, font_size }) : make([String(text)], { font_size });
    this.brace.put_at_tip(this.label);
    this.add(this.brace, this.label);
    return this;
  }

  shift_brace(obj, kw = {}) {
    const target = Array.isArray(obj) ? this.get_group_class().make({ vmobjects: obj }) : obj;
    this.brace = Brace.make({ ...kw, mobject: target, direction: this.brace_direction });
    this.brace.put_at_tip(this.label);
    return this;
  }

  change_label(...text) {
    this.remove(this.label);
    this.label = this.label_constructor.make(pyKwargs(this.label_constructor, text, {}));
    this.brace.put_at_tip(this.label);
    this.add(this.label);
    return this;
  }
}

export class BraceText extends BraceLabel {
  static SIG = ["obj", "text", "label_constructor"];

  __init__({ label_constructor = Text, ...kw } = {}) {
    return super.__init__({ ...kw, label_constructor });
  }
}

export class BraceBetweenPoints extends Brace {
  static SIG = ["point_1", "point_2", "direction"];

  __init__({ point_1, point_2, direction = ORIGIN, ...kw } = {}) {
    let dir = pt3(direction);
    if (dir.every((v) => v === 0)) {
      const v = sub(pt3(point_2), pt3(point_1));
      dir = [v[1], -v[0], 0];
    }
    return super.__init__({ ...kw, mobject: Line.make({ start: point_1, end: point_2 }), direction: dir });
  }
}

export { LEFT, UP };
