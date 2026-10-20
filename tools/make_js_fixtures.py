"""Dev only: write the reference data the JavaScript engine tests compare against, computed by Manim itself.

    python tools/make_js_fixtures.py            # every section
    python tools/make_js_fixtures.py rates      # some sections

Each section writes tests/js/fixtures/<section>.json.gz. `node --test tests/js/` then checks the browser engine's ports
against them. Run again after upgrading Manim.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "js" / "fixtures"
sys.path.insert(0, str(ROOT))

SECTIONS = {}


def section(fn):
    SECTIONS[fn.__name__] = fn
    return fn


def _num(v):
    import numpy as np

    if isinstance(v, np.ndarray):
        return [_num(x) for x in v.tolist()]
    if isinstance(v, (list, tuple)):
        return [_num(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    return v


@section
def rates():
    import numpy as np
    from manim.utils import rate_functions as rf

    from manimator.registry.animations import RATE_FUNCS

    names = sorted({n.removeprefix("rate_functions.") for n, _ in RATE_FUNCS if n != "default"}
                   | {"smoothstep", "smootherstep", "running_start", "slow_into", "lingering", "exponential_decay",
                      "ease_in_out_bounce", "ease_in_out_elastic", "ease_in_back", "ease_in_out_back",
                      "ease_in_expo", "ease_in_out_expo", "ease_in_out_circ", "ease_in_quad"})
    ts = [round(float(t), 6) for t in np.linspace(-0.1, 1.1, 241)]
    return {"t": ts, "values": {n: [float(getattr(rf, n)(t)) for t in ts] for n in names}}


def mobject_state(mob) -> list[dict]:
    """Each family member's class, points and style, the way tests/js/helpers.mjs reads them from the ports."""
    from manim import VMobject

    out = []
    for m in mob.get_family():
        entry = {"cls": type(m).__name__, "points": m.points.tolist()}
        if isinstance(m, VMobject):
            entry |= {"fill": m.get_fill_rgbas().tolist(), "stroke": m.get_stroke_rgbas().tolist(),
                      "stroke_width": float(m.get_stroke_width()),
                      "background_stroke": m.get_stroke_rgbas(background=True).tolist(),
                      "background_stroke_width": float(m.get_stroke_width(background=True)),
                      "sheen_direction": [float(x) for x in m.sheen_direction]}
        out.append(entry)
    return out


# Shapes built in both Manim and the ports: [class, positional args, keyword args, then (method, args, kwargs)...].
GEOMETRY_CASES = [
    ["VMobject", [], {"stroke_color": "#FC6255"}],
    ["Circle", [], {}],
    ["Circle", [], {"radius": 2.5, "color": "#83C167", "fill_opacity": 0.5}],
    ["Dot", [[1, 2, 0]], {}],
    ["AnnotationDot", [], {}],
    ["Ellipse", [], {"width": 3, "height": 1.5}],
    ["Arc", [], {"radius": 1.5, "start_angle": 0.3, "angle": 2.0}],
    ["ArcBetweenPoints", [[-1, 0, 0], [2, 1, 0]], {"angle": 1.2}],
    ["ArcBetweenPoints", [[-1, 0, 0], [2, 1, 0]], {"radius": 3}],
    ["CurvedArrow", [[-2, -1, 0], [2, 1, 0]], {"angle": 0.785}],
    ["CurvedDoubleArrow", [[-2, -1, 0], [2, 1, 0]], {"angle": -1.0}],
    ["AnnularSector", [], {"inner_radius": 0.5, "outer_radius": 1.5, "angle": 2.0}],
    ["Sector", [], {"radius": 1.2, "angle": 1.0, "start_angle": 0.5}],
    ["Annulus", [], {"inner_radius": 0.7, "outer_radius": 1.4}],
    ["ArcPolygon", [[0, 0, 0], [2, 0, 0], [1, 1.5, 0]], {"angle": 0.785}],
    ["ArcPolygon", [[0, 0, 0], [2, 0, 0], [1, 1.5, 0]], {"radius": 2}],
    ["Line", [[-1, -1, 0], [2, 1, 0]], {}],
    ["Line", [[-1, -1, 0], [2, 1, 0]], {"buff": 0.3}],
    ["Line", [[-1, -1, 0], [2, 1, 0]], {"path_arc": 1.0}],
    ["Arrow", [[-2, 0, 0], [2, 1, 0]], {}],
    ["Arrow", [[0, 0, 0], [0.5, 0.2, 0]], {}],
    ["DoubleArrow", [[-2, 0, 0], [2, 1, 0]], {"color": "#FFFF00"}],
    ["Vector", [[1, 2, 0]], {}],
    ["DashedLine", [[-3, 0, 0], [3, 1, 0]], {"dash_length": 0.05}],
    ["DashedLine", [[-3, 0, 0], [3, 1, 0]], {}],
    ["Elbow", [], {"width": 0.5, "angle": 0.5}],
    ["Polygon", [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0.5, 1.5, 0]], {}],
    ["RegularPolygon", [], {"n": 5}],
    ["RegularPolygram", [6], {"density": 2, "radius": 1.5}],
    ["RegularPolygram", [5], {"density": 2}],
    ["Star", [], {}],
    ["Star", [7], {"outer_radius": 2, "density": 3}],
    ["Triangle", [], {}],
    ["Rectangle", [], {"width": 3, "height": 1.5}],
    ["Rectangle", [], {"width": 3, "height": 2, "grid_xstep": 0.5, "grid_ystep": 0.5}],
    ["Square", [], {"side_length": 1.5}],
    ["RoundedRectangle", [], {"corner_radius": 0.3, "width": 3, "height": 2}],
    ["Cross", [], {}],
    ["StealthTip", [], {}],
    ["ArrowCircleFilledTip", [], {}],
    ["ArrowSquareTip", [], {}],
    ["Arrow", [[-2, -1, 0], [1, 2, 0]], {"tip_shape": "StealthTip"}],
    ["Line", [[-2, -1, 0], [1, 2, 0]], {}, ["add_tip", [], {"tip_shape": "ArrowCircleFilledTip", "at_start": True}]],
    ["Arrow", [[-2, -1, 0], [1, 2, 0]], {}, ["scale", [0.5], {}]],
    ["Arrow", [[-2, -1, 0], [1, 2, 0]], {}, ["put_start_and_end_on", [[0, 0, 0], [3, -1, 0]], {}]],
    ["Circle", [], {}, ["set_fill", ["#FFFF00", 0.6], {}], ["rotate", [0.7], {}], ["set_sheen", [0.3], {}]],
    ["Square", [], {}, ["set_stroke", [], {"color": "#FC6255", "width": 8}], ["stretch", [2, 0], {}]],
    ["Circle", [], {}, ["apply_function", ["wave"], {}]],
]


