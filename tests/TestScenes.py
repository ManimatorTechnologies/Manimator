"""Scene kinds: MovingCameraScene, ZoomedScene, VectorScene, LinearTransformationScene, ThreeDScene and
SpecialThreeDScene, with their settings and scene actions.

The generated scenes are really run by Manim (without writing a video), so a scene action that Manim can't
play, or a Manim quirk the generated code doesn't handle, fails here.
"""

import ast

import pytest

try:
    import numpy as np
except ImportError:  # the server's own packages: the tests using numpy need Manim and skip
    np = None

from manimator import codegen
from manimator.model import ops
from manimator.model.project import Project
from manimator.registry import ANIMATIONS
from manimator.registry.animations import ANIMATE
from manimator.registry.scenes import SCENE_KINDS
from manimator.server.session import OpError, Session, revalidate

KINDS = list(SCENE_KINDS)
ACTIONS = [k for k, a in ANIMATIONS.items() if a.scene_action]


def run_scene(project: Project, scene, manim_ns) -> object:
    """Run the generated class with Manim (all animations, no files) and return the finished scene."""
    from manim import tempconfig

    ns = dict(manim_ns)
    exec(codegen.project_source(project), ns)
    with tempconfig({"dry_run": True, "pixel_width": 320, "pixel_height": 180, "frame_rate": 5}):
        s = ns[scene.name]()
        s.render()
    return s


def scene_of(kind: str) -> tuple[Project, object]:
    project = Project.new()
    scene = project.scenes[0]
    ops.set_scene_kind(scene, kind)
    return project, scene


# ---------------------------------------------------------------------- every action in every kind


@pytest.mark.parametrize("kind", KINDS)
def test_every_action_plays_in_manim(kind, manim_ns):
    """All the scene's actions, one per step, after some objects: the generated code runs to the end."""
    project, scene = scene_of(kind)
    circle = ops.create_mobject(scene, "Circle", 2, 1)
    vector = ops.create_mobject(scene, "Vector", 0, 0)
    label = ops.create_mobject(scene, "MathTex", -3, 2)
    ops.add_play_step(scene, "Write", label.id)
    for key in ACTIONS:
        if kind in ANIMATIONS[key].scene_kinds:
            ops.add_play_step(scene, key, circle.id)
            if not ANIMATIONS[key].fixed_time:  # an object animation alongside
                ops.add_animation_to_step(scene, len(scene.steps) - 1, "Indicate", vector.id)
    src = codegen.project_source(project)
    ast.parse(src)
    assert f"class Scene1({kind}):" in src
    s = run_scene(project, scene, manim_ns)
    expected = sum(st.run_time if st.kind == "play" else st.duration for st in scene.steps)
    assert s.renderer.time == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize("kind", KINDS)
def test_every_setting_reaches_manim(kind, manim_ns):
    """Each kind with all its settings changed from their defaults still runs."""
    project, scene = scene_of(kind)
    for p in SCENE_KINDS[kind].options:
        scene.options[p.name] = _changed(p)
    ops.create_mobject(scene, "Square", 1, 1)
    project.settings.background = "#202040"
    src = codegen.scene_source(scene, project)
    for p in SCENE_KINDS[kind].options:
        if p.name in ("camera_center", "camera_zoom", "phi", "theta", "gamma", "zoom", "background",
                      "basis_vectors", "basis_vector_labels", "unit_square", "zoom_at_start", "lens_color",
                      "display_color", "unit_square_color"):
            continue  # these become setup lines rather than constructor arguments
        if SCENE_KINDS[kind].active(p.name, scene.options):
            assert f"{p.name}=" in src, p.name
    run_scene(project, scene, manim_ns)


def _changed(p):
    if p.kind == "bool":
        return not p.default
    if p.kind == "float":
        return round(min(p.max, p.default * 1.5 + 0.5), 2)
    if p.kind == "point":
        return [1.0, -0.5]
    if p.kind == "color":
        return "#FC6255" if p.default != "#FC6255" else "#58C4DD"
    if p.kind == "direction":
        return "DL"
    if p.kind == "enum":
        return p.choices[1][0]
    raise AssertionError(p.kind)


def test_plain_scene_code_is_unchanged():
    project = Project.new()
    ops.create_mobject(project.scenes[0], "Circle")
    src = codegen.project_source(project)
    assert "class Scene1(Scene):\n    def construct(self):\n        # Objects" in src
    assert "__init__" not in src


# ---------------------------------------------------------------------- MovingCameraScene / ZoomedScene


