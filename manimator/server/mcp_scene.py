"""Scenes written by an AI assistant for the MCP App (server/mcp.py): its JSON, checked as the editor checks edits.

The assistant sends one JSON object: the objects (each with a name and Manimator's settings for its type), then
the steps that animate them, referring to objects by name. Every value goes through the editor's own checks
(session.coerce, ops.check_step, the animations' checks), and every problem is reported at once with where it is,
so the assistant can fix them all in its next try. The result is an ordinary Manimator project.
"""

from __future__ import annotations

import copy
import difflib
import json
import math
import re
from dataclasses import dataclass, field
from typing import Callable

from ..model import ops
from ..model.project import PLAY, WAIT, AnimationItem, MethodCall, MobjectItem, Project, Scene, Step, new_id
from ..registry import ANIMATIONS, METHODS, MOBJECTS
from ..registry.animations import ANIMATE, RATE_FUNCS
from ..registry.custom import is_kit_type
from ..registry.mobjects import SHAPE, STYLE_FIELDS
from ..registry.params import (
    ANGLE, BOOL, COLOR, DIRECTION, DIRECTION_VECTORS, ENUM, EXPR, FILE, FLOAT, FONT, GRID, INT, MOBREF, MOBREFS,
    NUMBERS, POINT, POINT3, POINTS, RANGE, STR, TEXT, VECTOR, Param,
)
from ..registry.scenes import FIXED_CHOICES, MOVING_VECTOR, SCENE, SCENE_KINDS, THREE_D, TRANSFORM_ROLES, VECTOR_TYPES
from .session import OpError, coerce

MAX_OBJECTS = 120
MAX_STEPS = 150
MAX_DURATION = 600.0  # seconds
MAX_PROBLEMS = 15
FILE_TYPES = ("ImageMobject", "SVGMobject")  # need an uploaded file, which a chat has no way to give
KIT_REFUSED = ("custom objects and animations (customizations) can be used only through the Manimator connector "
               "signed in to the user's account")
_KEPT_PARAM = re.compile(r"^[a-z][a-z0-9_]{0,31}$")

_OBJECT_FIELDS = ("name", "type", "params", "style", "position", "rotation", "scale", "z_index", "z", "methods",
                  "on_screen_at_start", "fixed", "transform_role")
_STEP_FIELDS = ("play", "wait", "run_time", "rate_func", "lag_ratio")
_ANIM_FIELDS = ("anim", "target", "method", "params", "args")
_RATES = {name: name for name, _label in RATE_FUNCS}
_RATES.update({name.split(".")[-1]: name for name, _label in RATE_FUNCS})  # "ease_in_sine" as well


class SceneSpecError(ValueError):
    """The scene can't be made; `problems` lists what to fix, each starting with where it is."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("\n".join(problems))


class _Skip(Exception):
    """A reference to an object that was already reported as broken: nothing more to say about it."""


def _suggest(word, choices) -> str:
    close = difflib.get_close_matches(str(word), list(choices), n=3, cutoff=0.6) if isinstance(word, str) else []
    return f" Did you mean {' or '.join(repr(c) for c in close)}?" if close else ""


def _names(items) -> str:
    items = list(items)
    return ", ".join(items) if items else "none"


def _label(key) -> str:
    """How a type is named in messages: a customization by its class name."""
    spec = ops.kit_spec(key) if is_kit_type(key) else None
    return spec.kit["class"] if spec is not None and spec.kit else str(key)


def _find(params, name) -> Param | None:
    return next((p for p in params if p.name == name), None)


def _number(value, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise OpError(f"expected a number, not {json.dumps(value)}")
    return float(min(hi, max(lo, value)))


def _no_files(_name: str) -> str:
    raise OpError("files can't be used here")


MAX_SCENE_NAME = 24


def _class_name(title) -> str:
    """A scene's name (its tab in Manimator, and the Python class) from its title: short PascalCase words, as the
    owner wants them. A leading number goes, apart or not ("2. Squares on the sides", "3ProofByRearrangement"):
    tabs are in order already, and a name can't start with one (it would become _3Proof...). Whole words up to
    MAX_SCENE_NAME characters."""
    words = re.findall(r"[A-Za-z0-9]+", str(title or ""))
    while words and words[0][:1].isdigit():
        words[0] = words[0].lstrip("0123456789")
        if not words[0]:
            words.pop(0)
    name = ""
    for w in words:
        part = w[:1].upper() + w[1:]
        if name and len(name) + len(part) > MAX_SCENE_NAME:
            break
        name += part
    return name[:40] or "Explainer"


@dataclass(frozen=True)
class KitAccess:
    """The customizations (server/kits.py) an account may put in scenes, as the editor allows them: `check(key)`
    raises OpError unless it may add that type now (Workspace.check_kit); `usable` maps class names to the type to
    add (its own packages, its library's approved ones). Types in `keep` (already in the scene being changed) stay
    whatever check() says, as the editor keeps them; `prefer` (used anywhere in the project) decides which version a
    class name means."""

    check: Callable[[str], None]
    usable: dict = field(default_factory=dict)
    keep: frozenset = frozenset()
    prefer: frozenset = frozenset()

    def named(self, name: str) -> str | None:
        for key in sorted(self.prefer):
            spec = ops.kit_spec(key)
            if spec is not None and spec.kit and spec.kit.get("class") == name:
                return key
        return self.usable.get(name)

    def listing(self, kind: str | None = None) -> str:
        names = [f"{cls} ({ops.kit_spec(key).kit['kind']})" for cls, key in self.usable.items()
                 if kind is None or ops.kit_spec(key).kit["kind"] == kind]
        return _names(names)


@dataclass(frozen=True)
class Rules:
    """What a scene may hold. Guests: no files, MAX_OBJECTS/MAX_STEPS, no customizations. An account (the User MCP):
    the editor's own limits, files the account uploaded in Manimator (`assets` checks a name, as session.coerce
    does), and its customizations (`kits`)."""

    max_objects: int = MAX_OBJECTS
    max_steps: int = MAX_STEPS
    assets: Callable[[str], str] | None = None
    kits: KitAccess | None = None


GUEST = Rules()


def _kept_values(given) -> dict:
    """Settings of a customization that isn't available any more, kept as they were (there is no list of its
    settings to check them against): only the kinds of value a package's settings can have."""
    def plain(v):
        if isinstance(v, bool) or isinstance(v, int) or isinstance(v, float) and math.isfinite(v):
            return True
        if isinstance(v, str):
            return len(v) <= 2000
        return isinstance(v, list) and len(v) <= 3 and all(
            isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v)
    if not isinstance(given, dict):
        return {}
    return {k: copy.deepcopy(v) for k, v in list(given.items())[:40] if isinstance(k, str) and _KEPT_PARAM.match(k)
            and plain(v)}