@section
def geometry():
    import manim
    import numpy as np

    funcs = {"wave": lambda p: p + np.array([0.0, 0.3 * np.sin(2 * p[0]), 0.0])}

    def value(v):
        return getattr(manim, v) if isinstance(v, str) and v.endswith("Tip") else funcs.get(v, v) \
            if isinstance(v, str) else v

    cases = []
    for cls, args, kwargs, *calls in GEOMETRY_CASES:
        mob = getattr(manim, cls)(*map(value, args), **{k: value(v) for k, v in kwargs.items()})
        for name, cargs, ckwargs in calls:
            getattr(mob, name)(*map(value, cargs), **{k: value(v) for k, v in ckwargs.items()})
        cases.append({"case": [cls, args, kwargs, *calls], "family": mobject_state(mob)})
    return cases


# SVG files (tests/js/fixtures/svg) read by SVGMobject: [file, keyword args].
SVG_CASES = [
    ["paths.svg", {}],
    ["paths.svg", {"height": None, "should_center": False}],
    ["paths.svg", {"fill_color": "#FFFF00", "stroke_width": 2, "width": 5}],
    ["structure.svg", {}],
    ["structure.svg", {"svg_default": {"color": "#FC6255", "opacity": None, "fill_color": None, "fill_opacity": 0.5,
                                       "stroke_width": 1, "stroke_color": None, "stroke_opacity": None}}],
]


@section
def svg():
    from manim import SVGMobject

    folder = OUT / "svg"
    return [{"case": [name, kwargs], "family": mobject_state(SVGMobject(folder / name, **kwargs))}
            for name, kwargs in SVG_CASES]


# Text keyword arguments ("font" defaults to DejaVu Sans: the server's Pango has only DejaVu).
TEXT_CASES = [
    {"text": "Hello, Manim!"},
    {"text": "AV Te To Wa yo fi fl ffi ffl"},
    {"text": "fi fl ffi", "disable_ligatures": True},
    {"text": "Serif text: AVA", "font": "DejaVu Serif"},
    {"text": "mono(code) -> 42", "font": "DejaVu Sans Mono"},
    {"text": "Bold text", "weight": "BOLD"},
    {"text": "Italic text", "slant": "ITALIC"},
    {"text": "Bold italic", "weight": "BOLD", "slant": "ITALIC"},
    {"text": "Serif italic", "font": "DejaVu Serif", "slant": "ITALIC"},
    {"text": "Small 37", "font_size": 37},
    {"text": "Big 96", "font_size": 96},
    {"text": "Odd size 23.3", "font_size": 23.3},
    {"text": "Two\nlines here"},
    {"text": "Three\n\nlines", "line_spacing": 1.5},
    {"text": "tab\there"},
    {"text": "Colour words here", "t2c": {"words": "#FC6255", "Col": "#58C4DD"}},
    {"text": "Mixed AVAV styles", "t2w": {"AV": "BOLD"}, "t2s": {"styles": "ITALIC"}},
    {"text": "Fonts mix", "t2f": {"mix": "DejaVu Serif"}},
    {"text": "Gradient!", "gradient": ["#FC6255", "#58C4DD"]},
    {"text": "Slice colour", "t2c": {"[1:4]": "#FFFF00"}},
    {"text": "Accents: éàüñ ç ΑΒΓ Ωμ ЖЯ ½ € ©"},
    {"text": "x", "color": "#83C167"},
    {"text": "width set", "width": 3},
]


