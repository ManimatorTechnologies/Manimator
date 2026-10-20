// Ports of manim/mobject/types/image_mobject.py (AbstractImageMobject, ImageMobject) and of Camera's
// display_image_mobject: the picture is mapped onto its four points (UL, UR, DL, DR) and composited over the frame.
//
// Pixels are {width, height, data: Uint8ClampedArray RGBA}, decoded before the scene is built (resources: "image").

import { ManimColor } from "../core/color.js";
import { config } from "./config.js";
import { DL, DR, UL, UR } from "./frozen.js";
import { Mobject } from "./mobject.js";
import { resources } from "./resources.js";

const DEFAULT_RESOLUTION = 1080; // QUALITIES[DEFAULT_QUALITY]["pixel_height"]

export class AbstractImageMobject extends Mobject {
  __init__({ scale_to_resolution, pixel_array_dtype = "uint8", resampling_algorithm = "bicubic", ...kw } = {}) {
    this.pixel_array_dtype = pixel_array_dtype;
    this.scale_to_resolution = scale_to_resolution;
    this.set_resampling_algorithm(resampling_algorithm);
    return super.__init__(kw);
  }

  set_resampling_algorithm(algorithm) {
    const known = { bicubic: "bicubic", cubic: "bicubic", nearest: "nearest", none: "nearest", bilinear: "bilinear",
      linear: "bilinear", box: "bilinear", hamming: "bilinear", lanczos: "bicubic" };
    const value = known[String(algorithm).toLowerCase()];
    if (!value) throw new Error("resampling_algorithm has to be one of 'bicubic', 'nearest' or 'bilinear'.");
    this.resampling_algorithm = value;
    return this;
  }

  reset_points() {
    this.points = [UL, UR, DL, DR].map((p) => [...p]);
    this.center();
    const { width: w, height: h } = this.get_pixel_array();
    const height = this.scale_to_resolution ? (h / this.scale_to_resolution) * config.frame_height : 3;
    this.stretch_to_fit_height(height);
    this.stretch_to_fit_width((height * w) / h);
    return this;
  }

  /** Camera.display_image_mobject on a 2D canvas. */
  draw_on_camera(ctx, camera) {
    const img = this.get_pixel_array();
    if (!img.width || !img.height) return;
    const { width: fw, height: fh, center: fc } = camera.get_frame();
    const pts = camera.transform_points_pre_display(this, this.points);
    const toPixel = (p) => [(p[0] - fc[0]) * (camera.pixel_width / fw) + camera.pixel_width / 2,
      (p[1] - fc[1]) * -(camera.pixel_height / fh) + camera.pixel_height / 2];
    const target = pts.map(toPixel);
    const ints = target.map(([x, y]) => [Math.trunc(x), Math.trunc(y)]);
    const shift = [Math.min(...ints.map((p) => p[0])), Math.min(...ints.map((p) => p[1]))];
    const size = [Math.max(...ints.map((p) => p[0] - shift[0])), Math.max(...ints.map((p) => p[1] - shift[1]))];
    // nothing to draw when the quadrilateral is thinner than half a pixel
    const order = [0, 1, 3, 2].map((i) => target[i]);
    const sides = order.map((p, i) => [order[(i + 1) % 4][0] - p[0], order[(i + 1) % 4][1] - p[1]]);
    const lengths = sides.map(([x, y]) => Math.sqrt(x * x + y * y));
    const li = lengths.indexOf(Math.max(...lengths));
    if (lengths[li] === 0) return;
    const prev = sides[(li + 3) % 4];
    const h1 = Math.abs(sides[li][0] * prev[1] - sides[li][1] * prev[0]) / lengths[li];
    if (h1 < 0.5) return;
    const [ul, ur, dl] = target;
    const source = this._canvas(img);
    ctx.save();
    ctx.beginPath();
    ctx.rect(shift[0], shift[1], size[0], size[1]);
    ctx.clip();
    ctx.imageSmoothingEnabled = this.resampling_algorithm !== "nearest";
    ctx.imageSmoothingQuality = this.resampling_algorithm === "bicubic" ? "high" : "low";
    ctx.setTransform((ur[0] - ul[0]) / img.width, (ur[1] - ul[1]) / img.width, (dl[0] - ul[0]) / img.height,
      (dl[1] - ul[1]) / img.height, ul[0], ul[1]);
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }

