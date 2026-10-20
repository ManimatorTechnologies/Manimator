"""The data frozen from Manim (tools/freeze_manim.py) is still what Manim says, and the server side that builds
code and scene plans runs without Manim installed."""

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Imports the modules with `manim` and `manimpango` made unimportable, then builds code, a plan and the catalog.
_WITHOUT_MANIM = r"""
import sys
class Block:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in ("manim", "manimpango"):
            raise ImportError(f"{name} is blocked")
sys.meta_path.insert(0, Block())
from manimator import codegen
from manimator.model import ops
from manimator.model.project import Project
from manimator.plan import scene_plan
from manimator.server.catalog import catalog
project = Project.new()
scene = project.scenes[0]
c = ops.create_mobject(scene, "Circle")
ops.add_play_step(scene, "Create", c.id)
assert "Circle(" in codegen.project_source(project)
assert scene_plan(scene, project)["objects"]
assert catalog()["palette"]["hex"]["BLUE"] == "#58C4DD"
assert ops.sanitize_identifier("Circle") == "Circle_"
print("ok")
"""


def test_code_and_plans_need_no_manim():
    out = subprocess.run([sys.executable, "-c", _WITHOUT_MANIM], cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip() == "ok"


def test_frozen_data_matches_manim():
    pytest.importorskip("manim")
    sys.path.insert(0, str(ROOT / "tools"))
    import freeze_manim

    for path, text in freeze_manim.files().items():
        assert path.read_text(encoding="utf-8") == text, f"{path.name} is stale: run tools/freeze_manim.py"
