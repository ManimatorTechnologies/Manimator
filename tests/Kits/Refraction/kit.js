// Refraction: the browser engine's version (Manimator draws and plays this one). kit.py is the same for Manim.
import {
  Animation, Arc, DEGREES, DOWN, Line, MathTex, ORIGIN, OUT, PI, Rectangle, UP, VGroup, angleOfVector, midpoint, mul,
  norm, sub,
} from "manimator";

/** Snell's law, n1 sin(theta1) = n2 sin(theta2): the bent ray's angle for light going from index n1 into n2, or
 * null when it can't get through (total internal reflection). */
function bentAngle(theta, n1, n2) {
  const s = Math.sin(theta) * n1 / n2;
  return Math.abs(s) <= 1 ? Math.asin(s) : null;
}

/** The share of unpolarized light the boundary reflects (the Fresnel equations): the reflectances of its s and p
 * polarizations, averaged. The rest of the light goes through. */
function reflectance(n1, n2, cos1, cos2) {
  const rs = (n1 * cos1 - n2 * cos2) / (n1 * cos1 + n2 * cos2);
  const rp = (n2 * cos1 - n1 * cos2) / (n2 * cos1 + n1 * cos2);
  return (rs * rs + rp * rp) / 2;
}

/** How opaque to draw a ray carrying this share of the light, so that on screen (gamma 2.2) it looks that share as
 * bright as the incoming light. */
const brightness = (share) => Math.max(share, 0) ** (1 / 2.2);

/** Where a unit direction from the center leaves the media: nothing pokes out, so the object's center stays where
 * the light hits the boundary. */
function reach([dx, dy], width, depth) {
  const limits = [];
  [[dx, width / 2], [dy, depth]].forEach(([d, edge]) => { if (Math.abs(d) > 1e-9) limits.push(edge / Math.abs(d)); });
  return mul([dx, dy, 0], Math.min(...limits));
}

/** A refractive index to 3 decimals, but at least 2: 1.00, 1.33, 1.333. */
function indexText(n) {
  const k = Math.floor(n * 1000 + 0.5);
  const digits = String(k % 1000).padStart(3, "0");
  return `${Math.floor(k / 1000)}.${digits.endsWith("0") ? digits.slice(0, 2) : digits}`;
}

const clip01 = (x) => Math.min(Math.max(x, 0), 1);

export class Refraction extends VGroup {
  static SIG = ["theta"]; // Refraction(30 * DEGREES) means theta=30 * DEGREES, as in Python

  __init__({ theta = 40 * DEGREES, source = "top", n1 = 1.0, n2 = 1.33, reflection = true, width = 14.25,
    depth = 4.0, ray_color = "#FFFF00", ray_width = 4.0, bottom_color = "#1B3540", top_color = "#000000",
    top_opacity = 0.0, normal = true, normal_length = 2.0, line_color = "#BBBBBB", arcs = true, arc_radius = 0.8,
    labels = true, label1 = "\\theta_1", label2 = "\\theta_2", ...kw } = {}) {
    super.__init__(kw);
    // what it was made with, so its animations can make it again with another angle
    this.settings = { theta, source, n1, n2, reflection, width, depth, ray_color, ray_width, bottom_color, top_color,
      top_opacity, normal, normal_length, line_color, arcs, arc_radius, labels, label1, label2 };
    const limit = 89 * DEGREES;
    const theta1 = Math.max(-limit, Math.min(limit, theta));
    const up = source === "bottom" ? -1 : 1; // which way the light's own medium is from the boundary
    const [nTop, nBottom] = [Math.max(1, n1), Math.max(1, n2)];
    const [nIn, nOut] = up > 0 ? [nTop, nBottom] : [nBottom, nTop];
    const theta2 = bentAngle(theta1, nIn, nOut);
    this.reflected = theta2 === null; // all of it
    const share = this.reflected ? 1 : reflectance(nIn, nOut, Math.cos(theta1), Math.cos(theta2));
    this.top_medium = Rectangle.make({ width, height: depth, stroke_width: 0, fill_color: top_color,
      fill_opacity: top_opacity }).move_to(mul(UP, depth / 2));
    this.bottom_medium = Rectangle.make({ width, height: depth, stroke_width: 0, fill_color: bottom_color,
      fill_opacity: 1 }).move_to(mul(DOWN, depth / 2));
    const n = Math.min(normal_length, depth);
    this.normal_line = normal ? Line.make({ start: mul(UP, n), end: mul(DOWN, n),
      stroke_color: line_color, stroke_width: 2 }) : VGroup.make();
    const start = reach([-Math.sin(theta1), up * Math.cos(theta1)], width, depth);
    this.ray_in = Line.make({ start, end: ORIGIN, stroke_color: ray_color, stroke_width: ray_width });
    this.ray_bent = this.reflected ? VGroup.make() : Line.make({ start: ORIGIN,
      end: reach([Math.sin(theta2), -up * Math.cos(theta2)], width, depth), stroke_color: ray_color,
      stroke_width: ray_width, stroke_opacity: brightness(1 - share) });
    this.ray_reflected = reflection || this.reflected ? Line.make({ start: ORIGIN,
      end: reach([Math.sin(theta1), up * Math.cos(theta1)], width, depth), stroke_color: ray_color,
      stroke_width: ray_width, stroke_opacity: brightness(share) }) : VGroup.make();
    // [where the normal points into the medium, angle from it to the ray] in the top medium, then the bottom
    const light = [up * PI / 2, up * theta1];
    const bent = this.reflected ? null : [-up * PI / 2, up * theta2];
    const corners = up > 0 ? [light, bent] : [bent, light];
    this.angle_arcs = [VGroup.make(), VGroup.make()];
    this.angle_labels = [VGroup.make(), VGroup.make()];
    corners.forEach((corner, i) => {
      if (corner === null || Math.abs(corner[1]) < 1e-3) return;
      const [side, angle] = corner;
      const text = String([label1, label2][i]);
      if (arcs) {
        this.angle_arcs[i] = Arc.make({ radius: arc_radius, start_angle: side, angle, stroke_color: line_color,
          stroke_width: 2 });
      }
      if (labels && text.trim()) {
        const middle = side + angle / 2;
        this.angle_labels[i] = MathTex.make({ tex_strings: [text], font_size: 40 }).move_to(
          mul([Math.cos(middle), Math.sin(middle), 0], arc_radius + 0.35));
      }
    });
    // each medium's index in its outer left corner, if it fits there
    this.index_labels = [VGroup.make(), VGroup.make()];
    [[nTop, 1], [nBottom, -1]].forEach(([index, y], i) => {
      const label = labels ? MathTex.make({ tex_strings: [`n_${i + 1} = ${indexText(index)}`], font_size: 36 }) : null;
      if (label !== null && label.width + 0.6 <= width / 2 && label.height + 0.6 <= depth) {
        this.index_labels[i] = label.move_to([-width / 2 + 0.3 + label.width / 2,
          y * (depth - 0.3 - label.height / 2), 0]);
      }
    });
    this.add(this.top_medium, this.bottom_medium, this.normal_line, this.ray_in, this.ray_bent, this.ray_reflected,
      ...this.angle_arcs, ...this.angle_labels, ...this.index_labels);
    return this;
  }
}

