"""Manim for code that runs in Manimator: the same names as `from manim import *`, made by the browser engine.

Each Manim object here wraps the engine's object (`_js`). Calls, attributes and self.play go to the engine
(code/PyBridge.js gives them as the `_manimator` module); numbers and points come back as numpy arrays.
"""

import inspect
import sys
import traceback

import numpy as np
from pyodide.ffi import JsProxy, create_proxy, to_js

import _manimator as _bridge

_wrappers = {}  # engine object id -> its Python object (so `is` and Python attributes keep working)
_proxies = []  # Python callables the engine holds, freed after the run
_last_error = None
_scene_names = []  # the scenes the last script run defines, in order
SCRIPT = "scene.py"


# ---------------------------------------------------------------------------------------------- crossing over

def _js(v):
    """A Python value as the engine takes it."""
    if isinstance(v, (_Wrap, _Animate)):
        return v._js
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return to_js(v.tolist())
    if isinstance(v, (list, tuple)):
        out = _bridge.array()
        for x in v:
            out.push(_js(x))
        return out
    if isinstance(v, dict):
        out = _bridge.object()
        for k, x in v.items():
            _bridge.set(out, str(k), _js(x))
        return out
    if isinstance(v, JsProxy):
        return v
    if callable(v):
        return _callback(v)
    raise TypeError(f"Manimator can't pass a {type(v).__name__} to Manim")


def _kw(kwargs):
    return _js(kwargs)


def _py(v):
    """An engine value as Python sees it."""
    if not isinstance(v, JsProxy):
        return v
    kind = _bridge.kind(v)
    if kind in ("mobject", "animation"):
        return _wrap(v)
    if kind == "numbers":
        return np.array(_bridge.numbers(v).to_py(), dtype=float)
    if kind == "array":
        return [_py(x) for x in v]
    if kind == "other" and not callable(v) and _bridge.has(v, "constructor"):
        return _Thing(v)
    return v