@section
def text():
    import manim_frames
    from manim import Text

    manim_frames._prepare()
    cases = []
    for kwargs in TEXT_CASES:
        t = Text(**({"font": "DejaVu Sans"} | kwargs))
        cases.append({"case": kwargs, "family": mobject_state(t)})
    return cases


# TeX cases beyond the formula corpus: [class, args, kwargs].
TEX_CASES = [
    ["MathTex", ["a^2", "+", "b^2", "=", "c^2"], {}],
    ["MathTex", ["{{a}}^2 + {{b}}^2"], {}],
    ["MathTex", [r"x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}"], {"substrings_to_isolate": ["b", "a"]}],
    ["MathTex", [r"E = mc^2"], {"tex_to_color_map": {"E": "#FC6255", "c": "#58C4DD"}, "font_size": 72}],
    ["MathTex", [r"\sqrt{2}", r"\sqrt[3]{x}"], {}],
    ["Tex", ["Hello, World!"], {}],
    ["Tex", ["Text with $x^2$ inside"], {}],
    ["Tex", ["Two ", "parts"], {"font_size": 36}],
    ["BulletedList", ["First item", "Second", "Third one"], {}],
    ["Title", ["A Title"], {}],
]


@section
def tex():
    import manim
    import manim_frames

    manim_frames._prepare()
    corpus = json.loads((OUT / "tex_corpus.json").read_text(encoding="utf-8"))
    cases = [["MathTex", [f], {}] for f in corpus] + TEX_CASES
    out = []
    for cls, args, kwargs in cases:
        try:
            mob = getattr(manim, cls)(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 - recorded: the engine should fail too
            out.append({"case": [cls, args, kwargs], "error": str(e)[:200]})
            continue
        parts = [[float(v) for v in (*p.get_corner([-1, -1, 0])[:2], *p.get_corner([1, 1, 0])[:2])]
                 for p in mob.submobjects]
        out.append({"case": [cls, args, kwargs], "width": float(mob.width), "height": float(mob.height),
                    "glyphs": len(mob.family_members_with_points()), "parts": parts,
                    "colors": [m.get_fill_color().to_hex() for m in mob.family_members_with_points()]})
    return out


# Graphs and composite objects: [class, args, kwargs]. Named functions are FUNCTIONS below (and in the JS test).
GRAPHING_CASES = [
    ["NumberLine", [], {"x_range": [-5, 5, 1], "length": 10}],
    ["NumberLine", [], {"x_range": [-3, 3, 0.5], "include_tip": True, "rotation": 0.3}],
    ["NumberLine", [], {"x_range": [2, 8, 2], "unit_size": 0.5, "numbers_with_elongated_ticks": [4]}],
    ["Axes", [], {"x_range": [-5, 5, 1], "y_range": [-3, 3, 1], "x_length": 10, "y_length": 6}],
    ["Axes", [], {}],
    ["Axes", [], {"x_range": [0, 10, 2], "y_range": [-1, 4, 1], "tips": False}],
    ["NumberPlane", [], {"x_range": [-7, 7, 1], "y_range": [-4, 4, 1]}],
    ["NumberPlane", [], {}],
    ["NumberPlane", [], {"x_range": [-4, 4, 2], "y_range": [-2, 2, 1], "faded_line_ratio": 2}],
    ["ComplexPlane", [], {"x_range": [-5, 5, 1], "y_range": [-3, 3, 1]}],
    ["PolarPlane", [], {"radius_max": 3, "radius_step": 1}],
    ["ThreeDAxes", [], {"x_range": [-4, 4, 1], "y_range": [-4, 4, 1], "z_range": [-3, 3, 1], "x_length": 7,
                        "y_length": 7, "z_length": 5}],
    ["FunctionGraph", ["sin"], {"x_range": [-5, 5, 0.05]}],
    ["FunctionGraph", ["square"], {}],
    ["ParametricFunction", ["lissajous"], {"t_range": [0, 6.2832, 0.02]}],
    ["ImplicitFunction", ["circle"], {"x_range": [-4, 4], "y_range": [-3, 3]}],
    ["ImplicitFunction", ["hyperbola"], {"x_range": [-4, 4], "y_range": [-3, 3]}],
    ["Brace", ["square"], {}],
    ["Brace", ["square"], {"direction": [1, 1, 0], "buff": 0.3}],
    ["BraceBetweenPoints", [[-2, 0, 0], [2, 1, 0]], {}],
    ["Table", [[["Ann", "90"], ["Bob", "85"]]], {}],
    ["Table", [[["a", "b", "c"], ["d", "e", "f"]]], {"include_outer_lines": True, "h_buff": 1, "v_buff": 0.5}],
]

FUNCTIONS = {
    "sin": "lambda x: np.sin(x)",
    "square": "lambda x: x ** 2 / 4",
    "lissajous": "lambda t: np.array([2 * np.sin(3 * t), 2 * np.sin(2 * t), 0])",
    "circle": "lambda x, y: x ** 2 + y ** 2 - 4",
    "hyperbola": "lambda x, y: x * y - 1",
}


@section
def graphing():
    import manim
    import manim_frames
    import numpy as np

    manim_frames._prepare()
    manim.Paragraph.set_default(font="DejaVu Sans")
    funcs = {k: eval(v, {"np": np}) for k, v in FUNCTIONS.items()}  # noqa: S307 - our own constants
    out = []
    for cls, args, kwargs in GRAPHING_CASES:
        values = [manim.Square() if a == "square" and cls.startswith("Brace") else funcs.get(a, a)
                  if isinstance(a, str) else a for a in args]
        if cls == "Table":
            values = args
        mob = getattr(manim, cls)(*values, **kwargs)
        out.append({"case": [cls, args, kwargs], "family": mobject_state(mob)})
    return out


# Graph / DiGraph on 5 vertices: [class, layout, labels, seed].
GRAPH_CASES = [["Graph", "circular", False, 1], ["Graph", "shell", False, 1], ["Graph", "spring", False, 1],
               ["Graph", "spring", False, 7], ["Graph", "random", False, 3], ["Graph", "spectral", False, 1],
               ["Graph", "kamada_kawai", False, 1], ["DiGraph", "circular", False, 1], ["DiGraph", "spring", False, 2],
               ["DiGraph", "kamada_kawai", False, 1], ["Graph", "circular", True, 1]]
GRAPH_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 2]]


