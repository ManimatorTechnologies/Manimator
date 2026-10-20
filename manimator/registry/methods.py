"""Mobject methods: applied once during setup, or animated with `.animate`."""

from __future__ import annotations

from dataclasses import dataclass

from .params import (
    ANGLE, COLOR, CORNERS, DIRECTION, EDGES, ENUM, FLOAT, MOBREF, NO_ORIGIN, POINT, VECTOR, Param,
)


@dataclass(frozen=True)
class MethodSpec:
    key: str  # the Python method name
    label: str
    group: str
    params: tuple[Param, ...] = ()
    description: str = ""


_P = dict(positional=True, emit_default=True)

_SPECS = [
    # Position
    MethodSpec("shift", "Shift by", "Position",
               (Param("vector", VECTOR, [1.0, 0.0], label="Offset", **_P),),
               "Move by an offset"),
    MethodSpec("move_to", "Move to", "Position",
               (Param("point", POINT, [0.0, 0.0], **_P),),
               "Move the center to a point"),
    MethodSpec("next_to", "Next to", "Position",
               (Param("mobject_or_point", MOBREF, None, label="Object", **_P),
                Param("direction", DIRECTION, "RIGHT", choices=NO_ORIGIN, **_P),
                Param("buff", FLOAT, 0.25, min=0, max=10)),
               "Place beside another object"),
    MethodSpec("align_to", "Align to", "Position",
               (Param("mobject_or_point", MOBREF, None, label="Object", **_P),
                Param("direction", DIRECTION, "LEFT", choices=NO_ORIGIN, **_P)),
               "Line up an edge with another object"),
    MethodSpec("to_edge", "To edge", "Position",
               (Param("edge", DIRECTION, "UP", choices=EDGES, **_P),
                Param("buff", FLOAT, 0.5, min=0, max=10)),
               "Push against a frame edge"),
    MethodSpec("to_corner", "To corner", "Position",
               (Param("corner", DIRECTION, "UL", choices=CORNERS, **_P),
                Param("buff", FLOAT, 0.5, min=0, max=10)),
               "Push into a frame corner"),
    MethodSpec("center", "Center", "Position", (), "Move to the middle of the frame"),
    MethodSpec("arrange", "Arrange", "Position",
               (Param("direction", DIRECTION, "RIGHT", choices=NO_ORIGIN, **_P),
                Param("buff", FLOAT, 0.25, label="Gap", min=0, max=10)),
               "Line up a group's members one after another, then center the group"),
    # Size & shape
    MethodSpec("scale", "Scale", "Transform",
               (Param("scale_factor", FLOAT, 1.5, label="Factor", min=0.01, max=100, **_P),),
               "Grow or shrink"),
    MethodSpec("rotate", "Rotate", "Transform",
               (Param("angle", ANGLE, 90.0, **_P),),
               "Rotate around the center (counter-clockwise)"),
    MethodSpec("flip", "Flip", "Transform",
               (Param("axis", ENUM, "UP", raw=True, choices=(("UP", "Mirror left ↔ right"),
                                                            ("RIGHT", "Mirror up ↕ down")), **_P),),
               "Mirror the object"),
    MethodSpec("stretch", "Stretch", "Transform",
               (Param("factor", FLOAT, 2.0, min=0.01, max=100, **_P),
                Param("dim", ENUM, "0", label="Direction", raw=True,
                      choices=(("0", "Horizontal"), ("1", "Vertical")), **_P)),
               "Stretch along one direction"),
    MethodSpec("scale_to_fit_width", "Fit width", "Transform",
               (Param("width", FLOAT, 2.0, min=0.01, max=100, **_P),),
               "Scale so the width matches"),
    MethodSpec("scale_to_fit_height", "Fit height", "Transform",
               (Param("height", FLOAT, 2.0, min=0.01, max=100, **_P),),
               "Scale so the height matches"),
    # Style
    MethodSpec("set_color", "Set color", "Style",
               (Param("color", COLOR, "#F7D96F", **_P),), "Recolor stroke and fill"),
    MethodSpec("set_fill", "Set fill", "Style",
               (Param("color", COLOR, "#58C4DD", emit_default=True),
                Param("opacity", FLOAT, 1.0, min=0, max=1, step=0.05, slider=True, emit_default=True)),
               "Fill color and opacity"),
    MethodSpec("set_stroke", "Set stroke", "Style",
               (Param("color", COLOR, "#FFFFFF", emit_default=True),
                Param("width", FLOAT, 4.0, min=0, max=100, step=0.5, emit_default=True),
                Param("opacity", FLOAT, 1.0, min=0, max=1, step=0.05, slider=True)),
               "Outline color, width and opacity"),
    MethodSpec("set_opacity", "Set opacity", "Style",
               (Param("opacity", FLOAT, 0.5, min=0, max=1, step=0.05, slider=True, **_P),),
               "Opacity of stroke and fill"),
]

METHODS: dict[str, MethodSpec] = {s.key: s for s in _SPECS}
METHOD_GROUPS: list[str] = list(dict.fromkeys(s.group for s in _SPECS))