def _takes_dt(fn):
    try:
        params = [p for p in inspect.signature(fn).parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    except (TypeError, ValueError):
        return None
    return len(params) >= 2


def _callback(fn):
    def call(*args):
        return _js(fn(*[_py(a) for a in args]))
    proxy = create_proxy(call)
    _proxies.append(proxy)
    return _bridge.fn(proxy, _takes_dt(fn))


def _wrap(js):
    key = _bridge.id(js)
    found = _wrappers.get(key)
    if found is not None:
        return found
    name = _bridge.className(js)
    cls = _CLASSES.get(name, Animation if _bridge.kind(js) == "animation" else Mobject)
    obj = cls.__new__(cls)
    _adopt(obj, js)
    return obj


def _adopt(obj, js):
    object.__setattr__(obj, "_js", js)
    _wrappers[_bridge.id(js)] = obj


def _engine_name(cls):
    for c in cls.__mro__:
        if "_name" in c.__dict__:
            return c.__dict__["_name"]
    raise TypeError(f"{cls.__name__} isn't a Manim class")


# ---------------------------------------------------------------------------------------------- objects

class _Wrap:
    """An engine object: its methods and attributes, called the way Python calls them."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        js = object.__getattribute__(self, "_js")
        kind = _bridge.attrKind(js, name)
        if kind == "missing":
            raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")
        if kind == "method":
            def method(*args, **kwargs):
                return _py(_bridge.call(js, name, _js(list(args)), _kw(kwargs)))
            method.__name__ = name
            return method
        return _py(_bridge.get(js, name))

    def __setattr__(self, name, value):
        if not name.startswith("_") and _bridge.has(self._js, name):
            _bridge.set(self._js, name, _js(value))
        else:
            object.__setattr__(self, name, value)

    def __eq__(self, other):
        return isinstance(other, _Wrap) and _bridge.id(self._js) == _bridge.id(other._js)

    def __hash__(self):
        return _bridge.id(self._js)


class _Thing(_Wrap):
    """An engine object that isn't a Manim object or animation (a camera...)."""

    def __init__(self, js):
        _adopt(self, js)

    def __repr__(self):
        return f"<{_bridge.get(_bridge.get(self._js, 'constructor'), 'name')}>"


class Mobject(_Wrap):
    _name = "Mobject"

    def __init__(self, *args, **kwargs):
        _adopt(self, _bridge.make(_engine_name(type(self)), _js(list(args)), _kw(kwargs)))

    def __repr__(self):
        return type(self).__name__

    @property
    def animate(self):
        return _Animate(self)

    def __getitem__(self, index):
        subs = self.submobjects
        if isinstance(index, slice):
            return (VGroup if isinstance(self, VMobject) else Group)(*subs[index])
        return subs[index]

    def __iter__(self):
        return iter(self.submobjects)

    def __len__(self):
        return len(self.submobjects)

    def __add__(self, other):
        return (VGroup if isinstance(self, VMobject) else Group)(self, other)

    def coords_to_point(self, *coords):
        """Axes.coords_to_point: one point, or many given as arrays (the engine's takes one point)."""
        c = np.asarray(coords, dtype=float)
        transposed = False
        if c.ndim == 3:  # c2p([[x1, y1, z1], [x2, y2, z2], ...])
            c = c[0]
            if c.shape[0] == 1:
                c = c[0]
            else:
                c = c.T
                transposed = True
        elif c.ndim == 2 and c.shape[0] == 1:  # c2p([x, y, z])
            c = c[0]
        one = lambda xs: _py(_bridge.call(self._js, "coords_to_point", _js([float(x) for x in xs]), _kw({})))  # noqa: E731
        if c.ndim == 1:
            return one(c)
        points = np.array([one(col) for col in c.T])
        return points if transposed else points.T

    c2p = coords_to_point


class Animation(_Wrap):
    _name = "Animation"

    def __init__(self, *args, **kwargs):
        _adopt(self, _bridge.make(_engine_name(type(self)), _js(list(args)), _kw(kwargs)))

    def __repr__(self):
        return f"{type(self).__name__}()"


class _Animate:
    """mobject.animate: method calls become one animation."""

    def __init__(self, mobject):
        object.__setattr__(self, "_js", _bridge.animate(mobject._js))

    def __call__(self, **kwargs):
        _bridge.builderArgs(self._js, _kw(kwargs))
        return self

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        def method(*args, **kwargs):
            _bridge.builderCall(self._js, name, _js(list(args)), _kw(kwargs))
            return self
        return method


_CLASSES = {"Mobject": Mobject, "Animation": Animation}


def _make_classes(table, base):
    pending = dict(table.to_py())
    while pending:
        for name, parent in list(pending.items()):
            if name in _CLASSES:
                del pending[name]
            elif parent is None or parent in _CLASSES:
                _CLASSES[name] = type(name, (_CLASSES.get(parent, base),), {"_name": name, "__module__": __name__})
                del pending[name]


_make_classes(_bridge.classes(), Mobject)
_make_classes(_bridge.animations(), Animation)
globals().update(_CLASSES)

for _name in _bridge.constants():
    _value = _py(_bridge.constant(_name))
    globals()[_name] = _value


# ---------------------------------------------------------------------------------------------- scenes

class Scene:
    """A scene: construct() plays its animations with self.play and self.wait, which the engine records."""

    _kind = "Scene"

    def __init__(self):
        _bridge.newScene(type(self)._scene_kind())

    @classmethod
    def _scene_kind(cls):
        for c in cls.__mro__:
            if "_kind" in c.__dict__:
                return c.__dict__["_kind"]
        return "Scene"

    def setup(self):
        pass

    def construct(self):
        pass

    def play(self, *args, **kwargs):
        _bridge.scene("play", _js(list(args)), _kw(kwargs))

    def wait(self, duration=1.0, stop_condition=None, frozen_frame=None):
        _bridge.scene("wait", _js([duration, stop_condition, frozen_frame]), _kw({}))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        kind = _bridge.sceneAttrKind(name)
        if kind == "missing":
            raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")
        if kind == "method":
            def method(*args, **kwargs):
                return _py(_bridge.scene(name, _js(list(args)), _kw(kwargs)))
            method.__name__ = name
            return method
        return _py(_bridge.sceneAttr(name))

    @property
    def mobjects(self):
        return _py(_bridge.sceneAttr("mobjects"))


for _kind in _bridge.sceneKinds():
    if _kind != "Scene":
        globals()[_kind] = type(_kind, (Scene,), {"_kind": _kind, "__module__": __name__})

__all__ = [n for n in globals() if not n.startswith("_") and n not in ("inspect", "sys", "traceback", "JsProxy",
                                                                    "create_proxy", "to_js", "SCRIPT")]
__all__ += ["np"]


# ---------------------------------------------------------------------------------------------- running

class _Output:
    def __init__(self, stream):
        self.stream = stream

    def write(self, text):
        if text:
            _bridge.print(text, self.stream)
        return len(text)

    def flush(self):
        pass


def _user_traceback(exc):
    """The error as the user's script sees it: only its own lines."""
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == SCRIPT]
    lines = ["Traceback (most recent call last):\n"] if frames else []
    lines += traceback.format_list(frames)
    lines += traceback.format_exception_only(type(exc), exc)
    return "".join(lines).rstrip()


def _run(code, scene_name=None):
    """Runs a script and the construct() of its scene (`scene_name`, or the first Scene class it defines)."""
    global _last_error, _scene_names
    _last_error = None
    _scene_names = []
    _wrappers.clear()
    for p in _proxies:
        p.destroy()
    _proxies.clear()
    out, err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _Output("out"), _Output("err")
    try:
        namespace = {"__name__": "__main__", "__file__": SCRIPT}
        exec(compile(code, SCRIPT, "exec"), namespace)
        scenes = [v for v in namespace.values() if isinstance(v, type) and issubclass(v, Scene) and v.__module__ == "__main__"]
        _scene_names = [v.__name__ for v in scenes]
        if scene_name:
            scenes = [s for s in scenes if s.__name__ == scene_name]
        if not scenes:
            raise NameError(f"There's no scene named {scene_name}" if scene_name else "The code has no Scene class")
        scene = scenes[0]()
        scene.setup()
        scene.construct()
    except BaseException as exc:  # noqa: BLE001 - any error is the script's, shown in the console
        _last_error = _user_traceback(exc)
    finally:
        sys.stdout, sys.stderr = out, err
    return _last_error
