"""Call trees: the one description of a scene that both outputs come from.

Each node prints as Manim Python (the downloadable script, `.py`) and turns into plain JSON (the scene plan the
browser plays, `.json()`). A value's JSON is what the printed Python evaluates to (a number as printed, a
vector as its coordinates, an angle in radians), so the two outputs cannot disagree.

JSON forms: numbers, strings, booleans, null and lists as themselves, and
  {"ref": id}                                   an object of the scene
  {"name": "Rectangle"}                         a Manim name: a class, rate function or constant
  {"asset": "photo-1a2b3c4d.png"}               an uploaded file
  {"frame_width": z}                            config.frame_width / z (it depends on the video size)
  {"dict": {...}}                               a Python dict argument
  {"call": "Circle", "args": [...], "kwargs": {...}, "on": node, "then": [calls]}
  {"animate": node, "calls": [calls]}           node.animate.call(...).call(...)
  {"attr": "self.camera.frame"}                 a scene attribute
  {"lambda": ["p"], "bind": {"x": ["p", 0]}, "body": node}
  {"expr": tree}                                a formula (see registry/exprs.py: expr_tree)
Statements: {"do": node} and {"set": "self.camera.background_color", "value": node}.
"""

from __future__ import annotations

import ast
import math
from dataclasses import dataclass

MAX_LINE = 88
DEGREES = 2 * math.pi / 360  # Manim's DEGREES (TAU / 360)


class Node:
    def py(self) -> str:
        raise NotImplementedError

    def json(self):
        raise NotImplementedError


@dataclass(frozen=True)
class Lit(Node):
    """A value with a fixed spelling: `code` is the Python, `value` what it evaluates to (as JSON)."""

    code: str
    value: object

    def py(self) -> str:
        return self.code

    def json(self):
        return self.value


@dataclass(frozen=True)
class Name(Node):
    """A bare Manim name (Rectangle, smooth, rate_functions.ease_out_bounce): the browser looks it up."""

    code: str

    def py(self) -> str:
        return self.code

    def json(self):
        return {"name": self.code}


@dataclass(frozen=True)
class Ref(Node):
    """Another object of the scene: its variable in Python, its id in the plan."""

    mob_id: str
    var: str

    def py(self) -> str:
        return self.var

    def json(self):
        return {"ref": self.mob_id}


@dataclass(frozen=True)
class Asset(Node):
    """An uploaded file: a path in Python, its stored name in the plan."""

    path: str  # as printed (a string literal)
    name: str

    def py(self) -> str:
        return self.path

    def json(self):
        return {"asset": self.name}


@dataclass(frozen=True)
class FrameWidth(Node):
    """config.frame_width divided by a zoom level (the frame is 14.22 units at 16:9, a little more at 854x480)."""

    zoom: float
    zoom_code: str

    def py(self) -> str:
        return "config.frame_width" if self.zoom == 1 else f"config.frame_width / {self.zoom_code}"

    def json(self):
        return {"frame_width": self.zoom}


@dataclass(frozen=True)
class Seq(Node):
    """A Python list."""

    items: tuple

    def py(self) -> str:
        return "[" + ", ".join(i.py() for i in self.items) + "]"

    def json(self):
        return [i.json() for i in self.items]


@dataclass(frozen=True)
class Dict(Node):
    items: tuple  # ((key, Node), ...)

    def py(self) -> str:
        return "{" + ", ".join(f'"{k}": {v.py()}' for k, v in self.items) + "}"

    def json(self):
        return {"dict": {k: v.json() for k, v in self.items}}


@dataclass(frozen=True)
class Attr(Node):
    """A scene attribute such as self.camera.frame."""

    path: str

    def py(self) -> str:
        return self.path

    def json(self):
        return {"attr": self.path}


@dataclass(frozen=True)
class Expr(Node):
    """A user's formula: Python from exprs.compile_expr, the plan gets its checked syntax tree."""

    code: str
    tree: object

    def py(self) -> str:
        return self.code

    def json(self):
        return {"expr": self.tree}


@dataclass(frozen=True)
class Lambda(Node):
    """lambda <params>: <body>. `bind` names formula variables that are items of a parameter: x is p[0]."""

    params: tuple
    body: Node
    bind: tuple = ()  # ((variable, param, index), ...)

    def py(self) -> str:
        return f"lambda {', '.join(self.params)}: {self.body.py()}"

    def json(self):
        out = {"lambda": list(self.params), "body": self.body.json()}
        if self.bind:
            out["bind"] = {var: [param, index] for var, param, index in self.bind}
        return out


@dataclass(frozen=True)
class Call(Node):
    """name(args, key=value).then[0](...)... ; `on` is the receiver (an object or a scene attribute)."""

    name: str
    args: tuple = ()
    kwargs: tuple = ()  # ((key, Node), ...)
    on: Node | None = None
    then: tuple = ()  # chained calls (Calls without a receiver)

    @property
    def callee(self) -> str:
        return f"{self.on.py()}.{self.name}" if self.on is not None else self.name

    def arg_codes(self) -> list[str]:
        return [a.py() for a in self.args] + [f"{k}={v.py()}" for k, v in self.kwargs]

    def py(self) -> str:
        return f"{self.callee}({', '.join(self.arg_codes())})" + "".join("." + c.py() for c in self.then)

    def json(self):
        out: dict = {"call": self.name}
        if self.on is not None:
            out["on"] = self.on.json()
        if self.args:
            out["args"] = [a.json() for a in self.args]
        if self.kwargs:
            out["kwargs"] = {k: v.json() for k, v in self.kwargs}
        if self.then:
            out["then"] = [c.json() for c in self.then]
        return out


@dataclass(frozen=True)
class Animate(Node):
    """target.animate.call(...).call(...)"""

    on: Node
    calls: tuple

    def py(self) -> str:
        return f"{self.on.py()}.animate." + ".".join(c.py() for c in self.calls)

    def json(self):
        return {"animate": self.on.json(), "calls": [c.json() for c in self.calls]}


# ---------------------------------------------------------------------- statements


@dataclass(frozen=True)
class Do:
    """A call on its own line. `wrap`: split a long call over several lines, one argument each."""

    node: Node
    wrap: bool = False

    def lines(self, indent: str) -> list[str]:
        if self.wrap and isinstance(self.node, Call) and not self.node.then:
            return join_call(self.node.callee, self.node.arg_codes(), indent)
        return [indent + self.node.py()]

    def json(self):
        return {"do": self.node.json()}


@dataclass(frozen=True)
class Assign:
    target: str  # a scene attribute, e.g. self.camera.background_color
    value: Node

    def lines(self, indent: str) -> list[str]:
        return [f"{indent}{self.target} = {self.value.py()}"]

    def json(self):
        return {"set": self.target, "value": self.value.json()}


@dataclass(frozen=True)
class Comment:
    text: str

    def lines(self, indent: str) -> list[str]:
        return [indent + line for line in self.text.splitlines()]

    def json(self):
        return None


def join_call(prefix: str, args: list[str], indent: str) -> list[str]:
    one_line = f"{indent}{prefix}({', '.join(args)})"
    if len(one_line) <= MAX_LINE:
        return [one_line]
    return [f"{indent}{prefix}(", *[f"{indent}    {a}," for a in args], f"{indent})"]


def statements_json(stmts) -> list:
    return [s.json() for s in stmts if not isinstance(s, Comment)]


# ---------------------------------------------------------------------- literals


def literal_value(code: str):
    """What a printed number or string evaluates to."""
    return ast.literal_eval(code)


def number(code: str) -> Lit:
    return Lit(code, literal_value(code))
