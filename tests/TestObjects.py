"""The newer object kinds: math expressions, point/table input, groups, files and 3D scenes."""

import ast

import pytest

from manimator import codegen
from manimator.model import ops
from manimator.model.project import Project
from manimator.plan import layout
from manimator.registry.exprs import ExprError, compile_expr
from manimator.registry.params import GRID, NUMBERS, POINTS, Param, parse_grid, parse_numbers, parse_points
from manimator.server.session import OpError, Session


def scene_id(session):
    return session.project.scenes[0].id


def add(session, type_, **kw):
    return session.apply("add_mobject", {"scene_id": scene_id(session), "type": type_, **kw})


def set_param(session, mob_id, name, value):
    return session.apply("set_param", {"scene_id": scene_id(session), "mob_id": mob_id, "name": name, "value": value})


# ---------------------------------------------------------------------- expressions


def test_expressions_become_numpy_code():
    assert compile_expr("sin(x)^2 + 2*pi*x", ("x",)) == "np.sin(x) ** 2 + 2 * np.pi * x"
    assert compile_expr("-y", ("x", "y"), {"y": "p[1]"}) == "-p[1]"
    assert compile_expr("sqrt(u**2 + v**2)", ("u", "v")) == "np.sqrt(u ** 2 + v ** 2)"


@pytest.mark.parametrize("bad", [
    '__import__("os").system("calc")', "x.real", "lambda: 1", "[x]", "x if x else 1", "open('f')", "9**9**9",
    "sin", "foo(x)", "x; y", "", "x" * 300, "1e12 * x", "'abc'", "True", "sin(x, x)",
    "(9**64)**64", "-(2**60 + 1)**60 * x",
])
def test_expressions_reject_anything_but_math(bad):
    with pytest.raises(ExprError):
        compile_expr(bad, ("x",))


def test_powers_of_powers_are_fine_when_a_variable_is_involved():
    assert compile_expr("(x**2)**3", ("x",)) == "(x ** 2) ** 3"
    assert compile_expr("(2**3)**x + 2**3 * x", ("x",)) == "(2 ** 3) ** x + 2 ** 3 * x"


def test_a_hand_edited_expression_never_reaches_the_code():
    project = Project.new()
    scene = project.scenes[0]
    graph = ops.create_mobject(scene, "FunctionGraph")
    graph.params["expr"] = '__import__("os").system("calc")'
    src = codegen.project_source(project)
    assert "__import__" not in src and "system" not in src
    codes, _ = codegen.scene_objects(scene)
    assert codes[0].error and "invalid value" in codes[0].error
    ast.parse(src)


# ---------------------------------------------------------------------- text input for lists and tables


def test_points_numbers_and_grid_parse_from_text():
    assert parse_points("1, 2\n(3 4)", Param("p", POINTS)) == [[1, 2], [3, 4]]
    assert parse_points("1, 2; 3, 4", Param("p", POINTS)) == [[1, 2], [3, 4]]  # ; separates points
    assert parse_numbers("1, 2.5  3", Param("n", NUMBERS)) == [1, 2.5, 3]
    # ragged rows are padded; | wins over commas so cells can contain commas
    assert parse_grid("a, b, c\nd", Param("g", GRID)) == [["a", "b", "c"], ["d", "", ""]]
    assert parse_grid("f(x,y) | 2", Param("g", GRID)) == [["f(x,y)", "2"]]
    assert parse_grid("1, 2.5\n3, 4", Param("g", GRID, numeric=True)) == [["1", "2.5"], ["3", "4"]]


@pytest.mark.parametrize("call", [
    lambda: parse_points("1", Param("p", POINTS)),
    lambda: parse_points("1,2", Param("p", POINTS, min_items=3)),
    lambda: parse_numbers("1, abc", Param("n", NUMBERS)),
    lambda: parse_grid("1, x", Param("g", GRID, numeric=True)),
    lambda: parse_grid("\n".join("1" for _ in range(30)), Param("g", GRID)),
])
def test_bad_list_input_is_refused_with_a_message(call):
    with pytest.raises(ValueError):
        call()


def test_editing_new_kinds_through_the_session():
    s = Session()
    poly = add(s, "Polygon")
    set_param(s, poly, "points", "-1, 0\n1, 0\n0, 2")
    assert s.project.scenes[0].mob(poly).params["points"] == [[-1, 0], [1, 0], [0, 2]]
    with pytest.raises(OpError):
        set_param(s, poly, "points", "0, 0\n1, 1")  # a polygon needs 3 corners
    graph = add(s, "FunctionGraph")
    set_param(s, graph, "expr", "x^2 - 1")
    with pytest.raises(OpError):
        set_param(s, graph, "expr", "exit()")
    assert s.project.scenes[0].mob(graph).params["expr"] == "x^2 - 1"  # the bad edit changed nothing
    image = add(s, "ImageMobject")
    set_param(s, image, "file", "C:/pics/cat.png")
    with pytest.raises(OpError):
        set_param(s, image, "file", "C:/pics/notes.txt")


def test_an_object_that_needs_a_file_says_so_until_it_has_one():
    project = Project.new()
    item = ops.create_mobject(project.scenes[0], "ImageMobject")
    codes, _ = codegen.scene_objects(project.scenes[0])
    assert codes[0].error and "choose an image file" in codes[0].error
    item.params["file"] = "C:/pics/cat.png"
    codes, _ = codegen.scene_objects(project.scenes[0])
    assert codes[0].error is None and codes[0].ctor.startswith("ImageMobject(")