class _Builder:
    def __init__(self, spec: dict, rules: Rules = GUEST):
        self.spec = spec
        self.rules = rules
        self.problems: list[str] = []
        self.project = Project.new()
        self.scene: Scene = self.project.scenes[0]
        self.ids: dict[str, str] = {}  # the assistant's names -> object ids
        self.broken: set[str] = set()  # names of objects already reported as broken
        self.shown: dict[str, bool] = {}  # explicit on_screen_at_start, by object id

    def problem(self, where: str, message: str) -> None:
        if len(self.problems) < MAX_PROBLEMS:
            self.problems.append(f"{where}: {message}" if where else message)

    def unknown_fields(self, where: str, data: dict, allowed) -> None:
        for key in data:
            if key not in allowed:
                self.problem(where, f"unknown field {key!r}.{_suggest(key, allowed)} Fields here: {_names(allowed)}")

    def ref(self, value) -> str:
        if isinstance(value, str) and value in self.ids:
            return self.ids[value]
        if isinstance(value, str) and value in self.broken:
            raise _Skip
        raise OpError(f"no object named {json.dumps(value)}.{_suggest(value, self.ids)} "
                      f"Objects: {_names(self.ids)}")

    def value(self, p: Param, value, where: str):
        """A setting's value as the project stores it; names of objects become their ids."""
        if p.kind == MOBREF and value is not None:
            value = self.ref(value)
        elif p.kind == MOBREFS:
            if not isinstance(value, list):
                raise OpError("expected a list of object names")
            value = [self.ref(v) for v in value]
        return coerce(p, value, self.scene, None, assets=self.rules.assets or _no_files)

    def settings(self, params, values: dict, given, where: str, owner: str) -> None:
        """Checks and stores `given` (the assistant's settings) into `values`."""
        if given is None:
            return
        if not isinstance(given, dict):
            self.problem(where, 'expected an object like {"name": value}')
            return
        for key, raw in given.items():
            p = _find(params, key)
            if p is None:
                names = [q.name for q in params]
                self.problem(where, f"{owner} has no setting {key!r}.{_suggest(key, names)} "
                                    f"Its settings: {_names(names)}")
                continue
            try:
                values[key] = self.value(p, raw, where)
            except OpError as e:
                self.problem(f"{where}.{key}", str(e))
            except _Skip:
                pass

    def custom(self, where: str, name, kind: str) -> str | None:
        """The customization `name` means ("kit:<id>:<version>", or the class name of one the account can use), if it
        may go in this scene: None when `name` isn't one, "" when it is but can't (reported)."""
        access = self.rules.kits
        key = name if is_kit_type(name) else access.named(name) if access is not None and isinstance(name, str) \
            else None
        if key is None:
            return None
        if access is None:
            self.problem(where, KIT_REFUSED)
            return ""
        spec = ops.kit_spec(key)
        if spec is not None and spec.kit and spec.kit.get("kind") != kind:
            use = 'in steps ("anim")' if kind == "object" else 'as an object ("type")'
            self.problem(where, f"{spec.kit['class']} is a custom {spec.kit['kind']}: use it {use}")
            return ""
        if key not in access.keep:
            try:
                access.check(key)
            except OpError as e:
                self.problem(where, f"{name}: {e} Customizations this account can use: {access.listing(kind)}")
                return ""
        return key

    def kit_names(self, kind: str) -> list[str]:
        """Class names of the account's customizations of this kind, for "did you mean"."""
        access = self.rules.kits
        if access is None:
            return []
        return [cls for cls, key in access.usable.items() if ops.kit_spec(key).kit["kind"] == kind]

    def required_refs(self, params, values: dict, where: str, owner: str) -> None:
        for p in params:
            if p.kind == MOBREF and not p.optional and values.get(p.name) is None:
                self.problem(where, f"{owner} needs {p.name!r}: the name of another object")
            elif p.kind == MOBREFS and len(values.get(p.name) or []) < p.min_items:
                self.problem(where, f"{owner} needs at least {p.min_items} object(s) in {p.name!r}")

    # ------------------------------------------------------------------ the scene
    def build(self) -> Project:
        spec = self.spec
        if not isinstance(spec, dict):
            raise SceneSpecError(["The scene must be a JSON object with \"objects\" and \"steps\"."])
        # text: the explanation ShowAnimation shows above the clip (server/mcp.py); scenes ignore it
        # (text_before: its forerunner, still sent by chats begun on 2026-10-16)
        self.unknown_fields("", spec, ("title", "scene", "scene_options", "background", "objects", "steps",
                                       "text", "text_before"))
        scene = self.scene
        scene.name = ops.unique_scene_name(self.project, _class_name(spec.get("title")), exclude_id=scene.id)
        kind = spec.get("scene") or SCENE
        if kind not in SCENE_KINDS:
            self.problem("scene", f"unknown scene type {json.dumps(kind)}.{_suggest(kind, SCENE_KINDS)} "
                                  f"Types: {_names(SCENE_KINDS)}")
            kind = SCENE
        scene.kind = kind
        options = spec.get("scene_options")
        if options is not None:
            self.settings(SCENE_KINDS[kind].options, scene.options, options, "scene_options", kind)
        if spec.get("background") is not None:
            try:
                self.project.settings.background = coerce(Param("background", COLOR), spec["background"])
            except OpError as e:
                self.problem("background", str(e))
        self.objects(spec.get("objects", []))
        self.steps(spec.get("steps", []))
        self.visibility()
        duration = sum(s.duration if s.kind == WAIT else s.run_time for s in scene.steps)
        if duration > MAX_DURATION:
            self.problem("steps", f"the video would be {duration:g} s long; keep it under {MAX_DURATION:g} s")
        clash = kit_clash(self.project)
        if clash:
            self.problem("", clash)
        if self.problems:
            raise SceneSpecError(self.problems)
        ops.sanitize_project(self.project)
        return self.project

    # ------------------------------------------------------------------ objects
    def objects(self, raw) -> None:
        if not isinstance(raw, list):
            self.problem("objects", "expected a list of objects")
            return
        most = self.rules.max_objects
        if len(raw) > most:
            self.problem("objects", f"at most {most} objects are allowed")
            raw = raw[:most]
        made = []
        for i, data in enumerate(raw):  # first every object, so that any of them can refer to any other
            where = f"objects[{i}]"
            if not isinstance(data, dict):
                self.problem(where, 'expected an object like {"name": "circle", "type": "Circle"}')
                continue
            name = data.get("name")
            if name is not None and not (isinstance(name, str) and name.strip()):
                self.problem(where, "name must be a non-empty string")
                continue
            if name is not None:
                where += f" ({name})"
            kind = data.get("type")
            custom = self.custom(where, kind, "object")  # a customization (server/kits.py)
            if custom == "":
                if isinstance(name, str):
                    self.broken.add(name)
                continue
            kind = custom or kind
            spec = MOBJECTS.get(kind) if isinstance(kind, str) else None
            no_files = kind in FILE_TYPES and self.rules.assets is None
            if spec is None or no_files:
                why = "needs an uploaded file, which isn't available here" if no_files else \
                    f"unknown type {json.dumps(kind)}.{_suggest(kind, [*MOBJECTS, *self.kit_names('object')])}"
                self.problem(where, why)
                if isinstance(name, str):
                    self.broken.add(name)
                continue
            if name in self.ids:
                self.problem(where, f"another object is already named {name!r}")
                continue
            item = MobjectItem(id=new_id(), type=kind, name=ops.unique_mobject_name(self.scene, name or spec.name),
                               params=ops.default_params(spec.params), style=copy.deepcopy(spec.default_style),
                               scale=spec.initial_scale)
            self.scene.mobjects.append(item)
            if name is not None:
                self.ids[name] = item.id
            made.append((where, data, item))
        for where, data, item in made:
            self.settle(where, data, item)
        for where, _data, item in made:
            refs = ops.mobject_refs(item)
            if item.id in refs or refs & (ops.dependents(self.scene, item.id) - {item.id}):
                self.problem(where, "objects refer to each other in a loop (through params or methods)")
        if any(MOBJECTS[m.type].three_d for m in self.scene.mobjects) and self.scene.kind == SCENE:
            self.scene.kind = THREE_D  # 3D objects need a 3D camera (as when they're added in the editor)

    def settle(self, where: str, data: dict, item: MobjectItem) -> None:
        """Everything about one object except its type and name."""
        self.unknown_fields(where, data, _OBJECT_FIELDS)
        spec = MOBJECTS[item.type]
        if spec.blocked:  # a customization that isn't available any more: kept as it was, never drawn
            item.params = _kept_values(data.get("params"))
            item.style = _kept_values(data.get("style"))
        else:
            self.settings(spec.params, item.params, data.get("params"), f"{where}.params", _label(item.type))
            self.required_refs(spec.params, item.params, f"{where}.params", _label(item.type))
            self.style(where, data.get("style"), item)
        if data.get("position") is not None:
            try:
                x, y = coerce(Param("position", POINT), data["position"])
                if not (spec.positioned or spec.point_params):
                    raise OpError(f"a {item.type} is drawn where its settings put it, so it has no position")
                ops.set_mobject_position(item, round(min(50, max(-50, x)), 3), round(min(50, max(-50, y)), 3))
            except OpError as e:
                self.problem(f"{where}.position", str(e))
        elif item.type == "Polygon":  # as in Manim: the corners are where they're listed (the editor centers it)
            xs, ys = zip(*item.params["points"])
            item.position = [round((min(xs) + max(xs)) / 2, 4), round((min(ys) + max(ys)) / 2, 4)]
        elif item.type == "Vector":  # as in Manim: from the origin to `direction`
            item.position = [round(v / 2, 4) for v in item.params["direction"]]
        for name, lo, hi in (("rotation", -36000, 36000), ("scale", 0.01, 100), ("z_index", -100, 100),
                             ("z", -50, 50)):
            if data.get(name) is not None:
                try:
                    v = _number(data[name], lo, hi)
                    setattr(item, name, int(round(v)) if name == "z_index" else round(v, 4))
                except OpError as e:
                    self.problem(f"{where}.{name}", str(e))
        if data.get("on_screen_at_start") is not None:
            self.shown[item.id] = bool(data["on_screen_at_start"])
        fixed = data.get("fixed")
        if fixed is not None:
            if fixed not in {v for v, _label in FIXED_CHOICES}:
                self.problem(f"{where}.fixed", f'use "in_frame", "orientation" or "" (not {json.dumps(fixed)})')
            else:
                item.fixed = fixed
        role = data.get("transform_role")
        if role is not None:
            roles = {"", *(v for v, _label in TRANSFORM_ROLES)}
            if role not in roles:
                self.problem(f"{where}.transform_role", f"use one of {_names(json.dumps(r) for r in sorted(roles))}")
            elif role == MOVING_VECTOR and item.type not in VECTOR_TYPES:
                self.problem(f"{where}.transform_role", "only a Vector or Arrow can move as a vector")
            else:
                item.transform_role = role
        methods = data.get("methods")
        if methods is None:
            return
        if not isinstance(methods, list):
            self.problem(f"{where}.methods", 'expected a list like [{"method": "to_edge", "args": {"edge": "UP"}}]')
            return
        for k, call in enumerate(methods):
            mw = f"{where}.methods[{k}]"
            built = self.method_call(mw, call)
            if built is not None:
                item.methods.append(MethodCall(*built))

    def style(self, where: str, given, item: MobjectItem) -> None:
        if given is None:
            return
        fields = STYLE_FIELDS[MOBJECTS[item.type].style_kind]
        if not fields:
            self.problem(f"{where}.style", f"a {_label(item.type)} has no style settings (it has its own colors)")
            return
        if not isinstance(given, dict):
            self.problem(f"{where}.style", 'expected an object like {"color": "BLUE"}')
            return
        given = dict(given)
        if MOBJECTS[item.type].style_kind == SHAPE and "color" in given:  # Circle(color=BLUE): outline and fill
            color = given.pop("color")
            given.setdefault("stroke_color", color)
            given.setdefault("fill_color", color)
        self.settings(fields, item.style, given, f"{where}.style", f"a {_label(item.type)}'s style")

    def method_call(self, where: str, call) -> tuple[str, dict] | None:
        if not isinstance(call, dict):
            self.problem(where, 'expected {"method": name, "args": {...}}')
            return None
        self.unknown_fields(where, call, ("method", "args", "params"))
        name = call.get("method")
        spec = METHODS.get(name) if isinstance(name, str) else None
        if spec is None:
            self.problem(where, f"unknown method {json.dumps(name)}.{_suggest(name, METHODS)} Methods: {_names(METHODS)}")
            return None
        args = ops.default_params(spec.params)
        self.settings(spec.params, args, call.get("args", call.get("params")), f"{where}.args", name)
        self.required_refs(spec.params, args, f"{where}.args", name)
        return name, args

    # ------------------------------------------------------------------ steps
    def steps(self, raw) -> None:
        if not isinstance(raw, list):
            self.problem("steps", "expected a list of steps")
            return
        most = self.rules.max_steps
        if len(raw) > most:
            self.problem("steps", f"at most {most} steps are allowed")
            raw = raw[:most]
        for j, data in enumerate(raw):
            where = f"steps[{j}]"
            if not isinstance(data, dict) or ("play" in data) == ("wait" in data):
                self.problem(where, 'a step is {"play": [animations...]} or {"wait": seconds}')
                continue
            self.unknown_fields(where, data, _STEP_FIELDS)
            if "wait" in data:
                try:
                    self.scene.steps.append(Step(kind=WAIT, duration=_number(data["wait"], 0.05, 60)))
                except OpError as e:
                    self.problem(f"{where}.wait", str(e))
                continue
            anims = data["play"]
            if isinstance(anims, dict):
                anims = [anims]
            if not isinstance(anims, list) or not anims:
                self.problem(f"{where}.play", "expected a non-empty list of animations")
                continue
            step = Step(kind=PLAY)
            for k, a in enumerate(anims):
                anim = self.animation(f"{where}.play[{k}]", a, j)
                if anim is not None:
                    step.animations.append(anim)
            if not step.animations:
                continue
            step.run_time = max(1.0 if a.anim == ANIMATE else ANIMATIONS[a.anim].run_time for a in step.animations)
            try:
                ops.check_step(self.scene, step)
            except ValueError as e:
                self.problem(where, str(e))
                continue
            for name, lo, hi in (("run_time", 0.05, 60), ("lag_ratio", 0, 1)):
                if data.get(name) is not None:
                    try:
                        setattr(step, name, _number(data[name], lo, hi))
                    except OpError as e:
                        self.problem(f"{where}.{name}", str(e))
            if data.get("rate_func") is not None:
                rate = _RATES.get(data["rate_func"]) if isinstance(data["rate_func"], str) else None
                if rate is None:
                    self.problem(f"{where}.rate_func", f"unknown rate function {json.dumps(data['rate_func'])}. "
                                                       f"Use one of: {_names(n for n in _RATES if '.' not in n)}")
                else:
                    step.rate_func = rate
            ops.sync_step_time(step)  # a step playing a sequence of its own lasts as long as that
            self.scene.steps.append(step)

    def animation(self, where: str, data, step_index: int) -> AnimationItem | None:
        if not isinstance(data, dict):
            self.problem(where, 'expected {"anim": name, "target": object name, ...}')
            return None
        self.unknown_fields(where, data, _ANIM_FIELDS)
        key = data.get("anim")
        custom = self.custom(where, key, "animation")  # a customization (server/kits.py)
        if custom == "":
            return None
        key = custom or key
        if key != ANIMATE and key not in ANIMATIONS:
            choices = [*ANIMATIONS, ANIMATE, *self.kit_names("animation")]
            self.problem(where, f"unknown animation {json.dumps(key)}.{_suggest(key, choices)}")
            return None
        given = data.get("params", data.get("args"))
        target_name = data.get("target")
        if key == ANIMATE:
            name = data.get("method")
            spec = METHODS.get(name) if isinstance(name, str) else None
            if spec is None:
                self.problem(where, f'Animate needs "method", one of: {_names(METHODS)}')
                return None
            target = self.target(where, target_name)
            args = ops.default_params(spec.params)
            self.settings(spec.params, args, given, f"{where}.params", f"{name}")
            self.required_refs(spec.params, args, f"{where}.params", name)
            return AnimationItem(ANIMATE, target, args, name) if target else None
        spec = ANIMATIONS[key]
        values = ops.default_params(spec.params)
        if spec.scene_action:
            if self.scene.kind not in spec.scene_kinds:
                self.problem(where, f"{key} needs \"scene\": {' or '.join(json.dumps(k) for k in spec.scene_kinds)}")
                return None
            refs = [p for p in spec.params if p.kind in (MOBREF, MOBREFS)]
            if target_name is not None and len(refs) == 1 and refs[0].name not in (given or {}):
                given = {**(given or {}), refs[0].name: target_name if refs[0].kind == MOBREF else [target_name]}
            if key == "camera_move3d":  # from wherever the camera is by then
                values.update(ops.camera_angles_before(self.scene, step_index))
            target = None
        else:
            target = self.target(where, target_name)
            if target is None:
                return None
            item = self.scene.mob(target)
            if spec.only and item.type not in spec.only:
                self.problem(where, f"{key} only works on {_names(spec.only)} (not on a {item.type})")
                return None
        if spec.blocked:  # a customization that isn't available any more: kept as it was
            return AnimationItem(key, target, _kept_values(given))
        self.settings(spec.params, values, given, f"{where}.params", _label(key))
        self.required_refs(spec.params, values, f"{where}.params", _label(key))
        second = spec.second_target
        if spec.only and second is not None and values.get(second.name):
            other = self.scene.mob(values[second.name])
            if other is not None and other.type not in spec.only:
                self.problem(f"{where}.params.{second.name}", f"{key} needs a {_names(spec.only)} here")
        if spec.check is not None:
            try:
                spec.check(values)
            except ValueError as e:
                self.problem(f"{where}.params", str(e))
        return AnimationItem(key, target, values)

    def target(self, where: str, name) -> str | None:
        if name is None:
            self.problem(where, 'needs "target": the name of the object to animate')
            return None
        try:
            return self.ref(name)
        except OpError as e:
            self.problem(f"{where}.target", str(e))
        except _Skip:
            pass
        return None

    # ------------------------------------------------------------------ who is on screen when
    def visibility(self) -> None:
        """As the editor decides it: an object first brought in by an animation (or that a transform turns
        something into) is not on screen before then. The assistant's own on_screen_at_start wins."""
        scene = self.scene
        auto_visibility(scene)
        for mob_id, shown in self.shown.items():
            scene.mob(mob_id).on_screen_at_start = shown


