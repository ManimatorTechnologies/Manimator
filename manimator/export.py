"""The "Download Python" zip: a folder that renders with Manim Community Edition as it is.

    <Project>/
      scene.py           every scene (manim -pqm scene.py Scene1)
      assets/            the uploaded pictures and SVG files the scenes show
      fonts/<family>/    the fonts the text uses, with their licenses (scene.py loads them: nothing to install)
      customizations/    the custom objects and animations it uses (code packages, server/kits.py)
      requirements.txt   the Manim version Manimator matches
      README.txt         how to render it

Only what the project uses goes in. Fonts are chosen the way the browser engine chooses them
(web/js/engine/manim/fonts.js: FONT_FILES, familyOf, ensureFonts): the default family for text, families named by
font= arguments, t2f and markup, each with the family that draws the characters it lacks.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from typing import Callable

from . import codegen
from .model.ops import kit_spec, kit_types_in
from .model.project import Project
from .plan import project_plan
from .registry import MOBJECTS
from .registry.params import FILE

FONTS_DIR = Path(__file__).resolve().parent / "web" / "fonts"
MANIM_REQUIREMENT = "manim~=0.21.0"  # the Manim the browser engine is a port of (docs/BrowserEngine.md)

# family -> (folder in web/fonts, file name prefix, family for the characters it lacks), as FONT_FILES in fonts.js
FONT_FAMILIES = {
    "Crimson Pro": ("crimson-pro", "CrimsonPro", "DejaVu Serif"),
    "STIX Two Text": ("stix-two-text", "STIXTwoText", "DejaVu Serif"),
    "Tinos": ("tinos", "Tinos", "DejaVu Serif"),
    "CMU Serif": ("cmu-serif", "CMUSerif", "DejaVu Serif"),
    "Source Serif 4": ("source-serif-4", "SourceSerif4", "DejaVu Serif"),
    "Inter": ("inter", "Inter", "DejaVu Sans"),
    "Geist": ("geist", "Geist", "DejaVu Sans"),
    "Source Sans 3": ("source-sans-3", "SourceSans3", "DejaVu Sans"),
    "IBM Plex Sans": ("ibm-plex-sans", "IBMPlexSans", "DejaVu Sans"),
    "Lato": ("lato", "Lato", "DejaVu Sans"),
    "DejaVu Sans": ("dejavu", "DejaVuSans", None),
    "DejaVu Sans Mono": ("dejavu", "DejaVuSansMono", "DejaVu Sans"),
    "DejaVu Serif": ("dejavu", "DejaVuSerif", "DejaVu Sans"),
}
GENERIC = {"sans": "DejaVu Sans", "sans-serif": "DejaVu Sans", "serif": "DejaVu Serif", "monospace": "DejaVu Sans Mono",
           "mono": "DejaVu Sans Mono"}
_FACES = ("-Regular", "", "-Bold", "-Italic", "-BoldItalic")  # DejaVu's regular faces have no "-Regular"
_LICENSES = ("OFL.txt", "LICENSE")
_MARKUP_FONT = re.compile(r"""\b(?:font|face|font_family|font_desc)\s*=\s*(["'])(.*?)\1""")


def family_of(name) -> str:
    """The bundled family a font name gets (as the engine's familyOf): unknown names get DejaVu Sans."""
    n = str(name or "").split(",")[0].strip().lower()
    if not n:
        return codegen.TEXT_FONT
    if n in GENERIC:
        return GENERIC[n]
    return next((f for f in FONT_FAMILIES if f.lower() == n), "DejaVu Sans")


def _named_fonts(value, key=None, out=None) -> set[str]:
    """Font names anywhere in a plan: font= arguments, t2f values, and markup's font attributes."""
    out = set() if out is None else out
    if isinstance(value, str):
        if key == "font":
            out.add(value)
        out.update(m.group(2) for m in _MARKUP_FONT.finditer(value))
    elif isinstance(value, list):
        for v in value:
            _named_fonts(v, None, out)
    elif isinstance(value, dict):
        for k, v in value.items():
            if k == "t2f" and isinstance(v, dict):
                out.update(str(f) for f in v.values())
            _named_fonts(v, k, out)
    return out


def used_families(project: Project, sources: list[str]) -> list[str]:
    """The families the project's text is drawn with, each followed by the one for characters it lacks."""
    want = []
    if codegen.uses_text(sources):
        want.append(codegen.TEXT_FONT)
    want += sorted({family_of(n) for n in _named_fonts(project_plan(project)) if str(n).strip()})
    families = []
    for fam in want:
        for f in (fam, FONT_FAMILIES[fam][2]):  # one level, as the engine loads them
            if f and f not in families:
                families.append(f)
    return families


def font_files(family: str) -> list[Path]:
    folder, prefix, _fallback = FONT_FAMILIES[family]
    return [FONTS_DIR / folder / f"{prefix}{face}.ttf" for face in _FACES
            if (FONTS_DIR / folder / f"{prefix}{face}.ttf").is_file()]


def used_assets(project: Project) -> list[str]:
    """The uploaded files the project's objects show (by their stored names)."""
    names = set()
    for scene in project.scenes:
        for m in scene.mobjects:
            for p in MOBJECTS[m.type].params:
                value = m.params.get(p.name)
                if p.kind == FILE and isinstance(value, str) and value:
                    names.add(value)
    return sorted(names)


def folder_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9 _-]", "", str(name)).strip()[:60] or "project"


