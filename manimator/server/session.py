"""The open project, its undo history, and every edit the UI can make.

The browser UI is only a view: it sends named operations (`add_mobject`,
`set_param`, ...) and gets the whole project back. Every operation validates
its inputs, runs one of the pure functions in model/ops.py, and is recorded as a
before/after snapshot for undo. Projects are small, so snapshots keep undo
simple and always correct. The snapshots are kept compressed, and the history keeps only so many bytes, so a big
project's history can't fill the server's memory.
"""

from __future__ import annotations

import copy
import itertools
import json
import threading
import time
import zlib
from dataclasses import dataclass
from typing import Any, Callable

from ..model import ops
from ..model.project import PLAY, WAIT, MobjectItem, Project, Scene, Step
from ..registry import ANIMATIONS, METHODS, MOBJECTS
from ..registry.animations import ANIMATE, RATE_FUNCS
from ..registry.colors import normalize
from ..registry.custom import KIT_TYPE_RE, is_kit_type, kit_type
from ..registry.exprs import compile_expr
from ..registry.mobjects import STYLE_FIELDS
from ..registry.params import (
    ANGLE, BOOL, COLOR, DIRECTION, DIRECTION_VECTORS, ENUM, EXPR, FILE, FLOAT, FONT, GRID, INT, MOBREF, MOBREFS,
    NUMBERS, POINT, POINT3, POINTS, RANGE, STR, TEXT, VECTOR, Param, parse_grid, parse_numbers, parse_points,
)
from ..registry.scenes import FIXED_CHOICES, MOVING_VECTOR, SCENE, SCENE_KINDS, THREE_D, TRANSFORM_ROLES, VECTOR_TYPES
from ..registry.qualities import QUALITY_ORDER

UNDO_LIMIT = 300
UNDO_BYTES = 16 * 1024 * 1024  # compressed snapshots one open project keeps for undo and redo
MAX_PROJECT_CHARS = 8_000_000  # a project as JSON; one at the editor's limits is about 3 MB
MERGE_SECONDS = 2.0
MAX_TEXT = 20_000


@dataclass(frozen=True)
class ProjectLimits:
    """How big a project may get when the editor is shared between many people."""

    max_scenes: int = 20
    max_objects: int = 200  # per scene
    max_steps: int = 400  # per scene


class OpError(ValueError):
    """An edit that can't be made; the message is shown to the user."""


@dataclass
class _Entry:
    id: int
    label: str
    before: bytes  # the project before and after the edit, as compressed JSON (_pack)
    after: bytes
    merge_key: str | None
    stamp: float


def _dumps(data: dict) -> str:
    return json.dumps(data, separators=(",", ":"))


def _pack(text: str) -> bytes:
    return zlib.compress(text.encode(), 1)


def _unpack(blob: bytes) -> Project:
    return Project.from_dict(json.loads(zlib.decompress(blob)))


_OPS: dict[str, tuple[Callable, str]] = {}


def op(label: str):
    def register(fn):
        _OPS[fn.__name__] = (fn, label)
        return fn
    return register


