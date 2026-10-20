import ast

import pytest

try:
    import numpy as np
except ImportError:  # the server's own packages: the tests using numpy need Manim and skip
    np = None

from manimator import codegen
from manimator.model import ops
from manimator.model.project import PLAY, Project
from manimator.registry import ANIMATIONS, METHODS, MOBJECTS
from manimator.registry.animations import ANIMATE


def run_setup(scene, ns):
    codes, _ = codegen.scene_objects(scene)
    for c in codes:
        assert c.error is None, c.error
        for line in c.lines():
            exec(line, ns)
    return {c.mob_id: ns[c.var] for c in codes}


def scene_with_anchor():
    project = Project.new()
    scene = project.scenes[0]
    anchor = ops.create_mobject(scene, "Square", 0, 0)
    return project, scene, anchor


# Placed by points, but their bounding box is not centered on the midpoint of those points.
CURVED = {"ArcBetweenPoints", "CurvedArrow", "CurvedDoubleArrow", "Angle", "RightAngle", "BraceBetweenPoints",
          "Arrow3D"}


def sample_files(tmp_path):
    """Real files for the objects that need one."""
    from PIL import Image

    png = tmp_path / "sample.png"
    Image.new("RGBA", (40, 20), (200, 80, 80, 255)).save(png)
    svg = tmp_path / "sample.svg"
    svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">'
                   '<rect width="40" height="40" fill="red"/></svg>', encoding="utf-8")
    return {"ImageMobject": str(png), "SVGMobject": str(svg)}


@pytest.mark.parametrize("key", list(MOBJECTS))
def test_every_mobject_builds_at_its_position(key, manim_ns, tmp_path):
    project, scene, anchor = scene_with_anchor()
    item = ops.create_mobject(scene, key, 2.0, -1.0, target_id=anchor.id)
    if key in sample_files(tmp_path):
        item.params["file"] = sample_files(tmp_path)[key]
    built = run_setup(scene, manim_ns)
    mob = built[item.id]
    if MOBJECTS[key].positioned:
        np.testing.assert_allclose(mob.get_center()[:2], [2.0, -1.0], atol=1.0 if key in CURVED else 1e-6)


@pytest.mark.parametrize("key", [k for k, s in MOBJECTS.items() if s.natural])
def test_natural_style_matches_manim(key, manim_ns):
    """Codegen leaves out style values equal to `natural`; they must match what Manim really does."""
    project, scene, anchor = scene_with_anchor()
    item = ops.create_mobject(scene, key, target_id=anchor.id)
    names = {m.id: m.name for m in scene.mobjects}
    manim_ns[anchor.name] = manim_ns["Square"]()
    mob = eval(codegen.mobject_code(item, names).ctor, manim_ns)
    nat = MOBJECTS[key].natural
    assert mob.get_stroke_width() == pytest.approx(nat["stroke_width"])
    assert mob.get_stroke_opacity() == pytest.approx(nat["stroke_opacity"])
    if "fill_opacity" in nat:
        assert mob.get_fill_opacity() == pytest.approx(nat["fill_opacity"])


@pytest.mark.parametrize("key", list(METHODS))
def test_every_method_runs_and_animates(key, manim_ns):
    project, scene, anchor = scene_with_anchor()
    item = ops.create_mobject(scene, "Circle", 1, 1)
    ops.add_method(item, key, scene)
    run_setup(scene, manim_ns)
    _, names = codegen.scene_objects(scene)
    anim = ops.make_animation(scene, ANIMATE, item.id, method=key)
    expr = codegen.animation_code(anim, names)
    assert ".animate." in expr
    eval(expr, manim_ns).build()


@pytest.mark.parametrize("key", [k for k, a in ANIMATIONS.items() if k != ANIMATE and not a.scene_action])
def test_every_animation_constructs(key, manim_ns):
    project = Project.new()
    scene = project.scenes[0]
    target_type = ANIMATIONS[key].only[0] if ANIMATIONS[key].only else "Circle"
    item = ops.create_mobject(scene, target_type, -2, 0)
    other_type = "MathTex" if target_type in ("MathTex", "Tex") else "Square"
    ops.create_mobject(scene, other_type, 2, 0)
    ops.add_play_step(scene, key, item.id)
    run_setup(scene, manim_ns)
    _, names = codegen.scene_objects(scene)
    expr = codegen.animation_code(scene.steps[0].animations[0], names)
    eval(expr, manim_ns)


