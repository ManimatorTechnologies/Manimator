"""The scene plan the browser plays (manimator/plan.py), without Manim.

Golden plans for the fixture projects (tests/golden/plan/, object ids replaced by their variable names), and
tests/fixtures/engine/coverage.json: every call, scene attribute, Manim name and formula function the fixtures
use, which the JavaScript tests check the engine implements. After an intended change, rewrite both with
MANIMATOR_UPDATE_GOLDEN=1 and review the diff.
"""

import json
import os
from pathlib import Path

import pytest

from manimator import codegen
from manimator.code_highlight import highlight
from manimator.model import ops
from manimator.plan import layout, project_plan, scene_plan
from manimator.registry.animations import RATE_FUNCS
from manimator.registry.exprs import ExprError, expr_tree
from manimator.registry.scenes import SCENE_KINDS
from tests.fixture_projects import _new, golden_projects

HERE = Path(__file__).resolve().parent
GOLDEN = HERE / "golden" / "plan"
COVERAGE = HERE / "fixtures" / "engine" / "coverage.json"
UPDATE = os.environ.get("MANIMATOR_UPDATE_GOLDEN") == "1"
PROJECTS = golden_projects()


def readable(plan: dict, scene) -> dict:
    """The plan with every object id replaced by "#<variable>", so it doesn't change between runs."""
    names = {m.id: "#" + codegen.safe_identifier(m.name) for m in scene.mobjects}
    names[scene.id] = "#scene"

    def walk(v):
        if isinstance(v, dict):
            return {names.get(k, k): walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, str):
            return names.get(v, v)
        return v

    return walk(plan)


def _check(path: Path, data) -> None:
    text = json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if UPDATE:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        return
    assert path.exists(), f"no golden file {path.name}; run with MANIMATOR_UPDATE_GOLDEN=1"
    assert text == path.read_text(encoding="utf-8"), f"{path.name} differs from the golden file"


@pytest.mark.parametrize("name", sorted(PROJECTS))
def test_plan_is_unchanged(name):
    project = PROJECTS[name]
    for scene in project.scenes:
        plan = scene_plan(scene, project)
        json.dumps(plan, allow_nan=False)  # plain JSON
        _check(GOLDEN / f"{name}-{codegen.safe_identifier(scene.name)}.json", readable(plan, scene))


# ---------------------------------------------------------------------- coverage


def coverage() -> dict:
    calls, attrs, names, functions, kinds, sets = set(), set(), set(), set(), set(), set()

    def walk(v):
        if isinstance(v, dict):
            if "call" in v and isinstance(v["call"], str):
                on = v.get("on")
                receiver = on["attr"] if isinstance(on, dict) and "attr" in on else "object" if on else ""
                calls.add(f"{receiver}.{v['call']}" if receiver else v["call"])
            if "attr" in v:
                attrs.add(v["attr"])
            if "name" in v and len(v) == 1:
                names.add(v["name"])
            if "f" in v and "args" in v:
                functions.add(v["f"])
            if "set" in v:
                sets.add(v["set"])
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    for project in PROJECTS.values():
        for scene in project.scenes:
            plan = scene_plan(scene, project)
            kinds.add(plan["scene"]["kind"])
            walk(plan)
    return {"calls": sorted(calls), "attrs": sorted(attrs), "names": sorted(names), "functions": sorted(functions),
            "assignments": sorted(sets), "kinds": sorted(kinds),
            "rate_funcs": sorted(name for name, _label in RATE_FUNCS if name != "default")}


def test_coverage_fixture_is_current():
    _check(COVERAGE, coverage())


def test_coverage_includes_every_kind_and_rate_function():
    cov = coverage()
    assert cov["kinds"] == sorted(SCENE_KINDS)
    used = set(cov["names"])
    assert {name for name, _label in RATE_FUNCS if name != "default"} <= used


# ---------------------------------------------------------------------- what the plan says


def test_plan_matches_the_python():
    """Each step's statements are the ones the Python plays, with the same timing."""
    project = PROJECTS["animations"]
    scene = project.scenes[0]
    plan = scene_plan(scene, project)
    assert len(plan["steps"]) == len(scene.steps)
    for step, item in zip(plan["steps"], scene.steps):
        assert step["run_time"] == pytest.approx(item.duration if item.kind == "wait" else item.run_time)
        played = step["statements"][step["play"]]["do"]
        assert played["call"] in ("play", "wait")
    assert plan["duration"] == pytest.approx(sum(s["run_time"] for s in plan["steps"]))
    assert [o["id"] for o in plan["objects"]] == [m.id for m in codegen.build_order(scene)]


