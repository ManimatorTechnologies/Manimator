// Battery: the browser engine's version (Manimator draws and plays this one). kit.py is the same for Manim.
import { Animation, GREEN, LEFT, RED, RIGHT, Rectangle, RoundedRectangle, VGroup, WHITE, YELLOW, mul } from "manimator";

/** A battery whose fill shows its charge: green, then yellow, then red as it runs down. */
export class Battery extends VGroup {
  static SIG = ["charge"]; // Battery(0.5) means charge=0.5, as in Python

  __init__({ charge = 0.7, ...kw } = {}) {
    super.__init__(kw);
    const c = Math.max(0, Math.min(1, charge));
    const body = RoundedRectangle.make({ width: 2, height: 1, corner_radius: 0.12, color: WHITE });
    const tip = Rectangle.make({ width: 0.12, height: 0.4, color: WHITE, fill_opacity: 1 }).next_to(body, RIGHT, 0);
    const level = c >= 0.5 ? GREEN : c >= 0.2 ? YELLOW : RED;
    const fill = Rectangle.make({ width: Math.max(0.01, 1.8 * c), height: 0.8, stroke_width: 0, fill_color: level,
      fill_opacity: 1 });
    fill.align_to(body, LEFT).shift(mul(RIGHT, 0.1));
    this.add(body, tip, fill);
    return this;
  }
}

/** Pop in: grow the battery from nothing, a little past full size, and settle. */
export class PopIn extends Animation {
  __init__({ mobject = null, bounce = 1.7, ...kw } = {}) {
    this.bounce = bounce;
    return super.__init__({ ...kw, mobject, introducer: true });
  }

  interpolate_mobject(alpha) {
    const t = this.rate_func(alpha) - 1; // "ease out back": 0 at the start, past 1 on the way, 1 at the end
    const size = 1 + (this.bounce + 1) * t ** 3 + this.bounce * t ** 2;
    this.mobject.become(this.starting_mobject);
    this.mobject.scale(Math.max(size, 0.001));
  }
}
