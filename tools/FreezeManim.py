"""Dev only: freeze what the server used to ask Manim while running (needs Manim; run after upgrading it).

    python tools/FreezeManim.py            # write the files
    python tools/FreezeManim.py --check    # only say whether they are current (also tests/TestFrozenManim.py)

Writes, under manimator/registry/:
- ManimDefaults.py: for every Manim class the scene plans use (tests/fixtures/engine/coverage.json) and its
  bases, the defaults of its own __init__. The browser engine's port of each class must match these.
- reserved.py: the names `from manim import *` brings in, which variables and scene classes must not take.
- ColorTable.py: the hex values of Manim's named colours that the colour picker and codegen use.

The server then runs without Manim: Manim is only needed to run the exported Python and for these dev tools.
"""

from __future__ import annotations

import enum
import inspect
import json
import pprint
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "manimator" / "registry"
COVERAGE = ROOT / "tests" / "fixtures" / "engine" / "coverage.json"
HEADER = '"""Frozen from Manim {version} by tools/FreezeManim.py. Do not edit; run the tool again instead."""\n\n'


def _plain(value):
    """A JSON-like version of a default value."""
    import numpy as np
    from manim.utils.color import ManimColor

    if value is inspect.Parameter.empty:
        return {"required": True}
    if isinstance(value, ManimColor):
        return value.to_hex().upper()
    if isinstance(value, np.ndarray):
        return [_plain(v) for v in value.tolist()]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, enum.Enum):  # before int: an IntEnum (PIL's Resampling) is one, and its repr isn't Python
        return {"name": f"{type(value).__name__}.{value.name}"}
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if inspect.isclass(value) or inspect.isfunction(value) or inspect.isbuiltin(value):
        return {"name": value.__name__}
    if hasattr(value, "name") and hasattr(value, "value"):  # an enum-like member
        return {"name": f"{type(value).__name__}.{value.name}"}
    if hasattr(value, "__dict__"):  # an object such as LinearBase(): its class and settings
        return {"instance": type(value).__name__,
                **{k: _plain(v) for k, v in vars(value).items() if not k.startswith("_")}}
    return {"repr": repr(value)}


def defaults() -> dict:
    import manim

    names = [c for c in json.loads(COVERAGE.read_text(encoding="utf-8"))["calls"] if c[:1].isupper() and "." not in c]
    out: dict = {}
    todo = [getattr(manim, n) for n in names if inspect.isclass(getattr(manim, n, None))]
    while todo:
        cls = todo.pop()
        if cls.__name__ in out or not cls.__module__.startswith("manim"):
            continue
        params = {}
        if "__init__" in vars(cls):
            for p in inspect.signature(cls.__init__).parameters.values():
                if p.name == "self" or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                    continue
                params[p.name] = _plain(p.default)
        bases = [b for b in cls.__bases__ if b.__module__.startswith("manim")]
        out[cls.__name__] = {"bases": [b.__name__ for b in bases], "init": params}
        todo += bases
    return dict(sorted(out.items()))


def reserved() -> list[str]:
    ns: dict = {}
    exec("from manim import *", ns)
    return sorted(n for n in ns if n != "__builtins__")


def colors() -> dict:
    from manim.utils.color import manim_colors

    from manimator.registry.palette import PALETTE_ROWS, PREFERRED

    names = list(dict.fromkeys([*PREFERRED, *(n for row in PALETTE_ROWS for n in row)]))
    return {n: getattr(manim_colors, n).to_hex().upper() for n in names}


def js_constants() -> str:
    """manim/constants.py's numbers and vectors, and every named Manim colour, for the browser engine."""
    import manim.constants as c
    import numpy as np
    from manim.utils.color import ManimColor, manim_colors

    lines = []
    for name in sorted(n for n in dir(c) if n.isupper()):
        value = getattr(c, name)
        if isinstance(value, bool) or isinstance(value, enum.Enum):
            continue
        if isinstance(value, np.ndarray):
            lines.append(f"export const {name} = Object.freeze({json.dumps(value.astype(float).tolist())});")
        elif isinstance(value, (int, float)):
            lines.append(f"export const {name} = {float(value)!r};")
    colors = {n: getattr(manim_colors, n) for n in sorted(dir(manim_colors))
              if n.isupper() and isinstance(getattr(manim_colors, n), ManimColor)}
    table = ",\n".join(f"  {n}: {json.dumps([float(x) for x in col._internal_value])}" for n, col in colors.items())
    return (f"// Frozen from Manim {__import__('manim').__version__} by tools/FreezeManim.py. Do not edit; run the "
            "tool again instead.\n\n" + "\n".join(lines) + "\n\n// Named colours as RGBA floats (ManimColor's "
            f"internal value)\nexport const COLOR_TABLE = Object.freeze({{\n{table},\n}});\n")


def files() -> dict[Path, str]:
    import manim

    head = HEADER.format(version=manim.__version__)
    return {
        ROOT / "manimator" / "web" / "js" / "engine" / "manim" / "frozen.js": js_constants(),
        REGISTRY / "ManimDefaults.py": head + f"MANIM_VERSION = {manim.__version__!r}\n\n"
        "# class -> {'bases': [...], 'init': {argument: default}} (each class's own __init__ only)\n"
        f"DEFAULTS = {pprint.pformat(defaults(), width=116, sort_dicts=False)}\n",
        REGISTRY / "reserved.py": head + f"MANIM_NAMES = frozenset({pprint.pformat(reserved(), width=116, compact=True)})\n",
        REGISTRY / "ColorTable.py": head + f"HEX = {pprint.pformat(colors(), width=116, sort_dicts=False)}\n",
    }


def main() -> None:
    sys.path.insert(0, str(ROOT))
    check = "--check" in sys.argv
    stale = []
    for path, text in files().items():
        if path.exists() and path.read_text(encoding="utf-8") == text:
            continue
        stale.append(path.name)
        if not check:
            path.write_text(text, encoding="utf-8", newline="\n")
    print(("stale: " if check else "wrote: ") + ", ".join(stale) if stale else "frozen Manim data is current")
    sys.exit(1 if check and stale else 0)


if __name__ == "__main__":
    main()
