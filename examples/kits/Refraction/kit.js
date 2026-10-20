// Refraction: the browser engine's version (Manimator draws this one). kit.py is the same object for Manim.
import { Arc, DEGREES, DOWN, Line, MathTex, ORIGIN, PI, Rectangle, UP, VGroup, mul } from "manimator";

/** Snell's law, sin(theta2) / v2 = sin(theta1) / v1: the refracted ray's angle, or null when the ray can't get
 * through (total internal reflection). */
function bentAngle(theta, v1, v2) {
  const s = Math.sin(theta) * v2 / v1;
  return Math.abs(s) <= 1 ? Math.asin(s) : null;
}

/** The point ray_length along a unit direction from the center, or where the direction leaves the media if that
 * comes first: nothing pokes out, so the object's center stays where the ray hits the boundary. */
function reach([dx, dy], rayLength, width, depth) {
  const limits = [rayLength];
  [[dx, width / 2], [dy, depth]].forEach(([d, edge]) => { if (Math.abs(d) > 1e-9) limits.push(edge / Math.abs(d)); });
  return mul([dx, dy, 0], Math.min(...limits));
}

export default class Refraction extends VGroup {
  static SIG = ["theta"]; // Refraction(30 * DEGREES) means theta=30 * DEGREES, as in Python

  __init__({ theta = 40 * DEGREES, v1 = 1.0, v2 = 0.6, width = 14.25, depth = 4.0, ray_length = 10.0,
    ray_color = "#FFFF00", ray_width = 4.0, bottom_color = "#1B3540", top_color = "#000000", top_opacity = 0.0,
    normal = true, normal_length = 2.0, line_color = "#BBBBBB", arcs = true, arc_radius = 0.8, labels = true,
    label1 = "\\theta_1", label2 = "\\theta_2", ...kw } = {}) {
    super.__init__(kw);
    const limit = 89 * DEGREES;
    const theta1 = Math.max(-limit, Math.min(limit, theta));
    const theta2 = bentAngle(theta1, Math.max(0.01, v1), Math.max(0.01, v2));
    this.reflected = theta2 === null;
    this.top_medium = Rectangle.make({ width, height: depth, stroke_width: 0, fill_color: top_color,
      fill_opacity: top_opacity }).move_to(mul(UP, depth / 2));
    this.bottom_medium = Rectangle.make({ width, height: depth, stroke_width: 0, fill_color: bottom_color,
      fill_opacity: 1 }).move_to(mul(DOWN, depth / 2));
    const n = Math.min(normal_length, depth);
    this.normal_line = normal ? Line.make({ start: mul(UP, n), end: mul(DOWN, n),
      stroke_color: line_color, stroke_width: 2 }) : VGroup.make();
    const start = reach([-Math.sin(theta1), Math.cos(theta1)], ray_length, width, depth);
    const end = reach(this.reflected ? [Math.sin(theta1), Math.cos(theta1)] : [Math.sin(theta2), -Math.cos(theta2)],
      ray_length, width, depth);
    this.ray_in = Line.make({ start, end: ORIGIN, stroke_color: ray_color, stroke_width: ray_width });
    this.ray_out = Line.make({ start: ORIGIN, end, stroke_color: ray_color, stroke_width: ray_width });
    const corners = [[PI / 2, theta1, label1]]; // [where the normal points, angle to the ray, label]
    if (!this.reflected) corners.push([-PI / 2, theta2, label2]);
    this.angle_arcs = [VGroup.make(), VGroup.make()];
    this.angle_labels = [VGroup.make(), VGroup.make()];
    corners.forEach(([side, angle, text], i) => {
      if (Math.abs(angle) < 1e-3) return;
      if (arcs) {
        this.angle_arcs[i] = Arc.make({ radius: arc_radius, start_angle: side, angle, stroke_color: line_color,
          stroke_width: 2 });
      }
      if (labels && String(text).trim()) {
        const middle = side + angle / 2;
        this.angle_labels[i] = MathTex.make({ tex_strings: [String(text)], font_size: 40 }).move_to(
          mul([Math.cos(middle), Math.sin(middle), 0], arc_radius + 0.35));
      }
    });
    this.add(this.top_medium, this.bottom_medium, this.normal_line, this.ray_in, this.ray_out, ...this.angle_arcs,
      ...this.angle_labels);
    return this;
  }
}