def test_moving_camera_starts_where_it_is_set_and_moves(manim_ns):
    project, scene = scene_of("MovingCameraScene")
    scene.options.update(camera_center=[1.0, 0.5], camera_zoom=2.0)
    dot = ops.create_mobject(scene, "Dot", -3, 2)
    ops.add_play_step(scene, "camera_focus", dot.id)
    ops.add_play_step(scene, "camera_restore", None)
    src = codegen.scene_source(scene, project)
    assert "self.camera.frame.move_to([1, 0.5, 0])" in src
    assert "self.camera.frame.set(width=config.frame_width / 2)" in src
    assert "self.camera.frame.save_state()" in src
    assert "self.camera.frame.animate.move_to(dot).set(width=config.frame_width / 2)" in src
    s = run_scene(project, scene, manim_ns)
    np.testing.assert_allclose(s.camera.frame.get_center()[:2], [1, 0.5], atol=1e-6)  # restored
    assert s.camera.frame.width == pytest.approx(128 / 9 / 2)


def test_zoom_on_off_and_lens_while_off(manim_ns):
    project, scene = scene_of("ZoomedScene")
    scene.options.update(zoom_factor=0.3, zoomed_display_corner="DL", lens_color="#9A72AC")
    dot = ops.create_mobject(scene, "Dot", 1, 1)
    ops.add_play_step(scene, "lens_to_object", dot.id)  # zoom still off: moved without being shown
    ops.add_play_step(scene, "zoom_on", None)
    ops.add_play_step(scene, "zoom_off", None)
    ops.add_play_step(scene, "zoom_on", None)  # back on: no second activate_zooming()
    src = codegen.scene_source(scene, project)
    assert "super().__init__(zoom_factor=0.3, zoomed_display_corner=DL, **kwargs)" in src
    assert "        self.zoomed_camera.frame.move_to(dot)\n        self.wait(1)" in src
    assert src.count("self.activate_zooming()") == 1
    assert "self.add_foreground_mobjects(self.zoomed_camera.frame, self.zoomed_display)" in src
    s = run_scene(project, scene, manim_ns)
    assert s.zoomed_display in s.mobjects and s.zoomed_camera.frame in s.mobjects
    np.testing.assert_allclose(s.zoomed_camera.frame.get_center()[:2], [1, 1], atol=1e-6)


# ---------------------------------------------------------------------- LinearTransformationScene


def test_linear_transformation_moves_the_right_objects(manim_ns):
    """Objects join the grid's lists when they come on screen and leave them when they go, so a later
    transformation neither leaves an object behind nor brings a removed one back."""
    project, scene = scene_of("LinearTransformationScene")
    scene.options.update(leave_ghost_vectors=True, show_coordinates=True)
    shape = ops.create_mobject(scene, "Square", 1, 1)
    vector = ops.create_mobject(scene, "Vector", 3, 3)  # drawn from the origin all the same
    late = ops.create_mobject(scene, "Dot", 1, 0)
    gone = ops.create_mobject(scene, "Circle", -1, -1)
    title = ops.create_mobject(scene, "Text", 0, 3)
    never = ops.create_mobject(scene, "Triangle", -2, 2)
    never.on_screen_at_start = False
    late.on_screen_at_start = False
    stretch = [["2", "0"], ["0", "2"]]
    ops.add_play_step(scene, "apply_matrix", None)
    scene.steps[-1].animations[0].params["matrix"] = stretch
    ops.add_animation_to_step(scene, 0, "Indicate", title.id)
    ops.add_play_step(scene, "FadeIn", late.id)
    ops.add_play_step(scene, "FadeOut", gone.id)
    ops.add_play_step(scene, "apply_matrix", None)
    scene.steps[-1].animations[0].params["matrix"] = stretch
    src = codegen.scene_source(scene, project)
    assert "self.add_transformable_mobject(square)\n        self.add_vector(vector)" in src
    assert "self.add_foreground_mobject(text)" in src
    assert "self.transformable_mobjects.remove(circle)" in src
    assert src.count("self.moving_mobjects = []") == 2
    assert "vector.move_to" not in src
    s = run_scene(project, scene, manim_ns)
    family = s.get_mobject_family_members()
    square = next(m for m in s.transformable_mobjects if type(m).__name__ == "Square")
    np.testing.assert_allclose(square.get_center()[:2], [4, 4], atol=1e-6)  # stretched x2, twice
    vec = next(v for v in s.moving_vectors if type(v).__name__ == "Vector" and v not in s.basis_vectors)
    assert vec.get_start()[:2] == pytest.approx([0, 0], abs=1e-6)
    assert not any(type(m).__name__ == "Circle" for m in family)  # faded out, and not brought back
    assert not any(type(m).__name__ == "Triangle" for m in family)  # never shown
    assert any(type(m).__name__ == "Text" for m in s.foreground_mobjects)


