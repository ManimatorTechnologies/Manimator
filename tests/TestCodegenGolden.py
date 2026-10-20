"""The generated Python, byte for byte, for projects that use every object, method, animation, scene kind,
setting and scene action (tests/FixtureProjects.py).

The code generator builds call trees that both print this Python and become the browser's scene plan, so any
change to the printed code shows up here. After an intended change, rewrite the files with
MANIMATOR_UPDATE_GOLDEN=1 and review the diff.
"""

import os
from pathlib import Path

import pytest

from manimator import codegen
from tests.FixtureProjects import file_name, golden_projects

GOLDEN = Path(__file__).resolve().parent / "golden" / "codegen"
PROJECTS = golden_projects()
UPDATE = os.environ.get("MANIMATOR_UPDATE_GOLDEN") == "1"


def _check(name: str, source: str) -> None:
    path = GOLDEN / f"{file_name(name)}.py"
    if UPDATE:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8", newline="\n")
        return
    assert path.exists(), f"no golden file for {name}; run with MANIMATOR_UPDATE_GOLDEN=1"
    expected = path.read_text(encoding="utf-8")
    assert source == expected, f"{name}.py differs from the golden file"


@pytest.mark.parametrize("name", sorted(PROJECTS))
def test_project_source_is_unchanged(name):
    with codegen.asset_root("assets"):
        _check(name, codegen.project_source(PROJECTS[name], "scene.py"))


def test_source_without_an_asset_folder_is_unchanged():
    _check("objects_no_asset_root", codegen.project_source(PROJECTS["objects"], "scene.py"))


def test_every_golden_file_has_a_project():
    names = {p.stem for p in GOLDEN.glob("*.py")}
    assert names == {file_name(n) for n in [*PROJECTS, "objects_no_asset_root"]}
