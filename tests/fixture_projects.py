"""Projects that exercise every path of the code generator and the scene plan.

Used by the golden tests (tests/golden/) and the browser parity checks. Each builder is deterministic: object
names, values and order never depend on random ids.
"""

from __future__ import annotations

import json
from pathlib import Path

from manimator.model import ops
from manimator.model.project import Project, Scene
from manimator.registry import ANIMATIONS, METHODS, MOBJECTS
from manimator.registry.animations import ANIMATE, RATE_FUNCS
from manimator.registry.params import (
    ANGLE, BOOL, COLOR, DIRECTION, ENUM, EXPR, FILE, FLOAT, FONT, GRID, INT, MOBREF, MOBREFS, NUMBERS, POINT, POINT3,
    POINTS, RANGE, STR, TEXT, VECTOR, Param,
)
from manimator.registry.scenes import SCENE_KINDS

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
FILES = {"ImageMobject": "sample-1a2b3c4d.png", "SVGMobject": "sample-5e6f7a8b.svg"}
ACTIONS = [k for k, a in ANIMATIONS.items() if a.scene_action]
OBJECT_ANIMS = [k for k, a in ANIMATIONS.items() if k != ANIMATE and not a.scene_action]

# Changed values that keep the object valid in Manim (for parameters where a generic change would not).
_CHANGED_BY_NAME = {
    ("Text", "text"): "Changed text", ("MarkupText", "text"): "<i>Changed</i> <b>markup</b>",
    ("MathTex", "tex"): r"\frac{a}{b} = \sqrt{c}", ("Tex", "tex"): r"Changed $x^2$",
    ("Title", "text"): "Another Title", ("Paragraph", "text"): "One\nTwo",
    ("BulletedList", "text"): "Alpha\nBeta", ("Code", "code"): "x = 1\nprint(x)",
    ("Table", "col_labels"): "A, B", ("Table", "row_labels"): "R1, R2",
    ("IntegerTable", "col_labels"): "P, Q", ("IntegerTable", "row_labels"): "S, T",
    ("DecimalTable", "col_labels"): "P, Q", ("DecimalTable", "row_labels"): "S, T",
    ("BarChart", "bar_names"): "V, W, X", ("Graph", "edges"): "0-1, 1-2", ("DiGraph", "edges"): "0->1, 1->2",
    ("LabeledDot", "label"): "B", ("LabeledLine", "label"): "len", ("LabeledArrow", "label"): "v",
    ("BraceLabel", "text"): "x", ("Variable", "label"): "t",
}


def changed(p: Param, owner: str = "", others: list[str] | None = None):
    """A valid value different from the parameter's default."""
    if (owner, p.name) in _CHANGED_BY_NAME:
        return _CHANGED_BY_NAME[(owner, p.name)]
    k, d = p.kind, p.default
    if k == FLOAT:
        v = round(min(p.max, (d or 0) * 1.5 + 0.5), 2)
        return v if v != d else round(max(p.min, (d or 0) - 0.5), 2)
    if k == INT:
        return int(d + 1 if d + 1 <= p.max else d - 1)
    if k == BOOL:
        return not d
    if k == COLOR:
        return "#123456" if d != "#123456" else "#FC6255"
    if k == POINT:
        return [1.5, -0.5]
    if k == POINT3:
        return [1.0, 2.0, 0.5]
    if k == VECTOR:
        return [-1.0, 2.0]
    if k == DIRECTION:
        return next(c for c in (p.choices or ("UR", "DL", "LEFT")) if c != d)
    if k == ANGLE:
        return 45.0 if d != 45.0 else 30.0
    if k == ENUM:
        return next(v for v, _label in p.choices if v != d)
    if k == RANGE:
        return [-2.0, 3.0, 0.5]
    if k == FONT:
        return "DejaVu Sans"
    if k == EXPR:
        return {("x",): "x**2 - 1", ("t",): "cos(t) + 0.5", ("x", "y"): "x*y - 1", ("u", "v"): "u*v"}[tuple(p.variables)]
    if k == POINTS:
        return [[0.0, 0.0], [1.5, 0.0], [0.5, 1.0], [-0.5, 0.5]]
    if k == NUMBERS:
        return [1.0, 4.0, 2.5]
    if k == GRID:
        return [["5", "6"], ["7", "8.5"]] if p.numeric else [["a", "b"], ["c", r"\pi"]]
    if k in (STR, TEXT):
        return "changed"
    if k == MOBREF:
        return (others or [None])[0]
    if k == MOBREFS:
        return list(others or [])[:2]
    if k == FILE:
        return FILES.get(owner, "")
    raise AssertionError(k)