def test_values_are_what_the_python_evaluates_to():
    project, scene = _new()
    sq = ops.create_mobject(scene, "Square", 1.5, -2)
    sq.rotation = 30.0
    ops.add_play_step(scene, "Animate", sq.id, method="shift")
    scene.steps[0].animations[0].params["vector"] = [2.0, 1.0]
    plan = scene_plan(scene, project)
    obj = plan["objects"][0]
    rotate = next(c for c in obj["post"] if c["call"] == "rotate")
    assert rotate["args"] == [pytest.approx(30 * 3.141592653589793 / 180)]
    move = next(c for c in obj["post"] if c["call"] == "move_to")
    assert move["args"] == [[1.5, -2, 0]]
    shift = plan["steps"][0]["statements"][0]["do"]["args"][0]
    assert shift == {"animate": {"ref": sq.id}, "calls": [{"call": "shift", "args": [[2.0, 1.0, 0.0]]}]}


def test_uploaded_files_and_frame_widths():
    project, scene = _new("MovingCameraScene")
    img = ops.create_mobject(scene, "ImageMobject")
    img.params["file"] = "photo-1a2b3c4d.png"
    ops.add_play_step(scene, "camera_zoom", None)
    plan = scene_plan(scene, project)
    assert plan["objects"][0]["call"]["args"] == [{"asset": "photo-1a2b3c4d.png"}]
    frame = plan["steps"][0]["statements"][0]["do"]["args"][0]
    assert frame["calls"][0]["kwargs"]["width"] == {"frame_width": 2.0}


def test_formulas_arrive_as_trees():
    project, scene = _new()
    graph = ops.create_mobject(scene, "FunctionGraph")
    graph.params["expr"] = "2*sin(x) + pi"
    plan = scene_plan(scene, project)
    func = plan["objects"][0]["call"]["args"][0]
    assert func == {"lambda": ["x"], "body": {"expr": {"op": "+", "a": {"op": "*", "a": 2.0, "b": {
        "f": "sin", "args": [{"v": "x"}]}}, "b": pytest.approx(3.141592653589793)}}}


def test_expression_trees_fold_constants_and_keep_the_allow_list():
    assert expr_tree("2^3 + x", ("x",)) == {"op": "+", "a": 8.0, "b": {"v": "x"}}
    assert expr_tree("sqrt(4) * tau", ()) == pytest.approx(4 * 3.141592653589793)
    assert expr_tree("-x", ("x",)) == {"op": "neg", "a": {"v": "x"}}
    assert expr_tree("1/0 + x", ("x",)) == {"op": "+", "a": {"op": "/", "a": 1.0, "b": 0.0}, "b": {"v": "x"}}
    assert expr_tree("(-8)**0.5", ())["op"] == "**"  # complex in Python: left for the browser (NaN, as numpy)
    assert expr_tree("x % 3 // 2", ("x",))["op"] == "//"
    with pytest.raises(ExprError):
        expr_tree("__import__('os')", ("x",))
    with pytest.raises(ExprError):
        expr_tree("y", ("x",))


def test_vector_field_binds_its_coordinates():
    project, scene = _new()
    ops.create_mobject(scene, "ArrowVectorField")
    func = scene_plan(scene, project)["objects"][0]["call"]["args"][0]
    assert func["lambda"] == ["p"] and func["bind"] == {"x": ["p", 0], "y": ["p", 1]}
    assert func["body"]["call"] == "np.array"


def test_layout_moves_foreground_last_and_fades_hidden_objects():
    project, scene = _new("LinearTransformationScene")
    text = ops.create_mobject(scene, "Text")
    sq = ops.create_mobject(scene, "Square")
    later = ops.create_mobject(scene, "Circle")
    later.on_screen_at_start = False
    out = layout(scene)
    assert out["order"] == [sq.id, later.id, text.id]
    assert out["hidden"] == [later.id]


def test_code_objects_carry_their_colours():
    project, scene = _new()
    ops.create_mobject(scene, "Code")
    listing = scene_plan(scene, project)["objects"][0]["code"]
    assert listing["lines"][0] == 'print("Hello, Manim!")'
    assert listing["background"].startswith("#") and listing["spans"]
    assert highlight("x = 1", "python", "monokai")["background"] == "#272822"


def test_project_plan_has_every_scene():
    plan = project_plan(PROJECTS["two_scenes"])
    assert [s["scene"]["name"] for s in plan["scenes"]] == ["First", "Second"]


def test_screen_orders_follow_manims_rules():
    project, scene = _new()
    a = ops.create_mobject(scene, "Circle")
    b = ops.create_mobject(scene, "Square")
    c = ops.create_mobject(scene, "Star")
    c.on_screen_at_start = False
    ops.add_play_step(scene, "FadeIn", a.id)  # already on screen: stays where it is
    ops.add_play_step(scene, "Indicate", c.id)  # not on screen: added on top
    ops.add_play_step(scene, "ReplacementTransform", a.id)
    scene.steps[-1].animations[0].params["target_mobject"] = c.id
    a.on_screen_at_start, c.on_screen_at_start = True, False  # (adding the steps hid them)
    orders = ops.screen_orders(scene)
    assert orders == [[a.id, b.id], [a.id, b.id], [a.id, b.id, c.id], [c.id, b.id]]
