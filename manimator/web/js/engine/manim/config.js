// Manim's config, as far as the engine needs it. The frame stays 14.22 x 8 units at every quality (Manim keeps
// frame_width from its defaults even at 854 x 480); only the pixel size and frame rate change.

const FRAME_HEIGHT = 8.0;

export const config = {
  pixel_width: 1920,
  pixel_height: 1080,
  frame_rate: 60,
  frame_height: FRAME_HEIGHT,
  frame_width: FRAME_HEIGHT * (1920 / 1080),
  background_color: "#000000",
  background_opacity: 1,
  get frame_x_radius() {
    return this.frame_width / 2;
  },
  get frame_y_radius() {
    return this.frame_height / 2;
  },
};

/** The video size and frame rate for a quality letter (Manim's -ql ... -qk). */
export const QUALITIES = {
  l: { pixel_width: 854, pixel_height: 480, frame_rate: 15 },
  m: { pixel_width: 1280, pixel_height: 720, frame_rate: 30 },
  h: { pixel_width: 1920, pixel_height: 1080, frame_rate: 60 },
  p: { pixel_width: 2560, pixel_height: 1440, frame_rate: 60 },
  k: { pixel_width: 3840, pixel_height: 2160, frame_rate: 60 },
};

export function setQuality(q) {
  Object.assign(config, QUALITIES[q] ?? QUALITIES.h);
}
