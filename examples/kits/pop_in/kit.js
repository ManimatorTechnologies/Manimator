// Pop in: the browser engine's version (Manimator plays this one). kit.py is the same animation for Manim.
import { Animation } from "manimator";

export default class PopIn extends Animation {
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