/** When each part of a Refraction comes in during Shine, as [from, to, drawn] over the animation (after its rate
 * function): the media, the normal and the index labels fade in, the light draws in to the boundary and on (bent and
 * reflected at once), and each angle's arc and label fade in as the light reaches it. Drawn parts grow from their
 * start; the others fade in. */
function shineTimes(fromBottom) {
  const first = [0.45, 0.65, false], then = [0.8, 1, false];
  const [top, bottom] = fromBottom ? [then, first] : [first, then];
  return [[0, 0.3, false], [0, 0.3, false], [0.1, 0.35, false], [0.25, 0.6, true], [0.6, 0.95, true],
    [0.6, 0.95, true], top, bottom, top, bottom, [0.1, 0.35, false], [0.1, 0.35, false]];
}

/** Shine: brings the refraction in, the light travelling through it. */
export class Shine extends Animation {
  __init__({ mobject = null, ...kw } = {}) {
    return super.__init__({ ...kw, mobject, introducer: true });
  }

  interpolate_mobject(alpha) {
    const t = this.rate_func(alpha);
    const times = shineTimes((this.mobject.settings ?? {}).source === "bottom");
    const parts = this.mobject.submobjects;
    const start = this.starting_mobject.submobjects;
    if (parts.length !== times.length || start.length !== times.length) { // not shaped like a Refraction
      this.mobject.become(this.starting_mobject).fade(1 - t);
      return;
    }
    times.forEach(([from, to, drawn], i) => {
      const s = clip01((t - from) / (to - from));
      if (drawn) parts[i].pointwise_become_partial(start[i], 0, s);
      else parts[i].become(start[i]).fade(1 - s);
    });
  }
}

/** Sweep angle: the incoming light turns to another angle, and the bent and reflected rays, the arcs and the labels
 *  follow it. It starts from the refraction's angle as it is and leaves it at `to`, wherever it was moved, turned or
 *  scaled to. */
export class SweepAngle extends Animation {
  __init__({ mobject = null, to = 70 * DEGREES, ...kw } = {}) {
    this.to = to;
    this.settings = null;
    return super.__init__({ ...kw, mobject });
  }

  begin() {
    this.settings = this.mobject.settings ? { ...this.mobject.settings } : null;
    if (this.settings) {
      // the media say where the boundary is now (its center), how big and which way up
      const [top, bottom] = this.mobject.submobjects;
      const up = sub(top.get_center(), bottom.get_center());
      this.hit = midpoint(top.get_center(), bottom.get_center());
      this.size = norm(up) / this.settings.depth;
      this.turn = angleOfVector(up) - PI / 2;
      this.start_theta = this.settings.theta;
    }
    super.begin();
  }

  interpolate_mobject(alpha) {
    if (!this.settings) return;
    const theta = this.start_theta + (this.to - this.start_theta) * this.rate_func(alpha);
    const fresh = Refraction.make({ ...this.settings, theta });
    fresh.scale(this.size, { about_point: ORIGIN }).rotate(this.turn, OUT, { about_point: ORIGIN }).shift(this.hit);
    this.mobject.become(fresh);
  }

  finish() {
    super.finish();
    if (this.settings) this.mobject.settings = { ...this.settings, theta: this.to };
  }
}
