"""Editing operations on the model.

Pure Python with no Qt, so they are easy to test. The UI wraps each call in an
undoable edit (see ui/document.py).
"""

from __future__ import annotations

import copy
import keyword
import re
import unicodedata

from ..registry import ANIMATIONS, METHODS, MOBJECTS
from ..registry.animations import ADD, ANIMATE, REMOVE, REPLACE
from ..registry.custom import is_kit_type
from ..registry.params import MOBREF, MOBREFS
from ..registry.scenes import (
    FIXED_CHOICES, FOREGROUND, LINEAR, MOVING_VECTOR, SCENE, SCENE_KINDS, STATIC, TRANSFORM_ROLES, TRANSFORMABLE,
    VECTOR_TYPES, SceneKind,
)
from .project import (
    PLAY, WAIT, AnimationItem, MethodCall, MobjectItem, Project, Scene, Step, new_id,
)

# ---------------------------------------------------------------------- names

_reserved: set[str] | None = None


def reserved_names() -> set[str]:
    """Names a variable or scene class must not take: keywords and everything `from manim import *` brings in
    (frozen in registry/reserved.py by tools/FreezeManim.py)."""
    global _reserved
    if _reserved is None:
        from ..registry.reserved import MANIM_NAMES

        _reserved = set(MANIM_NAMES) | {"__builtins__"} | set(keyword.kwlist) | {"self", "config", "construct"}
    return _reserved