def kit_clash(project: Project) -> str:
    """Why the project can't hold its customizations together ("" if it can): two different packages (or versions)
    with the same class name, which the Python download can't import side by side."""
    for key in ops.kit_types_in(project):
        cls = ops.kit_class_clash(project, key)
        if cls:
            used = [k for k in ops.kit_types_in(project) if _label(k) == cls]
            return (f"two different customizations called {cls} ({', '.join(used)}): a project can use only one; "
                    f"use the same type everywhere")
    return ""


def auto_visibility(scene: Scene) -> None:
    """Who is on screen at the start, as the editor decides it when steps are added (ops.apply_visibility_rules)."""
    for m in scene.mobjects:
        m.on_screen_at_start = True
    for j, step in enumerate(scene.steps):
        for a in step.animations:
            ops.apply_visibility_rules(scene, j, a)


# ---------------------------------------------------------------------- a saved scene, written back as JSON


def _same(a, b) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(a - b) < 1e-9
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    return a == b


def scene_spec(scene: Scene) -> dict:
    """A scene of a project (as the editor keeps it, maybe changed there by hand) in the format ShowAnimation takes,
    so an assistant can read it and send it back changed: build_project(scene_spec(s)) makes the same scene.
    Settings equal to their defaults are left out."""
    names = {m.id: m.name for m in scene.mobjects}

    def out(p: Param, value):
        if p.kind == MOBREF:
            return names.get(value)
        if p.kind == MOBREFS:
            return [names[i] for i in value or [] if i in names]
        return copy.deepcopy(value)

    def changed(params, values: dict, keep=()) -> dict:
        return {p.name: out(p, values[p.name]) for p in params
                if p.name in values and (p.name in keep or not _same(values[p.name], p.default))}

    auto = copy.deepcopy(scene)
    auto_visibility(auto)
    shown_by_rule = {m.id: m.on_screen_at_start for m in auto.mobjects}
    objects = []
    for m in scene.mobjects:
        spec = MOBJECTS[m.type]
        obj: dict = {"name": m.name, "type": m.type}
        # a customization that isn't available any more has no settings list: its values go back as they are
        params = copy.deepcopy(m.params) if spec.blocked else changed(spec.params, m.params)
        if params:
            obj["params"] = params
        style = copy.deepcopy(m.style) if spec.blocked else \
            {k: v for k, v in m.style.items() if not _same(v, spec.default_style.get(k))}
        if style:
            obj["style"] = style
        if spec.positioned and not spec.point_params:  # see _Builder.settle: where these start without a position
            if m.type == "Polygon":
                xs, ys = zip(*m.params["points"])
                start = [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2]
            elif m.type == "Vector":
                start = [v / 2 for v in m.params["direction"]]
            else:
                start = [0.0, 0.0]
            if not _same(list(m.position), start):
                obj["position"] = list(m.position)
        for name, default in (("rotation", 0), ("scale", spec.initial_scale), ("z_index", 0), ("z", 0)):
            if not _same(getattr(m, name), default):
                obj[name] = getattr(m, name)
        if m.methods:
            obj["methods"] = [{"method": c.method, **({"args": a} if (a := changed(METHODS[c.method].params, c.args))
                                                      else {})} for c in m.methods if c.method in METHODS]
        if m.on_screen_at_start != shown_by_rule.get(m.id, True):
            obj["on_screen_at_start"] = m.on_screen_at_start
        if m.fixed:
            obj["fixed"] = m.fixed
        if m.transform_role:
            obj["transform_role"] = m.transform_role
        objects.append(obj)
    steps = []
    for st in scene.steps:
        if st.kind == WAIT:
            steps.append({"wait": st.duration})
            continue
        anims = []
        for a in st.animations:
            item: dict = {"anim": a.anim}
            if a.target is not None:
                item["target"] = names.get(a.target)
            if a.anim == ANIMATE:
                item["method"] = a.method
                params = changed(METHODS[a.method].params, a.params)
            elif ANIMATIONS[a.anim].blocked:
                params = copy.deepcopy(a.params)
            else:  # a camera move starts from where the camera is: its angles are always given
                keep = ("phi", "theta", "gamma", "zoom") if a.anim == "camera_move3d" else ()
                params = changed(ANIMATIONS[a.anim].params, a.params, keep)
            if params:
                item["params"] = params
            anims.append(item)
        step: dict = {"play": anims, "run_time": st.run_time}
        if st.rate_func != "default":
            step["rate_func"] = st.rate_func.split(".")[-1]
        if st.lag_ratio:
            step["lag_ratio"] = st.lag_ratio
        steps.append(step)
    spec: dict = {"title": scene.name}
    if scene.kind != SCENE:
        spec["scene"] = scene.kind
    if scene.options:
        spec["scene_options"] = copy.deepcopy(scene.options)
    spec["objects"] = objects
    spec["steps"] = steps
    return spec