def _new(kind: str = "Scene", name: str = "Scene1") -> tuple[Project, Scene]:
    project = Project.new()
    scene = project.scenes[0]
    scene.name = name
    ops.set_scene_kind(scene, kind)
    return project, scene


def _place(i: int) -> tuple[float, float]:
    return (round(-6 + (i % 7) * 2, 3), round(3 - (i // 7) % 7, 3))


# ---------------------------------------------------------------------- objects


def all_objects(variant: bool = False, three_d: bool = False) -> Project:
    """Every 2D (or 3D) object type once, around a Square they can attach to. `variant`: every parameter changed
    and the style, placement and layer changed too."""
    project, scene = _new("ThreeDScene" if three_d else "Scene", "Objects3D" if three_d else "Objects")
    anchor = ops.create_mobject(scene, "Square", 0, 0)
    spare = ops.create_mobject(scene, "Circle", 3, -2)
    keys = [k for k, s in MOBJECTS.items() if s.three_d == three_d]
    for i, key in enumerate(keys):
        _add_object(scene, key, i, _place(i), [anchor.id, spare.id], variant, three_d)
    return project


def one_object(key: str, variant: bool = False) -> Project:
    """One object type on its own (in the middle; the Square and Circle it may use are to the left)."""
    three_d = MOBJECTS[key].three_d
    project, scene = _new("ThreeDScene" if three_d else "Scene", key)
    anchor = ops.create_mobject(scene, "Square", -4, 1)
    spare = ops.create_mobject(scene, "Circle", -4, -2)
    _add_object(scene, key, 0, (1.0, 0.0), [anchor.id, spare.id], variant, three_d)
    return project


def _add_object(scene: Scene, key: str, i: int, at: tuple[float, float], others: list[str], variant: bool,
                three_d: bool) -> None:
    item = ops.create_mobject(scene, key, at[0], at[1], target_id=others[0])
    if key in FILES:
        item.params["file"] = FILES[key]
    if not variant:
        return
    for p in MOBJECTS[key].params:
        if p.kind == MOBREF and MOBJECTS[key].needs_target:
            continue  # stays on the anchor
        item.params[p.name] = changed(p, key, others)
    for name, value in list(item.style.items()):
        if name.endswith("color"):
            item.style[name] = "#83C167" if value != "#83C167" else "#FFFF00"
        elif name.endswith("width"):
            item.style[name] = value + 2
        elif name.endswith("opacity"):
            item.style[name] = 0.5
    item.rotation = 30.0
    item.scale = 1.25
    item.z_index = i % 3
    item.z = 0.5 if three_d else 0.0


def methods_everywhere() -> Project:
    """Every method on one object, with default and with changed arguments, plus a reference (next_to)."""
    project, scene = _new(name="Methods")
    box = ops.create_mobject(scene, "Square", -3, 0)
    circle = ops.create_mobject(scene, "Circle", 2, 1)
    star = ops.create_mobject(scene, "Star", 0, -2)
    for key in METHODS:
        ops.add_method(circle, key, scene)
        call = ops.add_method(star, key, scene)
        for p in METHODS[key].params:
            call.args[p.name] = changed(p, key, [box.id])
    return project


# ---------------------------------------------------------------------- animations


def animations_everywhere() -> Project:
    """Every animation with its defaults, then again with changed settings, then .animate with every method,
    with rate functions, lag ratios and waits in between."""
    project, scene = _new(name="Animations")
    circle = ops.create_mobject(scene, "Circle", -3, 0)
    square = ops.create_mobject(scene, "Square", 3, 0)
    text = ops.create_mobject(scene, "Text", 0, 3)
    arrow = ops.create_mobject(scene, "Arrow", 0, -3)
    eq = ops.create_mobject(scene, "MathTex", -3, -2)
    eq2 = ops.create_mobject(scene, "MathTex", 3, -2)
    eq2.params["tex"] = r"e^{i\pi} = -1"
    # Uncreate, Unwrite and ShrinkToCenter leave their object as a point (and FadeOut invisible), which Manim can't
    # wave, wiggle or fit afterwards: they get an object of their own.
    gone = ops.create_mobject(scene, "Star", 5, 3)
    pick = {"Arrow": arrow, "DoubleArrow": arrow, "Text": text, "MarkupText": text, "MathTex": eq, "Tex": eq}
    for variant in (False, True):
        for key in OBJECT_ANIMS:
            spec = ANIMATIONS[key]
            target = pick[spec.only[0]] if spec.only else gone if spec.category == "Disappear" else circle
            ops.add_play_step(scene, key, target.id)
            anim = scene.steps[-1].animations[0]
            for p in spec.params:
                if p.kind == MOBREF:
                    anim.params[p.name] = eq2.id if target is eq else square.id
                elif variant:
                    anim.params[p.name] = changed(p, key)
    for key in METHODS:
        ops.add_play_step(scene, ANIMATE, square.id, method=key)
        anim = scene.steps[-1].animations[0]
        for p in METHODS[key].params:
            anim.params[p.name] = circle.id if p.kind == MOBREF else changed(p, key)
    # Rate functions that end where they started (there_and_back...) leave an introduced object collapsed, which
    # Manim can't animate further: they go to the emphasis steps, the others to the rest.
    back = ["there_and_back", "there_and_back_with_pause", "wiggle"]
    onward = [name for name, _label in RATE_FUNCS if name not in back]
    counts = {"back": 0, "onward": 0}
    for i, step in enumerate(scene.steps):
        first = step.animations[0]
        emphasis = first.anim != ANIMATE and ANIMATIONS[first.anim].category == "Emphasize"
        pool = "back" if emphasis else "onward"
        names = back if emphasis else onward
        step.rate_func = names[counts[pool] % len(names)]
        counts[pool] += 1
        step.run_time = round(0.5 + (i % 4) * 0.5, 2)
    ops.add_wait_step(scene, 3, duration=0.75)
    ops.add_wait_step(scene, 10, duration=2.0)
    ops.add_play_step(scene, "FadeIn", circle.id)
    ops.add_animation_to_step(scene, len(scene.steps) - 1, "FadeIn", square.id)
    ops.add_animation_to_step(scene, len(scene.steps) - 1, "Rotate", text.id)
    scene.steps[-1].lag_ratio = 0.3
    return project


# ---------------------------------------------------------------------- scene kinds


def every_action(kind: str) -> Project:
    """test_scenes.test_every_action_plays_in_manim: every action the kind has, one per step, with an object
    animation alongside each."""
    project, scene = _new(kind, f"Actions{kind}")
    circle = ops.create_mobject(scene, "Circle", 2, 1)
    vector = ops.create_mobject(scene, "Vector", 0, 0)
    label = ops.create_mobject(scene, "MathTex", -3, 2)
    ops.add_play_step(scene, "Write", label.id)
    for key in ACTIONS:
        if kind in ANIMATIONS[key].scene_kinds:
            ops.add_play_step(scene, key, circle.id)
            if not ANIMATIONS[key].fixed_time:
                ops.add_animation_to_step(scene, len(scene.steps) - 1, "Indicate", vector.id)
    return project


def every_action_changed(kind: str) -> Project:
    """Every action with changed settings, twice (so state carried between steps shows: zoom on/off, camera
    angles used, lens moves while the zoom is off)."""
    project, scene = _new(kind, f"Changed{kind}")
    circle = ops.create_mobject(scene, "Circle", 2, 1)
    dot = ops.create_mobject(scene, "Dot", -2, -1)
    for _round in range(2):
        for key in ACTIONS:
            if kind not in ANIMATIONS[key].scene_kinds:
                continue
            ops.add_play_step(scene, key, circle.id)
            anim = scene.steps[-1].animations[0]
            for p in ANIMATIONS[key].params:
                if p.kind == MOBREF:
                    anim.params[p.name] = dot.id
                elif p.kind == MOBREFS:
                    anim.params[p.name] = [circle.id, dot.id]
                elif key in ("apply_matrix", "apply_inverse") and p.name == "matrix":
                    anim.params[p.name] = [["2", "1"], ["1", "1"]]
                else:
                    anim.params[p.name] = changed(p, key)
    return project


def every_setting(kind: str) -> Project:
    """test_scenes.test_every_setting_reaches_manim: all the kind's settings changed, a background colour."""
    project, scene = _new(kind, f"Settings{kind}")
    for p in SCENE_KINDS[kind].options:
        scene.options[p.name] = changed(p)
    ops.create_mobject(scene, "Square", 1, 1)
    project.settings.background = "#202040"
    return project


def three_d_roles() -> Project:
    """Fixed-in-frame and always-facing objects, some shown later; a spin that rolls the camera."""
    project, scene = _new("ThreeDScene", "Fixed")
    title = ops.create_mobject(scene, "Text", -4, 3)
    later = ops.create_mobject(scene, "Text", 4, 3)
    facing = ops.create_mobject(scene, "Text", 2, 0)
    group_member = ops.create_mobject(scene, "Dot", 1, 1)
    group = ops.create_mobject(scene, "VGroup", target_id=group_member.id)
    ops.create_mobject(scene, "Sphere", 0, 0)
    title.fixed = later.fixed = "in_frame"
    facing.fixed = "orientation"
    group.fixed = "in_frame"
    later.on_screen_at_start = False
    ops.add_play_step(scene, "Write", later.id)
    ops.add_play_step(scene, "camera_move3d", None)
    ops.add_play_step(scene, "camera_spin", None)
    scene.steps[-1].animations[0].params["about"] = "gamma"
    ops.add_play_step(scene, "camera_move3d", None)
    ops.add_play_step(scene, "camera_wobble", None)
    return project


def linear_roles() -> Project:
    """test_scenes.test_linear_transformation_moves_the_right_objects, plus every role chosen by hand."""
    project, scene = _new("LinearTransformationScene", "Linear")
    scene.options.update(leave_ghost_vectors=True, show_coordinates=True, unit_square=True)
    shape = ops.create_mobject(scene, "Square", 1, 1)
    vector = ops.create_mobject(scene, "Vector", 3, 3)
    late = ops.create_mobject(scene, "Dot", 1, 0)
    gone = ops.create_mobject(scene, "Circle", -1, -1)
    title = ops.create_mobject(scene, "Text", 0, 3)
    never = ops.create_mobject(scene, "Triangle", -2, 2)
    arrow = ops.create_mobject(scene, "Arrow", 0, -2)
    arrow.transform_role = "vector"
    still = ops.create_mobject(scene, "Star", -3, -2)
    still.transform_role = "static"
    front = ops.create_mobject(scene, "Rectangle", 3, -2)
    front.transform_role = "foreground"
    never.on_screen_at_start = False
    late.on_screen_at_start = False
    stretch = [["2", "0"], ["0", "2"]]
    ops.add_play_step(scene, "apply_matrix", None)
    scene.steps[-1].animations[0].params["matrix"] = stretch
    ops.add_animation_to_step(scene, 0, "Indicate", title.id)
    ops.add_play_step(scene, "FadeIn", late.id)
    ops.add_play_step(scene, "FadeOut", gone.id)
    ops.add_play_step(scene, "apply_inverse", None)
    ops.add_play_step(scene, "apply_function", None)
    ops.add_play_step(scene, "FadeOut", vector.id)
    ops.add_play_step(scene, "apply_matrix", None)
    assert shape and still
    return project


def hostile() -> Project:
    """test_codegen.test_hostile_values_never_reach_the_code."""
    project = Project.new()
    scene = project.scenes[0]
    brace_target = ops.create_mobject(scene, "Square")
    brace = ops.create_mobject(scene, "Brace", target_id=brace_target.id)
    brace.params["direction"] = "__import__('os').system('calc')"
    flip = ops.create_mobject(scene, "Circle")
    ops.add_method(flip, "flip", scene)
    flip.methods[0].args["axis"] = "exit()"
    flip.style["stroke_color"] = "#FFF')\nimport os#"
    evil = ops.create_mobject(scene, "Dot")
    evil.name = "x = 1; import os; y"
    scene.name = "S(Scene): pass\nimport os\nclass T"
    ops.add_play_step(scene, "FadeIn", evil.id)
    scene.steps[0].rate_func = "__import__('os').getcwd()"
    return project


def groups_and_layers() -> Project:
    """Groups (shown and hidden together), a Cutout, a helper on a group, objects hidden at the start, layers."""
    project, scene = _new(name="Groups")
    a = ops.create_mobject(scene, "Circle", -2, 0)
    b = ops.create_mobject(scene, "Square", 2, 0)
    c = ops.create_mobject(scene, "Triangle", 0, 2)
    group = ops.create_mobject(scene, "VGroup", target_id=a.id)
    group.params["members"] = [a.id, b.id]
    mixed = ops.create_mobject(scene, "Group", target_id=c.id)
    outer = ops.create_mobject(scene, "Rectangle", 0, -2)
    hole = ops.create_mobject(scene, "Circle", 0, -2)
    hole.params["radius"] = 0.4
    cut = ops.create_mobject(scene, "Cutout", target_id=outer.id)
    cut.params.update(shape=outer.id, holes=[hole.id])
    ops.create_mobject(scene, "SurroundingRectangle", target_id=group.id)
    ops.create_mobject(scene, "Brace", target_id=mixed.id)
    hidden = ops.create_mobject(scene, "Star", 4, 2)
    hidden.on_screen_at_start = False
    hidden.z_index = -1
    ops.add_play_step(scene, "FadeIn", hidden.id)
    ops.add_play_step(scene, "Transform", group.id)
    ops.add_play_step(scene, "ReplacementTransform", c.id)
    project.settings.background = "#1C758A"
    return project


def example() -> Project:
    project = Project.load(EXAMPLES / "hello_manimator.manimator")
    ops.sanitize_project(project)
    return project


def two_scenes() -> Project:
    project, scene = _new(name="First")
    dot = ops.create_mobject(scene, "Dot", 1, 1)
    ops.add_play_step(scene, "Create", dot.id)
    second = ops.add_scene(project)
    second.name = "Second"
    ops.set_scene_kind(second, "MovingCameraScene")
    sq = ops.create_mobject(second, "Square", -1, 0)
    ops.add_play_step(second, "camera_focus", sq.id)
    return project


def golden_projects() -> dict[str, Project]:
    """Every fixture by name (one project per golden file)."""
    out = {
        "objects": all_objects(), "objects_variant": all_objects(variant=True),
        "objects_3d": all_objects(three_d=True), "objects_3d_variant": all_objects(variant=True, three_d=True),
        "methods": methods_everywhere(), "animations": animations_everywhere(), "three_d_roles": three_d_roles(),
        "linear_roles": linear_roles(), "hostile": hostile(), "groups": groups_and_layers(),
        "example": example(), "two_scenes": two_scenes(),
    }
    for kind in SCENE_KINDS:
        out[f"actions_{kind}"] = every_action(kind)
        out[f"actions_changed_{kind}"] = every_action_changed(kind)
        out[f"settings_{kind}"] = every_setting(kind)
    return out


def project_json(project: Project) -> str:
    return json.dumps(project.to_dict(), indent=1, sort_keys=True)
