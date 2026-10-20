// A port of Manim's ManimColor (manim/utils/color/core.py): RGBA floats in 0..1.

import { COLOR_TABLE } from "../manim/frozen.js";
import { linspace } from "./math.js";

const HEX = /(?:(?<=#)|(?<=0x))[A-F0-9]{3,8}/i;

export class ManimColor {
  constructor(value = null, alpha = 1.0) {
    if (value === null || value === undefined) this.v = [0, 0, 0, alpha];
    else if (value instanceof ManimColor) this.v = value.v;
    else if (typeof value === "number") {
      this.v = [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, alpha];
    } else if (typeof value === "string") {
      const m = HEX.exec(value);
      if (m) this.v = fromHex(m[0], alpha);
      else {
        const named = COLOR_TABLE[value.toUpperCase()];
        if (!named) throw new Error(`Color ${value} not found`);
        this.v = [named[0], named[1], named[2], alpha];
      }
    } else if (Array.isArray(value)) { // RGB(A) floats (JavaScript can't tell 1.0 from 1; see fromIntRgb)
      if (value.length !== 3 && value.length !== 4) throw new Error("ManimColor only accepts 3 or 4 values");
      this.v = value.length === 3 ? [...value, alpha] : [...value];
    } else {
      throw new Error(`not a colour: ${value}`);
    }
  }

  static fromIntRgb(rgb, alpha = 1.0) {
    return new ManimColor([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, rgb.length > 3 ? rgb[3] / 255 : alpha]);
  }

  static parse(color, alpha = 1.0) {
    if (Array.isArray(color) && color.length && (color[0] instanceof ManimColor || typeof color[0] === "string")) {
      return color.map((c) => new ManimColor(c, alpha));
    }
    return new ManimColor(color, alpha);
  }

  to_rgb() {
    return this.v.slice(0, 3);
  }

  to_rgba() {
    return [...this.v];
  }

  to_rgba_with_alpha(alpha) {
    return [this.v[0], this.v[1], this.v[2], alpha];
  }

  /** Manim truncates: int(value * 255). */
  to_hex(withAlpha = false) {
    const h = (x) => Math.trunc(x * 255).toString(16).toUpperCase().padStart(2, "0");
    return `#${h(this.v[0])}${h(this.v[1])}${h(this.v[2])}${withAlpha ? h(this.v[3]) : ""}`;
  }

  interpolate(other, alpha) {
    const o = new ManimColor(other);
    return new ManimColor(this.v.map((x, i) => x * (1 - alpha) + o.v[i] * alpha));
  }

  invert(withAlpha = false) {
    return new ManimColor([1 - this.v[0], 1 - this.v[1], 1 - this.v[2], withAlpha ? 1 - this.v[3] : this.v[3]]);
  }

  equals(other) {
    const o = new ManimColor(other);
    return this.v.every((x, i) => x === o.v[i]);
  }

  toString() {
    return this.to_hex();
  }
}

function fromHex(hex, alpha) {
  let h = hex;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) h += "FF";
  else if (h.length === 8) alpha = (parseInt(h, 16) & 255) / 255;
  else throw new Error("Hex colors must contain 6 or 8 hexadecimal numbers");
  const n = parseInt(h, 16);
  return [((n >>> 24) & 255) / 255, ((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, alpha];
}

export const color = (c, alpha = 1.0) => new ManimColor(c, alpha);

/** Named colours (BLUE, YELLOW_C...) as ManimColor. */
export const C = new Proxy({}, { get: (_t, name) => new ManimColor(String(name)) });

export const interpolateColor = (c1, c2, alpha) => new ManimColor(c1).interpolate(c2, alpha);

export function colorGradient(referenceColors, length) {
  if (length === 0) return [];
  const parsed = referenceColors.map((c) => new ManimColor(c));
  if (parsed.length === 0) throw new Error("Expected 1 or more reference colors. Got 0 colors.");
  if (parsed.length === 1) return Array.from({ length }, () => parsed[0]);
  const rgbs = parsed.map((c) => c.to_rgb());
  const num = parsed.length;
  const alphas = linspace(0, num - 1, length);
  const out = [];
  for (let k = 0; k < length; k += 1) {
    const alpha = alphas[k];
    let floor = Math.trunc(alpha);
    let mod = alpha - floor;
    if (k === length - 1) {
      mod = 1;
      floor = num - 2;
    }
    const a = rgbs[floor];
    const b = rgbs[floor + 1];
    out.push(new ManimColor([0, 1, 2].map((i) => a[i] * (1 - mod) + b[i] * mod)));
  }
  return out;
}

export function averageColor(...colors) {
  const rgbs = colors.map((c) => new ManimColor(c).to_rgb());
  const mean = [0, 1, 2].map((i) => rgbs.reduce((s, c) => s + c[i], 0) / rgbs.length);
  return new ManimColor(mean);
}

export const invertColor = (c) => new ManimColor(c).invert();
