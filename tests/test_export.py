"""The "Download Python" zip: scene.py with the pictures and fonts the project uses, ready for Manim CE."""

import io
import subprocess
import sys
import zipfile

import pytest
from fastapi.testclient import TestClient

from manimator import export
from manimator.server.api import create_app
from manimator.server.session import Session
from manimator.server.web import WebConfig
from tests.conftest import CACHE, HAVE_MANIM
from tests.test_web import HEADERS, png


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {name: z.read(name) for name in z.namelist()}


def project_with(*types_and_params):
    s = Session()
    sid = s.project.scenes[0].id
    for kind, params in types_and_params:
        mob = s.apply("add_mobject", {"scene_id": sid, "type": kind})
        for name, value in params.items():
            s.apply("set_param", {"scene_id": sid, "mob_id": mob, "name": name, "value": value})
    return s.project


def test_text_brings_its_fonts_and_scene_py_loads_them():
    project = project_with(("Text", {"text": "Hello"}), ("Paragraph", {"font": "Inter"}))
    name, data = export.export_zip(project, "My talk: part 1", lambda _n: None)
    files = unzip(data)
    assert name == "My talk part 1.zip" and all(f.startswith("My talk part 1/") for f in files)
    fonts = sorted(f.split("/", 1)[1] for f in files if "/fonts/" in f)
    # the default family and the one named, each with the family for characters they lack (one level, as the
    # engine loads them), every face, and each folder's license
    assert fonts == ["fonts/crimson-pro/CrimsonPro-Bold.ttf", "fonts/crimson-pro/CrimsonPro-BoldItalic.ttf",
                     "fonts/crimson-pro/CrimsonPro-Italic.ttf", "fonts/crimson-pro/CrimsonPro-Regular.ttf",
                     "fonts/crimson-pro/OFL.txt", "fonts/dejavu/DejaVuSans-Bold.ttf", "fonts/dejavu/DejaVuSans.ttf",
                     "fonts/dejavu/DejaVuSerif-Bold.ttf", "fonts/dejavu/DejaVuSerif.ttf", "fonts/dejavu/LICENSE",
                     "fonts/inter/Inter-Bold.ttf", "fonts/inter/Inter-BoldItalic.ttf", "fonts/inter/Inter-Italic.ttf",
                     "fonts/inter/Inter-Regular.ttf", "fonts/inter/OFL.txt"]
    source = files["My talk part 1/scene.py"].decode()
    assert "manimpango.register_font(str(font_file))" in source and 'Text.set_default(font="Crimson Pro")' in source
    assert "Without it installed" not in source  # nothing to install
    readme = files["My talk part 1/README.txt"].decode()
    assert "manim -pqm scene.py Scene1" in readme and "Crimson Pro, DejaVu Serif, Inter, DejaVu Sans" in readme
    assert files["My talk part 1/requirements.txt"].decode().startswith("manim")


def test_without_text_there_are_no_fonts():
    name, data = export.export_zip(project_with(("Circle", {})), "", lambda _n: None)
    files = unzip(data)
    assert name == "project.zip" and not any("/fonts/" in f for f in files)
    source = files["project/scene.py"].decode()
    assert "manimpango" not in source and "from manim import *" in source and "fonts/" not in files["project/README.txt"].decode()


def test_every_font_in_the_editor_list_ships_whole():
    from manimator.server.catalog import FONTS

    for family in FONTS:
        assert export.family_of(family) == family
        files = export.font_files(family)
        assert any(f.stem.endswith("Regular") or "-" not in f.stem for f in files), family  # a regular face
    assert export.family_of("") == "Crimson Pro" and export.family_of("monospace") == "DejaVu Sans Mono"
    assert export.family_of("Comic Sans") == "DejaVu Sans"  # as the engine draws an unknown name


def test_the_download_has_the_pictures_the_scenes_use_and_no_others(tmp_path):
    c = TestClient(create_app(web=WebConfig(data_dir=tmp_path)), base_url="http://localhost")
    send = {**HEADERS, "Content-Type": "application/octet-stream"}
    used = c.post("/api/upload?name=dot.png", content=png(), headers=send).json()["name"]
    c.post("/api/upload?name=other.png", content=png((30, 30)), headers=send)
    sid = c.get("/api/state").json()["project"]["scenes"][0]["id"]
    mob = c.post("/api/op", json={"op": "add_mobject", "args": {"scene_id": sid, "type": "ImageMobject"}},
                 headers=HEADERS).json()["result"]
    chosen = c.post("/api/op", json={"op": "set_param", "args": {"scene_id": sid, "mob_id": mob, "name": "file",
                                                                  "value": used}}, headers=HEADERS)
    assert chosen.status_code == 200, chosen.text
    res = c.get("/api/file/export.zip")
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    assert res.headers["content-disposition"] == 'attachment; filename="Untitled project.zip"'
    files = unzip(res.content)
    assert sorted(f for f in files if "/assets/" in f) == [f"Untitled project/assets/{used}"]
    assert files[f"Untitled project/assets/{used}"] == png()
    assert f'"assets/{used}"' in files["Untitled project/scene.py"].decode()


@pytest.mark.skipif(not HAVE_MANIM, reason="needs Manim")
def test_manim_uses_the_bundled_font():
    """Run scene.py the way Manim does (in a fresh process, whose fonts we don't touch): Crimson Pro, which this
    computer doesn't have installed, becomes available, and the scene builds."""
    project = project_with(("Text", {"text": "Hello"}))
    _name, data = export.export_zip(project, "Font check", lambda _n: None)
    folder = CACHE / "export-test"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(folder)
    script = ("import runpy, manimpango, sys; ns = runpy.run_path(sys.argv[1]); "
              "print('Crimson Pro' in manimpango.list_fonts()); "
              "t = ns['Text']('Hello'); print(t.font)")
    out = subprocess.run([sys.executable, "-c", script, str(folder / "Font check" / "scene.py")],
                         capture_output=True, text=True, timeout=120, cwd=folder / "Font check")
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.split() [-3:] == ["True", "Crimson", "Pro"], out.stdout