@section
def graphs():
    import manim
    import manim_frames

    manim_frames._prepare()
    out = []
    for cls, layout, labels, seed in GRAPH_CASES:
        kw = {"layout": layout, "layout_scale": 2, "labels": labels}
        if layout in ("spring", "random"):
            kw["layout_config"] = {"seed": seed}
        edges = [tuple(e) for e in GRAPH_EDGES]
        g = getattr(manim, cls)(list(range(5)), edges, **kw)
        out.append({"case": [cls, layout, labels, seed],
                    "vertices": [g[v].get_center().tolist() for v in range(5)],
                    "edges": [[*g.edges[e].get_start().tolist(), *g.edges[e].get_end().tolist()] for e in edges],
                    "width": float(g.width), "height": float(g.height)})
    return out


THREE_D_CASES = [
    ["Sphere", [], {"radius": 1.5, "resolution": [12, 6]}],
    ["Sphere", [], {}],
    ["Dot3D", [[1, 2, 0]], {}],
    ["Cube", [], {"side_length": 2}],
    ["Prism", [], {"dimensions": [3, 2, 1]}],
    ["Cone", [], {"base_radius": 1, "height": 2}],
    ["Cone", [], {"direction": [1, 1, 0], "show_base": True}],
    ["Cylinder", [], {"radius": 1, "height": 2}],
    ["Cylinder", [], {"direction": [0, 1, 1], "resolution": [6, 12]}],
    ["Torus", [], {"major_radius": 2, "minor_radius": 0.5, "resolution": [12, 12]}],
    ["Line3D", [], {"start": [-1, -1, 0], "end": [1, 1, 1], "thickness": 0.05}],
    ["Arrow3D", [], {"start": [-2, 0, 0], "end": [2, 1, 1]}],
    ["Surface", ["saddle"], {"u_range": [-2, 2], "v_range": [-2, 2], "resolution": 8}],
    ["Tetrahedron", [], {"edge_length": 2}],
    ["Octahedron", [], {}],
    ["Icosahedron", [], {}],
    ["Dodecahedron", [], {}],
]
FUNCTIONS["saddle"] = "lambda u, v: np.array([u, v, 0.25 * (u ** 2 - v ** 2)])"