def test_singular_matrices_cannot_be_inverted():
    s = Session()
    sid = s.project.scenes[0].id
    s.apply("set_scene_kind", {"scene_id": sid, "kind": "LinearTransformationScene"})
    s.apply("add_play_step", {"scene_id": sid, "anim": "apply_inverse", "target_id": None})
    with pytest.raises(OpError, match="no inverse"):
        s.apply("set_animation_param", {"scene_id": sid, "step": 0, "index": 0, "name": "matrix",
                                        "value": "1, 2\n2, 4"})
    with pytest.raises(OpError, match="2 rows of 2"):
        s.apply("set_animation_param", {"scene_id": sid, "step": 0, "index": 0, "name": "matrix",
                                        "value": "1, 2, 3\n2, 4, 5"})


# ---------------------------------------------------------------------- 3D


def test_fixed_in_frame_objects_stay_on_screen(manim_ns):
    project, scene = scene_of("ThreeDScene")
    title = ops.create_mobject(scene, "Text", -4, 3)
    later = ops.create_mobject(scene, "Text", 4, 3)
    facing = ops.create_mobject(scene, "Text", 2, 0)
    title.fixed = later.fixed = "in_frame"
    facing.fixed = "orientation"
    later.on_screen_at_start = False
    ops.add_play_step(scene, "Write", later.id)
    ops.add_play_step(scene, "camera_move3d", None)
    ops.add_play_step(scene, "camera_spin", None)
    scene.steps[-1].animations[0].params["about"] = "gamma"
    ops.add_play_step(scene, "camera_move3d", None)
    src = codegen.scene_source(scene, project)
    assert "self.add_fixed_in_frame_mobjects(text)\n        self.add_fixed_orientation_mobjects(text_3)" in src
    assert "self.camera.add_fixed_in_frame_mobjects(text_2)" in src
    assert 'self.begin_ambient_camera_rotation(rate=20 * DEGREES, about="gamma")' in src
    assert src.count("gamma=") == 1  # only once the spin has rolled the camera
    s = run_scene(project, scene, manim_ns)
    frame_fixed = s.camera.fixed_in_frame_mobjects
    texts = [m for m in s.mobjects if type(m).__name__ == "Text"]
    assert len(texts) == 3 and sum(t in frame_fixed for t in texts) == 2


def test_special_three_d_scene_works_around_manims_constructor(manim_ns):
    project, scene = scene_of("SpecialThreeDScene")
    ops.create_mobject(scene, "Sphere")
    src = codegen.scene_source(scene, project)
    assert "self.set_camera_to_default_position()" in src
    s = run_scene(project, scene, manim_ns)
    assert s.camera.get_phi() == pytest.approx(70 * np.pi / 180)
    assert s.camera.get_theta() == pytest.approx(-110 * np.pi / 180)
    scene.options["theta"] = -90.0
    assert "set_camera_orientation(phi=70 * DEGREES, theta=-90 * DEGREES)" in codegen.scene_source(scene, project)


# ---------------------------------------------------------------------- what is on screen when


EFFECT_CASES = [k for k, a in ANIMATIONS.items() if k != ANIMATE and not a.scene_action]


@pytest.mark.parametrize("key", EFFECT_CASES)
@pytest.mark.parametrize("shown", [False, True])
def test_screen_states_match_manim(key, shown, manim_ns):
    """ops.screen_states predicts which objects Manim has on screen after each animation."""
    spec = ANIMATIONS[key]
    project = Project.new()
    scene = project.scenes[0]
    kind = spec.only[0] if spec.only else "Circle"
    a = ops.create_mobject(scene, kind, -2, 0)
    b = ops.create_mobject(scene, "MathTex" if kind in ("MathTex", "Tex") else "Square", 2, 0)
    a.z_index, b.z_index = 1, 2  # to tell them apart afterwards (a Transform makes one look like the other)
    ops.add_play_step(scene, key, a.id)
    a.on_screen_at_start = shown
    b.on_screen_at_start = False
    predicted = ops.screen_states(scene)[-1]
    s = run_scene(project, scene, manim_ns)
    on = {item.id for item in (a, b) if any(m.z_index == item.z_index for m in s.mobjects)}
    assert on == predicted


# ---------------------------------------------------------------------- editing rules


def test_changing_the_kind_drops_actions_it_cannot_do():
    s = Session()
    sid = s.project.scenes[0].id
    s.apply("add_mobject", {"scene_id": sid, "type": "Circle"})
    s.apply("set_scene_kind", {"scene_id": sid, "kind": "ZoomedScene"})
    s.apply("add_play_step", {"scene_id": sid, "anim": "camera_zoom", "target_id": None})
    s.apply("add_play_step", {"scene_id": sid, "anim": "zoom_on", "target_id": None})
    assert s.apply("set_scene_kind", {"scene_id": sid, "kind": "MovingCameraScene"}) == ["Turn on zoom"]
    assert [a.anim for st in s.project.scenes[0].steps for a in st.animations] == ["camera_zoom"]
    s.apply("set_scene_kind", {"scene_id": sid, "kind": "Scene"})
    assert s.project.scenes[0].steps == []
    with pytest.raises(OpError, match="needs a MovingCameraScene or ZoomedScene"):
        s.apply("add_play_step", {"scene_id": sid, "anim": "camera_zoom", "target_id": None})