def build_project(spec, rules: Rules = GUEST) -> Project:
    """The assistant's scene as a project with one scene. Raises SceneSpecError listing every problem found."""
    return _Builder(spec, rules).build()


MAX_SCENES = 10
_FIELD_FIRST = re.compile(r"^[a-z_]+(\[|\.|:| \()")


def build_saved_project(spec, rules: Rules = GUEST) -> tuple[Project, str]:
    """CreateProject's input, {"name": ..., "scenes": [scene, ...]} with each scene written as for ShowAnimation, as
    one project and its name. The first background given is the project's. Raises SceneSpecError."""
    if not isinstance(spec, dict):
        raise SceneSpecError(['Expected {"name": "...", "scenes": [scene, ...]}.'])
    problems: list[str] = []
    for key in spec:
        if key not in ("name", "scenes"):
            problems.append(f"unknown field {key!r}. Fields here: name, scenes (each scene has its own objects and steps)")
    name = spec.get("name")
    if not isinstance(name, str) or not name.strip():
        problems.append("name: give the project a name")
    scenes = spec.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        problems.append("scenes: expected a list with at least one scene")
        scenes = []
    elif len(scenes) > MAX_SCENES:
        problems.append(f"scenes: at most {MAX_SCENES} scenes per project")
        scenes = scenes[:MAX_SCENES]
    project = Project.new()
    project.scenes = []
    background = None
    for i, scene_spec in enumerate(scenes):
        try:
            one = build_project(scene_spec, rules)
        except SceneSpecError as e:
            problems += [f"scenes[{i}].{p}" if _FIELD_FIRST.match(p) else f"scenes[{i}]: {p}" for p in e.problems]
            continue
        scene = one.scenes[0]
        scene.name = ops.unique_scene_name(project, scene.name)
        project.scenes.append(scene)
        if background is None and isinstance(scene_spec, dict) and scene_spec.get("background") is not None:
            background = one.settings.background
    if not problems and kit_clash(project):
        problems.append(kit_clash(project))
    if problems:
        raise SceneSpecError(problems[:MAX_PROBLEMS])
    if background is not None:
        project.settings.background = background
    return project, " ".join(name.split())