def test_full_source_compiles_and_reads_well():
    project = Project.new()
    scene = project.scenes[0]
    title = ops.create_mobject(scene, "Text", 0, 3)
    circle = ops.create_mobject(scene, "Circle", -2, 0)
    eq = ops.create_mobject(scene, "MathTex", 2, 0)
    ops.add_play_step(scene, "Write", title.id)
    ops.add_play_step(scene, "Create", circle.id)
    ops.add_animation_to_step(scene, 1, "FadeIn", eq.id)
    ops.add_wait_step(scene)
    ops.add_play_step(scene, ANIMATE, circle.id, method="shift")
    src = codegen.project_source(project)
    compile(src, "scene.py", "exec")
    assert 'text = Text("Hello", font_size=48)' in src
    assert 'eq = MathTex(r"e^{i\\pi} + 1 = 0", font_size=48)' in src
    assert "self.play(Create(circle), FadeIn(eq), run_time=1)" in src
    assert "self.play(circle.animate.shift(RIGHT), run_time=1)" in src
    assert "self.wait(1)" in src
    # Introduced by animations, so not added up front.
    assert "self.add(" not in src
    assert not title.on_screen_at_start and not circle.on_screen_at_start


def test_references_build_in_dependency_order(manim_ns):
    project = Project.new()
    scene = project.scenes[0]
    label = ops.create_mobject(scene, "Text", 0, 0)
    box = ops.create_mobject(scene, "Square", 0, 0)
    ops.add_method(label, "next_to", scene)
    label.methods[0].args["mobject_or_point"] = box.id
    order = [m.id for m in codegen.build_order(scene)]
    assert order.index(box.id) < order.index(label.id)
    built = run_setup(scene, manim_ns)
    assert built[label.id].get_left()[0] > built[box.id].get_right()[0]


def test_lagged_start_and_rate_func():
    project = Project.new()
    scene = project.scenes[0]
    a = ops.create_mobject(scene, "Circle")
    b = ops.create_mobject(scene, "Square")
    ops.add_play_step(scene, "FadeIn", a.id)
    ops.add_animation_to_step(scene, 0, "FadeIn", b.id)
    scene.steps[0].lag_ratio = 0.5
    scene.steps[0].rate_func = "rate_functions.ease_out_bounce"
    src = codegen.scene_source(scene, project)
    assert "LaggedStart(FadeIn(circle), FadeIn(square), lag_ratio=0.5)" in src
    assert "rate_func=rate_functions.ease_out_bounce" in src


def test_vector_and_value_formatting():
    assert codegen.vector_code([2, 0]) == "2 * RIGHT"
    assert codegen.vector_code([-1, 1]) == "LEFT + UP"
    assert codegen.vector_code([0, 0]) == "ORIGIN"
    assert codegen.num(1.0) == "1" and codegen.num(0.30000000001) == "0.3"
    assert codegen.py_str("a\\b") == 'r"a\\b"'
    assert codegen.py_str('say "hi"') == "'say \"hi\"'"


def test_hostile_values_never_reach_the_code():
    """Bare identifiers come only from allow-lists, so project data can't inject code."""
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
    src = codegen.project_source(project)
    tree = ast.parse(src)
    imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert [(type(n).__name__, getattr(n, "module", None)) for n in imports] == [("ImportFrom", "manim")]
    identifiers = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    identifiers |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert not identifiers & {"__import__", "exit", "system", "getcwd", "os"}
    assert "rate_func" not in src
    assert len([n for n in tree.body if isinstance(n, ast.ClassDef)]) == 1


def test_sanitize_project_drops_unknown_entries():
    project = Project.new()
    scene = project.scenes[0]
    c = ops.create_mobject(scene, "Circle")
    ops.create_mobject(scene, "Circle").type = "NotAMobject"
    c.methods.append(ops.MethodCall("delete_everything", {}))
    ops.add_play_step(scene, "Create", c.id)
    scene.steps[0].animations[0].anim = "Explode"
    c.name = "bad name"
    notes = ops.sanitize_project(project)
    assert len(notes) == 3
    assert [m.type for m in scene.mobjects] == ["Circle"]
    assert c.methods == [] and scene.steps == [] and c.name == "bad_name"


def test_text_with_control_characters_still_makes_valid_python():
    for text in ("a\\b\rc", "x\\y\x00z", "\\alpha\x0b", "tab\\\there", "plain\\frac{1}{2}"):
        literal = codegen.py_str(text)
        assert ast.literal_eval(literal) == text
        compile(f"x = {literal}\n", "scene.py", "exec")
    assert codegen.py_str("\\frac{1}{2}") == 'r"\\frac{1}{2}"'  # LaTeX stays readable
