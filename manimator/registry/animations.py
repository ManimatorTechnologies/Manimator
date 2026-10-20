"""Animations that can be added to a scene's step list."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .params import (
    ANGLE, BOOL, COLOR, DIRECTION, EDGES, ENUM, EXPR, FLOAT, GRID, INT, MOBREF, MOBREFS, NO_ORIGIN, POINT, POINT3,
    Param,
)
from .custom import UNAVAILABLE, SpecTable
from .scenes import LINEAR, MOVING_CAMERA, SPECIAL_THREE_D, THREE_D, VECTOR_SCENE, ZOOMED

ANIMATE = "Animate"  # special entry: `target.animate.<method>(...)`

# What an animation does to its target's place on screen (checked against Manim in tests/TestScenes.py).
ADD = "add"  # on screen afterwards (brought in if it wasn't)
REMOVE = "remove"  # gone afterwards
REPLACE = "replace"  # gone, and the second object takes its place
KEEP = "keep"  # left as it was: the animation draws something around it instead


@dataclass(frozen=True)
class AnimSpec:
    key: str
    category: str
    params: tuple[Param, ...] = ()
    introducer: bool = False  # brings its target onto the screen
    remover: bool = False  # takes its target off the screen
    run_time: float = 1.0  # default run time for a new step
    only: tuple[str, ...] = ()  # restrict to these mobject types (empty = any)
    description: str = ""
    effect: str = ""  # ADD, REMOVE, REPLACE or KEEP; "" means REMOVE for removers and ADD for the rest
    # Scene actions (camera moves, grid transformations...) belong to the scene, not to an object: they have no
    # target, exist only in the scene kinds listed here, and codegen writes them itself (see codegen.ACTIONS).
    scene_kinds: tuple[str, ...] = ()
    label: str = ""  # shown instead of the key
    # A step holds at most one scene action per channel (one camera move, one grid transformation...).
    channel: str = ""
    # Plays a fixed sequence of its own: it is alone in its step, which lasts exactly this many seconds.
    fixed_time: float | None = None
    # Extra checks on the parameter values; raises ValueError with a message for the user.
    check: Callable[[dict], None] | None = None
    # The class the code calls, when it isn't the key (custom animations: the key is "kit:<id>:<version>").
    call_name: str = ""
    # A custom animation from a code package (registry/custom.py), and whether that package is unavailable.
    kit: dict | None = None
    blocked: bool = False

    @property
    def second_target(self) -> Param | None:
        """The MOBREF param naming another object (Transform target, path...)."""
        return next((p for p in self.params if p.kind == MOBREF), None)

    @property
    def scene_action(self) -> bool:
        return bool(self.scene_kinds)

    @property
    def title(self) -> str:
        return self.label or self.key

    @property
    def screen_effect(self) -> str:
        return self.effect or (REMOVE if self.remover else ADD)


_SHIFT = Param("shift", DIRECTION, None, label="Slide from", choices=NO_ORIGIN, optional=True,
               tooltip="Direction of travel while fading")
_SCALE = Param("scale", FLOAT, 1.0, min=0.01, max=20, tooltip="Start/end at this scale")
_INTO = Param("target_mobject", MOBREF, None, label="Into", positional=True)
_ARC = Param("path_arc", ANGLE, 0.0, label="Path arc", tooltip="Curve the movement path")

_SPECS = [
    # ---------------------------------------------------------------- Appear
    AnimSpec("Create", "Appear", introducer=True, description="Draw the outline, then fill"),
    AnimSpec("Write", "Appear", introducer=True, description="Hand-write text or shapes"),
    AnimSpec("FadeIn", "Appear", (_SHIFT, _SCALE), introducer=True, description="Fade in"),
    AnimSpec("DrawBorderThenFill", "Appear", introducer=True, run_time=2.0,
             description="Trace the border, then fill"),
    AnimSpec("GrowFromCenter", "Appear", introducer=True, description="Grow from the center"),
    AnimSpec("GrowFromEdge", "Appear",
             (Param("edge", DIRECTION, "DOWN", choices=EDGES, positional=True, emit_default=True),),
             introducer=True, description="Grow out of one edge"),
    AnimSpec("GrowArrow", "Appear", introducer=True, only=("Arrow", "DoubleArrow"),
             description="Grow an arrow from its start"),
    AnimSpec("SpinInFromNothing", "Appear", (Param("angle", ANGLE, 90.0),), introducer=True,
             description="Spin while growing"),
    AnimSpec("AddTextLetterByLetter", "Appear",
             (Param("time_per_char", FLOAT, 0.1, min=0.01, max=2, step=0.01),),
             introducer=True, only=("Text", "MarkupText"), description="Type letters one by one"),
    # ---------------------------------------------------------------- Disappear
    AnimSpec("Uncreate", "Disappear", remover=True, description="Reverse of Create"),
    AnimSpec("Unwrite", "Disappear", remover=True, description="Reverse of Write"),
    AnimSpec("FadeOut", "Disappear", (_SHIFT, _SCALE), remover=True, description="Fade out"),
    AnimSpec("ShrinkToCenter", "Disappear", remover=True, effect=ADD,  # Manim keeps the dot-sized object
             description="Shrink to nothing"),
    # ---------------------------------------------------------------- Emphasize
    AnimSpec("Indicate", "Emphasize",
             (Param("scale_factor", FLOAT, 1.2, min=0.1, max=10), Param("color", COLOR, "#FFFF00")),
             description="Briefly enlarge and recolor"),
    AnimSpec("Flash", "Emphasize",
             (Param("color", COLOR, "#FFFF00"),
              Param("flash_radius", FLOAT, 0.5, min=0, max=20, emit_default=True),
              Param("num_lines", INT, 12, min=2, max=100, step=1)),
             effect=KEEP, description="Burst of lines around the object"),
    AnimSpec("Circumscribe", "Emphasize",
             (Param("shape", ENUM, "Rectangle", raw=True, choices=(("Rectangle", "Rectangle"), ("Circle", "Circle"))),
              Param("color", COLOR, "#FFFF00"),
              Param("fade_out", BOOL, False)),
             effect=KEEP, description="Draw a line around the object"),
    AnimSpec("Wiggle", "Emphasize",
             (Param("scale_value", FLOAT, 1.1, min=0.1, max=5), Param("rotation_angle", ANGLE, 3.6),
              Param("n_wiggles", INT, 6, min=1, max=50, step=1)),
             run_time=2.0, description="Wiggle in place"),
    AnimSpec("FocusOn", "Emphasize",
             (Param("color", COLOR, "#888888"), Param("opacity", FLOAT, 0.2, min=0, max=1, slider=True)),
             run_time=2.0, effect=KEEP, description="Spotlight shrinking onto the object"),
    AnimSpec("ApplyWave", "Emphasize",
             (Param("direction", DIRECTION, "UP", choices=NO_ORIGIN),
              Param("amplitude", FLOAT, 0.2, min=0, max=10), Param("ripples", INT, 1, min=1, max=20, step=1)),
             run_time=2.0, description="Send a wave through the object"),
    # ---------------------------------------------------------------- Transform
    AnimSpec("Transform", "Transform", (_INTO, _ARC),
             description="Morph into another object (the original stays, looking like the target)"),
    AnimSpec("ReplacementTransform", "Transform", (_INTO, _ARC), effect=REPLACE,
             description="Morph into another object, which replaces the original"),
    AnimSpec("TransformMatchingTex", "Transform", (_INTO,), only=("MathTex", "Tex"), effect=REPLACE,
             description="Morph equations, matching identical pieces"),
    AnimSpec("TransformMatchingShapes", "Transform", (_INTO,), effect=REPLACE,
             description="Morph, matching identical shapes (great for text)"),
    AnimSpec("FadeTransform", "Transform", (_INTO,), effect=REPLACE, description="Cross-fade into another object"),
    # ---------------------------------------------------------------- Move
    AnimSpec(ANIMATE, "Move", description="Smoothly animate any method"),
    AnimSpec("Rotate", "Move", (Param("angle", ANGLE, 180.0, emit_default=True),),
             description="Rotate around the center"),
    AnimSpec("MoveAlongPath", "Move", (Param("path", MOBREF, None, positional=True),),
             description="Travel along another object's outline"),
]


# ---------------------------------------------------------------------- scene actions


def _matrix(values: dict) -> list[list[float]]:
    m = values.get("matrix")
    if not (isinstance(m, list) and len(m) == 2 and all(isinstance(r, list) and len(r) == 2 for r in m)):
        raise ValueError("The matrix needs 2 rows of 2 numbers.")
    return [[float(c) for c in row] for row in m]


def _invertible(values: dict) -> None:
    (a, b), (c, d) = _matrix(values)
    if abs(a * d - b * c) < 1e-9:
        raise ValueError("This matrix has no inverse (its determinant is 0).")


_MOVING = (MOVING_CAMERA, ZOOMED)
_3D = (THREE_D, SPECIAL_THREE_D)
_ZOOM_LEVEL = Param("zoom", FLOAT, 2.0, min=0.1, max=20, step=0.25,
                    tooltip="1 shows the whole frame; 2 shows half as much, twice as large")
_MATRIX = Param("matrix", GRID, [["1", "1"], ["0", "1"]], numeric=True, min_items=2, max_items=2,
                tooltip="2 rows of 2 numbers. The columns are where î and ĵ land.")
_DEGREES = dict(min=-36000, max=36000, step=5, decimals=1)

_SPECS += [
    # ---------------------------------------------------------------- Camera (MovingCameraScene, ZoomedScene)
    AnimSpec("camera_pan", "Camera", (Param("point", POINT, [2.0, 0.0], label="To"),),
             scene_kinds=_MOVING, channel="camera", label="Pan camera", description="Slide the camera to a point"),
    AnimSpec("camera_focus", "Camera", (Param("object", MOBREF, None), _ZOOM_LEVEL),
             scene_kinds=_MOVING, channel="camera", label="Focus on object",
             description="Center the camera on an object and zoom"),
    AnimSpec("camera_zoom", "Camera", (_ZOOM_LEVEL,), scene_kinds=_MOVING, channel="camera", label="Zoom camera",
             description="Zoom in or out around the middle of the picture"),
    AnimSpec("camera_fit", "Camera",
             (Param("objects", MOBREFS, [], min_items=1),
              Param("margin", FLOAT, 1.0, min=0, max=20, step=0.25, tooltip="Extra room around them")),
             scene_kinds=_MOVING, channel="camera", label="Zoom to fit",
             description="Frame some objects so they fill the picture"),
    AnimSpec("camera_restore", "Camera", scene_kinds=_MOVING, channel="camera", label="Reset camera",
             description="Back to where the camera started"),
    # ---------------------------------------------------------------- Zoom (ZoomedScene)
    AnimSpec("zoom_on", "Zoom", (Param("pop_out", BOOL, True, label="Pop out",
                                       tooltip="Grow the display out of the lens; otherwise it appears at once"),),
             scene_kinds=(ZOOMED,), channel="zoom", label="Turn on zoom",
             description="Show the lens and the magnified display"),
    AnimSpec("zoom_off", "Zoom", scene_kinds=(ZOOMED,), channel="zoom", label="Turn off zoom",
             description="Fade out the lens and the display"),
    AnimSpec("lens_to_object", "Zoom", (Param("object", MOBREF, None),), scene_kinds=(ZOOMED,), channel="lens",
             label="Move lens to object", description="Magnify a different object"),
    AnimSpec("lens_to_point", "Zoom", (Param("point", POINT, [1.0, 1.0], label="To"),), scene_kinds=(ZOOMED,),
             channel="lens", label="Move lens to point", description="Magnify a different spot"),
    AnimSpec("lens_scale", "Zoom",
             (Param("factor", FLOAT, 2.0, min=0.05, max=20, step=0.25,
                    tooltip="Above 1 makes the lens bigger, so it magnifies less"),),
             scene_kinds=(ZOOMED,), channel="lens", label="Resize lens", description="Change how much is magnified"),
    # ---------------------------------------------------------------- Camera (ThreeDScene, SpecialThreeDScene)
    AnimSpec("camera_move3d", "Camera",
             (Param("phi", FLOAT, 70.0, label="Tilt", min=0, max=180, step=5, decimals=1),
              Param("theta", FLOAT, 10.0, label="Rotation", **_DEGREES),
              Param("gamma", FLOAT, 0.0, label="Roll", **_DEGREES),
              Param("zoom", FLOAT, 1.0, min=0.1, max=20, step=0.1)),
             scene_kinds=_3D, channel="camera", run_time=2.0, label="Move camera",
             description="Fly the camera to a new angle"),
    AnimSpec("camera_look_at", "Camera", (Param("object", MOBREF, None),), scene_kinds=_3D, channel="camera",
             run_time=2.0, label="Look at object", description="Turn the camera's center onto an object"),
    AnimSpec("camera_look_point", "Camera", (Param("point", POINT3, [0.0, 0.0, 0.0], label="Point"),),
             scene_kinds=_3D, channel="camera", run_time=2.0, label="Look at point",
             description="Turn the camera's center onto a point"),
    AnimSpec("camera_spin", "Camera",
             (Param("rate", FLOAT, 20.0, label="Speed", min=-3600, max=3600, step=5, decimals=1,
                    tooltip="Degrees per second; negative spins the other way"),
              Param("about", ENUM, "theta", label="Around",
                    choices=(("theta", "The vertical axis"), ("phi", "Tilting up and down"), ("gamma", "Rolling")))),
             scene_kinds=_3D, channel="camera", run_time=4.0, label="Spin camera",
             description="Keep turning the camera for the length of the step"),
    AnimSpec("camera_wobble", "Camera",
             (Param("rate", FLOAT, 1.0, label="Speed", min=0.05, max=20, step=0.25),),
             scene_kinds=_3D, channel="camera", run_time=4.0, label="Wobble camera",
             description="Sway the camera a little, so the picture looks 3D"),
    # ---------------------------------------------------------------- Grid (LinearTransformationScene)
    AnimSpec("apply_matrix", "Grid", (_MATRIX,), scene_kinds=(LINEAR,), channel="grid", run_time=3.0,
             check=_matrix, label="Apply matrix", description="Transform the grid, vectors and shapes by a matrix"),
    AnimSpec("apply_inverse", "Grid", (_MATRIX,), scene_kinds=(LINEAR,), channel="grid", run_time=3.0,
             check=_invertible, label="Apply inverse", description="Undo a matrix: transform by its inverse"),
    AnimSpec("apply_function", "Grid",
             (Param("fx", EXPR, "x + sin(y)", label="New x", variables=("x", "y"),
                    tooltip="Where the point (x, y) goes, x part. Functions: sin cos tan exp log sqrt abs"),
              Param("fy", EXPR, "y + sin(x)", label="New y", variables=("x", "y"))),
             scene_kinds=(LINEAR,), channel="grid", run_time=3.0, label="Apply function",
             description="Bend the grid with any formula (a non-linear transformation)"),
    # ---------------------------------------------------------------- Vectors (VectorScene)
    AnimSpec("vector_to_coords", "Vectors",
             (Param("vector", POINT, [2.0, 1.0], label="Vector"),
              Param("integer_labels", BOOL, True, label="Whole numbers", tooltip="Round the coordinates shown")),
             scene_kinds=(VECTOR_SCENE,), channel="demo", fixed_time=6.0, label="Show coordinates",
             description="Draw a vector, then its x and y steps and its coordinates"),
]

def _stand_in(key: str) -> AnimSpec:
    """A custom animation nobody registered (see registry/custom.py)."""
    return AnimSpec(key, "Custom", description=UNAVAILABLE, label="Unavailable", blocked=True)


ANIMATIONS: dict[str, AnimSpec] = SpecTable({s.key: s for s in _SPECS}, _stand_in)
ANIM_CATEGORIES: list[str] = list(dict.fromkeys(s.category for s in _SPECS))

RATE_FUNCS: list[tuple[str, str]] = [
    ("default", "Default"),
    ("smooth", "Smooth"),
    ("linear", "Linear"),
    ("rush_into", "Rush into"),
    ("rush_from", "Rush from"),
    ("there_and_back", "There and back"),
    ("there_and_back_with_pause", "There and back (pause)"),
    ("double_smooth", "Double smooth"),
    ("wiggle", "Wiggle"),
    ("rate_functions.ease_in_sine", "Ease in (sine)"),
    ("rate_functions.ease_out_sine", "Ease out (sine)"),
    ("rate_functions.ease_in_out_sine", "Ease in-out (sine)"),
    ("rate_functions.ease_in_out_cubic", "Ease in-out (cubic)"),
    ("rate_functions.ease_out_back", "Overshoot (back)"),
    ("rate_functions.ease_out_bounce", "Bounce"),
    ("rate_functions.ease_out_elastic", "Elastic"),
]