# ---------------------------------------------------------------------- the guide (the ReadMe tool)


def _default(p: Param) -> str:
    k, v = p.kind, p.default
    if k == MOBREF:
        return "<name>" + ("" if p.optional else " (required)")
    if k == MOBREFS:
        return "[<name>, ...]"
    if v is None:
        return "null"
    if k in (TEXT, STR, FONT, EXPR, ENUM, DIRECTION, FILE):
        text = str(v)
        if len(text) > 34:
            text = text[:30] + "..."
        return json.dumps(text, ensure_ascii=False)
    if k in (FLOAT, ANGLE):
        return f"{v:g}"
    if k == BOOL:
        return "true" if v else "false"
    return json.dumps(v, separators=(",", ":"))


def _hint(p: Param) -> str:
    k = p.kind
    if k == ANGLE:
        return "degrees"
    if k == EXPR:
        return f"formula in {', '.join(p.variables)}"
    if k == ENUM:
        return "|".join(str(v) for v, _label in p.choices)
    if k == DIRECTION and p.choices and set(p.choices) != set(DIRECTION_VECTORS):
        return "|".join(p.choices) if len(p.choices) <= 4 else ""
    if k == RANGE:
        return "[from, to, step]"
    if k == GRID:
        return "rows of cells"
    if k == POINTS:
        return "[[x, y], ...]"
    if k == POINT3:
        return "[x, y, z]"
    if k == NUMBERS:
        return "list of numbers"
    return ""


