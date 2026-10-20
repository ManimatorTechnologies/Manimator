"""Manimator's fonts: the bundled files, the list the editor offers, and what the exported Python asks Manim for."""

import hashlib
import re
from pathlib import Path

from manimator import codegen
from manimator.model import ops
from manimator.model.project import Project
from manimator.plan import scene_plan
from manimator.server.catalog import FONTS
from manimator.server.mcp_preview import check

WEB = Path(__file__).resolve().parent.parent / "manimator" / "web"
FONTS_JS = (WEB / "js" / "engine" / "manim" / "fonts.js").read_text(encoding="utf-8")


def engine_families() -> dict[str, list[str]]:
    """FONT_FILES in the engine's fonts.js: family -> its files (folder/name)."""
    body = FONTS_JS.split("export const FONT_FILES = {", 1)[1].split("\n};", 1)[0]
    out = {}
    for m in re.finditer(r'^\s*"?([A-Za-z0-9 ]+?)"?: faceSet\("([a-z0-9-]+)", "(\w+)"', body, re.M):
        out[m[1]] = [f"{m[2]}/{m[3]}-{face}.ttf" for face in ("Regular", "Bold", "Italic", "BoldItalic")]
    for m in re.finditer(r'^\s*"([A-Za-z ]+)": \{ dir: "dejavu".*?regular: "([\w-]+\.ttf)",\s*bold: "([\w-]+\.ttf)"',
                         body, re.M | re.S):
        out[m[1]] = [f"dejavu/{m[2]}", f"dejavu/{m[3]}"]
    return out


def test_the_editor_offers_exactly_the_engines_fonts_and_every_file_is_there():
    families = engine_families()
    assert sorted(families) == sorted(FONTS)
    assert FONTS[0] == codegen.TEXT_FONT == "Crimson Pro"
    assert f'let defaultFamily = "{codegen.TEXT_FONT}";' in FONTS_JS
    for family, files in families.items():
        for f in files:
            assert (WEB / "fonts" / f).is_file(), f"{family}: {f}"


def test_each_font_folder_has_its_licence_and_checksums():
    for folder in sorted({f.split("/")[0] for files in engine_families().values() for f in files} | {"ui", "prose"}):
        d = WEB / "fonts" / folder
        assert (d / "OFL.txt").exists() or (d / "LICENSE").exists(), folder
        for line in (d / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
            digest, name = line.split("  ")
            assert hashlib.sha256((d / name).read_bytes()).hexdigest() == digest, f"{folder}/{name}"


def project_with(*items):
    project = Project.new()
    scene = project.scenes[0]
    for kind, params in items:
        mob = ops.create_mobject(scene, kind, 0, 0)
        mob.params.update(params)
    return project, scene


def test_python_asks_for_the_font_only_when_there_is_text():
    shapes, _ = project_with(("Circle", {}), ("MathTex", {}))
    assert "set_default" not in codegen.project_source(shapes)
    text, _ = project_with(("Paragraph", {}))
    src = codegen.project_source(text)
    assert 'Text.set_default(font="Crimson Pro")' in src and "MarkupText.set_default" not in src
    assert src.index("set_default") < src.index("class ")  # once, before the scenes
    markup, _ = project_with(("MarkupText", {}))
    src = codegen.project_source(markup)
    assert 'MarkupText.set_default(font="Crimson Pro")' in src and "\nText.set_default" not in src
    table, _ = project_with(("Table", {}))
    assert 'Text.set_default(font="Crimson Pro")' in codegen.project_source(table)


def test_line_spacing_is_written_for_paragraphs_and_text_of_several_lines():
    project, scene = project_with(("Text", {"text": "one line"}), ("Text", {"text": "two\nlines"}), ("Paragraph", {}),
                                  ("Paragraph", {"font": "Lato", "line_spacing": 1.2}))
    src = codegen.project_source(project)
    lines = [ln.strip() for ln in src.splitlines() if "= Text(" in ln or "= Paragraph(" in ln]
    assert "line_spacing" not in lines[0]
    assert lines[1].endswith("line_spacing=0.75)")
    assert lines[2].endswith("font_size=36, line_spacing=0.75)")
    assert lines[3].endswith('font="Lato", line_spacing=1.2)')
    calls = {o["type"] + str(i): o["call"]["kwargs"] for i, o in enumerate(scene_plan(scene, project)["objects"])}
    assert calls["Paragraph2"]["line_spacing"] == 0.75 and "line_spacing" not in calls["Text0"]


def test_previews_ask_more_of_text_than_of_formulas():
    project, scene = project_with(("Text", {"text": "label", "font_size": 30}), ("MathTex", {"font_size": 30}))
    problems, _ = check(scene, scene_plan(scene, project), None, [])
    assert len(problems) == 1 and "font_size 30" in problems[0] and "use 32 or more" in problems[0]


def test_the_interface_font_is_bundled_and_named_first():
    css = (WEB / "style.css").read_text(encoding="utf-8")
    assert '--font: "Inter Variable",' in css
    for url in re.findall(r'url\("(fonts/ui/[^"]+)"\)', css):
        assert (WEB / url).is_file(), url
    assert len(re.findall(r"url\(\"fonts/ui/", css)) == 6