# ---------------------------------------------------------------------- groups


def grouped_scene():
    project = Project.new()
    scene = project.scenes[0]
    a = ops.create_mobject(scene, "Circle", -2, 0)
    b = ops.create_mobject(scene, "Square", 2, 0)
    group = ops.create_mobject(scene, "VGroup", target_id=a.id)
    group.params["members"] = [a.id, b.id]
    return project, scene, a, b, group


def test_group_members_are_added_through_the_group():
    project, scene, a, b, group = grouped_scene()
    src = codegen.scene_source(scene, project)
    assert f"{group.name} = VGroup({a.name}, {b.name})" in src
    assert f"self.add({group.name})" in src  # not the members as well
    group.on_screen_at_start = False
    assert "self.add(" not in codegen.scene_source(scene, project)


def test_the_editor_draws_members_once_and_fades_them_with_a_hidden_group():
    _project, scene, a, b, group = grouped_scene()
    drawn = layout(scene)
    assert group.id not in drawn["order"] and {a.id, b.id} <= set(drawn["order"])
    assert not drawn["hidden"]
    group.on_screen_at_start = False
    assert set(layout(scene)["hidden"]) == {a.id, b.id, group.id}


def test_deleting_a_member_only_shrinks_the_group():
    project, scene, a, b, group = grouped_scene()
    ops.delete_mobjects(scene, {a.id})
    assert scene.mob(group.id) is not None and group.params["members"] == [b.id]


def test_a_group_cannot_contain_something_that_depends_on_it():
    s = Session()
    a = add(s, "Circle")
    group = add(s, "VGroup", target_id=a)
    brace = add(s, "Brace", target_id=group)  # built around the group
    with pytest.raises(OpError):
        set_param(s, group, "members", [a, brace])


def test_adding_a_group_with_a_selection_starts_it_with_that_object():
    s = Session()
    a = add(s, "Circle")
    group = add(s, "VGroup", target_id=a)
    assert s.project.scenes[0].mob(group).params["members"] == [a]


# ---------------------------------------------------------------------- 3D scenes


def test_adding_a_3d_object_switches_the_scene_and_the_code_follows():
    s = Session()
    assert s.project.scenes[0].kind == "Scene"
    sphere = add(s, "Sphere", x=1, y=2)
    scene = s.project.scenes[0]
    assert scene.kind == "ThreeDScene"
    s.apply("set_placement", {"scene_id": scene.id, "mob_id": sphere, "name": "z", "value": 1.5})
    s.apply("set_scene_option", {"scene_id": scene.id, "name": "phi", "value": 60})
    src = codegen.project_source(s.project)
    assert "class Scene1(ThreeDScene):" in src
    assert "self.set_camera_orientation(phi=60 * DEGREES, theta=-50 * DEGREES)" in src
    assert "sphere.move_to([1, 2, 1.5])" in src
    ast.parse(src)


def test_a_2d_scene_stays_a_plain_scene():
    project = Project.new()
    ops.create_mobject(project.scenes[0], "Circle")
    src = codegen.project_source(project)
    assert "(Scene):" in src and "ThreeDScene" not in src and "set_camera_orientation" not in src


def test_camera_settings_are_limited():
    s = Session()
    with pytest.raises(OpError):
        s.apply("set_scene_option", {"scene_id": scene_id(s), "name": "color", "value": 1})
    with pytest.raises(OpError):  # a plain Scene has no camera angles
        s.apply("set_scene_option", {"scene_id": scene_id(s), "name": "phi", "value": 60})
    s.apply("set_scene_kind", {"scene_id": scene_id(s), "kind": "ThreeDScene"})
    s.apply("set_scene_option", {"scene_id": scene_id(s), "name": "phi", "value": 999})
    assert s.project.scenes[0].options["phi"] == 180


def test_moving_a_3d_line_keeps_its_height():
    project = Project.new()
    line = ops.create_mobject(project.scenes[0], "Line3D")
    ops.move_mobject(line, 1, 2)
    assert line.params["start"] == [-0.5, 1.0, -1.0] and line.params["end"] == [2.5, 3.0, 1.0]


# ---------------------------------------------------------------------- older files


def test_project_files_from_before_3d_still_load():
    old = {
        "version": 1,
        "scenes": [{"id": "s1", "name": "Scene1", "steps": [], "mobjects": [{
            "id": "m1", "type": "Circle", "name": "circle", "params": {"radius": 1.0}, "style": {},
            "position": [0.0, 0.0], "rotation": 0.0, "scale": 1.0, "z_index": 0,
            "on_screen_at_start": True, "methods": []}]}],
        "settings": {"background": "#000000", "quality": "m"},
    }
    project = Project.from_dict(old)
    scene = project.scenes[0]
    assert scene.kind == "Scene" and scene.options == {} and scene.mobjects[0].z == 0
    assert Project.from_dict(project.to_dict()).to_dict() == project.to_dict()


def test_version_1_3d_scenes_become_three_d_scenes():
    old = {"version": 1, "scenes": [{"id": "s1", "name": "Scene1", "steps": [], "mobjects": [],
                                     "three_d": True, "phi": 60.0, "theta": -30.0}]}
    scene = Project.from_dict(old).scenes[0]
    assert scene.kind == "ThreeDScene" and scene.options == {"phi": 60.0, "theta": -30.0}
