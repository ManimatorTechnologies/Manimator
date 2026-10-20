// Ports of manim/mobject/vector_field.py: VectorField (colouring) and ArrowVectorField.

import { ManimColor } from "../core/color.js";
import { arange } from "../core/math.js";
import { config } from "./config.js";
import { Vector } from "./geometry.js";
import { VGroup } from "./vmobject.js";

export const DEFAULT_SCALAR_FIELD_COLORS = ["#236B8E", "#83C167", "#F7D96F", "#FC6255"]; // BLUE_E, GREEN, YELLOW, RED

const sigmoid = (x) => 1.0 / (1 + Math.exp(-x));
const norm3 = (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

export class VectorField extends VGroup {
  static SIG = ["func", "color", "color_scheme", "min_color_scheme_value", "max_color_scheme_value", "colors"];

  __init__({ func, color = null, color_scheme = null, min_color_scheme_value = 0, max_color_scheme_value = 2,
    colors = DEFAULT_SCALAR_FIELD_COLORS, ...kw } = {}) {
    super.__init__(kw);
    this.func = func;
    if (color === null) {
      this.single_color = false;
      this.color_scheme = color_scheme ?? norm3;
      this.rgbs = colors.map((c) => new ManimColor(c).to_rgb());
      this.pos_to_rgb = (pos) => {
        const vec = this.func(pos);
        const value = Math.min(max_color_scheme_value, Math.max(min_color_scheme_value, this.color_scheme(vec)));
        let alpha = (value - min_color_scheme_value) / (max_color_scheme_value - min_color_scheme_value);
        alpha *= this.rgbs.length - 1;
        const c1 = this.rgbs[Math.trunc(alpha)];
        const c2 = this.rgbs[Math.min(Math.trunc(alpha + 1), this.rgbs.length - 1)];
        alpha %= 1;
        return c1.map((v, i) => v * (1 - alpha) + c2[i] * alpha);
      };
      this.pos_to_color = (pos) => new ManimColor(this.pos_to_rgb(pos));
    } else {
      this.single_color = true;
      this.color = ManimColor.parse(color);
    }
    this.submob_movement_updater = null;
    return this;
  }

  static shift_func(func, shift) {
    return (p) => func([p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]]);
  }

  static scale_func(func, scalar) {
    return (p) => func(p.map((v) => v * scalar));
  }
}

export class ArrowVectorField extends VectorField {
  static SIG = ["func", "color", "color_scheme", "min_color_scheme_value", "max_color_scheme_value", "colors",
    "x_range", "y_range", "z_range", "three_dimensions", "length_func", "opacity", "vector_config"];

  __init__({ func, color = null, color_scheme = null, min_color_scheme_value = 0, max_color_scheme_value = 2,
    colors = DEFAULT_SCALAR_FIELD_COLORS, x_range = null, y_range = null, z_range = null, three_dimensions = false,
    length_func = (n) => 0.45 * sigmoid(n), opacity = 1.0, vector_config = null, ...kw } = {}) {
    const xr = [...(x_range && x_range.length ? x_range : [Math.floor(-config.frame_width / 2), Math.ceil(config.frame_width / 2)])];
    const yr = [...(y_range && y_range.length ? y_range : [Math.floor(-config.frame_height / 2), Math.ceil(config.frame_height / 2)])];
    const ranges = [xr, yr];
    if (three_dimensions || (z_range && z_range.length)) ranges.push([...(z_range && z_range.length ? z_range : yr)]);
    else ranges.push([0, 0]);
    for (const r of ranges) {
      if (r.length === 2) r.push(0.5);
      r[1] += r[2];
    }
    [this.x_range, this.y_range, this.z_range] = ranges;
    super.__init__({ ...kw, func, color, color_scheme, min_color_scheme_value, max_color_scheme_value, colors });
    this.length_func = length_func;
    this.opacity = opacity;
    this.vector_config = vector_config ?? {};
    this.func = func;
    const vectors = [];
    for (const x of arange(...this.x_range)) {
      for (const y of arange(...this.y_range)) {
        for (const z of arange(...this.z_range)) vectors.push(this.get_vector([x, y, z]));
      }
    }
    this.add(...vectors);
    this.set_opacity(this.opacity);
    return this;
  }

  get_vector(point) {
    let output = [...this.func(point)].map(Number);
    while (output.length < 3) output.push(0);
    const n = norm3(output);
    if (n !== 0) output = output.map((v) => v * (this.length_func(n) / n));
    const vect = Vector.make({ ...this.vector_config, direction: output });
    vect.shift(point);
    vect.set_color(this.single_color ? this.color : this.pos_to_color(point));
    return vect;
  }
}
