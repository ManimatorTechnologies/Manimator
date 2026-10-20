"""Parameter descriptions shared by mobjects, methods and animations.

A Param says how a value is stored in the project file (plain JSON), which
widget edits it, and how the code generator turns it into Python source.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

# Value kinds. Stored JSON representation in parentheses.
FLOAT = "float"  # (number)
INT = "int"  # (integer)
STR = "str"  # (string) single line, committed on Enter / focus-out
TEXT = "text"  # (string) multi-line, committed on Apply / focus-out
BOOL = "bool"  # (bool)
COLOR = "color"  # ("#RRGGBB")
POINT = "point"  # ([x, y]) absolute position in scene units
VECTOR = "vector"  # ([x, y]) relative offset in scene units
DIRECTION = "direction"  # ("UP", "UL", ...) a Manim direction constant
ANGLE = "angle"  # (degrees) emitted as `n * DEGREES`
ENUM = "enum"  # (string) one of `choices`
MOBREF = "mobref"  # (mobject id) emitted as that mobject's variable name
RANGE = "range"  # ([min, max, step])
FONT = "font"  # (string) font family, "" = Manim default
EXPR = "expr"  # (string) a math expression in the param's `variables`, e.g. "sin(x)"
POINTS = "points"  # ([[x, y], ...]) edited as text, one "x, y" per line
NUMBERS = "numbers"  # ([n, ...]) edited as text, separated by commas
GRID = "grid"  # ([[cell, ...], ...]) rows of strings (numeric if `numeric`), one row per line
FILE = "file"  # (string) path to a file on disk; `accept` says which kind
MOBREFS = "mobrefs"  # ([mobject id, ...]) several other objects
POINT3 = "point3"  # ([x, y, z]) absolute position in 3D scene units

# The 3x3 direction grid, in the order the picker lays it out.
DIRECTION_GRID = (
    ("UL", "UP", "UR"),
    ("LEFT", "ORIGIN", "RIGHT"),
    ("DL", "DOWN", "DR"),
)
DIRECTION_VECTORS = {
    "UL": (-1, 1),
    "UP": (0, 1),
    "UR": (1, 1),
    "LEFT": (-1, 0),
    "ORIGIN": (0, 0),
    "RIGHT": (1, 0),
    "DL": (-1, -1),
    "DOWN": (0, -1),
    "DR": (1, -1),
}
EDGES = ("UP", "DOWN", "LEFT", "RIGHT")
CORNERS = ("UL", "UR", "DL", "DR")
NO_ORIGIN = tuple(d for d in DIRECTION_VECTORS if d != "ORIGIN")


@dataclass(frozen=True)
class Param:
    name: str
    kind: str
    default: Any = None
    label: str = ""
    min: float = -1000.0
    max: float = 1000.0
    step: float = 0.1
    decimals: int = 2
    # ENUM: ((value, label), ...). DIRECTION: allowed direction names.
    choices: tuple = ()
    # ENUM: emit the value as a bare identifier (e.g. Rectangle) instead of a string.
    raw: bool = False
    # None is allowed and means "leave the argument out".
    optional: bool = False
    # Emit as a positional argument (always emitted, in declaration order).
    positional: bool = False
    # Methods/animations leave out arguments equal to their default; this forces them in.
    emit_default: bool = False
    # Draw FLOAT as a slider + spinbox (for 0..1 values like opacity).
    slider: bool = False
    # Custom emitter: value -> "name=code" or None to leave it out.
    emit: Callable[[Any], str | None] | None = None
    # Emitted only when this is true of the object's stored values (e.g. line spacing only for several lines).
    when: Callable[[dict], bool] | None = None
    tooltip: str = ""
    # EXPR: the variable names the expression may use.
    variables: tuple = ()
    # POINTS / NUMBERS / GRID: how many items (rows, for GRID) are allowed.
    min_items: int = 0
    max_items: int = 256
    # GRID: every cell must be a number.
    numeric: bool = False
    # FILE: "image" or "svg" (decides the file dialog's filter).
    accept: str = ""

    @property
    def title(self) -> str:
        return self.label or self.name.replace("_", " ").capitalize()


# ---------------------------------------------------------------------- text <-> structured values

_NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
MAX_CELL = 80
MAX_GRID = 12


def _finite(text) -> float:
    try:
        v = float(text)
    except (TypeError, ValueError):
        raise ValueError(f"{text!r} is not a number.") from None
    if v != v or v in (float("inf"), float("-inf")) or abs(v) > 1e9:
        raise ValueError(f"{text!r} is not a usable number.")
    return v


def _check_count(n: int, p: Param, what: str) -> None:
    if n < p.min_items:
        raise ValueError(f"Needs at least {p.min_items} {what}.")
    if n > p.max_items:
        raise ValueError(f"At most {p.max_items} {what} are allowed.")


def parse_points(value, p: Param) -> list[list[float]]:
    """'x, y' per line (or a list of pairs) -> [[x, y], ...]."""
    if isinstance(value, str):
        rows = [r for r in re.split(r"[\n;]+", value) if r.strip()]
        pts = []
        for row in rows:
            nums = _NUMBER.findall(row)
            if len(nums) < 2:
                raise ValueError(f"'{row.strip()}' needs an x and a y, like 1.5, -2.")
            pts.append([_finite(nums[0]), _finite(nums[1])])
    elif isinstance(value, (list, tuple)):
        pts = []
        for v in value:
            if not isinstance(v, (list, tuple)) or len(v) < 2:
                raise ValueError("Each point needs an x and a y.")
            pts.append([_finite(v[0]), _finite(v[1])])
    else:
        raise ValueError("Expected a list of points.")
    _check_count(len(pts), p, "points")
    return [[max(-1000.0, min(1000.0, x)), max(-1000.0, min(1000.0, y))] for x, y in pts]


def parse_numbers(value, p: Param) -> list[float]:
    if isinstance(value, str):
        tokens = [t for t in re.split(r"[,;\s]+", value.strip()) if t]
    elif isinstance(value, (list, tuple)):
        tokens = list(value)
    else:
        raise ValueError("Expected a list of numbers.")
    nums = [_finite(t) for t in tokens]
    _check_count(len(nums), p, "numbers")
    return nums


def parse_grid(value, p: Param) -> list[list[str]]:
    """One row per line, cells separated by | (or commas) -> rows of strings, padded to a rectangle."""
    if isinstance(value, str):
        rows = []
        for line in value.splitlines():
            if not line.strip():
                continue
            cells = line.split("|") if "|" in line else line.split(",")
            rows.append([c.strip() for c in cells])
    elif isinstance(value, (list, tuple)):
        rows = [[str(c).strip() for c in r] for r in value if isinstance(r, (list, tuple))]
    else:
        raise ValueError("Expected rows of cells.")
    _check_count(len(rows), p, "rows")
    if not rows:
        return rows
    width = max(len(r) for r in rows)
    if width > MAX_GRID or len(rows) > MAX_GRID:
        raise ValueError(f"At most {MAX_GRID} rows and {MAX_GRID} columns are allowed.")
    out = []
    for r in rows:
        r = r + [""] * (width - len(r))
        for c in r:
            if len(c) > MAX_CELL:
                raise ValueError("A cell is too long.")
        if p.numeric:
            r = [_cell_number(c) for c in r]
        out.append(r)
    return out


def _cell_number(cell: str) -> str:
    if not cell:
        return "0"
    v = _finite(cell)
    return str(int(v)) if v == int(v) else repr(v)