class Session:
    def __init__(self, project: Project | None = None,
                 limits: ProjectLimits | None = None, assets: Callable[[str], str] | None = None,
                 kits: Callable[[str], None] | None = None):
        self.lock = threading.RLock()
        self.project = project or Project.new()
        self.limits = limits  # set for visitors of the website
        self.assets = assets  # checks an uploaded file's name; None means any path is fine
        self.kits = kits  # checks that a custom type (server/kits.py) may be added; None: they can't be
        self._undo: list[_Entry] = []
        self._redo: list[_Entry] = []
        self._ids = itertools.count(1)
        self._saved_version = 0

    # ------------------------------------------------------------------ state
    @property
    def version(self) -> int:
        return self._undo[-1].id if self._undo else 0

    @property
    def dirty(self) -> bool:
        return self.version != self._saved_version

    def state(self) -> dict:
        with self.lock:
            return {
                "project": self.project.to_dict(),
                "dirty": self.dirty,
                "version": self.version,
                "can_undo": bool(self._undo),
                "can_redo": bool(self._redo),
                "undo_label": self._undo[-1].label if self._undo else "",
                "redo_label": self._redo[-1].label if self._redo else "",
            }

    def load(self, project: Project) -> list[str]:
        with self.lock:
            notes = ops.sanitize_project(project)
            if self.limits is not None:  # a file from anywhere: hold it to the same rules as edits
                self._check_limits(project)
                notes += revalidate(project, self.assets)
            self.project = project
            self._undo.clear()
            self._redo.clear()
            self._saved_version = 0
            return notes

    def mark_downloaded(self) -> None:
        """The visitor took a copy; "dirty" means changed since the last download."""
        with self.lock:
            self._saved_version = self.version

    # ------------------------------------------------------------------ editing
    def apply(self, name: str, args: dict | None = None, merge_key: str | None = None) -> Any:
        if name not in _OPS:
            raise OpError(f"Unknown operation {name!r}")
        fn, label = _OPS[name]
        with self.lock:
            before = self.project.to_dict()
            try:
                result = fn(self, **(args or {}))
                if self.limits is not None:
                    self._check_limits(self.project)
            except OpError:
                self.project = Project.from_dict(before)
                raise
            except (TypeError, ValueError, KeyError, IndexError, AttributeError, ArithmeticError) as e:
                self.project = Project.from_dict(before)  # undo any partial change
                raise OpError(f"Couldn't {label.lower()}: {e}") from e
            after = self.project.to_dict()
            if after != before:
                text = _dumps(after)
                if self._too_big(before, text):
                    self.project = Project.from_dict(before)
                    raise OpError("This project is too large to grow any more. Split it into several projects.")
                self._record(label, before, text, merge_key)
            return result

    def replace(self, project: Project, label: str) -> None:
        """Take the project as changed outside the editor (an AI chat, server/mcp.py), as one step that can be
        undone like any edit."""
        with self.lock:
            if self.limits is not None:
                self._check_limits(project)
            before = self.project.to_dict()
            after = project.to_dict()
            if after != before:
                text = _dumps(after)
                if self._too_big(before, text):
                    raise OpError("the project would be too large")
                self.project = project
                self._record(label, before, text, None)

    def add_history(self, label: str, before: dict, after: dict) -> None:
        """An undo step for a change made while the project was closed (see Workspace.edit_project)."""
        with self.lock:
            self._undo.append(_Entry(next(self._ids), label, _pack(_dumps(before)), _pack(_dumps(after)), None,
                                     time.monotonic()))
            self._trim()

    def check_limits(self, project: Project) -> None:
        if self.limits is not None:
            self._check_limits(project)

    def _check_limits(self, project: Project) -> None:
        lim = self.limits
        if len(project.scenes) > lim.max_scenes:
            raise OpError(f"A project can have at most {lim.max_scenes} scenes.")
        for scene in project.scenes:
            if len(scene.mobjects) > lim.max_objects:
                raise OpError(f"A scene can have at most {lim.max_objects} objects.")
            if len(scene.steps) > lim.max_steps:
                raise OpError(f"A scene can have at most {lim.max_steps} animation steps.")

    @staticmethod
    def _too_big(before: dict, after_text: str) -> bool:
        """An edit that grows the project past MAX_PROJECT_CHARS (one already that big may still shrink)."""
        return len(after_text) > MAX_PROJECT_CHARS and len(after_text) > len(_dumps(before))

    def _record(self, label: str, before: dict, after_text: str, merge_key: str | None) -> None:
        now = time.monotonic()
        after = _pack(after_text)
        top = self._undo[-1] if self._undo else None
        if (
            merge_key and top is not None and top.merge_key == merge_key
            and (merge_key.startswith("live:") or now - top.stamp < MERGE_SECONDS)
        ):
            # Slider drags, spinner clicks and canvas drags become one undo step.
            top.after = after
            top.stamp = now
            top.id = next(self._ids)
        else:
            packed = _pack(_dumps(before))
            if top is not None and top.after == packed:
                packed = top.after  # the same project as the step before ends with: kept once
            self._undo.append(_Entry(next(self._ids), label, packed, after, merge_key, now))
        self._redo.clear()
        self._trim()

    def _trim(self) -> None:
        """Forget the oldest steps beyond UNDO_LIMIT, or beyond UNDO_BYTES (the newest step always stays)."""
        del self._undo[:-UNDO_LIMIT]
        total, seen = 0, set()
        for i in range(len(self._undo) - 1, -1, -1):
            entry = self._undo[i]
            for blob in (entry.after, entry.before):
                if id(blob) not in seen:
                    seen.add(id(blob))
                    total += len(blob)
            if total > UNDO_BYTES and i < len(self._undo) - 1:
                del self._undo[:i + 1]
                return

    def undo(self) -> None:
        with self.lock:
            if self._undo:
                entry = self._undo.pop()
                self.project = _unpack(entry.before)
                self._redo.append(entry)

    def redo(self) -> None:
        with self.lock:
            if self._redo:
                entry = self._redo.pop()
                self.project = _unpack(entry.after)
                self._undo.append(entry)

    def kept_states(self) -> list[bytes]:
        """The project and every state undo or redo can bring back, as JSON (server/web.py looks in them for the
        customization versions still in use)."""
        with self.lock:
            now = _dumps(self.project.to_dict()).encode()
            blobs = {id(b): b for e in [*self._undo, *self._redo] for b in (e.before, e.after)}
        return [now, *(zlib.decompress(b) for b in blobs.values())]


# ---------------------------------------------------------------------- lookups and validation