def _param_line(params) -> str:
    out = []
    for p in params:
        hint = _hint(p)
        out.append(f"{p.name}={_default(p)}" + (f" ({hint})" if hint else ""))
    return ", ".join(out)


GUIDE_HEAD = """# Manimator: animations for explaining things

`ShowAnimation` plays a Manim (Community Edition) animation inline in the chat, drawn by Manimator's browser
engine. The user gets a video player (play, pause, scrub, replay). Use it whenever a moving picture explains better
than words: math, geometry, graphs, physics, algorithms, data structures, linear algebra, 3D shapes.

You describe the scene as JSON: the **objects**, then the **steps** that animate them. Every value is checked; if
something is wrong you get back the list of problems with where they are. Fix them and call again.

## The frame
- 16:9, 14.2 units wide and 8 tall, (0, 0) in the middle: x from -7.1 to 7.1, y from -4 to 4. Keep things within
  x = ±6.6 and y = ±3.6.
- Black background unless you set "background". Text is white unless you style it.
- The chat's player is small (about 560 px wide), so text must be big. Text, Paragraph and MarkupText (Crimson
  Pro, which runs small): titles 48-60, body text 40-52, labels 34-40, never below 32. Formulas (MathTex, Tex):
  36-48, never below 28. A line of Text at font_size 40 is about 0.5 units tall and 0.23 units per character:
  60 characters fill the whole width, so keep lines well under that.

## Shape of the JSON
```json
{
  "text": "In a right triangle, the squares on the two shorter sides $a$ and $b$ together match the square on the longest side $c$: $a^2 + b^2 = c^2$.",
  "title": "Pythagorean theorem",
  "objects": [
    {"name": "title", "type": "Text", "params": {"text": "Pythagorean theorem", "font_size": 52},
     "methods": [{"method": "to_edge", "args": {"edge": "UP"}}]},
    {"name": "tri", "type": "Polygon", "params": {"points": [[-4, -1.5], [-1, -1.5], [-4, 0.75]]},
     "style": {"color": "WHITE", "fill_opacity": 0.15}},
    {"name": "corner", "type": "RightAngle",
     "params": {"vertex": [-4, -1.5], "p1": [-1, -1.5], "p2": [-4, 0.75], "length": 0.3, "show_lines": false}},
    {"name": "a", "type": "MathTex", "params": {"tex": "a"}, "style": {"color": "BLUE"},
     "methods": [{"method": "next_to", "args": {"mobject_or_point": "tri", "direction": "DOWN"}}]},
    {"name": "b", "type": "MathTex", "params": {"tex": "b"}, "style": {"color": "GREEN"},
     "methods": [{"method": "next_to", "args": {"mobject_or_point": "tri", "direction": "LEFT"}}]},
    {"name": "c", "type": "MathTex", "params": {"tex": "c"}, "style": {"color": "YELLOW"}, "position": [-2.25, -0.05]},
    {"name": "law", "type": "MathTex", "params": {"tex": "a^2 + b^2 = c^2", "font_size": 60}, "position": [2.6, -0.4]}
  ],
  "steps": [
    {"play": [{"anim": "Write", "target": "title"}]},
    {"play": [{"anim": "Create", "target": "tri"}, {"anim": "Create", "target": "corner"}], "run_time": 1.5},
    {"play": [{"anim": "FadeIn", "target": "a", "params": {"shift": "UP"}},
              {"anim": "FadeIn", "target": "b", "params": {"shift": "RIGHT"}},
              {"anim": "FadeIn", "target": "c", "params": {"shift": "DL"}}], "lag_ratio": 0.3},
    {"wait": 1},
    {"play": [{"anim": "Write", "target": "law"}]},
    {"play": [{"anim": "Circumscribe", "target": "law"}]},
    {"wait": 2}
  ]
}
```

**Object** fields:
- `name`: how steps and other objects refer to it (unique). `type`: one of the types below.
- `params`: the type's settings; any you leave out keep the default shown in the list.
- `style`: colors and line widths (see Style). Colors are "#RRGGBB" or Manim names: WHITE, GRAY, BLACK, BLUE, TEAL,
  GREEN, YELLOW, GOLD, RED, MAROON, PURPLE, PINK, ORANGE, and shades like BLUE_A (lightest) ... BLUE_E (darkest).
- `position`: [x, y] of its center (default [0, 0]). Points in settings (Line start/end, Arrow, Angle vertex,
  Polygon points, ...) are scene coordinates; giving a position as well moves the object so its center lands there.
  A Vector starts at the origin. ArcPolygon's points only give its shape: it is centered on its position. Objects
  drawn where their settings put them (graphs of functions, braces and boxes around another object, groups) take no
  position.
- `rotation` (degrees, counter-clockwise), `scale` (factor), `z_index` (higher is drawn on top).
- `methods`: run in order before the video starts, to place things relative to each other, e.g.
  `{"method": "next_to", "args": {"mobject_or_point": "title", "direction": "DOWN", "buff": 0.4}}`.
  Objects may refer to any other object, but not in a loop.
- `on_screen_at_start`: normally decided for you (see Visibility).
- 3D scenes: `z` (height); `fixed`: "in_frame" (stays put on screen, for titles and labels) or "orientation".
- LinearTransformationScene: `transform_role`: "transformable", "vector", "foreground" or "static" (default: vectors
  move with the grid, other shapes transform with it).

**Step**: `{"play": [animations], "run_time": 1.5, "rate_func": "smooth", "lag_ratio": 0}` or `{"wait": 1.5}`.
Animations in one step play together; steps play one after another. run_time is in seconds (default: the
animation's usual length, mostly 1). lag_ratio 0..1 staggers the step's animations (0.15 makes a nice cascade).

**Animation**: `{"anim": "Create", "target": "tri"}`, with `"params"` for its settings:
- `{"anim": "ReplacementTransform", "target": "eq1", "params": {"target_mobject": "eq2"}}`
- `{"anim": "Animate", "target": "dot", "method": "shift", "params": {"vector": [3, 0]}}` animates any method below
  (this is Manim's `dot.animate.shift(...)`).
- Scene actions (camera moves, grid transformations) have no target: `{"anim": "camera_zoom", "params": {"zoom": 2}}`.

## Visibility
Objects are on screen from the first frame, except that an object is hidden until its first animation if that is
an appear animation (Create, Write, FadeIn, ...), and an object a transform turns something into is hidden until
then. Set `on_screen_at_start` to override. Disappear animations (FadeOut, Uncreate, ...) take objects away.
- `Transform` a → b: a takes b's shape and stays on screen as a; b itself never appears. Keep animating a.
- `ReplacementTransform` a → b: a turns into b, and b is on screen from then on: animate b afterwards. Best for
  step-by-step derivations: eq1 → eq2 → eq3.
- `TransformMatchingTex` (MathTex/Tex only) moves matching pieces. Split a formula into pieces with double braces
  (a space or the start before each `{{`): "{{ a^2 }} + {{ b^2 }} = {{ c^2 }}".
- `FadeTransform` cross-fades; `TransformMatchingShapes` matches identical shapes (good for rearranging text).

## Pacing: the explanation is text, each clip illustrates its part
Every ShowAnimation call carries the part of the explanation it illustrates, in "text": the user reads that text
in the chat with the clip right under it. An explanation is a series of these: text, clip, text, clip.
- Write "text" as the real explanation, the way you would write your reply: full sentences, the reasoning,
  **bold** for key terms, lists, ### headings for sections, $...$ and $$...$$ for math. One paragraph or a few
  per clip. The clip only shows it.
- Go in order: the next idea's text goes in the next clip's "text". A paragraph that needs no picture of its own
  goes in the text of the next clip.
- Don't write the explanation again in your reply: after the last clip, write only what's left (a short wrap-up,
  caveats, an offer to go deeper). A sentence before the first clip is fine.
- Weigh the topic. A simple idea (one picture, one formula, one relationship) gets one short clip of 5-15 s, or
  none when a sentence or a still diagram says it as well. A complex topic (a proof, a derivation, an algorithm
  with stages, ideas that build on each other) gets a few short clips where a picture helps most; never one long
  video that explains everything.
- A clip shows, the text tells: keep the words on screen to a short title, labels and formulas. The sentences that
  explain belong in "text", not in captions.
- Each clip stands on its own: only the objects it needs (repeat what carries over from the previous clip), 3-8
  steps, ending on a picture that sums it up.
- PreviewAnimation takes the same input and ignores "text": check the clips before showing them.

## Layout
- Regions: a title at the top (`to_edge` UP, font_size 48-60), the main picture in the middle (y from about -2.6
  to 2.4), a formula or a short label at the bottom (`to_edge` DOWN). Keep 0.4 units between things and from the
  edges.
- Few things at once: at most about 3 text items and one diagram on screen. FadeOut what's done before adding more.
- Place things relative to each other instead of guessing coordinates: `next_to`, `align_to`, `to_edge`. For lists
  and rows, put the items in a VGroup and give the group `{"method": "arrange", "args": {"direction": "DOWN",
  "buff": 0.4}}` (then `to_edge`, `next_to` or `move_to` to place the whole group).
- Diagram on one side, text on the other: shift the diagram to x around -3.2 and the text to x around 3.2.
- Long text: break it into short lines (Paragraph, BulletedList) or several Text objects; never one long line.
- Use one color per idea and reuse it (the side a in the triangle and a in the formula both BLUE). Draw attention
  with Indicate, Circumscribe, Flash or a SurroundingRectangle; dim what's done with `Animate` + `set_opacity`.
- Put `{"wait": 1}`-`{"wait": 2}` after each key moment so there is time to read; end with a wait so the final
  picture stays.
- Check your work: PreviewAnimation draws frames of the scene and shows them to you, with a list of problems
  (objects outside the picture, text over text, text too small) and where each object is. Preview every scene
  before you show or save it, look at each frame, fix what is crowded, overlapping, cut off or unbalanced, and
  preview again until it looks right. The other tools run the same checks and tell you about problems they find.

## Graphs and coordinates
- NumberPlane with its default ranges shows scene coordinates exactly: the point (x, y) of the plane is at (x, y).
- FunctionGraph, ParametricFunction, ImplicitFunction, ArrowVectorField and Surface are drawn in scene
  coordinates. To line them up with Axes, give the Axes "tips": false and "include_numbers": false, ranges centered
  on 0, x_length = x_max - x_min and y_length = y_max - y_min, and position [0, 0]: then axes coordinates are scene
  coordinates. (In general the middle of the axes' ranges sits at the axes' position.) Label axes with MathTex.
- Formulas use x (or t, u, v, y as listed), numbers, + - * / ^ (or **), pi, e, and sin cos tan asin acos atan
  sinh cosh tanh exp log ln sqrt abs floor ceil min max.

## Text and formulas
- Text, Paragraph and MarkupText use Crimson Pro, a book serif. "font" picks another: the serifs "STIX Two Text",
  "Tinos" (like Times), "CMU Serif" (like the formulas), "Source Serif 4"; the sans "Inter", "Geist",
  "Source Sans 3", "IBM Plex Sans", "Lato"; or "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono". Latin, Greek
  and Cyrillic letters and common symbols render (letters a font lacks come from DejaVu); other scripts and emoji
  don't.
- Paragraph (and Text with several lines) has "line_spacing": the room between lines as a share of the font size,
  0.75 unless you set it.
- MathTex is LaTeX math mode (amsmath and amssymb): `\\frac`, `\\sqrt`, `\\int`, `\\sum`, `\\vec`, matrices with
  `\\begin{bmatrix}`, `\\\\` for a new line and `&` to align. No \\color or other packages: color a whole formula with
  style, or split it into separate MathTex objects placed with next_to.
- Tex is text mode with $...$ for math. BulletedList and BraceLabel text are LaTeX too.

## Limits
At most 120 objects, 150 steps and 10 minutes per animation. Pictures and SVG files can't be used.
"""