@section
def three_d():
    import manim
    import numpy as np

    funcs = {k: eval(v, {"np": np}) for k, v in FUNCTIONS.items()}  # noqa: S307 - our own constants
    out = []
    for cls, args, kwargs in THREE_D_CASES:
        kw = {k: np.array(v, dtype=float) if k == "direction" else v for k, v in kwargs.items()}  # Manim needs an array
        mob = getattr(manim, cls)(*[funcs.get(a, a) if isinstance(a, str) else a for a in args], **kw)
        state = mobject_state(mob)
        for entry, m in zip(state, mob.get_family(), strict=True):
            entry["shade_in_3d"] = bool(getattr(m, "shade_in_3d", False))
        out.append({"case": [cls, args, kwargs], "family": state})
    return out


CODE_SAMPLE = 'print("Hello, Manim!")\nfor i in range(3):\n    print(i)'
CODE_CASES = [
    {"code_string": CODE_SAMPLE, "language": "python", "formatter_style": "vim"},
    {"code_string": CODE_SAMPLE, "language": "python", "formatter_style": "monokai", "add_line_numbers": False},
    {"code_string": "int main() {\n\treturn 0;\n}", "language": "c", "formatter_style": "friendly",
     "background": "window"},
    {"code_string": "x = 1", "language": "python", "formatter_style": "emacs", "line_numbers_from": 9},
]


@section
def code():
    import manim
    import manim_frames

    from manimator.code_highlight import highlight

    manim_frames._prepare()
    out = []
    for kwargs in CODE_CASES:
        mob = manim.Code(**kwargs, paragraph_config={"font": "DejaVu Sans Mono"})
        hl = highlight(kwargs["code_string"], kwargs["language"], kwargs["formatter_style"])
        out.append({"case": kwargs, "highlight": hl, "family": mobject_state(mob)})
    return out


MARKUP_CASES = [
    {"text": "Hello <b>bold</b> and <i>italic</i>"},
    {"text": "A\nB\n\nC"},
    {"text": '<span foreground="#FC6255">red</span> <span size="x-large">big</span> <span size="200%">A</span>'},
    {"text": "<u>under</u> and <s>strike</s> text"},
    {"text": "x<sup>2</sup> + y<sub>3</sub>"},
    {"text": "<big>Big</big> <small>small</small> <tt>mono</tt>"},
    {"text": '<span font_family="DejaVu Serif" weight="bold">Serif bold</span> AV'},
    {"text": '<color col="#58C4DD">blue</color> and <gradient from="#FC6255" to="#FFFF00">grad</gradient>'},
    {"text": "&lt;tag&gt; &amp; fi ligature"},
    {"text": "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore"},
    {"text": "Sized", "font_size": 30},
]


@section
def markup():
    import manim
    import manim_frames

    manim_frames._prepare()
    return [{"case": kw, "family": mobject_state(manim.MarkupText(**({"font": "DejaVu Sans"} | kw)))}
            for kw in MARKUP_CASES]


@section
def objects():
    """Every object of the golden "all objects" projects: the scene plan (what the browser builds) and the state
    of the same object made by the generated Python in Manim. The uploads are a small picture and an SVG file."""
    import tempfile

    import manim
    import manim_frames
    import numpy as np
    from PIL import Image

    sys.path.insert(0, str(ROOT / "tests"))
    from fixture_projects import FILES, all_objects

    from manimator import codegen
    from manimator.plan import scene_plan

    manim_frames._prepare()
    for cls in (manim.Text, manim.MarkupText, manim.Paragraph):
        cls.set_default(font="DejaVu Sans")
    svg_text = (OUT / "svg" / "structure.svg").read_text(encoding="utf-8")
    picture = np.zeros((30, 40, 4), dtype=np.uint8)
    picture[..., 0] = np.linspace(0, 255, 40, dtype=np.uint8)[None, :]
    picture[..., 1] = 128
    picture[..., 3] = 255
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        Image.fromarray(picture, "RGBA").save(folder / FILES["ImageMobject"])
        (folder / FILES["SVGMobject"]).write_text(svg_text, encoding="utf-8")
        for variant, three_d in ((False, False), (True, False), (False, True), (True, True)):
            project = all_objects(variant=variant, three_d=three_d)
            scene = project.scenes[0]
            plan = scene_plan(scene, project)
            with codegen.asset_root(folder.as_posix()):
                sc = codegen.scene_code(scene, project)
            ns: dict = {}
            exec("from manim import *\nimport numpy as np", ns)  # noqa: S102 - our own generated code
            states = {}
            for c in sc.objects:
                if c.error:
                    continue
                try:
                    ns[c.var] = eval(c.call.py(), ns)  # noqa: S307
                    for post in c.post_calls:
                        eval(post.py(), ns)  # noqa: S307
                except Exception as e:  # noqa: BLE001 - the engine should fail too
                    states[c.mob_id] = {"error": str(e)[:200]}
                    continue
                mob = ns[c.var]
                family = mob.get_family()
                states[c.mob_id] = {"family": mobject_state(mob),
                                    "tex": any(isinstance(m, manim.SingleStringMathTex) for m in family),
                                    "width": float(mob.width), "height": float(mob.height),
                                    "center": mob.get_center().tolist()}
            out.append({"variant": variant, "three_d": three_d, "plan": plan, "states": states})
    return {"svg": svg_text, "picture": [40, 30], "files": FILES, "projects": out}