def test_one_camera_move_per_step_and_demos_alone():
    s = Session()
    sid = s.project.scenes[0].id
    s.apply("set_scene_kind", {"scene_id": sid, "kind": "MovingCameraScene"})
    s.apply("add_mobject", {"scene_id": sid, "type": "Circle"})
    s.apply("add_play_step", {"scene_id": sid, "anim": "camera_zoom", "target_id": None})
    with pytest.raises(OpError, match="can't play in the same step"):
        s.apply("add_animation_to_step", {"scene_id": sid, "step": 0, "anim": "camera_pan", "target_id": None})
    s.apply("add_play_step", {"scene_id": sid, "anim": "camera_pan", "target_id": None})
    with pytest.raises(OpError):
        s.apply("merge_steps", {"scene_id": sid, "step": 1})
    s.apply("set_scene_kind", {"scene_id": sid, "kind": "VectorScene"})
    s.apply("add_play_step", {"scene_id": sid, "anim": "vector_to_coords", "target_id": None})
    step = s.project.scenes[0].steps[-1]
    assert step.run_time == 6
    with pytest.raises(OpError, match="always lasts 6"):
        s.apply("set_step", {"scene_id": sid, "step": 0, "name": "run_time", "value": 2})
    circle = s.project.scenes[0].mobjects[0].id
    with pytest.raises(OpError, match="step to itself"):
        s.apply("add_animation_to_step", {"scene_id": sid, "step": 0, "anim": "Indicate", "target_id": circle})


def test_scene_roles_are_checked():
    s = Session()
    sid = s.project.scenes[0].id
    circle = s.apply("add_mobject", {"scene_id": sid, "type": "Circle"})
    with pytest.raises(OpError, match="Only vectors"):
        s.apply("set_scene_role", {"scene_id": sid, "mob_id": circle, "name": "transform_role", "value": "vector"})
    with pytest.raises(OpError):
        s.apply("set_scene_role", {"scene_id": sid, "mob_id": circle, "name": "fixed", "value": "sideways"})
    s.apply("set_scene_role", {"scene_id": sid, "mob_id": circle, "name": "fixed", "value": "in_frame"})
    assert s.project.scenes[0].mobjects[0].fixed == "in_frame"


def test_deleting_an_object_keeps_zoom_to_fit_on_the_others():
    project, scene = scene_of("MovingCameraScene")
    a = ops.create_mobject(scene, "Circle")
    b = ops.create_mobject(scene, "Square")
    ops.add_play_step(scene, "camera_fit", a.id)
    scene.steps[0].animations[0].params["objects"] = [a.id, b.id]
    ops.add_play_step(scene, "FadeIn", b.id, index=0)
    ops.delete_mobjects(scene, {a.id})
    assert scene.steps[-1].animations[0].params["objects"] == [b.id]
    assert scene.steps[0].animations[0].params["shift"] is None  # other animations keep their settings
    ops.delete_mobjects(scene, {b.id})
    assert scene.steps == []


def test_hand_edited_scene_settings_are_cleaned():
    data = Project.new().to_dict()
    data["scenes"][0].update(kind="ZoomedScene", options={"zoom_factor": "__import__('os')", "nope": 1,
                                                          "zoomed_display_corner": "exit()"})
    project = Project.from_dict(data)
    notes = ops.sanitize_project(project) + revalidate(project)
    assert project.scenes[0].options == {"zoom_factor": 0.15, "zoomed_display_corner": "UR"}
    assert notes
    unknown = Project.from_dict({**data, "scenes": [{**data["scenes"][0], "kind": "HackScene"}]})
    assert ops.sanitize_project(unknown) and unknown.scenes[0].kind == "Scene"


def test_codegen_ignores_hostile_settings():
    project, scene = scene_of("ZoomedScene")
    scene.options.update(zoom_factor="1); import os; (", zoomed_display_corner="__import__('os')",
                         lens_color="#FFF')\nimport os#")
    tree = ast.parse(codegen.project_source(project))
    identifiers = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert "os" not in identifiers and "__import__" not in identifiers


def test_files_round_trip_with_kinds_and_roles(tmp_path):
    project, scene = scene_of("LinearTransformationScene")
    scene.options["unit_square"] = True
    v = ops.create_mobject(scene, "Vector")
    v.transform_role = "foreground"
    ops.add_play_step(scene, "apply_matrix", None)
    path = tmp_path / "lin.manimator"
    project.save(path)
    assert Project.load(path).to_dict() == project.to_dict()