  /** The pixels as a canvas, remade when they change. */
  _canvas(img) {
    if (this._canvasCache && this._canvasCache.data === img.data && this._canvasCache.version === this._pixelVersion) {
      return this._canvasCache.canvas;
    }
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(img.width, img.height)
      : Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    canvas.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    Object.defineProperty(this, "_canvasCache", { value: { canvas, data: img.data, version: this._pixelVersion },
      writable: true, configurable: true, enumerable: false });
    return canvas;
  }
}

export class ImageMobject extends AbstractImageMobject {
  static SIG = ["filename_or_array", "scale_to_resolution", "invert", "image_mode"];

  __init__({ filename_or_array, scale_to_resolution = DEFAULT_RESOLUTION, invert = false, image_mode = "RGBA",
    ...kw } = {}) {
    this.fill_opacity = 1;
    this.stroke_opacity = 1;
    this.invert_image = invert;
    this.image_mode = image_mode;
    const src = typeof filename_or_array === "string" ? resources.get("image", filename_or_array) : filename_or_array;
    if (typeof filename_or_array === "string") this.path = filename_or_array;
    this.pixel_array = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
    this.pixel_array_dtype = kw.pixel_array_dtype ?? "uint8";
    this._pixelVersion = 0;
    const d = this.pixel_array.data;
    if (this.invert_image) for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    this.orig_alpha_pixel_array = new Uint8ClampedArray(d.length / 4);
    for (let i = 0; i < this.orig_alpha_pixel_array.length; i += 1) this.orig_alpha_pixel_array[i] = d[4 * i + 3];
    return super.__init__({ ...kw, scale_to_resolution });
  }

  get_pixel_array() {
    return this.pixel_array;
  }

  set_color(color = "#F7D96F", alpha = null, family = true) {
    const rgb = new ManimColor(color).to_rgb().map((v) => Math.trunc(v * 255));
    const d = this.pixel_array.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
      if (alpha !== null) d[i + 3] = Math.trunc(255 * alpha);
    }
    this._pixelVersion += 1;
    for (const submob of this.submobjects) submob.set_color(color, alpha, family);
    this.color = new ManimColor(color);
    return this;
  }

  set_opacity(alpha) {
    const d = this.pixel_array.data;
    for (let i = 0; i < this.orig_alpha_pixel_array.length; i += 1) d[4 * i + 3] = Math.trunc(this.orig_alpha_pixel_array[i] * alpha);
    this._pixelVersion += 1;
    this.stroke_opacity = alpha;
    return this;
  }

  fade(darkness = 0.5, family = true) {
    this.set_opacity(1 - darkness);
    super.fade(darkness, family);
    return this;
  }

  interpolate_color(m1, m2, alpha) {
    const a = m1.pixel_array;
    const b = m2.pixel_array;
    if (a.width !== b.width || a.height !== b.height) {
      throw new Error("Mobject pixel array shapes incompatible for interpolation.");
    }
    this.fill_opacity = (1 - alpha) * m1.fill_opacity + alpha * m2.fill_opacity;
    this.stroke_opacity = (1 - alpha) * m1.stroke_opacity + alpha * m2.stroke_opacity;
    const out = new Uint8ClampedArray(a.data.length);
    for (let i = 0; i < out.length; i += 1) out[i] = Math.trunc(a.data[i] * (1 - alpha) + b.data[i] * alpha);
    this.pixel_array = { width: a.width, height: a.height, data: out };
    this._pixelVersion += 1;
    return this;
  }

  get_style() {
    return { fill_color: new ManimColor(this.color.to_rgb()).to_hex(), fill_opacity: this.fill_opacity };
  }
}
