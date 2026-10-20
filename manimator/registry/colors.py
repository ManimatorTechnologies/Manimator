"""Manim's named color palette, for the color picker and for readable generated code."""

from __future__ import annotations

import re

from .ColorTable import HEX
from .palette import PALETTE_ROWS, PREFERRED

_HEX = re.compile(r"^#[0-9A-F]{6}$")

HEX_OF: dict[str, str] = {name: HEX[name] for row in PALETTE_ROWS for name in row}
for _name in PREFERRED:
    HEX_OF.setdefault(_name, HEX[_name])

NAME_OF_HEX: dict[str, str] = {}
for _name in PREFERRED + [n for row in PALETTE_ROWS for n in row]:
    NAME_OF_HEX.setdefault(HEX_OF[_name], _name)


def normalize(color: str) -> str:
    """'#abc', 'abcdef', 'BLUE' -> '#AABBCC' form. Raises ValueError for anything else."""
    c = str(color).strip()
    if c.upper() in HEX_OF:
        return HEX_OF[c.upper()]
    if not c.startswith("#"):
        c = "#" + c
    if len(c) == 4:
        c = "#" + "".join(ch * 2 for ch in c[1:])
    c = c.upper()
    if not _HEX.match(c):
        raise ValueError(f"not a color: {color!r}")
    return c


def color_code(color: str) -> str:
    """Python source for a color: a Manim constant when one matches, else a hex string."""
    c = normalize(color)
    return NAME_OF_HEX.get(c, repr(c))


def display_name(color: str) -> str:
    c = normalize(color)
    return NAME_OF_HEX.get(c, c)
