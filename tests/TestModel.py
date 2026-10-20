from manimator import codegen
from manimator.model import ops
from manimator.model.project import Project
from manimator.registry.animations import ANIMATE


def sample_project():
    project = Project.new()
    scene = project.scenes[0]
    c = ops.create_mobject(scene, "Circle", 1, 2)
    t = ops.create_mobject(scene, "Text", -1, 0)
    ops.create_mobject(scene, "Brace", target_id=c.id)
    ops.add_method(t, "next_to", scene)
    ops.add_play_step(scene, "Create", c.id)
    ops.add_wait_step(scene)
    ops.add_play_step(scene, ANIMATE, t.id, method="set_color")
    ops.add_scene(project)
    return project


def test_save_load_round_trip(tmp_path):
    project = sample_project()
    path = tmp_path / "demo.manimator"
    project.save(path)
    assert Project.load(path).to_dict() == project.to_dict()


def test_names_are_unique_and_valid_identifiers():
    project = Project.new()
    scene = project.scenes[0]
    names = [ops.create_mobject(scene, "Circle").name for _ in range(3)]
    assert names == ["circle", "circle_2", "circle_3"]
    assert ops.rename_mobject(scene, scene.mobjects[0].id, "my circle!") == "my_circle_"
    assert ops.rename_mobject(scene, scene.mobjects[1].id, "Circle") == "Circle_"  # shadows manim
    assert ops.rename_mobject(scene, scene.mobjects[2].id, "2nd") == "_2nd"
    assert ops.rename_scene(project, scene.id, "Scene") == "Scene_"


def test_names_are_what_python_reads():
    # Python reads names in NFKC form: "x²" isn't a name ("x2" is) and full-width "ｄｏｔ" is the variable dot
    assert ops.sanitize_identifier("x²") == "x2"
    assert ops.sanitize_identifier("y = x²") == "y___x2"
    assert ops.sanitize_identifier("½") == "_1_2"
    assert ops.sanitize_identifier("ｓｅｌｆ") == "self_"
    assert ops.sanitize_identifier("café") == "café" and ops.sanitize_identifier("") == "obj"
    project = Project.new()
    scene = project.scenes[0]
    a, b = ops.create_mobject(scene, "Circle"), ops.create_mobject(scene, "Square")
    assert ops.rename_mobject(scene, a.id, "dot") == "dot"
    assert ops.rename_mobject(scene, b.id, "ｄｏｔ") == "dot_2"
    assert ops.rename_scene(project, scene.id, "Scène²") == "Scène2"
    compile(codegen.project_source(project), "scene.py", "exec")


def test_opening_a_project_fixes_names_python_would_mix_up():
    project = Project.from_dict({"scenes": [
        {"id": "s1", "name": "Intro", "mobjects": [
            {"id": "a", "type": "Circle", "name": "dot"}, {"id": "b", "type": "Circle", "name": "ｄｏｔ"},
            {"id": "c", "type": "Circle", "name": "x²"}, {"id": "d", "type": "Circle", "name": "dot"}]},
        {"id": "s2", "name": "Intro"}, {"id": "s3", "name": "Circle"}]})
    ops.sanitize_project(project)
    assert [s.name for s in project.scenes] == ["Intro", "Intro_2", "Circle_"]
    assert [m.name for m in project.scenes[0].mobjects] == ["dot", "dot_2", "x2", "dot_3"]
    compile(codegen.project_source(project), "scene.py", "exec")


def test_delete_cascades_to_dependents_and_steps():
    project = sample_project()
    scene = project.scenes[0]
    circle = scene.mobjects[0]
    removed = ops.delete_mobjects(scene, {circle.id})
    assert removed == ["circle", "brace"]
    assert [m.name for m in scene.mobjects] == ["text"]
    assert scene.mobjects[0].methods == []  # next_to(circle) dropped
    assert [s.kind for s in scene.steps] == ["wait", "play"]


def test_ref_choices_prevent_cycles():
    project = Project.new()
    scene = project.scenes[0]
    a = ops.create_mobject(scene, "Circle")
    b = ops.create_mobject(scene, "Square")
    ops.add_method(b, "next_to", scene)  # b depends on a
    assert b.methods[0].args["mobject_or_point"] == a.id
    choices_for_a = [m.id for m in ops.ref_choices(scene, a.id, setup=True)]
    assert b.id not in choices_for_a


def test_line_moves_by_its_points():
    project = Project.new()
    scene = project.scenes[0]
    line = ops.create_mobject(scene, "Arrow", 3, 1)
    assert line.params["start"] == [2.0, 1.0] and line.params["end"] == [4.0, 1.0]
    ops.set_mobject_position(line, 0, 0)
    assert ops.mobject_position(line) == (0.0, 0.0)


def test_steps_merge_split_move():
    project = Project.new()
    scene = project.scenes[0]
    a = ops.create_mobject(scene, "Circle")
    b = ops.create_mobject(scene, "Square")
    ops.add_play_step(scene, "Create", a.id)
    ops.add_play_step(scene, "Create", b.id)
    assert ops.merge_with_previous(scene, 1) == 0
    assert len(scene.steps) == 1 and len(scene.steps[0].animations) == 2
    ops.split_step(scene, 0)
    assert len(scene.steps) == 2
    assert ops.move_step(scene, 0, 1) == 1
    assert scene.steps[0].animations[0].target == b.id


def test_transform_target_hidden_at_start():
    project = Project.new()
    scene = project.scenes[0]
    a = ops.create_mobject(scene, "Circle")
    b = ops.create_mobject(scene, "Square")
    ops.add_play_step(scene, "Transform", a.id)
    assert scene.steps[0].animations[0].params["target_mobject"] == b.id
    assert a.on_screen_at_start and not b.on_screen_at_start


def test_duplicate_scene_keeps_references():
    project = sample_project()
    copy = ops.duplicate_scene(project, project.scenes[0].id)
    assert copy.name == "Scene1Copy"
    brace = copy.mobjects[2]
    assert copy.mob(brace.params["mobject"]) is not None
