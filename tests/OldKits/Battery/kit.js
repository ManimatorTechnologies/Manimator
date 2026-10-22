// Battery: the browser engine's version (Manimator draws this one). kit.py is the same object for Manim.
import { GREEN, LEFT, RED, RIGHT, Rectangle, RoundedRectangle, VGroup, WHITE, YELLOW, mul } from "manimator";

export default class Battery extends VGroup {
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