def _scene(s: Session, scene_id: str) -> Scene:
    scene = s.project.scene(scene_id)
    if scene is None:
        raise OpError("That scene no longer exists.")
    return scene


def _mob(scene: Scene, mob_id: str) -> MobjectItem:
    item = scene.mob(mob_id)
    if item is None:
        raise OpError("That object no longer exists.")
    return item


def _step(scene: Scene, index: int) -> Step:
    if not isinstance(index, int) or not 0 <= index < len(scene.steps):
        raise OpError("That step no longer exists.")
    return scene.steps[index]


def _param(params, name: str) -> Param:
    for p in params:
        if p.name == name:
            return p
    raise OpError(f"Unknown setting {name!r}.")


def _number(value, lo: float | None = None, hi: float | None = None) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise OpError(f"{value!r} is not a number.") from None
    if v != v or v in (float("inf"), float("-inf")):
        raise OpError("Please enter a finite number.")
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _int(value, lo: float = -1e6, hi: float = 1e6) -> int:
    """A whole number (a step index, how far to move something). JSON allows Infinity, which int() can't take."""
    return int(round(_number(value, lo, hi)))


def coerce(p: Param, value, scene: Scene | None = None, ref_ok: set[str] | None = None,
           assets: Callable[[str], str] | None = None):
    """Turn an incoming JSON value into a valid stored value for this param, or raise OpError."""
    k = p.kind
    if value is None and p.optional:
        return None
    if k == FLOAT:
        return _number(value, p.min, p.max)
    if k == ANGLE:
        return _number(value, -36000, 36000)
    if k == INT:
        return int(round(_number(value, p.min, p.max)))
    if k in (STR, TEXT, FONT):
        if not isinstance(value, str):
            raise OpError("Expected text.")
        if len(value) > MAX_TEXT:
            raise OpError("That text is too long.")
        return value
    if k == BOOL:
        return bool(value)
    if k == COLOR:
        try:
            return normalize(value)
        except ValueError:
            raise OpError(f"{value!r} is not a color.") from None
    if k in (POINT, VECTOR):
        if not isinstance(value, (list, tuple)) or len(value) < 2:
            raise OpError("Expected an x and a y.")
        return [_number(value[0], -1000, 1000), _number(value[1], -1000, 1000)]
    if k == RANGE:
        if not isinstance(value, (list, tuple)) or len(value) < 3:
            raise OpError("Expected from, to and step.")
        lo, hi, step = (_number(v, -1000, 1000) for v in value[:3])
        if hi <= lo:
            raise OpError("'To' must be larger than 'from'.")
        if step <= 0:
            raise OpError("Step must be positive.")
        return [lo, hi, step]
    if k == DIRECTION:
        allowed = set(p.choices) if p.choices else set(DIRECTION_VECTORS)
        if value not in allowed:
            raise OpError(f"{value!r} is not an allowed direction here.")
        return value
    if k == ENUM:
        if value not in {v for v, _label in p.choices}:
            raise OpError(f"{value!r} is not one of the choices.")
        return value
    if k == MOBREF:
        if value is None:
            return None
        if scene is None or scene.mob(value) is None:
            raise OpError("That object no longer exists.")
        if ref_ok is not None and value not in ref_ok:
            raise OpError("That would make objects depend on each other in a loop.")
        return value
    if k == MOBREFS:
        if not isinstance(value, (list, tuple)):
            raise OpError("Expected a list of objects.")
        ids = list(dict.fromkeys(value))[:200]
        for i in ids:
            if scene is None or scene.mob(i) is None:
                raise OpError("That object no longer exists.")
            if ref_ok is not None and i not in ref_ok:
                raise OpError("That would make objects depend on each other in a loop.")
        return ids
    if k == POINT3:
        if not isinstance(value, (list, tuple)) or len(value) < 3:
            raise OpError("Expected x, y and z.")
        return [_number(v, -1000, 1000) for v in value[:3]]
    if k == EXPR:
        try:
            compile_expr(value, p.variables)
        except ValueError as e:
            raise OpError(str(e)) from None
        return value.strip()
    if k in (POINTS, NUMBERS, GRID):
        parse = {POINTS: parse_points, NUMBERS: parse_numbers, GRID: parse_grid}[k]
        try:
            return parse(value, p)
        except ValueError as e:
            raise OpError(str(e)) from None
    if k == FILE:
        if not isinstance(value, str):
            raise OpError("Expected a file path.")
        value = value.strip().strip('"')
        allowed = _FILE_TYPES.get(p.accept)
        if assets is not None:  # hosted: only files this visitor uploaded, of the right kind
            if value and allowed and not value.lower().endswith(allowed):
                raise OpError(f"Choose a {p.accept} file ({', '.join(allowed)}).")
            return assets(value) if value else ""
        if value and allowed and not value.lower().endswith(allowed):
            raise OpError(f"Choose a {p.accept} file ({', '.join(allowed)}).")
        return value
    raise OpError(f"Unsupported setting type {k}.")