def used_kits(project: Project) -> list[dict]:
    """The packages (server/kits.py) the project uses that are available: each one's kit info, one per class."""
    out: dict[str, dict] = {}
    for key in kit_types_in(project):
        spec = kit_spec(key)
        if spec is not None and spec.kit and not spec.blocked:
            out.setdefault(spec.kit["class"], spec.kit)
    return list(out.values())


def _credit(k: dict) -> str:
    """"Battery 1.2 by Ada (MIT)"."""
    return (f"{k['name']} {k['label']}".rstrip() + f" by {k.get('author') or 'unknown'}"
            + (f" ({k['license']})" if k.get("license") else ""))


def readme(project_name: str, project: Project, assets: list[str], families: list[str],
           kits: list[dict] = ()) -> str:
    q = project.settings.quality
    names = [codegen.safe_identifier(s.name) for s in project.scenes]
    width = max(len(n) for n in names)
    lines = [
        f"{project_name}",
        "Made with Manimator (https://manimator.app). This folder renders with Manim Community Edition.",
        "",
        "To render",
        "1. Install Manim Community Edition (https://docs.manim.community/en/stable/installation.html):",
        "     pip install -r requirements.txt",
        "   Formulas (MathTex, Tex) and numbers on axes also need LaTeX (MiKTeX or TeX Live).",
        "2. Open a terminal in this folder (the one with scene.py) and render a scene, for example:",
        f"     manim -pq{q} scene.py {names[0]}",
        "   -ql 480p, -qm 720p, -qh 1080p, -qp 1440p, -qk 4K. The videos are saved in media/videos/.",
        "",
        "Scenes",
        *(f"  {n.ljust(width)}   manim -pq{q} scene.py {n}" for n in names),
        "",
        "In this folder",
        "  scene.py           the scenes",
    ]
    if assets:
        lines.append("  assets/            the pictures and SVG files the scenes show")
    if families:
        lines.append("  fonts/             the fonts the text uses (scene.py loads them: nothing to install),")
        lines.append(f"                     each with its license: {', '.join(families)}")
    if kits:
        lines.append("  customizations/    the custom objects and animations the scenes use")
    lines += ["  requirements.txt   the Manim version Manimator matches", ""]
    if kits:
        lines += ["Custom objects and animations",
                  "These are code written by the people named below. Manim runs them on your computer like any",
                  "Python program: read the files in customizations/ before you render if you don't know them.",
                  *(f"  customizations/{k['module']}.py   {_credit(k)}" for k in kits), ""]
    return "\n".join(lines)


def export_zip(project: Project, project_name: str, asset_path: Callable[[str], Path | None],
               kit_file: Callable[[str, int], Path | None] | None = None) -> tuple[str, bytes]:
    """The project as a zip that renders with Manim CE: (file name, bytes). `asset_path` finds an uploaded file by
    its stored name (None if it is gone); `kit_file(package id, version)` a package's kit.py."""
    root = folder_name(project_name)
    with codegen.asset_root("assets"):
        sources = [codegen.scene_source(scene, project) for scene in project.scenes]
        families = used_families(project, sources)
        source = codegen.project_source(project, "scene.py", bundled_fonts=bool(families))
    assets = [(name, path) for name in used_assets(project) if (path := asset_path(name)) is not None]
    kits = [(k, path) for k in used_kits(project) if kit_file and (path := kit_file(k["id"], k["version"]))]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{root}/scene.py", source)
        for name, path in assets:
            z.write(path, f"{root}/assets/{name}")
        for fam in families:
            folder = FONTS_DIR / FONT_FAMILIES[fam][0]
            for file in font_files(fam):
                z.write(file, f"{root}/fonts/{folder.name}/{file.name}")
            for lic in _LICENSES:
                if (folder / lic).is_file() and f"{root}/fonts/{folder.name}/{lic}" not in z.namelist():
                    z.write(folder / lic, f"{root}/fonts/{folder.name}/{lic}")
        if kits:
            z.writestr(f"{root}/customizations/__init__.py", "# Custom objects and animations from Manimator\n")
        for k, path in kits:
            z.writestr(f"{root}/customizations/{k['module']}.py",
                       f"# {_credit(k)}. A Manimator customization.\n" + path.read_text(encoding="utf-8"))
        z.writestr(f"{root}/requirements.txt", f"{MANIM_REQUIREMENT}\n")
        z.writestr(f"{root}/README.txt", readme(project_name, project, [n for n, _ in assets], families,
                                                [k for k, _ in kits]))
    return f"{root}.zip", buf.getvalue()
