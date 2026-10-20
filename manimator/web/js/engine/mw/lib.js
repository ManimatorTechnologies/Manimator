// The only module that loads the vendored third-party code (pinned and checksummed by tools/vendor_manim_web.py),
// so it can be upgraded or swapped in one place. Each piece is fetched the first time it is needed.
//
// From manim-web 0.33.0 the engine uses only prebuilt, self-contained chunks: MathJax (TeX to SVG) and the MP4/WebM
// muxers. Drawing is the engine's own Canvas2D renderer (render/canvas.js), which follows Manim's Cairo camera.

export const VENDOR = {
  manimWeb: "0.33.0",
  opentype: "2.0.0",
};

export const loadMathJax = () => import("../../../vendor/manim-web/0.33.0/MathJaxBundle-BSrlS0Dh.js");
export const loadMp4Muxer = () => import("../../../vendor/manim-web/0.33.0/mp4-muxer-5DGKGEJk.js");
export const loadWebmMuxer = () => import("../../../vendor/manim-web/0.33.0/webm-muxer-BGY-Mgbp.js");
export const loadOpentype = () => import("../../../vendor/opentype/2.0.0/opentype.min.mjs");