def draw_state(m, tex: bool = False) -> dict:
    """What the camera draws of one object: its class, points and colours (`tex`: part of a formula)."""
    from manim import VMobject

    entry = {"cls": type(m).__name__, "points": m.points.tolist()}
    if tex:
        entry["tex"] = True
    if isinstance(m, VMobject):
        entry |= {"fill": m.get_fill_rgbas().tolist(), "stroke": m.get_stroke_rgbas().tolist(),
                  "stroke_width": float(m.get_stroke_width()),
                  "background_stroke": m.get_stroke_rgbas(background=True).tolist(),
                  "background_stroke_width": float(m.get_stroke_width(background=True))}
    return entry


TIMELINE_PROJECTS = ["animations", "methods", "groups", "example", "two_scenes", "hostile"]
TIMELINE_FPS = 15


@section
def timeline():
    """Golden projects played by Manim from their generated Python: at the first, middle and last frame of every
    play (and the one picture of a still wait), what the Cairo renderer draws: the still picture's objects, then
    the objects drawn over it, each as the camera sees it (family members with points, in z order)."""
    import tempfile

    import manim
    import manim_frames
    from manim.renderer.cairo_renderer import CairoRenderer
    from manim.utils.iterables import list_update

    sys.path.insert(0, str(ROOT / "tests"))
    from fixture_projects import FILES, golden_projects

    from manimator import codegen
    from manimator.plan import scene_plan

    manim_frames._prepare()
    for cls in (manim.Text, manim.MarkupText, manim.Paragraph):
        cls.set_default(font="DejaVu Sans")
    tex_init = manim.SingleStringMathTex.__init__

    def marked_init(self, *args, **kwargs):
        tex_init(self, *args, **kwargs)
        for m in self.get_family():
            m._fixture_tex = True

    manim.SingleStringMathTex.__init__ = marked_init
    projects = golden_projects()
    out = []
    picture_note = None
    with tempfile.TemporaryDirectory() as tmp, manim.tempconfig({
            "frame_rate": TIMELINE_FPS, "pixel_width": 320, "pixel_height": 180, "disable_caching": True,
            "write_to_movie": False, "progress_bar": "none"}):
        folder = Path(tmp)
        from PIL import Image

        Image.new("RGBA", (40, 30), (200, 120, 40, 255)).save(folder / FILES["ImageMobject"])
        (folder / FILES["SVGMobject"]).write_text((OUT / "svg" / "structure.svg").read_text(encoding="utf-8"),
                                                 encoding="utf-8")
        for name in TIMELINE_PROJECTS:
            project = projects[name]
            for scene_model in project.scenes:
                if scene_model.kind != "Scene":
                    continue
                plan = scene_plan(scene_model, project)
                with codegen.asset_root(folder.as_posix()):
                    source = codegen.scene_source(scene_model, project, "Fixture")
                ns: dict = {}
                exec("from manim import *\nimport numpy as np\n" + source, ns)  # noqa: S102 - our own code
                scene = ns["Fixture"]()
                renderer = scene.renderer
                fw = renderer.file_writer
                for attr in ("write_frame", "begin_animation", "end_animation", "add_partial_movie_file"):
                    setattr(fw, attr, lambda *a, **k: None)
                frames = []  # [play index, frame index, n frames, layers]
                state = {"play": -1, "frame": 0, "n": 0}
                camera = renderer.camera

                def tex_ids():  # formula pieces, and their copies (marked when made)
                    return {id(m) for m in scene.get_mobject_family_members() if getattr(m, "_fixture_tex", False)}

                def layers(mobjects):
                    still = scene.static_mobjects if renderer.static_image is not None else []
                    over = mobjects or list_update(scene.mobjects, scene.foreground_mobjects)
                    tex = tex_ids()
                    return [[draw_state(m, id(m) in tex) for m in camera.get_mobjects_to_display(still)],
                            [draw_state(m, id(m) in tex) for m in camera.get_mobjects_to_display(over)]]

                original_play = CairoRenderer.play
                original_render = CairoRenderer.render
                original_freeze = CairoRenderer.freeze_current_frame

                def play(self, scn, *args, **kwargs):
                    state["play"] += 1
                    state["frame"] = 0
                    return original_play(self, scn, *args, **kwargs)

                def render(self, scn, t, moving_mobjects=None):
                    import numpy as np

                    n = len(np.arange(0, scn.duration, 1 / manim.config.frame_rate))
                    i = state["frame"]
                    if i in (0, n // 2, n - 1):
                        frames.append([state["play"], i, n, layers(moving_mobjects)])
                    state["frame"] += 1
                    return original_render(self, scn, t, moving_mobjects)

                def freeze(self, duration):
                    # a still wait: the picture update_frame(moving objects) just drew
                    frames.append([state["play"], 0, int(duration / (1 / self.camera.frame_rate)),
                                   layers(scene.moving_mobjects)])
                    return original_freeze(self, duration)

                CairoRenderer.play, CairoRenderer.render, CairoRenderer.freeze_current_frame = play, render, freeze
                error = None
                try:
                    scene.setup()
                    scene.construct()
                except Exception as e:  # noqa: BLE001 - the engine should fail the same step
                    error = f"{type(e).__name__}: {e}"[:300]
                finally:
                    CairoRenderer.play, CairoRenderer.render, CairoRenderer.freeze_current_frame = (
                        original_play, original_render, original_freeze)
                tex = tex_ids()
                end = [[], [draw_state(m, id(m) in tex) for m in camera.get_mobjects_to_display(
                    list_update(scene.mobjects, scene.foreground_mobjects))]]
                out.append({"name": f"{name}/{scene_model.name}", "plan": plan, "frames": frames, "end": end,
                            "error": error})
                print(name, scene_model.name, len(frames), "frames", error or "")
    return {"fps": TIMELINE_FPS, "files": FILES, "svg": (OUT / "svg" / "structure.svg").read_text(encoding="utf-8"),
            "picture": [40, 30], "scenes": out}


def camera_state(m, camera, tex: bool = False) -> dict:
    """What a camera draws of one object: its points as the camera transforms them, and its colours as the camera
    shades them (3D)."""
    from manim import VMobject

    entry = {"cls": type(m).__name__, "points": camera.transform_points_pre_display(m, m.points).tolist()}
    if tex:
        entry["tex"] = True
    if isinstance(m, VMobject):
        entry |= {"fill": camera.get_fill_rgbas(m).tolist(), "stroke": camera.get_stroke_rgbas(m).tolist(),
                  "stroke_width": float(m.get_stroke_width()),
                  "background_stroke": camera.get_stroke_rgbas(m, background=True).tolist(),
                  "background_stroke_width": float(m.get_stroke_width(background=True))}
    return entry


KINDS_PROJECTS = ["three_d_roles", "linear_roles"]  # plus actions_*, actions_changed_*, settings_* of every kind


@section
def kinds():
    """Every scene kind (the golden actions and settings projects) played by Manim from the generated Python: at
    the first, middle and last frame of every play (and the one picture of a still wait), the camera and what it
    draws: the still picture's objects, then the objects drawn over it, with the points as the camera transforms
    them; for a ZoomedScene also the zoomed camera's frame and what it draws."""
    import tempfile

    import manim
    import manim_frames
    import numpy as np
    from manim.camera.multi_camera import MultiCamera
    from manim.camera.three_d_camera import ThreeDCamera
    from manim.renderer.cairo_renderer import CairoRenderer
    from manim.utils.iterables import list_difference_update, list_update

    sys.path.insert(0, str(ROOT / "tests"))
    from fixture_projects import FILES, golden_projects

    from manimator import codegen
    from manimator.plan import scene_plan
    from manimator.registry.scenes import SCENE_KINDS

    manim_frames._prepare()
    for cls in (manim.Text, manim.MarkupText, manim.Paragraph):
        cls.set_default(font="DejaVu Sans")
    tex_init = manim.SingleStringMathTex.__init__

    def marked_init(self, *args, **kwargs):
        tex_init(self, *args, **kwargs)
        for m in self.get_family():
            m._fixture_tex = True

    manim.SingleStringMathTex.__init__ = marked_init
    projects = golden_projects()
    names = [f"{group}_{kind}" for kind in SCENE_KINDS for group in ("actions", "actions_changed", "settings")]
    out = []
    try:
        with tempfile.TemporaryDirectory() as tmp, manim.tempconfig({
                "frame_rate": TIMELINE_FPS, "pixel_width": 320, "pixel_height": 180, "disable_caching": True,
                "write_to_movie": False, "progress_bar": "none"}):
            folder = Path(tmp)
            from PIL import Image

            Image.new("RGBA", (40, 30), (200, 120, 40, 255)).save(folder / FILES["ImageMobject"])
            (folder / FILES["SVGMobject"]).write_text((OUT / "svg" / "structure.svg").read_text(encoding="utf-8"),
                                                     encoding="utf-8")
            for name in names + KINDS_PROJECTS:
                project = projects[name]
                for scene_model in project.scenes:
                    plan = scene_plan(scene_model, project)
                    with codegen.asset_root(folder.as_posix()):
                        source = codegen.scene_source(scene_model, project, "Fixture")
                    ns: dict = {}
                    exec("from manim import *\nimport numpy as np\n" + source, ns)  # noqa: S102 - our own code
                    scene = ns["Fixture"]()
                    renderer = scene.renderer
                    fw = renderer.file_writer
                    for attr in ("write_frame", "begin_animation", "end_animation", "add_partial_movie_file"):
                        setattr(fw, attr, lambda *a, **k: None)
                    frames = []
                    state = {"play": -1, "frame": 0}

                    def info(mobjects, scene=scene, renderer=renderer):
                        camera = renderer.camera
                        tex = {id(m) for m in scene.get_mobject_family_members() if getattr(m, "_fixture_tex", False)}
                        still = scene.static_mobjects if renderer.static_image is not None else []
                        over = mobjects or list_update(scene.mobjects, scene.foreground_mobjects)
                        if isinstance(camera, ThreeDCamera):
                            camera.reset_rotation_matrix()
                            cam = {"phi": camera.get_phi(), "theta": camera.get_theta(), "gamma": camera.get_gamma(),
                                   "zoom": camera.get_zoom(), "focal": camera.get_focal_distance(),
                                   "center": np.asarray(camera.frame_center).tolist()}
                        else:
                            cam = {"center": np.asarray(camera.frame_center).tolist(),
                                   "width": float(camera.frame_width), "height": float(camera.frame_height)}
                        data = {"camera": cam, "layers": [
                            [camera_state(m, camera, id(m) in tex) for m in camera.get_mobjects_to_display(still)],
                            [camera_state(m, camera, id(m) in tex) for m in camera.get_mobjects_to_display(over)]]}
                        if isinstance(camera, MultiCamera):
                            zoomed = []
                            for imfc in camera.image_mobjects_from_cameras:
                                sub = imfc.camera
                                to_add = list_difference_update(list(over), imfc.get_family())
                                zoomed.append({"center": np.asarray(sub.frame_center).tolist(),
                                               "width": float(sub.frame_width), "height": float(sub.frame_height),
                                               "drawn": [camera_state(m, sub, id(m) in tex)
                                                         for m in sub.get_mobjects_to_display(to_add)]})
                            data["zoomed"] = zoomed
                        return data

                    original_play = CairoRenderer.play
                    original_render = CairoRenderer.render
                    original_freeze = CairoRenderer.freeze_current_frame

                    def play(self, scn, *args, state=state, **kwargs):
                        state["play"] += 1
                        state["frame"] = 0
                        return original_play(self, scn, *args, **kwargs)

                    def render(self, scn, t, moving_mobjects=None, info=info, state=state, frames=frames):
                        n = len(np.arange(0, scn.duration, 1 / manim.config.frame_rate))
                        i = state["frame"]
                        if i in (0, n // 2, n - 1):
                            frames.append([state["play"], i, n, info(moving_mobjects)])
                        state["frame"] += 1
                        return original_render(self, scn, t, moving_mobjects)

                    def freeze(self, duration, scene=scene, info=info, state=state, frames=frames):
                        frames.append([state["play"], 0, int(duration / (1 / self.camera.frame_rate)),
                                       info(scene.moving_mobjects)])
                        return original_freeze(self, duration)

                    CairoRenderer.play, CairoRenderer.render, CairoRenderer.freeze_current_frame = play, render, freeze
                    error = None
                    try:
                        scene.setup()
                        scene.construct()
                    except Exception as e:  # noqa: BLE001 - the engine should fail the same step
                        error = f"{type(e).__name__}: {e}"[:300]
                    finally:
                        CairoRenderer.play, CairoRenderer.render, CairoRenderer.freeze_current_frame = (
                            original_play, original_render, original_freeze)
                    renderer.static_image = None
                    end = info(None)
                    out.append({"name": f"{name}/{scene_model.name}", "kind": scene_model.kind, "plan": plan,
                                "frames": frames, "end": end, "error": error})
                    print(name, scene_model.name, len(frames), "frames", error or "")
    finally:
        manim.SingleStringMathTex.__init__ = tex_init
    return {"fps": TIMELINE_FPS, "files": FILES, "svg": (OUT / "svg" / "structure.svg").read_text(encoding="utf-8"),
            "picture": [40, 30], "scenes": out}


def main(argv: list[str]) -> None:
    names = argv or list(SECTIONS)
    OUT.mkdir(parents=True, exist_ok=True)
    for name in names:
        data = SECTIONS[name]()
        text = json.dumps(_num(data), separators=(",", ":"))
        # gzipped (some are tens of MB as JSON); mtime 0, so the same data gives the same bytes
        (OUT / f"{name}.json.gz").write_bytes(gzip.compress(text.encode("utf-8"), compresslevel=9, mtime=0))
        (OUT / f"{name}.json").unlink(missing_ok=True)
        print(f"{name}.json.gz")


if __name__ == "__main__":
    main(sys.argv[1:])