GUIDE_PROJECTS = """## Saving to the user's Manimator account
CreateProject saves animations as a project in the user's Manimator account, where they can open it in the editor
and change anything (it also plays the first scene here). Use it when the user wants to keep, save or edit an
animation in Manimator; for a quick explanation use ShowAnimation, which saves nothing.
- Input: `{"name": "Project name", "scenes": [scene, ...]}`: each scene is written exactly like ShowAnimation's input
  (the first "background" given is the project's). At most 10 scenes.
- Each scene's "title" becomes its tab name in Manimator: one or two short words in PascalCase, with no numbers,
  spaces or punctuation (the tabs are already in order). Good: "Theorem", "Squares", "Proof", "Algebra", "Uses".
  Not: "1. The theorem", "Proof by rearrangement".
- The plan limits how many projects an account keeps ({limits}). If it's full, tell the user: they
  can delete a project in Manimator or upgrade. ListProjects shows their projects and how many are used.
- The result has a link that opens the project in Manimator; give it to the user.

Changing a saved project:
- GetProject reads it as it is now (the user may have changed it in Manimator since): every scene in this format.
  Always read it before changing it, so you don't undo the user's own edits.
- UpdateScene replaces one scene: send the whole scene back, changed (objects and steps you leave out are gone).
  Keep its title to keep its name. AddScene adds a scene (at the end or after another), DeleteScene removes one,
  only when the user asks. Each change plays the scene here, and the user can undo it in Manimator.
- Scenes may show pictures or SVG files the user uploaded in Manimator: keep their file names as GetProject shows
  them. You can't add new files.
"""


