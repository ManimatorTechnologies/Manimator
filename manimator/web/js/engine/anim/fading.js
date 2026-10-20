// FadeIn, FadeOut, the Grow* animations and SpinInFromNothing: ports of manim/animation/fading.py and growing.py.

import { spiralPath } from "../core/paths.js";
import { ORIGIN, PI } from "../manim/frozen.js";
import { Group, Mobject } from "../manim/mobject.js";
import { Transform } from "./transform.js";

class Fade extends Transform {
  static SIG = ["*mobjects"];

  __init__({ mobjects = [], shift = null, target_position = null, scale = 1, ...kw } = {}) {
    if (!mobjects.length) throw new Error("At least one mobject must be passed.");
    const mobject = mobjects.length === 1 ? mobjects[0] : Group.make({ mobjects });
    this.point_target = false;
    let vector = shift;
    if (vector === null) {
      if (target_position !== null) {
        const target = target_position instanceof Mobject ? target_position.get_center() : target_position;
        const c = mobject.get_center();
        vector = [target[0] - c[0], target[1] - c[1], (target[2] ?? 0) - c[2]];
        this.point_target = true;
      } else {
        vector = ORIGIN;
      }
    }
    this.shift_vector = vector;
    this.scale_factor = scale;
    super.__init__({ ...kw, mobject });
    return this;
  }

  _create_faded_mobject(fadeIn) {
    const faded = this.mobject.copy();
    faded.fade(1);
    const k = fadeIn && !this.point_target ? -1 : 1;
    const v = this.shift_vector;
    faded.shift([v[0] * k, v[1] * k, (v[2] ?? 0) * k]);
    faded.scale(this.scale_factor);
    return faded;
  }
}

export class FadeIn extends Fade {
  __init__(kw = {}) {
    super.__init__({ ...kw, introducer: true });
    return this;
  }

  create_target() {
    return this.mobject;
  }

  create_starting_mobject() {
    return this._create_faded_mobject(true);
  }
}

export class FadeOut extends Fade {
  __init__(kw = {}) {
    super.__init__({ ...kw, remover: true });
    return this;
  }

  create_target() {
    return this._create_faded_mobject(false);
  }

  clean_up_from_scene(scene) {
    super.clean_up_from_scene(scene);
    this.interpolate(0);
  }
}

export class GrowFromPoint extends Transform {
  static SIG = ["mobject", "point", "point_color"];

  __init__({ mobject, point, point_color = null, ...kw } = {}) {
    this.point = point;
    this.point_color = point_color;
    super.__init__({ ...kw, mobject, introducer: true });
    return this;
  }

  create_target() {
    return this.mobject;
  }

  create_starting_mobject() {
    const start = super.create_starting_mobject();
    start.scale(0);
    start.move_to(this.point);
    if (this.point_color) start.set_color(this.point_color);
    return start;
  }
}

export class GrowFromCenter extends GrowFromPoint {
  static SIG = ["mobject", "point_color"];

  __init__({ mobject, point_color = null, ...kw } = {}) {
    super.__init__({ ...kw, mobject, point: mobject.get_center(), point_color });
    return this;
  }
}

export class GrowFromEdge extends GrowFromPoint {
  static SIG = ["mobject", "edge", "point_color"];

  __init__({ mobject, edge, point_color = null, ...kw } = {}) {
    super.__init__({ ...kw, mobject, point: mobject.get_critical_point(edge), point_color });
    return this;
  }
}

export class GrowArrow extends GrowFromPoint {
  static SIG = ["arrow", "point_color"];

  __init__({ arrow, point_color = null, ...kw } = {}) {
    super.__init__({ ...kw, mobject: arrow, point: arrow.get_start(), point_color });
    return this;
  }

  create_starting_mobject() {
    const start = this.mobject.copy();
    start.scale(0, { scale_tips: true, about_point: this.point });
    if (this.point_color) start.set_color(this.point_color);
    return start;
  }
}

export class SpinInFromNothing extends GrowFromCenter {
  static SIG = ["mobject", "angle", "point_color"];

  __init__({ mobject, angle = PI / 2, point_color = null, ...kw } = {}) {
    this.angle = angle;
    super.__init__({ ...kw, mobject, path_func: spiralPath(angle), point_color });
    return this;
  }
}
