// Draws mobjects onto a 2D canvas the way Manim's Cairo camera does (manim/camera/camera.py): the same paths
// (cubic Béziers, a subpath closed when it ends where it starts), nonzero fill, miter joins (limit 10), butt caps,
// background stroke, then fill, then stroke, and a line width of stroke_width / 100 scene units.
//
// ThreeDCamera and MovingCamera adjust the frame, the order and the points through the methods marked below.

import { config } from "../manim/config.js";
import { removeListRedundancies } from "../manim/mobject.js";

const CAIRO_LINE_WIDTH_MULTIPLE = 0.01;
const JOIN = { round: "round", bevel: "bevel", miter: "miter" };
const CAP = { round: "round", butt: "butt", square: "square" };

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const channel = (x) => clamp01(x) * 255;

/** An RGBA row (floats 0..1) as a CSS colour. */
export const cssColor = (rgba) => `rgba(${channel(rgba[0])}, ${channel(rgba[1])}, ${channel(rgba[2])}, ${clamp01(rgba[3])})`;

export class Camera {
  constructor({ pixel_width = config.pixel_width, pixel_height = config.pixel_height, frame_width = config.frame_width,
    frame_height = config.frame_height, frame_center = [0, 0, 0], background_color = config.background_color,
    background_opacity = config.background_opacity, use_z_index = true } = {}) {
    this.pixel_width = pixel_width;
    this.pixel_height = pixel_height;
    this.frame_width = frame_width;
    this.frame_height = frame_height;
    this.frame_center = frame_center;
    this.background_color = background_color;
    this.background_opacity = background_opacity;
    this.use_z_index = use_z_index;
  }

  /** The frame's centre and size (MovingCamera reads them from its frame mobject). */
  get_frame() {
    return { width: this.frame_width, height: this.frame_height, center: this.frame_center };
  }

  /** Fills the canvas with the background, as Camera.reset does. */
  reset(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = this.background_color;
    ctx.globalAlpha = this.background_opacity;
    ctx.fillRect(0, 0, this.pixel_width, this.pixel_height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Clears and draws `mobjects` (each with its family). */
  render(ctx, mobjects) {
    this.reset(ctx);
    this.capture_mobjects(ctx, mobjects);
  }

  // -------------------------------------------------------------------------------------------- overridable

  get_mobjects_to_display(mobjects) {
    const all = removeListRedundancies(mobjects.flatMap((m) => m.family_members_with_points()));
    if (!this.use_z_index) return all;
    return all.map((m, i) => [m, i]).sort((a, b) => a[0].z_index - b[0].z_index || a[1] - b[1]).map(([m]) => m);
  }

  transform_points_pre_display(mobject, points) {
    for (const p of points) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return [[0, 0, 0]];
    }
    return points;
  }

  get_fill_rgbas(vmobject) {
    return vmobject.get_fill_rgbas();
  }

  get_stroke_rgbas(vmobject, background = false) {
    return vmobject.get_stroke_rgbas(background);
  }

  // -------------------------------------------------------------------------------------------- drawing

  capture_mobjects(ctx, mobjects) {
    const { width: fw, height: fh, center: fc } = this.get_frame();
    const pw = this.pixel_width;
    const ph = this.pixel_height;
    const transform = [pw / fw, 0, 0, -(ph / fh), pw / 2 - fc[0] * (pw / fw), ph / 2 + fc[1] * (ph / fh)];
    for (const mob of this.get_mobjects_to_display(mobjects)) {
      if (mob.get_fill_rgbas) {
        ctx.setTransform(...transform);
        this.display_vectorized(ctx, mob);
      } else if (mob.draw_on_camera) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        mob.draw_on_camera(ctx, this);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  display_vectorized(ctx, vmobject) {
    if (!this.set_path(ctx, vmobject)) return;
    this.apply_stroke(ctx, vmobject, true);
    this.apply_fill(ctx, vmobject);
    this.apply_stroke(ctx, vmobject, false);
  }

  /** Camera.set_cairo_context_path. False when there is nothing to draw. */
  set_path(ctx, vmobject) {
    const points = this.transform_points_pre_display(vmobject, vmobject.points);
    if (points.length === 0) return false;
    ctx.beginPath();
    for (const subpath of vmobject.gen_subpaths_from_points_2d(points)) {
      const start = subpath[0];
      ctx.moveTo(start[0], start[1]);
      const usable = subpath.length - (subpath.length % 4);
      for (let i = 0; i < usable; i += 4) {
        const p1 = subpath[i + 1];
        const p2 = subpath[i + 2];
        const p3 = subpath[i + 3];
        ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      }
      if (vmobject.consider_points_equals_2d(subpath[0], subpath[subpath.length - 1])) ctx.closePath();
    }
    return true;
  }

  /** Camera.set_cairo_context_color: one colour, or a linear gradient along the sheen direction. */
  paint(ctx, rgbas, vmobject) {
    if (rgbas.length === 1) return cssColor(rgbas[0]);
    const ends = this.transform_points_pre_display(vmobject, vmobject.get_gradient_start_and_end_points());
    const [p0, p1] = ends.length === 2 ? ends : [[0, 0, 0], [0, 0, 0]];
    if (p0[0] === p1[0] && p0[1] === p1[1]) return cssColor(rgbas[rgbas.length - 1]);
    const gradient = ctx.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
    const step = 1.0 / (rgbas.length - 1);
    rgbas.forEach((rgba, i) => gradient.addColorStop(clamp01(i * step), cssColor(rgba)));
    return gradient;
  }

  apply_fill(ctx, vmobject) {
    const rgbas = this.get_fill_rgbas(vmobject);
    if (rgbas.every((r) => r[3] === 0)) return;
    ctx.fillStyle = this.paint(ctx, rgbas, vmobject);
    ctx.fill("nonzero");
  }

  apply_stroke(ctx, vmobject, background = false) {
    const width = vmobject.get_stroke_width(background);
    if (width === 0 || !Number.isFinite(width)) return;
    const rgbas = this.get_stroke_rgbas(vmobject, background);
    if (rgbas.every((r) => r[3] === 0)) return;
    ctx.strokeStyle = this.paint(ctx, rgbas, vmobject);
    ctx.lineWidth = width * CAIRO_LINE_WIDTH_MULTIPLE;
    ctx.lineJoin = JOIN[vmobject.joint_type] ?? "miter";
    ctx.miterLimit = 10;
    ctx.lineCap = CAP[vmobject.cap_style] ?? "butt";
    ctx.stroke();
  }
}
