# The browser engine

Manimator draws, plays and exports videos in the visitor's browser. The server sends a **scene plan** (the same
call trees that print the downloadable Python), and the browser builds Manim's objects from it, plays the steps,
and encodes MP4 with WebCodecs. This note records what the Phase 0 spike found and how the engine is built.

## Phase 0 results (2026-10-12)

Hard criteria, measured on the dev PC (Edge, Intel Iris Xe):

| Criterion | Result |
|---|---|
| Runs under the site's CSP | Yes, unchanged (`script-src 'self'`, no `wasm-unsafe-eval`, no workers needed) |
| No requests to other sites | 0 (the CDN fallbacks of the vendored code are never reached) |
| Same `t` gives the same frame | By construction: the timeline rebuilds state from the plan; checked by the browser tests |
| Text as vector glyphs | Yes: DejaVu outlines via opentype.js, drawn as paths |
| MathTex for ~50 common formulas | 57 of 58 (`tests/js/fixtures/TexCorpus.json`); `\color` is not in the bundled TeX packages and gives a clear error |
| 1080p60 export within 2× real time, under 1.5 GB | 0.76× real time, 0.5 ms drawing per frame, 45 MB JS heap; 4K60 also works (2.4×) |

So: **go**. `tests/browser/spike.py` repeats the export check; `tools/ParityReport.py` makes the side-by-side report.

### What changed from the plan: Canvas2D instead of manim-web's three.js renderer

The spike first drew 25 hand-mapped cases with manim-web's own classes (report kept in
`.cache/spike-report-manimweb/`). Circle, MathTex, Brace, Transform and the moving/zoomed cameras matched Manim
closely, but much did not, for reasons in its drawing model rather than its defaults:

- fills with holes (Cutout) and dashes (DashedLine) were lost;
- glyph text came out with no fill, and subpath jumps are encoded as connecting lines;
- `.rotate()` and friends change a three.js transform instead of the points, so `.animate` interpolates
  differently from Manim;
- Sphere/Surface/Cube are lit three.js meshes (z-buffer, other colours and camera) instead of Manim's shaded,
  depth-sorted faces; LinearTransformationScene and VectorScene draw different grids; Table, Code and Graph use
  other layouts; TransformMatchingTex threw.

Manim CE draws with **Cairo**, and the browser's **Canvas2D** has the same model: cubic Bézier paths with
sub-paths, nonzero fill, miter joins (limit 10), butt caps, line widths in user units, linear gradients, affine
image drawing. Manim's 3D camera is also just Cairo drawing projected, shaded, depth-sorted 2D paths. So the engine
ports Manim's own classes to JavaScript (from the Manim 0.21 source) and draws them with a Canvas2D port of Manim's
camera. Parity then depends on porting faithfully, which can be tested point by point against Manim in Node, not
on matching a different renderer.

From manim-web 0.33.0 we keep its prebuilt, self-contained chunks: **MathJax 4** (TeX to SVG, New Computer Modern
font) and the **MP4/WebM muxers**. Its 3 MB main bundle (three.js) is not shipped.

## Vendored code (`manimator/web/vendor/`, pinned, `SHA256SUMS`, made by `tools/VendorManimWeb.py`)

| Folder | What | Used for |
|---|---|---|
| `manim-web/0.33.0/` | MathJax 4.1.3 chunk, mp4-muxer, webm-muxer | TeX to SVG, video files |
| `mathjax-newcm/4.1.3/` | MathJax's on-demand font ranges, as JSON | `\mathbb`, `\mathcal`, `\mathfrak`, more symbols |
| `opentype/2.0.0/` | opentype.js | DejaVu glyph outlines and kerning |
| `../fonts/dejavu/` | DejaVu Sans / Sans Mono / Serif | what the live server's Pango drew Text with |

Only `web/js/engine/mw/*` loads vendored code (`mw/lib.js`), so any of it can be upgraded or swapped in one place.
opentype.js's full shaping can't run DejaVu's contextual substitution tables, so text layout places glyphs itself
(advance widths and kerning), like Pango does for these fonts.

## Layout of `manimator/web/js/engine/`

| Path | Role |
|---|---|
| `core/` | Pure maths, testable in Node: vectors, Bézier helpers, paths, colours, rate functions, graph layouts, isolines |
| `manim/` | The port of Manim CE's objects (also testable in Node), with `pycall.js`/`pymethods.js` to call them like Python |
| `anim/` | The port of Manim's animations (`ANIMATIONS` by name) and `.animate` |
| `scene/scene.js` | `Scene` with the Cairo renderer's play/draw bookkeeping (still and moving objects, Wait placeholders) |
| `scene/cameras.js`, `scene/kinds.js` | MovingCamera, MultiCamera (zoomed display), ThreeDCamera; the seven scene kinds |
| `scene/timeline.js` | Runs a plan's statements: `seek(t)` for the editor (snapshots per step), `frames()` for export (Manim's exact frame list) |
| `render/canvas.js` | Canvas2D port of Manim's Cairo camera |
| `plan/` | Plan values and calls (`values.js`), object building with a constructor cache (`build.js`), names |
| `mw/` | Adapters for vendored code (MathJax, opentype, muxers) |
| `index.js`, `export.js`, `thumbs.js` | Editor canvas and playback, MP4/WebM export (WebCodecs), project pictures |

The plan named `mw/build.js`, `mw/anims.js`, `mw/methods.js` and `mw/shading3d.js`; with manim-web reduced to
libraries, those live in `plan/`, `anim/`, `manim/` and `scene/` instead.

## How it is checked against Manim

`node --test tests/js/*.test.mjs` compares the engine with Manim itself through fixtures that
`tools/MakeJsFixtures.py` writes (it runs Manim): shapes, SVG, text, TeX, graphing, graphs, 3D, code, markup,
every object of the golden projects (`objects`), every frame-of-interest of the golden animation projects
(`timeline`) and of every scene kind (`kinds`), down to what each camera draws. `tools/ParityReport.py` puts
Manim's picture and the engine's side by side for every object and scene kind (`.cache/parity-report/`).

Things Manim does that the port keeps on purpose: each `Wait` adds an empty object to the scene; Manim's SVG cache
keeps a repeated SVG's group unflipped (the engine clears it per build, like a fresh process); a `Succession` only
moves forward, so seeking replays the frames between; the zoomed camera is cleared on every capture; the 3D camera's
Cairo context keeps the frame centre it had at the first frame.

Known differences: formulas come from MathJax (TeX's layout, not identical outlines), so formula pieces, and objects
placed by formulas, are compared by place and size; text drawn on Windows' Pango slants italic differently from
the server's (the reference for italic is size only).

## Resources that load asynchronously

Building is synchronous, like Manim. TeX (MathJax), fonts and pictures are loaded first: a build pass that meets
something not yet loaded records it and stops; the engine loads everything recorded, then builds again. Inputs are
fixed, so this settles after a pass or two. Results are cached (TeX by string and size, fonts and pictures by name).

## Not in the bundled TeX

The MathJax chunk has the `base`, `ams`, `newcommand` and `configmacros` packages. `\color`, `\textcolor`,
`\boldsymbol`, `physics` and `mathrsfs` macros are missing. If the live projects' formulas (Phase 7 corpus) need
them, the fix is a custom MathJax build with those packages, vendored the same way.
