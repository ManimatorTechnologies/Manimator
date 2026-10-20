# Manimator

A web app for building [Manim](https://www.manim.community) videos with buttons, in your browser:

- Add scenes.
- Click an object in the palette, then click the canvas to place it.
- Change its attributes in the inspector.
- Add methods and animations from menus.
- Play it on the canvas, and make the video, right in your browser.

You never have to write code. **Python** downloads the Manim script generated from your project, so you can keep editing it by hand.

Use it at [manimator.app](https://manimator.app), or run it on your own computer.

## Run it

You need Python 3.10 or newer. Once, in this folder:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

(On Windows: `.venv\Scripts\pip install -r requirements.txt`.) Then start it with `Manimator.bat` on Windows, or:

```bash
.venv/bin/python run.py
```

This starts the server and opens <http://127.0.0.1:8000/> in your browser. Keep the console window open while you work; close it (or press Ctrl+C) to stop Manimator. Use `--port 8080` for another port and `--no-open` to skip opening the browser.

It starts on the **Projects** screen. Every project is kept on the server as you edit, so there is nothing to save: pick a card to continue one, or **New Project** to start one. A card's **⋮** menu renames or deletes it. In the editor, click **Manimator** (top left) or File → All Projects to go back. **Download** (Ctrl+S) gives you a copy of the project as a file.

Projects and uploads live in `%LOCALAPPDATA%\Manimator` (or `--data-dir`). Videos are made by your browser and never stored on the server. Your projects belong to your browser through a cookie: another browser, a private window or clearing cookies starts an empty workspace, so download anything you want to keep.

The same server can be a website for other people (`--host 0.0.0.0`, or the `Dockerfile`); each visitor gets a private workspace, and requests and storage are limited. See [docs/SelfHosting.md](docs/SelfHosting.md) for the settings, the security model and hosting notes.

That is all the app needs: it draws and makes videos in the browser (Chrome, Edge, Safari or desktop Firefox), with no
Manim, LaTeX or ffmpeg. For development (the tests and the tools that compare the browser engine with real Manim),
install `RequirementsDev.txt` instead; those need ffmpeg and a LaTeX distribution (MiKTeX on Windows) as well.

## How to use

| Area | What it does |
|---|---|
| **Objects → +** | The **+** in the Objects panel opens a list of about 90 objects in categories, with a search box. Click one, then click the canvas. You can also drag it onto the canvas. Helpers (Brace, Surround, Underline, Cross, and so on) attach to the object you have selected. Graphs, groups and other objects with no spot of their own are added right away. See **Objects** below. |
| **Canvas** | Shows the scene's first frame, drawn by the browser engine (a port of Manim), so it matches the final video. **Space** (or F5) plays the scene; the bar under it moves to any moment. Click to select (click again on the same spot to reach objects underneath). Drag to move, use the arrow keys to nudge (Shift for bigger steps), and right-click for animations, layers and "add object here". Objects that appear later through an animation are drawn faded. Grid and Snap are in the bar above it. |
| **Inspector → Properties** | Size, text and LaTeX, stroke/fill colors from Manim's palette, opacity, position, rotation, scale and layer. To change a number, drag its label sideways. |
| **Inspector → Methods** | Setup calls that run once, in order, such as `next_to`, `align_to`, `to_edge`, `rotate`, `scale` or `set_color`. |
| **Objects** | Layer order (top of the list draws on top). The eye icon means *on screen when the scene starts*. It switches off automatically when you add an animation that brings the object in, such as Create or FadeIn. |
| **Scene tabs** | Along the bottom, like sheets in a spreadsheet. Each scene becomes its own video. Click a tab to switch to it (this also deselects any object, so the Inspector shows the scene), **+** to add one, drag to reorder, and right-click to duplicate or delete. Rename a scene in the Inspector. |
| **Animation** | A timeline plus an ordered list of steps. **＋ Animate** adds a step for the selected object: Appear, Disappear, Emphasize, Transform, or Move (which includes `.animate` with any method). With nothing selected (click the scene's tab to deselect), it animates the scene itself, whose own animations (camera moves and more, see **Scene types**) depend on its type. Select a step to set its duration, easing and stagger, or to play more animations at the same time. |
| **Render** | **F6** makes the scene's video at the chosen quality, and **F7** one video per scene; Render → Quick preview makes a 480p one. The videos are made in your browser and play in a window that opens when a render starts (Render menu → Show render output opens it again). |

### Objects

| Category | What is in it |
|---|---|
| **Shapes** | Circle, Square, Rectangle, Rounded, Triangle, Polygon (your own corners), Regular polygon, Polygram, Ellipse, Star, Dot, Marker, Label Dot, Annulus, Sector, Ring Slice, Arc Polygon |
| **Arcs & angles** | Arc, Arc between points, Curved arrow (one or both ways), Elbow, Angle, Right angle |
| **Lines** | Line, Arrow, Double arrow, Dashed line, Vector, Labeled line, Labeled arrow |
| **Text** | Text, Markup text, MathTex, Tex, Title, Paragraph, Bulleted list, Code, Decimal number, Integer, Variable |
| **Tables** | Matrix (plain, integer, decimal) and Table (plain, integer, decimal) |
| **Graphs** | Number line, Number plane, Complex plane, Polar plane, Axes, Function graph, Parametric curve, Implicit curve, Bar chart, Vector field, Graph and DiGraph (networks) |
| **Media** | Image (PNG, JPG, ...) and SVG, uploaded from your computer |
| **Helpers** | Brace, Brace with label, Brace between points, Surround, Backdrop, Underline, Cross, Dashed copy, Tangent line |
| **Groups** | VGroup and Group (objects that move and animate together), Cutout |
| **3D** | Sphere, Cube, Prism, Cone, Cylinder, Torus, Line, Arrow, Dot, Surface, 3D axes, Tetrahedron, Octahedron, Icosahedron, Dodecahedron |

Some things work a little differently from plain shapes:

- **Formulas** (function graph, curve, surface, vector field) take things like `x^2 - 1` or `2*sin(3*t)`. You can use numbers, the variables shown, `+ - * / ^`, `pi`, `e`, and functions such as `sin`, `cos`, `exp`, `sqrt`, `abs`. Nothing else is accepted.
- **Lists and tables** are edited as text: one corner per line (`x, y`) for polygons, comma separated numbers for bar charts, and one row per line for tables (cells separated by commas or `|`).
- **Groups** show and animate their members together, so a member isn't added to the scene on its own. Add a group while an object is selected and it starts with that object in it.
- **Graphs, curves and surfaces** are drawn at scene coordinates, so they have no position of their own. Use a `shift` method to move them.
- **3D objects** switch a plain Scene to a ThreeDScene. Click empty canvas to set the camera tilt and rotation in the scene settings. 3D objects have a *Height (z)* field, and dragging on the canvas is turned off in 3D scenes because a 2D drag can't say where in 3D you mean.

### Scene types

Click empty canvas, then pick the scene's **Class** under *Scene type*. Its settings appear below it. To use its own animations, click the scene's tab (so no object is selected) and use **＋ Animate**. **Play another animation in this step** works the same way, to play one together with the step's other animations.

| Class | Settings | Its own steps |
|---|---|---|
| **Scene** | | |
| **MovingCameraScene** | Where the camera starts and how far it is zoomed | Pan camera, Focus on object, Zoom camera, Zoom to fit, Reset camera |
| **ZoomedScene** | The same, plus the lens (position, size, color), the display (size, corner, border) and *Zoom on at start* | The camera steps, plus Turn on/off zoom, Move lens to an object or a point, Resize lens |
| **VectorScene** | Number plane or axes, basis vectors î and ĵ and their labels | Show coordinates (draws a vector and its coordinates) |
| **LinearTransformationScene** | Background and moving grids, numbers, basis vectors and their colors, unit square, ghost vectors | Apply matrix, Apply inverse, Apply function (any formula) |
| **ThreeDScene** | Camera tilt, rotation, roll and zoom | Move camera, Look at an object or a point, Spin camera, Wobble camera |
| **SpecialThreeDScene** | The same, starting from Manim's preset angle | The same |

In a 3D scene, an object's *In this scene* setting can keep it fixed in the frame (a title that stays put while the camera moves) or keep it facing the camera. In a LinearTransformationScene it decides whether the object transforms with the grid, moves as a vector (vectors start at the origin), or stays put. Text and tables stay put in front by default.

The canvas shows the real first frame of each type (the zoom display, the grids, a camera that starts zoomed in), so the grid and dragging follow the camera.

Some of this works around problems in Manim 0.21 itself:

- `SpecialThreeDScene()` crashes in its constructor. The generated class gets a small `__init__` that finishes setting it up as a ThreeDScene.
- `Scene.play()` reuses `self.moving_mobjects`, the attribute where a LinearTransformationScene keeps its moving objects, so a second transformation crashes. The code clears it before each transformation.
- A transformation brings back every object in the grid's lists, even ones that faded out. Objects join those lists when they come on screen and leave them when they go.
- VectorScene's `show_ghost_movement`, `coords_to_vector` and `lock_in_faded_grid` fail in Manim 0.21, so they aren't offered.

Undo and redo cover everything (Ctrl+Z / Ctrl+Y). Ctrl+S downloads the project as a `.manimator` file, which is plain JSON. Help → Keyboard shortcuts lists the rest.

Rendered videos play in the render window, with a **Download video** button. They are kept only in the page: download the ones you want to keep.

## How it works

```
browser UI (Preact + htm, manimator/web) ──HTTP──► FastAPI (manimator/server)
                                                     │  edits: named operations with undo (session.py)
                                                     │  one private workspace per browser, projects on disk (web.py)
                                                     ▼
                         project JSON ──► codegen.py (call trees) ──┬── Python printer ─► "Download Python" (Manim script)
                                                                     └── plan.py ─► scene plan (JSON) ─► browser engine
                                                                          (manimator/web/js/engine: a port of Manim with a Canvas2D
                                                                           Cairo camera) ─► canvas, playback and MP4 (WebCodecs)
```

- **One code generator.** The canvas, the video and the downloadable Python come from the same call trees, so they can't disagree. The server never runs Manim. See [docs/BrowserEngine.md](docs/BrowserEngine.md).
- **Thin UI.** The UI only displays the project and sends named edits. The server validates every value before it becomes code: directions, choices and easing names come from allow-lists, and colors and numbers are type-checked.
- **Safe to share.** The server only answers its own host names, needs the app's own header on every change (so other web pages can't drive it), and never takes a file path from the page.
- **No build step.** `manimator/web/vendor/preact-htm.js` is the only frontend dependency.

Everything the editor knows about Manim lives in `manimator/registry/` as data:

- `mobjects.py`: palette entries, their parameters and style. An entry that isn't a plain `Type(args)` call gives a small `build` function that writes its constructor
- `params.py` and `exprs.py`: the kinds of values a setting can hold (numbers, points, tables, files, formulas...) and the formula checker
- `methods.py`: methods usable at setup or through `.animate`
- `animations.py`: animations, easing functions and the scene actions (camera moves, grid transformations...)
- `scenes.py`: the scene types and their settings

To add a mobject, method or animation, add one entry there. The palette, forms, menus and code generation pick it up automatically; the browser engine needs the Manim class it names (`web/js/engine/manim/`). `tests/TestCodegen.py` builds every entry against the real Manim to catch mistakes (development only).

```
manimator/
  model/        project.py (data + JSON), ops.py (editing operations)
  registry/     the Manim catalog described above
  codegen.py    project → call trees → Python
  plan.py       project → scene plans (JSON) for the browser engine
  server/       FastAPI app, edit session with undo, catalog; web.py = private workspaces, uploads and limits for the website;
                addon.py = where an add-on can bring accounts
  web/          the UI: index.html, style.css, js/*.js; js/engine/ draws, plays and makes the videos
  app.py        launcher: starts the server and opens the browser
```

## Tests

```bash
.venv/bin/pip install -r RequirementsDev.txt
.venv/bin/python -m pytest
node --test tests/js/*.test.mjs
```

The tests that run the exported Python with real Manim skip themselves when Manim isn't installed. The JavaScript tests
compare the browser engine with frames and shapes made by real Manim (`tests/js/fixtures/`, made by
`tools/MakeJsFixtures.py`, gzipped).

## Accounts and the hosted site

This repository is the editor and its server, as you run it yourself: no accounts, every visitor may use everything.
[manimator.app](https://manimator.app) adds accounts, plans and payments with a private add-on that plugs in through
`manimator/server/addon.py`; that add-on is not part of this repository.

## License

Manimator is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): you may use, change and
share it for any noncommercial purpose (personal use, study, teaching, research, charities and public institutions).
Commercial use needs a separate license. Parts made by others keep their own licenses: see
[ThirdPartyNotices.md](ThirdPartyNotices.md). Contributions are welcome under the terms in
[CONTRIBUTING.md](CONTRIBUTING.md).