GUIDE_KITS = """## The user's customizations
Custom objects and animations the user made in Manimator or added from its gallery. Use them like the built-in ones:
the name below as "type" (objects) or "anim" (animations), with "params". GetProject shows scenes that have them with
their exact type ("kit:<id>:<version>"): keep it as it is.
- In the chat the player runs their code and plays them.
- PreviewAnimation and the layout checks can't draw them (their code runs only in the user's browser): the frames
  leave them out, custom animations show as nothing happening, and the report says where they are. Leave room for
  them.
"""


def _kit_line(spec) -> str:
    k = spec.kit
    if k["kind"] == "object":
        what = f"object [{spec.style_kind}]"
    else:
        what = f"animation, {spec.run_time:g} s"
        what += ", brings its object in" if spec.introducer else ", takes its object away" if spec.remover else ""
    line = f"- {k['class']}({_param_line(spec.params)}) ({what}; by {k['author']}; type {spec.key})"
    return line + (f": {spec.description}" if spec.description else "")


def guide(user: bool = False, kits=(), limits: str = "") -> str:
    """The ReadMe text: how scenes are written, then every type, style, method, animation and scene type. The User
    MCP's adds how projects are saved (`limits`: each plan's projects, "Free 3, Pro 30"), and the account's
    customizations (`kits`: their specs)."""
    custom = [GUIDE_KITS, *(_kit_line(s) for s in kits), ""] if kits else []
    projects = GUIDE_PROJECTS.replace(" ({limits})", f" ({limits})" if limits else "")
    lines = [GUIDE_HEAD, *([projects] if user else []), *custom, "## Object types",
             "`Type(param=default, ...)` [style kind]: what it is.", ""]
    category = None
    for spec in MOBJECTS.values():
        if spec.key in FILE_TYPES:
            continue
        if spec.category != category:
            category = spec.category
            lines.append(f"\n**{category}**")
        line = f"- {spec.key}({_param_line(spec.params)}) [{spec.style_kind}]"
        if spec.description:
            line += f": {spec.description}"
        if spec.three_d:
            line += " (3D)"
        lines.append(line)
    lines += ["", "## Style", "Style fields by style kind (shape also takes \"color\" for outline and fill together):"]
    for kind, fields in STYLE_FIELDS.items():
        lines.append(f"- {kind}: {_param_line(fields) if fields else 'none (the object has its own colors)'}")
    lines += ["", "## Methods", "For `methods` on objects, and for `Animate` steps. Directions: UP, DOWN, LEFT, RIGHT, "
              "UL, UR, DL, DR (ORIGIN where allowed).", ""]
    for m in METHODS.values():
        lines.append(f"- {m.key}({_param_line(m.params)}): {m.description}")
    lines += ["", "## Animations", "`Name(params)`: what it does. Usual length 1 s unless noted.", ""]
    for a in ANIMATIONS.values():
        if a.scene_action:
            continue
        extra = []
        if a.run_time != 1.0:
            extra.append(f"{a.run_time:g} s")
        if a.only:
            extra.append("only " + "/".join(a.only))
        note = f" ({'; '.join(extra)})" if extra else ""
        lines.append(f"- {a.key}({_param_line(a.params)}){note}: {a.description}")
    lines.append(f"- {ANIMATE}: target + \"method\" + \"params\" (the method's args): animates the method.")
    lines += ["", "## Scene types", 'Set `"scene"` to use camera moves, zooming, 3D or linear algebra. Options go in '
              '`"scene_options"`. Scene actions are steps with no target.', ""]
    for kind in SCENE_KINDS.values():
        line = f"- **{kind.key}**: {kind.description}."
        if kind.options:
            line += f" Options: {_param_line(kind.options)}."
        actions = [a for a in ANIMATIONS.values() if a.scene_action and kind.key in a.scene_kinds]
        if actions:
            line += " Actions: " + "; ".join(
                f"{a.key}({_param_line(a.params)})" + (f" {a.fixed_time:g} s, alone in its step" if a.fixed_time
                                                       else "") + f": {a.description}" for a in actions)
        lines.append(line)
    lines += ["", "3D scenes: put 3D objects at a height with `z`; keep titles and labels flat on screen with "
              "\"fixed\": \"in_frame\". Adding any 3D object makes a plain Scene a ThreeDScene. camera_move3d keeps "
              "the angles you leave out where they are.",
              "",
              "## Rate functions",
              ", ".join(n for n in _RATES if "." not in n)]
    return "\n".join(lines)