def _nfkc(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


def sanitize_identifier(text: str, fallback: str = "obj") -> str:
    """A Python name for `text`. Python reads names in their NFKC form, so "ｘ" (full width) is the variable x and
    "x²" isn't a name at all ("x2" is): names are kept in that form, with anything else turned into _."""
    s = "".join(ch if ("_" + ch).isidentifier() else "_" for ch in _nfkc(str(text).strip()))
    if not s:
        s = fallback
    if not s.isidentifier():  # starts with a digit, or a mark that can only follow a letter
        s = "_" + s
    if not s.isidentifier() or _nfkc(s) != s:  # rare combining characters: plain letters only
        s = re.sub(r"\W", "_", s, flags=re.ASCII)
        s = "_" + s if s[0].isdigit() else s
    if s in reserved_names():
        s += "_"
    return s


def valid_name(name, fallback: str = "obj") -> bool:
    """Whether `name` is already what sanitize_identifier makes of it."""
    return isinstance(name, str) and sanitize_identifier(name, fallback) == name


def _unique(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    stem = re.sub(r"_\d+$", "", base) or base
    i = 2
    while f"{stem}_{i}" in taken:
        i += 1
    return f"{stem}_{i}"


def unique_mobject_name(scene: Scene, base: str, exclude_id: str | None = None) -> str:
    taken = {_nfkc(str(m.name)) for m in scene.mobjects if m.id != exclude_id}
    return _unique(sanitize_identifier(base), taken)


def unique_scene_name(project: Project, base: str, exclude_id: str | None = None) -> str:
    taken = {_nfkc(str(s.name)) for s in project.scenes if s.id != exclude_id}
    return _unique(sanitize_identifier(base, "Scene"), taken)


# ---------------------------------------------------------------------- references


def mobject_refs(item: MobjectItem) -> set[str]:
    """Ids this object needs to exist before it can be built (constructor refs + method refs)."""
    refs = set()
    for p in MOBJECTS[item.type].params:
        if p.kind == MOBREF:
            refs.add(item.params.get(p.name))
        elif p.kind == MOBREFS:
            refs |= set(item.params.get(p.name) or [])
    for call in item.methods:
        refs |= method_refs(call)
    refs.discard(None)
    return refs


def method_refs(call: MethodCall) -> set[str]:
    spec = METHODS.get(call.method)
    if spec is None:
        return set()
    return {call.args.get(p.name) for p in spec.params if p.kind == MOBREF} - {None}


def anim_refs(anim: AnimationItem) -> set[str]:
    refs = {anim.target}
    if anim.anim == ANIMATE:
        refs |= method_refs(MethodCall(anim.method or "", anim.params))
    else:
        spec = ANIMATIONS[anim.anim]
        refs |= {anim.params.get(p.name) for p in spec.params if p.kind == MOBREF}
        for p in spec.params:
            if p.kind == MOBREFS:
                refs |= set(anim.params.get(p.name) or [])
    refs.discard(None)
    return refs


def dependents(scene: Scene, mob_id: str) -> set[str]:
    """mob_id plus every object that (directly or indirectly) needs it to be built first."""
    result = {mob_id}
    changed = True
    while changed:
        changed = False
        for m in scene.mobjects:
            if m.id not in result and mobject_refs(m) & result:
                result.add(m.id)
                changed = True
    return result


def group_owners(scene: Scene) -> dict[str, str]:
    """member id -> id of a group that holds it. Members are shown and hidden with their group."""
    owners: dict[str, str] = {}
    for m in scene.mobjects:
        p = MOBJECTS[m.type].group_param
        if p is not None and p.name == "members":  # holes of a Cutout are not owned
            for member in m.params.get(p.name) or []:
                owners.setdefault(member, m.id)
    return owners


def ref_choices(scene: Scene, owner_id: str | None, setup: bool) -> list[MobjectItem]:
    """Objects a reference param on `owner_id` may point at.

    Setup refs (constructor/method params) exclude anything that depends on the
    owner, which would create a cycle. Animation refs only exclude the owner itself.
    """
    excluded = dependents(scene, owner_id) if (setup and owner_id) else {owner_id}
    return [m for m in scene.mobjects if m.id not in excluded]


# ---------------------------------------------------------------------- mobjects


def kit_types_in(project: Project) -> list[str]:
    """The custom types (registry/custom.py) a project uses, objects and animations, in order of first use."""
    out = []
    for scene in project.scenes:
        out += [m.type for m in scene.mobjects if is_kit_type(m.type)]
        out += [a.anim for st in scene.steps for a in st.animations if is_kit_type(a.anim)]
    return list(dict.fromkeys(out))


def kit_spec(key: str):
    """A registered custom type's spec (None if nobody registered it)."""
    return MOBJECTS.custom.get(key) or ANIMATIONS.custom.get(key)


def kit_class_clash(project: Project, key: str) -> str | None:
    """The class name `key` shares with another package the project uses (its Python can hold only one)."""
    spec = kit_spec(key)
    cls = (spec.kit or {}).get("class") if spec is not None else None
    for other in kit_types_in(project):
        o = kit_spec(other) if other != key else None
        if o is not None and o.kit and o.kit.get("class") == cls:
            return cls
    return None


def default_params(params) -> dict:
    return {p.name: copy.deepcopy(p.default) for p in params}


def create_mobject(scene: Scene, type_key: str, x: float = 0.0, y: float = 0.0,
                   target_id: str | None = None) -> MobjectItem:
    spec = MOBJECTS[type_key]
    params = default_params(spec.params)
    if spec.needs_target:
        if target_id is None or scene.mob(target_id) is None:
            raise ValueError(f"Select the object the {type_key} should attach to, then add it.")
        params[spec.target_param.name] = target_id
    elif spec.group_param is not None and scene.mob(target_id) is not None:
        params[spec.group_param.name] = [target_id]  # group the selected object
    item = MobjectItem(
        id=new_id(),
        type=type_key,
        name=unique_mobject_name(scene, spec.name),
        params=params,
        style=copy.deepcopy(spec.default_style),
        position=[round(x, 3), round(y, 3)],
        scale=spec.initial_scale,
    )
    if spec.point_params:
        item.position = [0.0, 0.0]
        move_mobject(item, x, y)
    scene.mobjects.append(item)
    return item


def mobject_position(item: MobjectItem) -> tuple[float, float]:
    spec = MOBJECTS[item.type]
    if spec.point_params:
        pts = [item.params[p] for p in spec.point_params]
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    return (item.position[0], item.position[1])


def move_mobject(item: MobjectItem, dx: float, dy: float) -> None:
    spec = MOBJECTS[item.type]
    if spec.point_params:
        for p in spec.point_params:
            px, py, *rest = item.params[p]  # 3D points keep their z
            item.params[p] = [round(px + dx, 3), round(py + dy, 3), *rest]
    elif spec.positioned:
        item.position = [round(item.position[0] + dx, 3), round(item.position[1] + dy, 3)]


def set_mobject_position(item: MobjectItem, x: float, y: float) -> None:
    cx, cy = mobject_position(item)
    move_mobject(item, x - cx, y - cy)


def rename_mobject(scene: Scene, mob_id: str, name: str) -> str:
    item = scene.mob(mob_id)
    item.name = unique_mobject_name(scene, name, exclude_id=mob_id)
    return item.name


def duplicate_mobject(scene: Scene, mob_id: str) -> MobjectItem:
    src = scene.mob(mob_id)
    item = copy.deepcopy(src)
    item.id = new_id()
    item.name = unique_mobject_name(scene, src.name)
    move_mobject(item, 0.5, -0.5)
    scene.mobjects.insert(scene.mob_index(mob_id) + 1, item)
    return item


def delete_mobjects(scene: Scene, ids: set[str]) -> list[str]:
    """Delete objects plus whatever cannot exist without them. Returns the names removed."""
    doomed = set(ids)
    changed = True
    while changed:  # helpers built around a deleted object go too
        changed = False
        for m in scene.mobjects:
            if m.id in doomed:
                continue
            ctor_refs = {m.params.get(p.name) for p in MOBJECTS[m.type].params if p.kind == MOBREF}
            if ctor_refs & doomed:
                doomed.add(m.id)
                changed = True
    removed = [m.name for m in scene.mobjects if m.id in doomed]
    scene.mobjects = [m for m in scene.mobjects if m.id not in doomed]
    for m in scene.mobjects:  # a group just loses its deleted members
        for p in MOBJECTS[m.type].params:
            if p.kind == MOBREFS:
                m.params[p.name] = [i for i in m.params.get(p.name) or [] if i not in doomed]
    for m in scene.mobjects:
        m.methods = [c for c in m.methods if not (method_refs(c) & doomed)]
    for step in scene.steps:
        step.animations = [a for a in step.animations if _forget(a, doomed)]
    scene.steps = [s for s in scene.steps if s.kind == WAIT or s.animations]
    return removed


def _forget(anim: AnimationItem, doomed: set[str]) -> bool:
    """Take deleted objects out of the animation's object lists ("Zoom to fit" keeps the others).
    Returns False when the animation can't play any more."""
    if anim.anim != ANIMATE:
        for p in ANIMATIONS[anim.anim].params:
            if p.kind == MOBREFS:
                kept = [i for i in anim.params.get(p.name) or [] if i not in doomed]
                if p.min_items and not kept:
                    return False
                anim.params[p.name] = kept
    return not (anim_refs(anim) & doomed)


def move_layer(scene: Scene, mob_id: str, delta: int) -> None:
    i = scene.mob_index(mob_id)
    j = max(0, min(len(scene.mobjects) - 1, i + delta))
    if i != j:
        scene.mobjects.insert(j, scene.mobjects.pop(i))


def add_method(item: MobjectItem, method_key: str, scene: Scene) -> MethodCall:
    spec = METHODS[method_key]
    args = default_params(spec.params)
    for p in spec.params:
        if p.kind == MOBREF:
            choices = ref_choices(scene, item.id, setup=True)
            args[p.name] = choices[0].id if choices else None
    call = MethodCall(method_key, args)
    item.methods.append(call)
    return call


# ---------------------------------------------------------------------- steps


def appears_before(scene: Scene, mob_id: str, step_index: int) -> bool:
    return any(mob_id in anim_refs(a) for s in scene.steps[:step_index] for a in s.animations)


def _pick_other(scene: Scene, target_id: str | None) -> str | None:
    """Default for a second object (Transform target, path): prefer one that's hidden at the start."""
    others = [m for m in scene.mobjects if m.id != target_id]
    hidden = [m for m in others if not m.on_screen_at_start]
    pool = hidden or others
    return pool[0].id if pool else None


def make_animation(scene: Scene, anim_key: str, target_id: str | None,
                   method: str | None = None, step_index: int | None = None) -> AnimationItem:
    """A new animation with default settings. For a scene action `target_id` is only a hint (the selected
    object, picked for its object settings); the action itself has no target."""
    if anim_key != ANIMATE and ANIMATIONS[anim_key].scene_action:
        return _make_action(scene, anim_key, target_id, len(scene.steps) if step_index is None else step_index)
    if anim_key == ANIMATE:
        method = method or "shift"
        anim = AnimationItem(ANIMATE, target_id, default_params(METHODS[method].params), method)
        for p in METHODS[method].params:
            if p.kind == MOBREF:
                anim.params[p.name] = _pick_other(scene, target_id)
        return anim
    spec = ANIMATIONS[anim_key]
    params = default_params(spec.params)
    for p in spec.params:
        if p.kind == MOBREF:
            params[p.name] = _pick_other(scene, target_id)
    return AnimationItem(anim_key, target_id, params)


def _make_action(scene: Scene, key: str, hint: str | None, step_index: int) -> AnimationItem:
    spec = ANIMATIONS[key]
    params = default_params(spec.params)
    pick = hint if scene.mob(hint) is not None else (scene.mobjects[0].id if scene.mobjects else None)
    for p in spec.params:
        if p.kind == MOBREF:
            params[p.name] = pick
        elif p.kind == MOBREFS:
            params[p.name] = [pick] if pick else []
    if key == "camera_move3d":  # start from where the camera is at that point, turned a little further
        params.update(camera_angles_before(scene, step_index))
        params["theta"] = round(params["theta"] + 60.0, 1)
    return AnimationItem(key, None, params)


def camera_angles_before(scene: Scene, step_index: int) -> dict:
    """The 3D camera's tilt, rotation, roll and zoom as of the last "Move camera" before `step_index`."""
    angles = {name: float(option(scene, name)) for name in ("phi", "theta", "gamma", "zoom")} \
        if scene_kind(scene).three_d else {"phi": 70.0, "theta": -50.0, "gamma": 0.0, "zoom": 1.0}
    for step in scene.steps[:step_index]:
        for a in step.animations:
            if a.anim == "camera_move3d":
                angles.update({k: a.params[k] for k in angles if k in a.params})
    return angles


def is_action(anim: AnimationItem) -> bool:
    """A scene action (camera move, grid transformation...) rather than an animation of an object."""
    return anim.anim != ANIMATE and anim.anim in ANIMATIONS and ANIMATIONS[anim.anim].scene_action


def apply_visibility_rules(scene: Scene, step_index: int, anim: AnimationItem) -> None:
    """An object first brought in by an animation should not already be on screen."""
    if anim.anim == ANIMATE or is_action(anim):
        return
    spec = ANIMATIONS[anim.anim]
    hide = []
    if spec.introducer:
        hide.append(anim.target)
    if spec.category == "Transform" and spec.second_target:
        hide.append(anim.params.get(spec.second_target.name))
    for mob_id in hide:
        item = scene.mob(mob_id)
        if item is not None and not appears_before(scene, mob_id, step_index):
            item.on_screen_at_start = False


def add_play_step(scene: Scene, anim_key: str, target_id: str | None, index: int | None = None,
                  method: str | None = None) -> int:
    index = len(scene.steps) if index is None else index
    anim = make_animation(scene, anim_key, target_id, method, index)
    run_time = 1.0 if anim_key == ANIMATE else ANIMATIONS[anim_key].run_time
    step = Step(kind=PLAY, animations=[anim], run_time=run_time)
    check_step(scene, step)
    sync_step_time(step)
    scene.steps.insert(index, step)
    apply_visibility_rules(scene, index, anim)
    return index


def add_animation_to_step(scene: Scene, step_index: int, anim_key: str, target_id: str | None,
                          method: str | None = None) -> AnimationItem:
    anim = make_animation(scene, anim_key, target_id, method, step_index)
    step = scene.steps[step_index]
    step.animations.append(anim)
    check_step(scene, step)
    apply_visibility_rules(scene, step_index, anim)
    return anim


def change_animation_type(scene: Scene, step_index: int, anim_index: int, anim_key: str,
                          method: str | None = None) -> None:
    step = scene.steps[step_index]
    old = step.animations[anim_index]
    new = make_animation(scene, anim_key, old.target, method, step_index)
    if is_action(new) and is_action(old):
        for p in ANIMATIONS[anim_key].params:  # keep the objects already chosen
            if p.kind == MOBREF and len(anim_refs(old)) == 1:
                new.params[p.name] = next(iter(anim_refs(old)))
            elif p.kind == MOBREFS and anim_refs(old):
                new.params[p.name] = sorted(anim_refs(old), key=scene.mob_index)
    step.animations[anim_index] = new
    check_step(scene, step)
    sync_step_time(step)
    apply_visibility_rules(scene, step_index, new)


def check_step(scene: Scene, step: Step) -> None:
    """Raise ValueError if the step's animations can't play together in this kind of scene."""
    channels: dict[str, str] = {}
    for a in step.animations:
        if not is_action(a):
            if a.target is None:
                raise ValueError("Choose which object to animate.")
            continue
        spec = ANIMATIONS[a.anim]
        if scene.kind not in spec.scene_kinds:
            raise ValueError(f"'{spec.title}' needs a {' or '.join(spec.scene_kinds)}.")
        if spec.fixed_time is not None and len(step.animations) > 1:
            raise ValueError(f"'{spec.title}' plays a sequence of its own, so it needs a step to itself.")
        if spec.channel in channels:
            raise ValueError(f"'{channels[spec.channel]}' and '{spec.title}' can't play in the same step. "
                             "Put one of them in a step of its own.")
        channels[spec.channel] = spec.title


def fixed_time(step: Step) -> float | None:
    """How long the step lasts when it plays a sequence with a length of its own."""
    for a in step.animations:
        if is_action(a) and ANIMATIONS[a.anim].fixed_time is not None:
            return ANIMATIONS[a.anim].fixed_time
    return None


def sync_step_time(step: Step) -> None:
    t = fixed_time(step)
    if t is not None:
        step.run_time = t


def add_wait_step(scene: Scene, index: int | None = None, duration: float = 1.0) -> int:
    index = len(scene.steps) if index is None else index
    scene.steps.insert(index, Step(kind=WAIT, duration=duration))
    return index


def merge_with_previous(scene: Scene, index: int) -> int:
    """Play step `index` at the same time as the play step before it."""
    if index <= 0 or scene.steps[index].kind != PLAY or scene.steps[index - 1].kind != PLAY:
        return index
    prev = scene.steps[index - 1]
    prev.animations.extend(scene.steps.pop(index).animations)
    check_step(scene, prev)
    return index - 1


def split_step(scene: Scene, index: int) -> int:
    """Turn a play step with several animations into one step per animation."""
    step = scene.steps[index]
    if step.kind != PLAY or len(step.animations) < 2:
        return index
    parts = [
        Step(PLAY, [a], step.run_time, step.rate_func, 0.0, step.duration)
        for a in step.animations
    ]
    for part in parts:
        sync_step_time(part)
    scene.steps[index:index + 1] = parts
    return index


def move_step(scene: Scene, index: int, delta: int) -> int:
    j = max(0, min(len(scene.steps) - 1, index + delta))
    if j != index:
        scene.steps.insert(j, scene.steps.pop(index))
    return j


# ---------------------------------------------------------------------- loading


def sanitize_project(project: Project) -> list[str]:
    """Drop things this version doesn't know (e.g. from a hand-edited file) and fix names.

    Returns human-readable notes about what was changed.
    """
    notes = []
    scene_names: set[str] = set()
    for scene in project.scenes:
        if not valid_name(scene.name, "Scene") or scene.name in scene_names:  # each scene is its own class
            scene.name = unique_scene_name(project, str(scene.name), exclude_id=scene.id)
        scene_names.add(scene.name)
        if scene.kind not in SCENE_KINDS:
            notes.append(f"{scene.name}: unknown scene type {scene.kind!r}, using Scene")
            scene.kind = SCENE
        if not isinstance(scene.options, dict):
            scene.options = {}
        kept = []
        for m in scene.mobjects:
            if m.type not in MOBJECTS:
                notes.append(f"{scene.name}: removed unknown object type {m.type!r}")
                continue
            unknown = [c.method for c in m.methods if c.method not in METHODS]
            if unknown:
                notes.append(f"{scene.name}.{m.name}: removed unknown methods {unknown}")
                m.methods = [c for c in m.methods if c.method in METHODS]
            kept.append(m)
        scene.mobjects = kept
        names: set[str] = set()
        for m in kept:
            if not valid_name(m.name) or m.name in names:  # two objects must never share a variable
                m.name = unique_mobject_name(scene, str(m.name), exclude_id=m.id)
            names.add(m.name)
            if m.fixed not in {v for v, _label in FIXED_CHOICES}:
                m.fixed = ""
            if m.transform_role not in {v for v, _label in TRANSFORM_ROLES}:
                m.transform_role = ""
        for step in scene.steps:
            step.animations = [
                a for a in step.animations
                if (a.anim == ANIMATE and a.method in METHODS)
                or (a.anim != ANIMATE and a.anim in ANIMATIONS
                    and (a.target is not None) != ANIMATIONS[a.anim].scene_action
                    and (not ANIMATIONS[a.anim].scene_action or scene.kind in ANIMATIONS[a.anim].scene_kinds))
            ]
            try:
                check_step(scene, step)
            except ValueError:  # e.g. two camera moves in one step (a hand-edited file): keep the first
                step.animations = step.animations[:1]
            sync_step_time(step)
        before = len(scene.steps)
        scene.steps = [s for s in scene.steps if s.kind == WAIT or (s.kind == PLAY and s.animations)]
        if len(scene.steps) != before:
            notes.append(f"{scene.name}: removed {before - len(scene.steps)} step(s) with unknown animations")
    if not project.scenes:
        project.scenes.append(Scene(id=new_id(), name="Scene1"))
    return notes


# ---------------------------------------------------------------------- scenes


def add_scene(project: Project) -> Scene:
    scene = Scene(id=new_id(), name=unique_scene_name(project, f"Scene{len(project.scenes) + 1}"))
    project.scenes.append(scene)
    return scene


def duplicate_scene(project: Project, scene_id: str) -> Scene:
    src = project.scene(scene_id)
    scene = copy.deepcopy(src)  # object ids are scene-local, so they can stay
    scene.id = new_id()
    scene.name = unique_scene_name(project, src.name + "Copy")
    project.scenes.insert(project.scenes.index(src) + 1, scene)
    return scene


def delete_scene(project: Project, scene_id: str) -> None:
    if len(project.scenes) > 1:
        project.scenes = [s for s in project.scenes if s.id != scene_id]


def rename_scene(project: Project, scene_id: str, name: str) -> str:
    scene = project.scene(scene_id)
    scene.name = unique_scene_name(project, name, exclude_id=scene_id)
    return scene.name


def move_scene(project: Project, scene_id: str, delta: int) -> None:
    i = next(i for i, s in enumerate(project.scenes) if s.id == scene_id)
    j = max(0, min(len(project.scenes) - 1, i + delta))
    if i != j:
        project.scenes.insert(j, project.scenes.pop(i))


# ---------------------------------------------------------------------- scene kinds


def scene_kind(scene: Scene) -> SceneKind:
    return SCENE_KINDS.get(scene.kind) or SCENE_KINDS[SCENE]


def option(scene: Scene, name: str):
    """The scene's value for one of its kind's settings (the default when it was never set)."""
    p = scene_kind(scene).option(name)
    return scene.options.get(name, p.default) if p is not None else None


def set_scene_kind(scene: Scene, kind: str) -> list[str]:
    """Switch the scene to another Manim scene class. The scene actions that class can't do are removed (and
    steps left empty with them); returns their names."""
    scene.kind = kind
    removed = []
    for step in scene.steps:
        keep = []
        for a in step.animations:
            if is_action(a) and kind not in ANIMATIONS[a.anim].scene_kinds:
                removed.append(ANIMATIONS[a.anim].title)
            else:
                keep.append(a)
        step.animations = keep
    scene.steps = [s for s in scene.steps if s.kind == WAIT or s.animations]
    return removed


def transform_role(item: MobjectItem) -> str:
    """How the object takes part in a LinearTransformationScene: its own choice, or the automatic one."""
    role = item.transform_role
    if role == MOVING_VECTOR and item.type not in VECTOR_TYPES:
        role = ""
    return role or auto_transform_role(item.type)


def auto_transform_role(type_key: str) -> str:
    if type_key == "Vector":
        return MOVING_VECTOR
    if MOBJECTS[type_key].category in ("Text", "Tables"):  # labels, equations and matrices stay readable
        return FOREGROUND
    return TRANSFORMABLE


def top_level(scene: Scene) -> list[MobjectItem]:
    """Objects in layer order, without the members of groups (those come and go with their group)."""
    owned = group_owners(scene)
    return [m for m in scene.mobjects if m.id not in owned]


# How an animation takes part in Manim's list of drawn objects (Scene.mobjects): its target is added on top if it
# isn't on screen, by Scene.add_mobjects_from_animations as the step is prepared, or for an introducer a moment
# later, by Animation._setup_scene as it begins. Some animate objects of their own (lines, a frame, a spotlight).
def _introduces(key: str) -> bool:
    """An introducer (custom animations say so in their package)."""
    return key in ANIMATIONS and ANIMATIONS[key].introducer


_OWN_MOBJECT = {"Flash", "Circumscribe", "FocusOn"}
_APPENDS_TARGET = {"TransformMatchingTex", "TransformMatchingShapes", "FadeTransform"}  # remove, then add on top
_GRID_ACTIONS = {"apply_matrix", "apply_inverse", "apply_function"}


def screen_orders(scene: Scene) -> list[list[str]]:
    """Like screen_states, but each list is in Manim's drawing order (bottom first), as Scene.mobjects has it.

    Follows Manim: Scene.add puts objects on top (taking them out of where they were) and keeps foreground objects
    above everything; an animation adds its target on top only if it isn't on screen, introducers after the others;
    a LaggedStart adds one group of its non-introducing targets (on screen or not); at the end removers take
    theirs away, ReplacementTransform puts its second object in the first one's place, and the TransformMatching
    animations and FadeTransform put theirs on top. In a LinearTransformationScene objects join its lists on top
    (codegen's registration calls), and each grid transformation moves the vectors it carries above the rest."""
    tops = top_level(scene)
    top_ids = {m.id for m in tops}
    lts = scene.kind == LINEAR
    roles = {m.id: transform_role(m) for m in scene.mobjects} if lts else {}
    order: list[str] = []
    foreground: list[str] = []
    vectors: list[str] = []  # LinearTransformationScene.moving_vectors (the user's ones)
    registered: set[str] = set()  # in one of its lists (as codegen._Walk.roles)

    def add(*ids) -> None:
        # Scene.add appends [*ids, *foreground]; an object listed twice is drawn where its last copy is
        moved = list(reversed(list(dict.fromkeys(reversed([*(i for i in ids if i in top_ids), *foreground])))))
        order[:] = [i for i in order if i not in moved] + moved

    def remove(i) -> None:
        for lst in (order, foreground):
            if i in lst:
                lst.remove(i)

    def register(i: str) -> None:
        """add_transformable_mobject / add_vector / add_foreground_mobject, or a plain add for a static object."""
        role = roles.get(i)
        if role != STATIC:
            registered.add(i)
        if role == FOREGROUND and i not in foreground:
            foreground.append(i)
        if role == MOVING_VECTOR and i not in vectors:
            vectors.append(i)
        add(i)

    owners = group_owners(scene)

    def owner_of(mob_id):
        """The top-level group that holds an object (or the object itself)."""
        for _ in range(len(scene.mobjects)):
            if mob_id not in owners:
                break
            mob_id = owners[mob_id]
        return mob_id

    def other(a: AnimationItem):
        p = ANIMATIONS[a.anim].second_target if a.anim in ANIMATIONS else None
        return a.params.get(p.name) if p is not None and isinstance(a.params, dict) else None

    for m in tops:
        if m.on_screen_at_start:
            register(m.id) if lts else add(m.id)
    states = screen_states(scene)
    out = [list(order)]
    for index, step in enumerate(scene.steps):
        if step.kind == WAIT:
            out.append(list(order))
            continue
        anims = [a for a in step.animations if not is_action(a) and (a.anim == ANIMATE or a.anim in ANIMATIONS)]
        if lts and any(is_action(a) and a.anim in _GRID_ACTIONS for a in step.animations):
            add(*[v for v in vectors if v in order])  # Transform(VGroup(*moving_vectors)) is added on top
        # Scene.compile_animation_data
        plain = [a for a in anims if not _introduces(a.anim) and a.anim not in _OWN_MOBJECT]
        if step.lag_ratio > 0 and len(step.animations) > 1:  # one Group of the targets, added on top
            group = [i for a in plain for i in ((a.target, other(a)) if a.anim == "FadeTransform" else (a.target,))]
            add(*reversed(list(dict.fromkeys(reversed(group)))))  # Manim keeps the last of repeated objects
        else:
            for a in plain:
                if a.anim == "FadeTransform":  # its mobject is Group(source, target): always new
                    add(a.target, other(a))
                elif a.target not in order:
                    add(a.target)
        # Scene.begin_animations: introducers add their targets if they still aren't on screen
        for a in anims:
            if _introduces(a.anim) and a.target not in order:
                add(a.target)
        # Scene.play_internal: each animation cleans up
        for a in anims:
            effect = ADD if a.anim == ANIMATE else ANIMATIONS[a.anim].screen_effect
            if effect == REMOVE:
                remove(a.target)
            elif a.anim in _APPENDS_TARGET:
                remove(a.target)
                add(other(a))
            elif effect == REPLACE:  # ReplacementTransform: the other object takes the target's place
                new = other(a)
                if new not in top_ids:
                    continue
                if new in order:
                    order.remove(new)
                if a.target in order:
                    order[order.index(a.target)] = new
                    if a.target in foreground:
                        foreground[foreground.index(a.target)] = new
                elif owner_of(a.target) in order:  # a member of a group on screen: it goes into the group
                    order.insert(order.index(owner_of(a.target)) + 1, new)
                else:
                    add(new)
        order[:] = [i for i in order if i in top_ids]
        if lts:  # codegen._Walk._lts_changes: leaving objects drop out of the lists, arriving ones join on top
            now = states[index + 1]
            registered &= now
            vectors[:] = [v for v in vectors if v in now]
            for m in tops:
                if m.id in now and m.id not in registered and roles[m.id] != STATIC:
                    register(m.id)
        out.append(list(order))
    return out


def screen_states(scene: Scene) -> list[set[str]]:
    """Which top-level objects are on screen before each step, plus after the last one (len(steps) + 1 sets).

    Follows Manim: animating an object that isn't on screen brings it in, removers take theirs away at the end
    of the step, and ReplacementTransform-like animations swap their two objects."""
    tops = {m.id for m in top_level(scene)}
    on = {m.id for m in top_level(scene) if m.on_screen_at_start}
    states = [set(on)]
    for step in scene.steps:
        added, gone = set(), set()
        for a in step.animations:
            if a.anim != ANIMATE and (a.anim not in ANIMATIONS or ANIMATIONS[a.anim].scene_action):
                continue
            effect = ADD if a.anim == ANIMATE else ANIMATIONS[a.anim].screen_effect
            if effect == ADD:
                added.add(a.target)
            elif effect == REMOVE:
                gone.add(a.target)
            elif effect == REPLACE:
                gone.add(a.target)
                if isinstance(a.params, dict):
                    added.add(a.params.get(ANIMATIONS[a.anim].second_target.name))
        on = ((on | added) - gone) & tops
        states.append(set(on))
    return states
