"""The scene format the User MCP reads saved projects in (its editing tools are tested with accounts): a saved
scene written back as JSON builds the same scene again."""

import copy
import json

import pytest

from manimator.codegen import scene_source
from manimator.server.mcp_scene import Rules, SceneSpecError, build_project, scene_spec
from tests.fixture_projects import golden_projects


# ---------------------------------------------------------------------- the format, both ways


def test_every_fixture_scene_comes_back_the_same():
    rules = Rules(max_objects=1000, max_steps=1000, assets=lambda name: name)
    for key, project in golden_projects().items():
        if key == "hostile":  # values no editor could make: refused, as they should be
            continue
        for s in project.scenes:
            built = build_project(json.loads(json.dumps(scene_spec(s))), rules)
            built.settings = copy.deepcopy(project.settings)
            assert scene_source(built.scenes[0], built, s.name) == scene_source(s, project, s.name), f"{key}/{s.name}"


def test_values_no_editor_could_make_are_refused():
    hostile = golden_projects()["hostile"]
    with pytest.raises(SceneSpecError):
        build_project(scene_spec(hostile.scenes[0]), Rules(assets=lambda n: n))