_FILE_TYPES = {
    "image": (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"),
    "svg": (".svg",),
}


def _kit_gate(s: Session, key) -> None:
    """A custom object or animation may join the project only if the user may use its package now, and no other
    package of the project has the same class name."""
    if not is_kit_type(key):
        return
    if s.kits is None:
        raise OpError("Custom objects and animations aren't available here.")
    s.kits(key)
    clash = ops.kit_class_clash(s.project, key)
    if clash:
        raise OpError(f"This project already uses another customization called {clash}. Use one of them.")


def _setup_refs(scene: Scene, mob_id: str) -> set[str]:
    return {m.id for m in ops.ref_choices(scene, mob_id, setup=True)}


def _anim_params(anim) -> tuple[Param, ...]:
    return METHODS[anim.method].params if anim.anim == ANIMATE else ANIMATIONS[anim.anim].params


def _rule(fn, *args):
    """Run an ops function whose ValueErrors are messages for the user."""
    try:
        return fn(*args)
    except ValueError as e:
        raise OpError(str(e)) from None


# ---------------------------------------------------------------------- scenes


@op("Add scene")
def add_scene(s: Session) -> str:
    return ops.add_scene(s.project).id


@op("Duplicate scene")
def duplicate_scene(s: Session, scene_id: str) -> str:
    _scene(s, scene_id)
    return ops.duplicate_scene(s.project, scene_id).id


@op("Delete scene")
def delete_scene(s: Session, scene_id: str) -> None:
    _scene(s, scene_id)
    if len(s.project.scenes) <= 1:
        raise OpError("A project needs at least one scene.")
    ops.delete_scene(s.project, scene_id)


@op("Rename scene")
def rename_scene(s: Session, scene_id: str, name: str) -> str:
    _scene(s, scene_id)
    return ops.rename_scene(s.project, scene_id, str(name))


@op("Reorder scenes")
def move_scene(s: Session, scene_id: str, delta: int) -> None:
    _scene(s, scene_id)
    ops.move_scene(s.project, scene_id, _int(delta))


@op("Change scene type")
def set_scene_kind(s: Session, scene_id: str, kind: str) -> list[str]:
    """Returns the names of the scene actions the new type can't do (they are removed)."""
    scene = _scene(s, scene_id)
    if kind not in SCENE_KINDS:
        raise OpError(f"Unknown scene type {kind!r}.")
    return ops.set_scene_kind(scene, kind)


@op("Change scene setting")
def set_scene_option(s: Session, scene_id: str, name: str, value) -> None:
    scene = _scene(s, scene_id)
    p = ops.scene_kind(scene).option(name)
    if p is None:
        raise OpError(f"A {scene.kind} has no setting {name!r}.")
    scene.options[name] = coerce(p, value)


@op("Change how the object takes part")
def set_scene_role(s: Session, scene_id: str, mob_id: str, name: str, value) -> None:
    """`fixed` (3D scenes) or `transform_role` (LinearTransformationScene); see registry/scenes.py."""
    item = _mob(_scene(s, scene_id), mob_id)
    if name == "fixed":
        if value not in {v for v, _label in FIXED_CHOICES}:
            raise OpError(f"{value!r} is not one of the choices.")
        item.fixed = value
    elif name == "transform_role":
        if value not in {"", *(v for v, _label in TRANSFORM_ROLES)}:
            raise OpError(f"{value!r} is not one of the choices.")
        if value == MOVING_VECTOR and item.type not in VECTOR_TYPES:
            raise OpError("Only vectors and arrows can move as vectors.")
        item.transform_role = value
    else:
        raise OpError(f"Unknown setting {name!r}.")


@op("Change project setting")
def set_setting(s: Session, name: str, value) -> None:
    if name == "background":
        s.project.settings.background = coerce(Param("background", COLOR), value)
    elif name == "quality":
        if value not in QUALITY_ORDER:
            raise OpError(f"Unknown quality {value!r}.")
        s.project.settings.quality = value
    else:
        raise OpError(f"Unknown setting {name!r}.")


# ---------------------------------------------------------------------- objects


@op("Add object")
def add_mobject(s: Session, scene_id: str, type: str, x: float = 0.0, y: float = 0.0,
                target_id: str | None = None) -> str:
    scene = _scene(s, scene_id)
    if type not in MOBJECTS:
        raise OpError(f"Unknown object type {type!r}.")
    _kit_gate(s, type)
    x, y = _number(x, -50, 50), _number(y, -50, 50)
    try:
        item = ops.create_mobject(scene, type, x, y, target_id)
    except ValueError as e:
        raise OpError(str(e)) from None
    if MOBJECTS[type].three_d and scene.kind == SCENE:
        scene.kind = THREE_D  # 3D objects need a 3D camera
    return item.id


@op("Delete object")
def delete_mobject(s: Session, scene_id: str, mob_id: str) -> list[str]:
    scene = _scene(s, scene_id)
    _mob(scene, mob_id)
    return ops.delete_mobjects(scene, {mob_id})


@op("Duplicate object")
def duplicate_mobject(s: Session, scene_id: str, mob_id: str) -> str:
    scene = _scene(s, scene_id)
    _mob(scene, mob_id)
    return ops.duplicate_mobject(scene, mob_id).id


@op("Change layer")
def move_layer(s: Session, scene_id: str, mob_id: str, delta: int) -> None:
    scene = _scene(s, scene_id)
    _mob(scene, mob_id)
    ops.move_layer(scene, mob_id, _int(delta))


@op("Edit property")
def set_param(s: Session, scene_id: str, mob_id: str, name: str, value) -> None:
    scene = _scene(s, scene_id)
    item = _mob(scene, mob_id)
    p = _param(MOBJECTS[item.type].params, name)
    item.params[name] = coerce(p, value, scene, _setup_refs(scene, mob_id), assets=s.assets)
    if p.kind == MOBREF and item.params[name] is None:
        raise OpError(f"{p.title} must be set.")


@op("Edit style")
def set_style(s: Session, scene_id: str, mob_id: str, name: str, value) -> None:
    scene = _scene(s, scene_id)
    item = _mob(scene, mob_id)
    p = _param(STYLE_FIELDS[MOBJECTS[item.type].style_kind], name)
    item.style[name] = coerce(p, value)


@op("Move object")
def set_position(s: Session, scene_id: str, mob_id: str, x: float, y: float) -> None:
    item = _mob(_scene(s, scene_id), mob_id)
    ops.set_mobject_position(item, round(_number(x, -50, 50), 3), round(_number(y, -50, 50), 3))


@op("Nudge object")
def nudge(s: Session, scene_id: str, mob_id: str, dx: float, dy: float) -> None:
    item = _mob(_scene(s, scene_id), mob_id)
    ops.move_mobject(item, _number(dx, -10, 10), _number(dy, -10, 10))


@op("Edit placement")
def set_placement(s: Session, scene_id: str, mob_id: str, name: str, value) -> None:
    item = _mob(_scene(s, scene_id), mob_id)
    if name == "rotation":
        item.rotation = _number(value, -36000, 36000)
    elif name == "scale":
        item.scale = _number(value, 0.01, 100)
    elif name == "z_index":
        item.z_index = int(round(_number(value, -100, 100)))
    elif name == "z":
        item.z = round(_number(value, -50, 50), 3)
    else:
        raise OpError(f"Unknown placement {name!r}.")


@op("Rename object")
def rename_mobject(s: Session, scene_id: str, mob_id: str, name: str) -> str:
    scene = _scene(s, scene_id)
    _mob(scene, mob_id)
    return ops.rename_mobject(scene, mob_id, str(name))


@op("Toggle on screen at start")
def set_on_screen(s: Session, scene_id: str, mob_id: str, value: bool) -> None:
    _mob(_scene(s, scene_id), mob_id).on_screen_at_start = bool(value)


# ---------------------------------------------------------------------- methods


@op("Add method")
def add_method(s: Session, scene_id: str, mob_id: str, method: str) -> int:
    scene = _scene(s, scene_id)
    item = _mob(scene, mob_id)
    if method not in METHODS:
        raise OpError(f"Unknown method {method!r}.")
    ops.add_method(item, method, scene)
    return len(item.methods) - 1


def _call(item: MobjectItem, index: int):
    if not isinstance(index, int) or not 0 <= index < len(item.methods):
        raise OpError("That method no longer exists.")
    return item.methods[index]


@op("Edit method")
def set_method_arg(s: Session, scene_id: str, mob_id: str, index: int, name: str, value) -> None:
    scene = _scene(s, scene_id)
    item = _mob(scene, mob_id)
    call = _call(item, index)
    p = _param(METHODS[call.method].params, name)
    call.args[name] = coerce(p, value, scene, _setup_refs(scene, mob_id))


@op("Reorder methods")
def move_method(s: Session, scene_id: str, mob_id: str, index: int, delta: int) -> None:
    item = _mob(_scene(s, scene_id), mob_id)
    _call(item, index)
    j = max(0, min(len(item.methods) - 1, index + _int(delta)))
    item.methods.insert(j, item.methods.pop(index))


@op("Remove method")
def remove_method(s: Session, scene_id: str, mob_id: str, index: int) -> None:
    item = _mob(_scene(s, scene_id), mob_id)
    _call(item, index)
    item.methods.pop(index)


# ---------------------------------------------------------------------- steps


def _check_anim(scene: Scene, anim: str, target_id: str | None, method: str | None) -> None:
    """Scene actions take `target_id` only as a hint (the selected object) and may have none."""
    if anim == ANIMATE:
        if method not in METHODS:
            raise OpError(f"Unknown method {method!r}.")
    elif anim not in ANIMATIONS:
        raise OpError(f"Unknown animation {anim!r}.")
    spec = None if anim == ANIMATE else ANIMATIONS[anim]
    if spec is not None and spec.scene_action:
        if scene.kind not in spec.scene_kinds:
            raise OpError(f"'{spec.title}' needs a {' or '.join(spec.scene_kinds)}.")
        if any(p.kind in (MOBREF, MOBREFS) for p in spec.params) and not scene.mobjects:
            raise OpError(f"'{spec.title}' needs an object. Add one first.")
        if target_id is not None:
            _mob(scene, target_id)
        return
    _kit_target(scene, anim, _mob(scene, target_id))


def _kit_target(scene: Scene, anim: str, target) -> None:
    """A customization's animation plays only on its own package's object (AnimSpec.only)."""
    spec = ANIMATIONS.get(anim) if is_kit_type(anim) else None
    if spec is not None and spec.only and target.type not in spec.only:
        owner = MOBJECTS[spec.only[0]]
        name = (owner.kit or {}).get("name") or "its own object"
        raise OpError(f"{spec.title} plays only on {name}, the object it was made for.")


@op("Add animation")
def add_play_step(s: Session, scene_id: str, anim: str, target_id: str, index: int | None = None,
                  method: str | None = None) -> int:
    scene = _scene(s, scene_id)
    _check_anim(scene, anim, target_id, method)
    _kit_gate(s, anim)
    if index is not None:
        index = max(0, min(len(scene.steps), _int(index)))
    return _rule(ops.add_play_step, scene, anim, target_id, index, method)


@op("Add animation")
def add_animation_to_step(s: Session, scene_id: str, step: int, anim: str, target_id: str,
                          method: str | None = None) -> None:
    scene = _scene(s, scene_id)
    if _step(scene, step).kind != PLAY:
        raise OpError("Animations can only be added to play steps.")
    _check_anim(scene, anim, target_id, method)
    _kit_gate(s, anim)
    _rule(ops.add_animation_to_step, scene, step, anim, target_id, method)


@op("Add wait")
def add_wait_step(s: Session, scene_id: str, index: int | None = None) -> int:
    scene = _scene(s, scene_id)
    if index is not None:
        index = max(0, min(len(scene.steps), _int(index)))
    return ops.add_wait_step(scene, index)


@op("Play with previous")
def merge_steps(s: Session, scene_id: str, step: int) -> int:
    scene = _scene(s, scene_id)
    _step(scene, step)
    if step == 0 or scene.steps[step].kind != PLAY or scene.steps[step - 1].kind != PLAY:
        raise OpError("This step and the one above it must both be animation steps.")
    return _rule(ops.merge_with_previous, scene, step)


@op("Split step")
def split_step(s: Session, scene_id: str, step: int) -> int:
    scene = _scene(s, scene_id)
    _step(scene, step)
    return ops.split_step(scene, step)


@op("Reorder steps")
def move_step(s: Session, scene_id: str, step: int, delta: int) -> int:
    scene = _scene(s, scene_id)
    _step(scene, step)
    return ops.move_step(scene, step, _int(delta))


@op("Delete step")
def delete_step(s: Session, scene_id: str, step: int) -> None:
    scene = _scene(s, scene_id)
    _step(scene, step)
    scene.steps.pop(step)


_RATE_NAMES = {name for name, _label in RATE_FUNCS}


@op("Edit step")
def set_step(s: Session, scene_id: str, step: int, name: str, value) -> None:
    st = _step(_scene(s, scene_id), step)
    if name == "run_time":
        if ops.fixed_time(st) is not None:
            raise OpError(f"This step always lasts {ops.fixed_time(st):g} seconds.")
        st.run_time = _number(value, 0.05, 600)
    elif name == "duration":
        st.duration = _number(value, 0.05, 3600)
    elif name == "lag_ratio":
        st.lag_ratio = _number(value, 0, 1)
    elif name == "rate_func":
        if value not in _RATE_NAMES:
            raise OpError(f"Unknown easing {value!r}.")
        st.rate_func = value
    else:
        raise OpError(f"Unknown step setting {name!r}.")


def _anim(scene: Scene, step: int, index: int):
    st = _step(scene, step)
    if not isinstance(index, int) or not 0 <= index < len(st.animations):
        raise OpError("That animation no longer exists.")
    return st.animations[index]


@op("Change animation")
def change_animation(s: Session, scene_id: str, step: int, index: int, anim: str,
                     method: str | None = None) -> None:
    scene = _scene(s, scene_id)
    old = _anim(scene, step, index)
    new_is_action = anim != ANIMATE and anim in ANIMATIONS and ANIMATIONS[anim].scene_action
    if new_is_action != ops.is_action(old):
        raise OpError("A scene action can only be changed into another scene action.")
    _check_anim(scene, anim, old.target, method)
    if anim != old.anim:
        _kit_gate(s, anim)
    _rule(ops.change_animation_type, scene, step, index, anim, method)


@op("Change animation target")
def set_animation_target(s: Session, scene_id: str, step: int, index: int, target_id: str) -> None:
    scene = _scene(s, scene_id)
    a = _anim(scene, step, index)
    if ops.is_action(a):
        raise OpError("A scene action has no target object.")
    _kit_target(scene, a.anim, _mob(scene, target_id))
    a.target = target_id
    ops.apply_visibility_rules(scene, step, a)


@op("Edit animation")
def set_animation_param(s: Session, scene_id: str, step: int, index: int, name: str, value) -> None:
    scene = _scene(s, scene_id)
    a = _anim(scene, step, index)
    p = _param(_anim_params(a), name)
    a.params[name] = coerce(p, value, scene)
    if p.kind == MOBREF and a.params[name] is None:
        raise OpError(f"{p.title} must be set.")
    if p.kind == MOBREFS and len(a.params[name]) < p.min_items:
        raise OpError(f"Choose at least {p.min_items} object{'s' if p.min_items > 1 else ''}.")
    check = None if a.anim == ANIMATE else ANIMATIONS[a.anim].check
    if check is not None:
        _rule(check, a.params)
    ops.apply_visibility_rules(scene, step, a)


@op("Remove animation")
def remove_animation(s: Session, scene_id: str, step: int, index: int) -> bool:
    """Returns True when the step became empty and was removed too."""
    scene = _scene(s, scene_id)
    _anim(scene, step, index)
    st = scene.steps[step]
    st.animations.pop(index)
    if not st.animations:
        scene.steps.pop(step)
        return True
    return False


# ---------------------------------------------------------------------- customizations


def _refit(params, values, scene: Scene, assets) -> dict:
    """`values` for another version's settings: the ones it still has keep their values (if it can take them), the
    rest start at their defaults."""
    out = ops.default_params(params)
    for p in params:
        if isinstance(values, dict) and p.name in values:
            try:
                out[p.name] = coerce(p, values[p.name], scene, None, assets=assets)
            except Exception:  # noqa: BLE001 - a value the new setting can't take starts over
                pass
    return out


@op("Update customization")
def update_kit(s: Session, kit_id: str, version: int) -> dict:
    """Move every use of one customization in the project to another of its versions (the newest the editor offers):
    a project holds one version of a package, and a version's animations play only on its own object. Objects become
    that version's object and animations its animation of the same class; settings it still has keep their values,
    new ones start at their defaults. Refused when a step plays an animation that version doesn't have."""
    version = _int(version, 1, 9999)
    ours = lambda key: (m := KIT_TYPE_RE.match(key) if isinstance(key, str) else None) and m.group(1) == kit_id  # noqa: E731
    objects = {m.type for sc in s.project.scenes for m in sc.mobjects if ours(m.type)}
    animations = {a.anim for sc in s.project.scenes for st in sc.steps for a in st.animations if ours(a.anim)}
    if not objects and not animations:
        raise OpError("This project doesn't use that customization.")
    if s.kits is None:
        raise OpError("Custom objects and animations aren't available here.")
    moved = {key: kit_type(kit_id, version, KIT_TYPE_RE.match(key).group(3) or "") for key in objects | animations}
    moved = {old: new for old, new in moved.items() if old != new}
    if not moved:
        return {"objects": 0, "animations": 0}
    exists = kit_type(kit_id, version) in MOBJECTS.custom or kit_type(kit_id, version) in ANIMATIONS.custom
    for old, new in moved.items():
        table = MOBJECTS if old in objects else ANIMATIONS
        if new in table.custom:
            continue
        spec = ops.kit_spec(old)
        name = spec.kit.get("name") if spec is not None and spec.kit else "this customization"
        if old in objects or not exists:
            raise OpError(f"That version of {name} can't be used here.")
        where = next(f"step {i + 1} of {sc.name}" for sc in s.project.scenes for i, st in enumerate(sc.steps)
                     if any(a.anim == old for a in st.animations))
        raise OpError(f"That version of {name} has no {spec.title if spec else 'such'} animation, and {where} plays "
                      "it. Remove it there first.")
    for new in moved.values():
        s.kits(new)  # may this visitor use that version (theirs, or approved and in their library)?
    count = {"objects": 0, "animations": 0}
    for scene in s.project.scenes:
        for m in scene.mobjects:
            if m.type in moved:
                m.type = moved[m.type]
                spec = MOBJECTS[m.type]
                m.params = _refit(spec.params, m.params, scene, s.assets)
                # only the style the user set (none at first: the package's own colors show), if it still applies
                fields = {p.name: p for p in STYLE_FIELDS[spec.style_kind]}
                kept = _refit(fields.values(), m.style, scene, s.assets)
                m.style = {k: kept[k] for k in (m.style if isinstance(m.style, dict) else {}) if k in fields}
                count["objects"] += 1
        for i, step in enumerate(scene.steps):
            for a in step.animations:
                if a.anim in moved:
                    a.anim = moved[a.anim]
                    a.params = _refit(ANIMATIONS[a.anim].params, a.params, scene, s.assets)
                    ops.apply_visibility_rules(scene, i, a)
                    count["animations"] += 1
    for new in moved.values():
        clash = ops.kit_class_clash(s.project, new)
        if clash:
            raise OpError(f"This project also uses another customization called {clash}, which that version can't "
                          "go with.")
    return count


def operation_names() -> list[str]:
    return sorted(_OPS)


__all__ = ["OpError", "Session", "coerce", "operation_names", "PLAY", "WAIT"]


# ---------------------------------------------------------------------- files from elsewhere


def revalidate(project: Project, assets: Callable[[str], str] | None = None) -> list[str]:
    """Hold a loaded project to the rules edits follow: clamp numbers, drop junk, forget files that aren't ours.

    Returns notes about what was reset. A project file is just JSON anyone can write, so nothing in it is trusted.
    """
    notes: list[str] = []

    def fix(params, values: dict, where: str, scene: Scene | None) -> None:
        for p in params:
            if p.name not in values:
                continue
            try:
                values[p.name] = coerce(p, values[p.name], scene, None, assets=assets)
            except Exception:  # noqa: BLE001 - any odd value is replaced, never trusted
                values[p.name] = copy.deepcopy(p.default)
                notes.append(f"{where}: reset '{p.title}'")

    def clamp(value, lo, hi, default):
        try:
            return _number(value, lo, hi)
        except Exception:  # noqa: BLE001
            return default

    try:
        project.settings.background = normalize(project.settings.background)
    except Exception:  # noqa: BLE001
        project.settings.background = "#000000"
    if project.settings.quality not in QUALITY_ORDER:
        project.settings.quality = "m"
    for scene in project.scenes:
        kind = ops.scene_kind(scene)
        scene.options = {k: v for k, v in scene.options.items() if kind.option(k) is not None}
        fix(kind.options, scene.options, f"{scene.name} settings", None)
        for m in scene.mobjects:
            spec = MOBJECTS[m.type]
            if spec.blocked:  # a custom object whose package is unavailable: kept as it is
                continue
            where = f"{scene.name}.{m.name}"
            m.params = {k: v for k, v in (m.params if isinstance(m.params, dict) else {}).items()
                        if k in {p.name for p in spec.params}}
            fix(spec.params, m.params, where, scene)
            m.style = {k: v for k, v in (m.style if isinstance(m.style, dict) else {}).items()
                       if k in {p.name for p in STYLE_FIELDS[spec.style_kind]}}
            fix(STYLE_FIELDS[spec.style_kind], m.style, where, scene)
            pos = m.position if isinstance(m.position, list) and len(m.position) >= 2 else [0.0, 0.0]
            m.position = [clamp(pos[0], -50, 50, 0.0), clamp(pos[1], -50, 50, 0.0)]
            m.rotation = clamp(m.rotation, -36000, 36000, 0.0)
            m.scale = clamp(m.scale, 0.01, 100, 1.0)
            m.z = clamp(m.z, -50, 50, 0.0)
            m.z_index = int(clamp(m.z_index, -100, 100, 0))
            m.on_screen_at_start = bool(m.on_screen_at_start)
            for call in m.methods:
                call.args = call.args if isinstance(call.args, dict) else {}
                fix(METHODS[call.method].params, call.args, f"{where}.{call.method}", scene)
        for step in scene.steps:
            step.run_time = clamp(step.run_time, 0.05, 600, 1.0)
            step.duration = clamp(step.duration, 0.05, 3600, 1.0)
            step.lag_ratio = clamp(step.lag_ratio, 0, 1, 0.0)
            for a in step.animations:
                a.params = a.params if isinstance(a.params, dict) else {}
                if a.anim != ANIMATE and ANIMATIONS[a.anim].blocked:  # kept as it is (see above)
                    continue
                fix(_anim_params(a), a.params, f"{scene.name} animation", scene)
                check = None if a.anim == ANIMATE else ANIMATIONS[a.anim].check
                if check is not None:
                    try:
                        check(a.params)
                    except Exception:  # noqa: BLE001
                        a.params = ops.default_params(ANIMATIONS[a.anim].params)
                        notes.append(f"{scene.name} animation: reset '{ANIMATIONS[a.anim].title}'")
            ops.sync_step_time(step)
    return notes
