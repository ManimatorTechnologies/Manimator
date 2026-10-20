"""Mobjects available in the palette."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

from ..calltree import Call, Dict, Lambda, Lit, Seq
from .colors import color_code, normalize
from .custom import UNAVAILABLE, SpecTable, Unavailable
from .params import (
    ANGLE, BOOL, COLOR, DIRECTION, ENUM, EXPR, FILE, FLOAT, FONT, GRID, INT, MOBREF, MOBREFS, NO_ORIGIN,
    NUMBERS, POINT, POINT3, POINTS, RANGE, STR, TEXT, VECTOR, Param,
)

# Style kinds decide which style controls the inspector shows and how codegen applies them.
SHAPE = "shape"  # stroke_color/width/opacity + fill_color/opacity
LINE = "line"  # color + stroke width/opacity
TEXTISH = "text"  # color (None = keep the object's own colors) + opacity
COORDS = "coords"  # optional color only
OPACITY = "opacity"  # opacity only (images)
NONE = "none"  # no style controls (groups, objects with their own colors)


@dataclass(frozen=True)
class MobjectSpec:
    key: str
    category: str
    icon: str
    name: str  # base variable name for new objects
    style_kind: str
    default_style: dict
    params: tuple[Param, ...] = ()
    # Width/opacity values Manim gives this class on its own; codegen leaves out
    # style arguments that equal these so the generated code stays short.
    natural: dict = field(default_factory=dict)
    # Params holding absolute points (lines). Moving the object moves these.
    point_params: tuple[str, ...] = ()
    # False for objects built around another object (Brace, SurroundingRectangle) or
    # drawn in absolute scene coordinates (function graphs).
    positioned: bool = True
    description: str = ""
    # Builds the constructor call for objects that aren't a plain `Type(args)` call.
    # Receives codegen.Args and returns a calltree.Call, such as Call("Polygon", (point, ...)).
    build: Callable | None = None
    # Scale a new object starts with (big tables, matrices).
    initial_scale: float = 1.0
    # Needs a ThreeDScene; adding one switches its scene to 3D.
    three_d: bool = False
    # A custom object from a code package (registry/custom.py): {"id", "version", "class", "module", ...}
    kit: dict | None = None
    # A custom object whose package isn't available: it draws nothing and its object reports why.
    blocked: bool = False

    @property
    def needs_target(self) -> bool:
        return any(p.kind == MOBREF for p in self.params)

    @property
    def target_param(self) -> Param | None:
        return next((p for p in self.params if p.kind == MOBREF), None)

    @property
    def group_param(self) -> Param | None:
        """The param listing member objects (VGroup, Cutout holes), if any."""
        return next((p for p in self.params if p.kind == MOBREFS), None)

    @property
    def accepts_selection(self) -> bool:
        return self.needs_target or self.group_param is not None


def _shape(color: str, fill_opacity: float = 0.0, stroke_width: float = 4.0) -> dict:
    return {
        "stroke_color": color,
        "stroke_width": stroke_width,
        "stroke_opacity": 1.0,
        "fill_color": color,
        "fill_opacity": fill_opacity,
    }


def _line(color: str, stroke_width: float = 4.0) -> dict:
    return {"color": color, "stroke_width": stroke_width, "stroke_opacity": 1.0}


def _text(color: str | None = "#FFFFFF") -> dict:
    return {"color": color, "opacity": 1.0}


_NAT_SHAPE = {"stroke_width": 4.0, "stroke_opacity": 1.0, "fill_opacity": 0.0}
_NAT_FILLED = {"stroke_width": 0.0, "stroke_opacity": 1.0, "fill_opacity": 1.0}
_NAT_LINE = {"stroke_width": 4.0, "stroke_opacity": 1.0}

_SIZE = dict(min=0.01, max=50.0, step=0.1, emit_default=True)
_FONT_SIZE = Param("font_size", FLOAT, 48.0, min=1, max=500, step=2, decimals=0)
_START = Param("start", POINT, [-1.0, 0.0], emit_default=True)
_END = Param("end", POINT, [1.0, 0.0], emit_default=True)
_TARGET = Param("mobject", MOBREF, None, label="Target", positional=True)


def _fs(default: float = 48.0) -> Param:
    return Param("font_size", FLOAT, default, min=1, max=500, step=2, decimals=0, emit_default=True)


def _lines(text: str) -> list[str]:
    return [ln for ln in str(text).split("\n") if ln.strip()] or [" "]


def _csv(text: str) -> list[str]:
    return [t.strip() for t in str(text).split(",") if t.strip()]


_CODE_LANGUAGES = tuple((k, k) for k in ("python", "javascript", "typescript", "c", "cpp", "java", "rust", "go",
                                          "bash", "html", "css", "json", "sql"))
_CODE_STYLES = tuple((k, k) for k in ("vim", "monokai", "dracula", "native", "github-dark", "one-dark",
                                       "solarized-dark", "solarized-light", "default"))


# ------------------------------------------------------------------ builders (see MobjectSpec.build)
# Each gets codegen.Args (the values as call-tree nodes) and returns a calltree.Call.


def _kw(**kwargs) -> tuple:
    return tuple(kwargs.items())


def _true() -> Lit:
    return Lit("True", True)


def _polygon(a):
    return Call("Polygon", tuple(a.pt(p) for p in a.raw("points")))


def _arc_polygon(a):
    return Call("ArcPolygon", tuple(a.pt(p) for p in a.raw("points")), _kw(angle=a.code("angle")))


def _polygram(a):
    n = int(a.raw("num_vertices"))
    density = max(1, min(int(a.raw("density")), n - 1))
    return Call("RegularPolygram", (Lit(str(n), n),), _kw(density=Lit(str(density), density), radius=a.code("radius")))


def _arc_between(a):
    return Call("ArcBetweenPoints", (a.code("start"), a.code("end")), _kw(angle=a.code("angle")))


def _curved(cls):
    return lambda a: Call(cls, (a.code("start"), a.code("end")), _kw(angle=a.code("angle")))


def _labeled_line(cls):
    return lambda a: Call(cls, (a.code("label"),), _kw(label_position=a.code("label_position"),
                                                       start=a.code("start"), end=a.code("end")))


def _angle(right: bool):
    def build(a):
        v, p1, p2 = (a.code(k) for k in ("vertex", "p1", "p2"))
        l1, l2 = Call("Line", (v, p1)), Call("Line", (v, p2))
        if right:
            core = Call("RightAngle", (l1, l2), _kw(length=a.code("length")))
        else:
            core = Call("Angle", (l1, l2), _kw(radius=a.code("radius"), other_angle=a.code("other_angle")))
        return Call("VGroup", (l1, l2, core)) if a.raw("show_lines") else core
    return build


def _paragraph(a):
    items = tuple(a.s(ln) for ln in _lines(a.raw("text")))
    font = {"font": a.code("font")} if a.raw("font") else {}
    return Call("Paragraph", items, _kw(alignment=a.code("alignment"), font_size=a.code("font_size"), **font,
                                        line_spacing=a.code("line_spacing")))


# Manim puts lines 1.3 font sizes apart (line_spacing -1, or 0.3), which leaves them nearly touching; Manimator's
# text is looser. It only matters for text of several lines, so a one-line Text leaves it out.
LINE_SPACING = 0.75


def _several_lines(values: dict) -> bool:
    return "\n" in str(values.get("text", ""))


def _line_spacing(**extra) -> Param:
    return Param("line_spacing", FLOAT, LINE_SPACING, label="Line spacing", min=0.0, max=3.0, step=0.05,
                 tooltip="Room between lines, as a share of the font size (Manim's own default is 0.3)", **extra)


def _bulleted(a):
    items = tuple(a.s(ln) for ln in _lines(a.raw("text")))
    return Call("BulletedList", items, _kw(font_size=a.code("font_size")))


def _code(a):
    return Call("Code", (), _kw(code_string=a.code("code"), language=a.code("language"),
                                formatter_style=a.code("style"), add_line_numbers=a.code("line_numbers"),
                                background=a.code("background")))


def _labels(a, name: str) -> tuple | None:
    items = _csv(a.raw(name))
    return (name, Seq(tuple(Call("Text", (a.s(t),)) for t in items))) if items else None


def _decimals(n: int) -> Dict:
    return Dict((("num_decimal_places", Lit(str(n), n)),))


def _table(cls, decimals: bool = False):
    def build(a):
        kwargs = []
        for name in ("col_labels", "row_labels"):
            label = _labels(a, name)
            if label:
                kwargs.append(label)
        if a.raw("include_outer_lines"):
            kwargs.append(("include_outer_lines", _true()))
        if decimals:
            kwargs.append(("element_to_mobject_config", _decimals(int(a.raw("decimals")))))
        return Call(cls, (a.code("cells"),), tuple(kwargs))
    return build


def _decimal_matrix(a):
    return Call("DecimalMatrix", (a.code("cells"),), _kw(element_to_mobject_config=_decimals(int(a.raw("decimals")))))


def _function_graph(a):
    return Call("FunctionGraph", (Lambda(("x",), a.expr("expr")),), _kw(x_range=a.code("x_range")))


def _array(*items):
    return Call("np.array", (Seq(tuple(items)),))


def _parametric(a):
    return Call("ParametricFunction", (Lambda(("t",), _array(a.expr("x_expr"), a.expr("y_expr"), Lit("0", 0))),),
                _kw(t_range=a.code("t_range")))


def _pair(a, name):
    lo, hi = a.raw(name)[:2]
    return Seq((a.num(lo), a.num(hi)))


def _implicit(a):
    return Call("ImplicitFunction", (Lambda(("x", "y"), a.expr("expr")),),
                _kw(x_range=_pair(a, "x_range"), y_range=_pair(a, "y_range")))


def _vector_field(a):
    sub = {"x": "p[0]", "y": "p[1]"}
    func = Lambda(("p",), _array(a.expr("fx", sub), a.expr("fy", sub), Lit("0", 0)), (("x", "p", 0), ("y", "p", 1)))
    return Call("ArrowVectorField", (func,), _kw(x_range=a.code("x_range"), y_range=a.code("y_range")))


def _bar_chart(a):
    kwargs = []
    names = _csv(a.raw("bar_names"))
    if names:
        kwargs.append(("bar_names", Seq(tuple(a.s(n) for n in names))))
    kwargs += [("y_range", a.code("y_range")), ("x_length", a.code("x_length")), ("y_length", a.code("y_length"))]
    return Call("BarChart", (Seq(tuple(a.num(v) for v in a.raw("values"))),), tuple(kwargs))


_EDGE = re.compile(r"(\d+)\s*(?:-+>?|>)\s*(\d+)")


def _graph(cls):
    def build(a):
        n = int(a.raw("vertices"))
        edges = [(int(u), int(v)) for u, v in _EDGE.findall(str(a.raw("edges"))) if int(u) < n and int(v) < n]
        layout = a.raw("layout")
        vertices = Lit(f"list(range({n}))", list(range(n)))
        edge_list = Lit(f"[{', '.join(f'({u}, {v})' for u, v in edges)}]", [[u, v] for u, v in edges])
        kwargs = [("layout", a.code("layout")), ("layout_scale", a.code("layout_scale")), ("labels", a.code("labels"))]
        if layout in ("spring", "random"):
            seed = int(a.raw("seed"))
            kwargs.append(("layout_config", Dict((("seed", Lit(str(seed), seed)),))))
        return Call(cls, (vertices, edge_list), tuple(kwargs))
    return build


def _image(a):
    path = a.raw("file")
    if not path:
        raise ValueError("choose an image file")
    return Call("ImageMobject", (a.code("file"),), then=(Call("scale_to_fit_height", (a.code("height"),)),))


def _svg(a):
    if not a.raw("file"):
        raise ValueError("choose an SVG file")
    return Call("SVGMobject", (a.code("file"),), _kw(height=a.code("height")))


def _brace_between(a):
    return Call("BraceBetweenPoints", (a.code("point_1"), a.code("point_2")), _kw(direction=a.code("direction")))


def _group(cls):
    return lambda a: Call(cls, a.refs("members"))


def _cutout(a):
    return Call("Cutout", (a.code("shape"), *a.refs("holes")))


def _resolution(n: int, m: int) -> Lit:
    return Lit(f"({n}, {m})", [n, m])


def _sphere(a):
    n = int(a.raw("resolution"))
    return Call("Sphere", (), _kw(radius=a.code("radius"), resolution=_resolution(n, 2 * n)))


def _prism(a):
    return Call("Prism", (), _kw(dimensions=Seq((a.code("width"), a.code("height"), a.code("depth")))))


def _torus(a):
    n = int(a.raw("resolution"))
    return Call("Torus", (), _kw(major_radius=a.code("major_radius"), minor_radius=a.code("minor_radius"),
                                 resolution=_resolution(n, n)))


def _line3d(a):
    return Call("Line3D", (), _kw(start=a.code("start"), end=a.code("end"), thickness=a.code("thickness")))


def _arrow3d(a):
    return Call("Arrow3D", (), _kw(start=a.code("start"), end=a.code("end"), thickness=a.code("thickness")))


def _surface(a):
    func = Lambda(("u", "v"), _array(a.expr("x_expr"), a.expr("y_expr"), a.expr("z_expr")))
    n = int(a.raw("resolution"))
    return Call("Surface", (func,), _kw(u_range=_pair(a, "u_range"), v_range=_pair(a, "v_range"),
                                        resolution=Lit(str(n), n)))


_SPECS = [
    # ---------------------------------------------------------------- Shapes
    MobjectSpec("Circle", "Shapes", "◯", "circle", SHAPE, _shape("#FC6255"),
                (Param("radius", FLOAT, 1.0, **_SIZE),), natural=_NAT_SHAPE),
    MobjectSpec("Square", "Shapes", "◻", "square", SHAPE, _shape("#58C4DD"),
                (Param("side_length", FLOAT, 2.0, **_SIZE),), natural=_NAT_SHAPE),
    MobjectSpec("Rectangle", "Shapes", "▭", "rect", SHAPE, _shape("#83C167"),
                (Param("width", FLOAT, 4.0, **_SIZE), Param("height", FLOAT, 2.0, **_SIZE)),
                natural=_NAT_SHAPE),
    MobjectSpec("RoundedRectangle", "Shapes", "▢", "rrect", SHAPE, _shape("#FFFFFF"),
                (Param("width", FLOAT, 4.0, **_SIZE), Param("height", FLOAT, 2.0, **_SIZE),
                 Param("corner_radius", FLOAT, 0.5, min=0, max=20, emit_default=True)),
                natural=_NAT_SHAPE),
    MobjectSpec("Triangle", "Shapes", "△", "triangle", SHAPE, _shape("#F7D96F"),
                natural=_NAT_SHAPE),
    MobjectSpec("Polygon", "Shapes", "⬠", "poly", SHAPE, _shape("#FF862F"),
                (Param("points", POINTS, [[-1.4, -0.9], [1.4, -0.9], [1.9, 0.4], [0.0, 1.5], [-1.9, 0.4]],
                       label="Corners", min_items=3, max_items=64,
                       tooltip="One corner per line, as x, y. The shape is centered on its position."),),
                natural=_NAT_SHAPE, build=_polygon, description="A shape through the corners you list"),
    MobjectSpec("RegularPolygon", "Shapes", "⬡", "polygon", SHAPE, _shape("#5CD0B3"),
                (Param("n", INT, 6, label="Sides", min=3, max=64, step=1, emit_default=True),),
                natural=_NAT_SHAPE),
    MobjectSpec("RegularPolygram", "Shapes", "✡", "polygram", SHAPE, _shape("#C55F73"),
                (Param("num_vertices", INT, 5, label="Points", min=3, max=64, step=1),
                 Param("density", INT, 2, min=1, max=32, step=1, tooltip="How many points each line skips"),
                 Param("radius", FLOAT, 1.5, **_SIZE)),
                natural=_NAT_SHAPE, build=_polygram, description="A star made of straight lines, like a pentagram"),
    MobjectSpec("Ellipse", "Shapes", "⬭", "ellipse", SHAPE, _shape("#9A72AC"),
                (Param("width", FLOAT, 2.0, **_SIZE), Param("height", FLOAT, 1.0, **_SIZE)),
                natural=_NAT_SHAPE),
    MobjectSpec("Star", "Shapes", "☆", "star", SHAPE, _shape("#F0AC5F"),
                (Param("n", INT, 5, label="Points", min=3, max=64, step=1, emit_default=True),
                 Param("outer_radius", FLOAT, 1.0, **_SIZE),
                 Param("inner_radius", FLOAT, 0.4, **_SIZE)),
                natural=_NAT_SHAPE),
    MobjectSpec("Dot", "Shapes", "•", "dot", SHAPE, _shape("#FFFFFF", fill_opacity=1.0, stroke_width=0.0),
                (Param("radius", FLOAT, 0.1, min=0.01, max=5, step=0.02, emit_default=True),),
                natural=_NAT_FILLED),
    MobjectSpec("AnnotationDot", "Shapes", "◉", "mark", SHAPE, _shape("#58C4DD", fill_opacity=1.0, stroke_width=5.0),
                (Param("radius", FLOAT, 0.1, min=0.01, max=5, step=0.02, emit_default=True),),
                natural={"stroke_width": 5.0, "stroke_opacity": 1.0, "fill_opacity": 1.0},
                description="A dot with a white outline, for marking points"),
    MobjectSpec("LabeledDot", "Shapes", "Ⓐ", "label_dot", NONE, {},
                (Param("label", STR, "A", positional=True, tooltip="LaTeX; shown in black on the dot"),
                 Param("dot_color", COLOR, "#FFFFFF", label="Color",
                       emit=lambda v: ("color", Lit(color_code(v), normalize(v))))),
                description="A dot with a letter or number inside"),
    MobjectSpec("Annulus", "Shapes", "◎", "ring", SHAPE, _shape("#C55F73", fill_opacity=1.0, stroke_width=0.0),
                (Param("inner_radius", FLOAT, 0.5, **_SIZE), Param("outer_radius", FLOAT, 1.0, **_SIZE)),
                natural=_NAT_FILLED),
    MobjectSpec("Sector", "Shapes", "◔", "sector", SHAPE, _shape("#83C167", fill_opacity=1.0, stroke_width=0.0),
                (Param("radius", FLOAT, 1.5, **_SIZE),
                 Param("angle", ANGLE, 60.0, label="Sweep", emit_default=True),
                 Param("start_angle", ANGLE, 0.0, emit_default=True)),
                natural=_NAT_FILLED, description="A slice of a circle, like a pie chart piece"),
    MobjectSpec("AnnularSector", "Shapes", "◑", "ring_slice", SHAPE,
                _shape("#F0AC5F", fill_opacity=1.0, stroke_width=0.0),
                (Param("inner_radius", FLOAT, 0.7, **_SIZE), Param("outer_radius", FLOAT, 1.5, **_SIZE),
                 Param("angle", ANGLE, 90.0, label="Sweep", emit_default=True),
                 Param("start_angle", ANGLE, 0.0, emit_default=True)),
                natural=_NAT_FILLED, description="A slice of a ring"),
    MobjectSpec("ArcPolygon", "Shapes", "⬟", "arc_poly", SHAPE, _shape("#5CD0B3"),
                (Param("points", POINTS, [[-1.5, -1.0], [1.5, -1.0], [0.0, 1.5]], label="Corners",
                       min_items=3, max_items=64, tooltip="One corner per line, as x, y"),
                 Param("angle", ANGLE, 30.0, label="Curve", emit_default=True,
                       tooltip="How much each side bulges")),
                natural=_NAT_SHAPE, build=_arc_polygon, description="A shape whose sides are curved arcs"),
    # ---------------------------------------------------------------- Arcs & angles
    MobjectSpec("Arc", "Arcs & angles", "◜", "arc", LINE, _line("#FF862F"),
                (Param("radius", FLOAT, 1.0, **_SIZE),
                 Param("start_angle", ANGLE, 0.0, emit_default=True),
                 Param("angle", ANGLE, 90.0, label="Sweep", emit_default=True)),
                natural=_NAT_LINE),
    MobjectSpec("ArcBetweenPoints", "Arcs & angles", "⌒", "arc_between", LINE, _line("#FF862F"),
                (_START, _END, Param("angle", ANGLE, 90.0, label="Bend", emit_default=True)),
                natural=_NAT_LINE, point_params=("start", "end"), build=_arc_between,
                description="A curved line from one point to another"),
    MobjectSpec("CurvedArrow", "Arcs & angles", "↷", "curved_arrow", LINE, _line("#FFFFFF"),
                (_START, _END, Param("angle", ANGLE, 90.0, label="Bend", emit_default=True)),
                natural=_NAT_LINE, point_params=("start", "end"), build=_curved("CurvedArrow")),
    MobjectSpec("CurvedDoubleArrow", "Arcs & angles", "⥊", "curved_darrow", LINE, _line("#FFFFFF"),
                (_START, _END, Param("angle", ANGLE, 90.0, label="Bend", emit_default=True)),
                natural=_NAT_LINE, point_params=("start", "end"), build=_curved("CurvedDoubleArrow")),
    MobjectSpec("Elbow", "Arcs & angles", "⌐", "elbow", LINE, _line("#FFFFFF"),
                (Param("width", FLOAT, 0.8, **_SIZE), Param("angle", ANGLE, 0.0, emit_default=True)),
                natural=_NAT_LINE, description="A right-angle bracket"),
    MobjectSpec("Angle", "Arcs & angles", "∠", "angle", LINE, _line("#F7D96F"),
                (Param("vertex", POINT, [0.0, 0.0]), Param("p1", POINT, [2.0, 0.0], label="End of side 1"),
                 Param("p2", POINT, [1.2, 1.6], label="End of side 2"),
                 Param("radius", FLOAT, 0.7, min=0.1, max=10, step=0.1),
                 Param("other_angle", BOOL, False, label="Other side", tooltip="Measure the outside angle"),
                 Param("show_lines", BOOL, True, label="Draw sides")),
                point_params=("vertex", "p1", "p2"), build=_angle(False),
                description="The angle between two lines meeting at a corner"),
    MobjectSpec("RightAngle", "Arcs & angles", "∟", "right_angle", LINE, _line("#F7D96F"),
                (Param("vertex", POINT, [0.0, 0.0]), Param("p1", POINT, [2.0, 0.0], label="End of side 1"),
                 Param("p2", POINT, [0.0, 1.6], label="End of side 2"),
                 Param("length", FLOAT, 0.4, min=0.05, max=5, step=0.05),
                 Param("show_lines", BOOL, True, label="Draw sides")),
                point_params=("vertex", "p1", "p2"), build=_angle(True),
                description="A square corner mark between two lines"),
    # ---------------------------------------------------------------- Lines
    MobjectSpec("Line", "Lines", "╱", "line", LINE, _line("#FFFFFF"),
                (_START, _END), natural=_NAT_LINE, point_params=("start", "end")),
    MobjectSpec("Arrow", "Lines", "→", "arrow", LINE, _line("#FFFFFF", 6.0),
                (_START, _END, Param("buff", FLOAT, 0.0, min=0, max=5, emit_default=True,
                                     tooltip="Gap left at both ends")),
                natural={"stroke_width": 6.0, "stroke_opacity": 1.0}, point_params=("start", "end")),
    MobjectSpec("DoubleArrow", "Lines", "↔", "darrow", LINE, _line("#FFFFFF", 6.0),
                (_START, _END, Param("buff", FLOAT, 0.0, min=0, max=5, emit_default=True)),
                natural={"stroke_width": 6.0, "stroke_opacity": 1.0}, point_params=("start", "end")),
    MobjectSpec("DashedLine", "Lines", "┄", "dashed", LINE, _line("#FFFFFF"),
                (_START, _END, Param("dash_length", FLOAT, 0.05, min=0.01, max=5, step=0.05),
                 Param("dashed_ratio", FLOAT, 0.5, min=0.05, max=0.95, step=0.05)),
                natural=_NAT_LINE, point_params=("start", "end")),
    MobjectSpec("Vector", "Lines", "⇗", "vector", LINE, _line("#FFFFFF", 6.0),
                (Param("direction", VECTOR, [2.0, 1.0], label="Direction", emit_default=True),),
                natural={"stroke_width": 6.0, "stroke_opacity": 1.0},
                description="An arrow that starts at the origin (until you move it)"),
    MobjectSpec("LabeledLine", "Lines", "⊟", "labeled_line", LINE, _line("#FFFFFF"),
                (Param("label", STR, "label", positional=True),
                 Param("label_position", FLOAT, 0.5, min=0.05, max=0.95, step=0.05, slider=True,
                       label="Label position"), _START, _END),
                natural=_NAT_LINE, point_params=("start", "end"), build=_labeled_line("LabeledLine"),
                description="A line with a label on it"),
    MobjectSpec("LabeledArrow", "Lines", "⊳", "labeled_arrow", LINE, _line("#FFFFFF", 6.0),
                (Param("label", STR, "label", positional=True),
                 Param("label_position", FLOAT, 0.5, min=0.05, max=0.95, step=0.05, slider=True,
                       label="Label position"), _START, _END),
                natural={"stroke_width": 6.0, "stroke_opacity": 1.0}, point_params=("start", "end"),
                build=_labeled_line("LabeledArrow"), description="An arrow with a label on it"),
    # ---------------------------------------------------------------- Text & math
    MobjectSpec("Text", "Text", "T", "text", TEXTISH, _text(),
                (Param("text", TEXT, "Hello", positional=True),
                 Param("font_size", FLOAT, 48.0, min=1, max=500, step=2, decimals=0, emit_default=True),
                 Param("font", FONT, ""),
                 Param("weight", ENUM, "NORMAL", choices=(("NORMAL", "Normal"), ("BOLD", "Bold"),
                                                          ("LIGHT", "Light"), ("HEAVY", "Heavy"))),
                 Param("slant", ENUM, "NORMAL", choices=(("NORMAL", "Normal"), ("ITALIC", "Italic"),
                                                         ("OBLIQUE", "Oblique"))),
                 _line_spacing(emit_default=True, when=_several_lines)),
                description="Plain text rendered with Pango"),
    MobjectSpec("MarkupText", "Text", "𝐓", "markup", TEXTISH, _text(None),
                (Param("text", TEXT, "Hello <b>bold</b> <span fgcolor='#58C4DD'>blue</span>", positional=True),
                 Param("font_size", FLOAT, 48.0, min=1, max=500, step=2, decimals=0, emit_default=True),
                 Param("font", FONT, "")),
                description="Text with Pango markup"),
    MobjectSpec("MathTex", "Text", "∑", "eq", TEXTISH, _text(),
                (Param("tex", TEXT, r"e^{i\pi} + 1 = 0", label="LaTeX", positional=True),
                 Param("font_size", FLOAT, 48.0, min=1, max=500, step=2, decimals=0, emit_default=True)),
                description="LaTeX math mode"),
    MobjectSpec("Tex", "Text", "τ", "tex", TEXTISH, _text(),
                (Param("tex", TEXT, r"Hello \LaTeX", label="LaTeX", positional=True),
                 Param("font_size", FLOAT, 48.0, min=1, max=500, step=2, decimals=0, emit_default=True)),
                description="LaTeX text mode"),
    MobjectSpec("Title", "Text", "Ⓣ", "title", TEXTISH, _text(),
                (Param("text", TEXT, "A Great Title", label="LaTeX", positional=True),
                 Param("include_underline", BOOL, True, label="Underline", emit_default=True),
                 Param("font_size", FLOAT, 60.0, min=1, max=500, step=2, decimals=0, emit_default=True)),
                description="A title with a line under it"),
    MobjectSpec("Paragraph", "Text", "¶", "paragraph", TEXTISH, _text(),
                (Param("text", TEXT, "First line\nSecond line\nThird line", label="Lines"),
                 Param("alignment", ENUM, "center", choices=(("left", "Left"), ("center", "Center"),
                                                             ("right", "Right")), emit_default=True),
                 Param("font_size", FLOAT, 36.0, min=1, max=500, step=2, decimals=0, emit_default=True),
                 Param("font", FONT, ""), _line_spacing()),
                build=_paragraph, description="Several lines of plain text, one per line"),
    MobjectSpec("BulletedList", "Text", "☰", "bullets", TEXTISH, _text(),
                (Param("text", TEXT, "First point\nSecond point\nThird point", label="Items",
                       tooltip="One item per line (LaTeX)"),
                 Param("font_size", FLOAT, 40.0, min=1, max=500, step=2, decimals=0, emit_default=True)),
                build=_bulleted, description="A list with a dot before each item"),
    MobjectSpec("Code", "Text", "⌨", "code", NONE, {},
                (Param("code", TEXT, 'print("Hello, Manim!")\nfor i in range(3):\n    print(i)', label="Code"),
                 Param("language", ENUM, "python", choices=_CODE_LANGUAGES, emit_default=True),
                 Param("style", ENUM, "vim", label="Colors", choices=_CODE_STYLES, emit_default=True),
                 Param("line_numbers", BOOL, True, label="Line numbers", emit_default=True),
                 Param("background", ENUM, "rectangle", choices=(("rectangle", "Rectangle"), ("window", "Window")),
                       emit_default=True)),
                build=_code, initial_scale=1.3, description="A block of code with colors"),
    MobjectSpec("DecimalNumber", "Text", "1.0", "number", TEXTISH, _text(),
                (Param("number", FLOAT, 3.14, label="Value", min=-1e9, max=1e9, positional=True, decimals=4),
                 Param("num_decimal_places", INT, 2, label="Decimals", min=0, max=10, step=1, emit_default=True),
                 Param("font_size", FLOAT, 48.0, min=1, max=500, step=2, decimals=0, emit_default=True))),
    MobjectSpec("Integer", "Text", "7", "integer", TEXTISH, _text(),
                (Param("number", INT, 7, label="Value", min=-1000000000, max=1000000000, positional=True),
                 Param("font_size", FLOAT, 48.0, min=1, max=500, step=2, decimals=0, emit_default=True))),
    MobjectSpec("Variable", "Text", "x=", "variable", TEXTISH, _text(),
                (Param("var", FLOAT, 0.5, label="Value", min=-1e9, max=1e9, positional=True, decimals=3),
                 Param("label", STR, "x", positional=True, tooltip="LaTeX name shown before the value"),
                 Param("num_decimal_places", INT, 2, label="Decimals", min=0, max=10, step=1, emit_default=True)),
                description="A name and a number"),
    # ---------------------------------------------------------------- Tables & matrices
    MobjectSpec("Matrix", "Tables", "▤", "matrix", TEXTISH, _text(),
                (Param("matrix", GRID, [["1", "2"], ["3", "4"]], label="Entries", positional=True,
                       min_items=1, tooltip="One row per line; separate entries with commas or |. LaTeX works."),
                 Param("h_buff", FLOAT, 1.3, min=0.2, max=10, step=0.1, label="Column gap"),
                 Param("v_buff", FLOAT, 0.8, min=0.2, max=10, step=0.1, label="Row gap")),
                initial_scale=0.9, description="A matrix in square brackets"),
    MobjectSpec("IntegerMatrix", "Tables", "▥", "int_matrix", TEXTISH, _text(),
                (Param("matrix", GRID, [["1", "2"], ["3", "4"]], label="Entries", positional=True,
                       min_items=1, numeric=True),
                 Param("h_buff", FLOAT, 1.3, min=0.2, max=10, step=0.1, label="Column gap"),
                 Param("v_buff", FLOAT, 0.8, min=0.2, max=10, step=0.1, label="Row gap")),
                initial_scale=0.9, description="A matrix of whole numbers"),
    MobjectSpec("DecimalMatrix", "Tables", "▦", "dec_matrix", TEXTISH, _text(),
                (Param("cells", GRID, [["1.5", "2"], ["3", "4.25"]], label="Entries", min_items=1, numeric=True),
                 Param("decimals", INT, 1, label="Decimals", min=0, max=8, step=1)),
                build=_decimal_matrix, initial_scale=0.9, description="A matrix of decimal numbers"),
    MobjectSpec("Table", "Tables", "▧", "table", TEXTISH, _text(),
                (Param("cells", GRID, [["Ann", "90"], ["Bob", "85"], ["Cy", "77"]], label="Cells",
                       min_items=1, tooltip="One row per line; separate cells with commas or |"),
                 Param("col_labels", STR, "Name, Score", label="Column labels",
                       tooltip="Comma separated, one per column. Leave empty for none."),
                 Param("row_labels", STR, "", label="Row labels", tooltip="Comma separated, one per row"),
                 Param("include_outer_lines", BOOL, False, label="Outer lines")),
                build=_table("Table"), initial_scale=0.6, description="A grid of text with lines between cells"),
    MobjectSpec("IntegerTable", "Tables", "▨", "int_table", TEXTISH, _text(),
                (Param("cells", GRID, [["1", "2", "3"], ["4", "5", "6"]], label="Cells", min_items=1, numeric=True),
                 Param("col_labels", STR, "", label="Column labels"),
                 Param("row_labels", STR, "", label="Row labels"),
                 Param("include_outer_lines", BOOL, False, label="Outer lines")),
                build=_table("IntegerTable"), initial_scale=0.8, description="A table of whole numbers"),
    MobjectSpec("DecimalTable", "Tables", "▩", "dec_table", TEXTISH, _text(),
                (Param("cells", GRID, [["1.5", "2.25"], ["3", "4.5"]], label="Cells", min_items=1, numeric=True),
                 Param("col_labels", STR, "", label="Column labels"),
                 Param("row_labels", STR, "", label="Row labels"),
                 Param("include_outer_lines", BOOL, False, label="Outer lines"),
                 Param("decimals", INT, 2, label="Decimals", min=0, max=8, step=1)),
                build=_table("DecimalTable", decimals=True), initial_scale=0.8,
                description="A table of decimal numbers"),
    # ---------------------------------------------------------------- Graphs & coordinates
    MobjectSpec("NumberLine", "Graphs", "⟷", "number_line", COORDS, {"color": None},
                (Param("x_range", RANGE, [-5.0, 5.0, 1.0], emit_default=True),
                 Param("length", FLOAT, 10.0, **_SIZE),
                 Param("include_numbers", BOOL, False),
                 Param("include_tip", BOOL, False))),
    MobjectSpec("NumberPlane", "Graphs", "▦", "plane", COORDS, {"color": None},
                (Param("x_range", RANGE, [-7.0, 7.0, 1.0], emit_default=True),
                 Param("y_range", RANGE, [-4.0, 4.0, 1.0], emit_default=True))),
    MobjectSpec("ComplexPlane", "Graphs", "ℂ", "complex_plane", COORDS, {"color": None},
                (Param("x_range", RANGE, [-5.0, 5.0, 1.0], emit_default=True),
                 Param("y_range", RANGE, [-3.0, 3.0, 1.0], emit_default=True)),
                description="A number plane for complex numbers"),
    MobjectSpec("PolarPlane", "Graphs", "◎", "polar_plane", COORDS, {"color": None},
                (Param("radius_max", FLOAT, 3.0, min=0.5, max=20, step=0.5, emit_default=True),
                 Param("radius_step", FLOAT, 1.0, min=0.1, max=10, step=0.5, emit_default=True)),
                description="Circles and angle lines for polar coordinates"),
    MobjectSpec("Axes", "Graphs", "┼", "axes", COORDS, {"color": None},
                (Param("x_range", RANGE, [-5.0, 5.0, 1.0], emit_default=True),
                 Param("y_range", RANGE, [-3.0, 3.0, 1.0], emit_default=True),
                 Param("x_length", FLOAT, 10.0, **_SIZE),
                 Param("y_length", FLOAT, 6.0, **_SIZE),
                 Param("tips", BOOL, True),
                 Param("include_numbers", BOOL, False,
                       emit=lambda v: ("axis_config", Dict((("include_numbers", _true()),))) if v else None))),
    MobjectSpec("FunctionGraph", "Graphs", "∿", "graph", LINE, _line("#FFFF00"),
                (Param("expr", EXPR, "sin(x)", label="y =", variables=("x",),
                       tooltip="A formula in x. Functions: sin cos tan exp log sqrt abs"),
                 Param("x_range", RANGE, [-5.0, 5.0, 0.05], label="x range", emit_default=True,
                       tooltip="From, to, and the step between points")),
                natural=_NAT_LINE, positioned=False, build=_function_graph,
                description="The curve y = f(x), drawn at scene coordinates"),
    MobjectSpec("ParametricFunction", "Graphs", "➰", "curve", LINE, _line("#F0AC5F"),
                (Param("x_expr", EXPR, "2*sin(3*t)", label="x(t) =", variables=("t",)),
                 Param("y_expr", EXPR, "2*sin(2*t)", label="y(t) =", variables=("t",)),
                 Param("t_range", RANGE, [0.0, 6.2832, 0.02], label="t range", emit_default=True)),
                natural=_NAT_LINE, positioned=False, build=_parametric,
                description="A curve from x(t) and y(t), drawn at scene coordinates"),
    MobjectSpec("ImplicitFunction", "Graphs", "◌", "implicit", LINE, _line("#5CD0B3"),
                (Param("expr", EXPR, "x**2 + y**2 - 4", label="f(x, y) =", variables=("x", "y"),
                       tooltip="The curve where this equals 0"),
                 Param("x_range", RANGE, [-4.0, 4.0, 1.0], label="x range", emit_default=True),
                 Param("y_range", RANGE, [-3.0, 3.0, 1.0], label="y range", emit_default=True)),
                natural=_NAT_LINE, positioned=False, build=_implicit,
                description="The curve where f(x, y) = 0"),
    MobjectSpec("BarChart", "Graphs", "▥", "chart", COORDS, {"color": None},
                (Param("values", NUMBERS, [3.0, 5.0, 2.0, 6.0, 4.0], label="Values", min_items=1, max_items=24,
                       tooltip="Bar heights, separated by commas"),
                 Param("bar_names", STR, "A, B, C, D, E", label="Names", tooltip="Comma separated, one per bar"),
                 Param("y_range", RANGE, [0.0, 8.0, 2.0], label="y range", emit_default=True),
                 Param("x_length", FLOAT, 7.0, **_SIZE), Param("y_length", FLOAT, 4.0, **_SIZE)),
                build=_bar_chart, description="A bar chart"),
    MobjectSpec("ArrowVectorField", "Graphs", "⇉", "field", COORDS, {"color": None},
                (Param("fx", EXPR, "-y", label="x part", variables=("x", "y"), tooltip="Arrow x part at (x, y)"),
                 Param("fy", EXPR, "x", label="y part", variables=("x", "y"), tooltip="Arrow y part at (x, y)"),
                 Param("x_range", RANGE, [-5.0, 5.0, 1.0], emit_default=True),
                 Param("y_range", RANGE, [-3.0, 3.0, 1.0], emit_default=True)),
                positioned=False, build=_vector_field,
                description="A grid of arrows from a formula, drawn at scene coordinates"),
    MobjectSpec("Graph", "Graphs", "⚯", "graph_net", COORDS, {"color": None},
                (Param("vertices", INT, 5, label="Vertices", min=1, max=40, step=1),
                 Param("edges", STR, "0-1, 1-2, 2-3, 3-4, 4-0, 0-2", label="Edges",
                       tooltip="Pairs of vertex numbers, like 0-1, 1-2"),
                 Param("layout", ENUM, "circular", choices=(("circular", "Circle"), ("spring", "Spring"),
                                                            ("shell", "Shell"), ("spectral", "Spectral"),
                                                            ("kamada_kawai", "Kamada-Kawai"), ("random", "Random"))),
                 Param("layout_scale", FLOAT, 2.0, label="Size", min=0.5, max=10, step=0.5),
                 Param("labels", BOOL, True, label="Numbers"),
                 Param("seed", INT, 1, min=0, max=9999, step=1, tooltip="Spring and random layouts only")),
                build=_graph("Graph"), description="Dots joined by lines (a network)"),
    MobjectSpec("DiGraph", "Graphs", "➲", "digraph", COORDS, {"color": None},
                (Param("vertices", INT, 5, label="Vertices", min=1, max=40, step=1),
                 Param("edges", STR, "0-1, 1-2, 2-3, 3-4, 4-0", label="Edges",
                       tooltip="Pairs of vertex numbers, like 0-1, 1-2"),
                 Param("layout", ENUM, "circular", choices=(("circular", "Circle"), ("spring", "Spring"),
                                                            ("shell", "Shell"), ("spectral", "Spectral"),
                                                            ("kamada_kawai", "Kamada-Kawai"), ("random", "Random"))),
                 Param("layout_scale", FLOAT, 2.0, label="Size", min=0.5, max=10, step=0.5),
                 Param("labels", BOOL, True, label="Numbers"),
                 Param("seed", INT, 1, min=0, max=9999, step=1, tooltip="Spring and random layouts only")),
                build=_graph("DiGraph"), description="A network whose lines are arrows"),
    # ---------------------------------------------------------------- Media
    MobjectSpec("ImageMobject", "Media", "🖼", "image", OPACITY, {"opacity": 1.0},
                (Param("file", FILE, "", label="Image", accept="image"),
                 Param("height", FLOAT, 3.0, **_SIZE)),
                build=_image, description="A picture from a file"),
    MobjectSpec("SVGMobject", "Media", "✎", "svg", TEXTISH, _text(None),
                (Param("file", FILE, "", label="SVG file", accept="svg"),
                 Param("height", FLOAT, 3.0, **_SIZE)),
                build=_svg, description="A vector drawing from an SVG file"),
    # ---------------------------------------------------------------- Helpers (attach to a target)
    MobjectSpec("Brace", "Helpers", "⏟", "brace", TEXTISH, _text(),
                (_TARGET,
                 Param("direction", DIRECTION, "DOWN", choices=NO_ORIGIN, emit_default=True),
                 Param("buff", FLOAT, 0.2, min=0, max=5)),
                positioned=False, description="A curly brace next to the target"),
    MobjectSpec("BraceLabel", "Helpers", "⏞", "brace_label", TEXTISH, _text(),
                (_TARGET,
                 Param("text", STR, "label", positional=True, tooltip="LaTeX shown next to the brace"),
                 Param("brace_direction", DIRECTION, "DOWN", label="Side", choices=NO_ORIGIN, emit_default=True),
                 Param("font_size", FLOAT, 36.0, min=1, max=500, step=2, decimals=0, emit_default=True)),
                positioned=False, description="A brace with a label, next to the target"),
    MobjectSpec("BraceBetweenPoints", "Helpers", "⌓", "brace_pts", TEXTISH, _text(),
                (Param("point_1", POINT, [-1.5, 0.0], label="Point 1"),
                 Param("point_2", POINT, [1.5, 0.0], label="Point 2"),
                 Param("direction", DIRECTION, "DOWN", label="Side", choices=NO_ORIGIN, emit_default=True)),
                point_params=("point_1", "point_2"), build=_brace_between,
                description="A curly brace between two points"),
    MobjectSpec("SurroundingRectangle", "Helpers", "⬚", "box", SHAPE, _shape("#F7D96F"),
                (_TARGET,
                 Param("buff", FLOAT, 0.1, min=0, max=5),
                 Param("corner_radius", FLOAT, 0.0, min=0, max=5)),
                natural=_NAT_SHAPE, positioned=False, description="A box around the target"),
    MobjectSpec("BackgroundRectangle", "Helpers", "▰", "backdrop", SHAPE, _shape("#1C758A", fill_opacity=0.75, stroke_width=0.0),
                (_TARGET, Param("buff", FLOAT, 0.15, min=0, max=5, emit_default=True)),
                positioned=False, description="A filled box behind the target"),
    MobjectSpec("Underline", "Helpers", "_", "underline", LINE, _line("#FFFFFF"),
                (_TARGET, Param("buff", FLOAT, 0.1, min=0, max=5)),
                natural=_NAT_LINE, positioned=False, description="A line under the target"),
    MobjectSpec("Cross", "Helpers", "✕", "cross", LINE, _line("#FF0000", 6.0),
                (_TARGET, Param("scale_factor", FLOAT, 1.0, min=0.1, max=5)),
                natural={"stroke_width": 6.0, "stroke_opacity": 1.0}, positioned=False,
                description="An X over the target"),
    MobjectSpec("DashedVMobject", "Helpers", "┅", "dashed_copy", LINE, _line("#FFFFFF"),
                (_TARGET,
                 Param("num_dashes", INT, 15, label="Dashes", min=2, max=200, step=1, emit_default=True),
                 Param("dashed_ratio", FLOAT, 0.5, label="Dash length", min=0.05, max=0.95, step=0.05,
                       emit_default=True)),
                positioned=False, description="A dashed copy of the target shape"),
    MobjectSpec("TangentLine", "Helpers", "⟋", "tangent", LINE, _line("#F7D96F"),
                (_TARGET,
                 Param("alpha", FLOAT, 0.25, label="Position", min=0, max=1, step=0.01, slider=True,
                       emit_default=True, tooltip="How far along the target's outline (0 to 1)"),
                 Param("length", FLOAT, 3.0, min=0.1, max=50, step=0.1, emit_default=True)),
                positioned=False, description="A line touching the target's outline at one point"),
    # ---------------------------------------------------------------- Groups
    MobjectSpec("VGroup", "Groups", "❐", "group", NONE, {},
                (Param("members", MOBREFS, [], label="Members", tooltip="Objects that move and animate together"),),
                positioned=False, build=_group("VGroup"),
                description="Treat several shapes as one object"),
    MobjectSpec("Group", "Groups", "▣", "mixed_group", NONE, {},
                (Param("members", MOBREFS, [], label="Members", tooltip="Objects that move and animate together"),),
                positioned=False, build=_group("Group"),
                description="Treat any mix of objects (including images) as one"),
    MobjectSpec("Cutout", "Groups", "◧", "cutout", SHAPE, _shape("#58C4DD", fill_opacity=1.0),
                (Param("shape", MOBREF, None, label="Main shape"),
                 Param("holes", MOBREFS, [], label="Holes", tooltip="Shapes punched out of the main shape")),
                positioned=False, build=_cutout,
                description="A shape with other shapes cut out of it"),
]

_UV = ("u", "v")
_SPECS += [
    # ---------------------------------------------------------------- 3D (these switch the scene to 3D)
    MobjectSpec("Sphere", "3D", "●", "sphere", TEXTISH, _text(None),
                (Param("radius", FLOAT, 1.5, **_SIZE),
                 Param("resolution", INT, 24, min=8, max=64, step=4, tooltip="Higher is smoother but slower")),
                build=_sphere, three_d=True, description="A ball"),
    MobjectSpec("Cube", "3D", "⬛", "cube", TEXTISH, _text(None),
                (Param("side_length", FLOAT, 2.0, **_SIZE),), three_d=True, description="A box with equal sides"),
    MobjectSpec("Prism", "3D", "▰", "prism", TEXTISH, _text(None),
                (Param("width", FLOAT, 3.0, **_SIZE), Param("height", FLOAT, 2.0, **_SIZE),
                 Param("depth", FLOAT, 1.0, **_SIZE)),
                build=_prism, three_d=True, description="A box with its own width, height and depth"),
    MobjectSpec("Cone", "3D", "▲", "cone", TEXTISH, _text(None),
                (Param("base_radius", FLOAT, 1.0, **_SIZE), Param("height", FLOAT, 2.0, **_SIZE),
                 Param("show_base", BOOL, True, label="Closed base", emit_default=True)),
                three_d=True, description="A cone standing on its base"),
    MobjectSpec("Cylinder", "3D", "▮", "cylinder", TEXTISH, _text(None),
                (Param("radius", FLOAT, 1.0, **_SIZE), Param("height", FLOAT, 2.0, **_SIZE)),
                three_d=True, description="A can"),
    MobjectSpec("Torus", "3D", "◍", "torus", TEXTISH, _text(None),
                (Param("major_radius", FLOAT, 2.0, label="Ring radius", **_SIZE),
                 Param("minor_radius", FLOAT, 0.6, label="Tube radius", **_SIZE),
                 Param("resolution", INT, 24, min=8, max=64, step=4)),
                build=_torus, three_d=True, description="A doughnut"),
    MobjectSpec("Line3D", "3D", "⟍", "line3d", TEXTISH, _text(None),
                (Param("start", POINT3, [-1.5, -1.0, -1.0]), Param("end", POINT3, [1.5, 1.0, 1.0]),
                 Param("thickness", FLOAT, 0.03, min=0.005, max=1, step=0.01, decimals=3)),
                point_params=("start", "end"), build=_line3d, three_d=True, description="A line in 3D space"),
    MobjectSpec("Arrow3D", "3D", "➚", "arrow3d", TEXTISH, _text(None),
                (Param("start", POINT3, [-1.5, -1.0, -1.0]), Param("end", POINT3, [1.5, 1.0, 1.0]),
                 Param("thickness", FLOAT, 0.03, min=0.005, max=1, step=0.01, decimals=3)),
                point_params=("start", "end"), build=_arrow3d, three_d=True, description="An arrow in 3D space"),
    MobjectSpec("Dot3D", "3D", "◉", "dot3d", TEXTISH, _text(None),
                (Param("radius", FLOAT, 0.12, min=0.01, max=5, step=0.02, emit_default=True),),
                three_d=True, description="A small ball for marking a point"),
    MobjectSpec("Surface", "3D", "◭", "surface", TEXTISH, _text(None),
                (Param("x_expr", EXPR, "u", label="x(u, v) =", variables=_UV),
                 Param("y_expr", EXPR, "v", label="y(u, v) =", variables=_UV),
                 Param("z_expr", EXPR, "0.5*sin(u)*cos(v)", label="z(u, v) =", variables=_UV,
                       tooltip="Height"),
                 Param("u_range", RANGE, [-3.0, 3.0, 1.0], label="u range", emit_default=True),
                 Param("v_range", RANGE, [-3.0, 3.0, 1.0], label="v range", emit_default=True),
                 Param("resolution", INT, 24, min=4, max=64, step=4)),
                positioned=False, build=_surface, three_d=True,
                description="A sheet drawn from formulas in u and v, at scene coordinates"),
    MobjectSpec("ThreeDAxes", "3D", "✛", "axes3d", COORDS, {"color": None},
                (Param("x_range", RANGE, [-4.0, 4.0, 1.0], emit_default=True),
                 Param("y_range", RANGE, [-4.0, 4.0, 1.0], emit_default=True),
                 Param("z_range", RANGE, [-3.0, 3.0, 1.0], emit_default=True),
                 Param("x_length", FLOAT, 7.0, **_SIZE), Param("y_length", FLOAT, 7.0, **_SIZE),
                 Param("z_length", FLOAT, 5.0, **_SIZE)),
                three_d=True, description="Three number lines meeting at the center"),
    MobjectSpec("Tetrahedron", "3D", "△", "tetra", TEXTISH, _text(None),
                (Param("edge_length", FLOAT, 2.0, **_SIZE),), three_d=True, description="A solid with 4 triangle faces"),
    MobjectSpec("Octahedron", "3D", "◇", "octa", TEXTISH, _text(None),
                (Param("edge_length", FLOAT, 2.0, **_SIZE),), three_d=True, description="A solid with 8 triangle faces"),
    MobjectSpec("Icosahedron", "3D", "⬢", "icosa", TEXTISH, _text(None),
                (Param("edge_length", FLOAT, 2.0, **_SIZE),), three_d=True, description="A solid with 20 triangle faces"),
    MobjectSpec("Dodecahedron", "3D", "⬠", "dodeca", TEXTISH, _text(None),
                (Param("edge_length", FLOAT, 1.5, **_SIZE),), three_d=True, description="A solid with 12 pentagon faces"),
]

def _unavailable(_args):
    raise Unavailable(UNAVAILABLE)


def _stand_in(key: str) -> MobjectSpec:
    """A custom object type nobody registered (see registry/custom.py)."""
    return MobjectSpec(key, "Custom", "?", "custom", NONE, {}, build=_unavailable, description=UNAVAILABLE,
                       blocked=True)


MOBJECTS: dict[str, MobjectSpec] = SpecTable({s.key: s for s in _SPECS}, _stand_in)
MOB_CATEGORIES: list[str] = list(dict.fromkeys(s.category for s in _SPECS))

# Style fields per style kind, in inspector order: (key, label, param).
STYLE_FIELDS: dict[str, tuple[Param, ...]] = {
    SHAPE: (
        Param("stroke_color", COLOR, "#FFFFFF", label="Stroke color"),
        Param("stroke_width", FLOAT, 4.0, label="Stroke width", min=0, max=100, step=0.5, decimals=1),
        Param("stroke_opacity", FLOAT, 1.0, label="Stroke opacity", min=0, max=1, step=0.05, slider=True),
        Param("fill_color", COLOR, "#FFFFFF", label="Fill color"),
        Param("fill_opacity", FLOAT, 0.0, label="Fill opacity", min=0, max=1, step=0.05, slider=True),
    ),
    LINE: (
        Param("color", COLOR, "#FFFFFF", label="Color"),
        Param("stroke_width", FLOAT, 4.0, label="Stroke width", min=0, max=100, step=0.5, decimals=1),
        Param("stroke_opacity", FLOAT, 1.0, label="Opacity", min=0, max=1, step=0.05, slider=True),
    ),
    TEXTISH: (
        Param("color", COLOR, "#FFFFFF", label="Color", optional=True),
        Param("opacity", FLOAT, 1.0, label="Opacity", min=0, max=1, step=0.05, slider=True),
    ),
    COORDS: (Param("color", COLOR, None, label="Color", optional=True),),
    OPACITY: (Param("opacity", FLOAT, 1.0, label="Opacity", min=0, max=1, step=0.05, slider=True),),
    NONE: (),
}
