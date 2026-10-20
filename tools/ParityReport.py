"""Dev only: compare the browser engine with Manim, picture by picture, in a side-by-side HTML report.

    python tools/ParityReport.py                  # every case
    python tools/ParityReport.py Circle Text~     # some cases ("~": the object with every parameter changed)
    python tools/ParityReport.py --reuse-manim    # keep the Manim pictures from the last run

The cases are the golden test projects (tests/FixtureProjects.py): every object on its own, with its default and
with changed parameters, the "all objects" projects, and every scene kind's settings and actions projects. Each is drawn twice: by Manim, the way the server's preview
draws a scene's starting layout (tools/ManimPreview.py, in this process), and by the browser engine from the scene
plan at /dev/ (headless Edge, under the site's real Content-Security-Policy). Text uses DejaVu on both sides, as on
the live server. The report goes to .cache/parity-report/index.html, with each pair's difference and the objects
whose boxes differ by more than the gate allows (0.05 units; 2% for text and formulas).
"""

from __future__ import annotations

import base64
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from EngineDriver import ROOT, page, serve  # noqa: E402

sys.path.insert(0, str(ROOT / "tests"))

OUT = ROOT / ".cache" / "parity-report"
W, H = 1280, 720
TEXTLIKE = {"Text", "MarkupText", "Paragraph", "MathTex", "Tex", "Title", "BulletedList", "Code", "DecimalNumber",
            "Integer", "Variable", "Matrix", "IntegerMatrix", "DecimalMatrix", "MobjectMatrix", "Table", "MathTable",
            "IntegerTable", "DecimalTable", "MobjectTable", "BraceLabel", "BraceText", "LabeledDot", "LabeledLine",
            "LabeledArrow", "BarChart", "NumberLine", "Axes", "NumberPlane", "ComplexPlane", "PolarPlane"}


def cases() -> dict:
    from FixtureProjects import all_objects, one_object

    from manimator.registry import MOBJECTS

    out = {}
    for key in MOBJECTS:
        out[key] = lambda key=key: one_object(key)
        out[f"{key}~"] = lambda key=key: one_object(key, variant=True)
    from FixtureProjects import golden_projects

    golden = None

    def kind_project(name):
        nonlocal golden
        golden = golden or golden_projects()
        return golden[name]

    from manimator.registry.scenes import SCENE_KINDS

    for kind in SCENE_KINDS:
        for group in ("settings", "actions", "actions_changed"):
            out[f"{group} {kind}"] = lambda name=f"{group}_{kind}": kind_project(name)
    out["three_d_roles"] = lambda: kind_project("three_d_roles")
    out["linear_roles"] = lambda: kind_project("linear_roles")
    out["all objects"] = lambda: all_objects()
    out["all objects~"] = lambda: all_objects(variant=True)
    out["all objects 3D"] = lambda: all_objects(three_d=True)
    out["all objects 3D~"] = lambda: all_objects(variant=True, three_d=True)
    return out


def sample_files(folder: Path) -> dict[str, bytes]:
    """The uploads the projects use: a small picture and the SVG test file."""
    import io

    from FixtureProjects import FILES
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGBA", (40, 30), (200, 120, 40, 255)).save(buf, "PNG")
    files = {FILES["ImageMobject"]: buf.getvalue(),
             FILES["SVGMobject"]: (ROOT / "tests" / "js" / "fixtures" / "svg" / "structure.svg").read_bytes()}
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (folder / name).write_bytes(data)
    return files


def by_name(project, by_id: dict) -> dict:
    """Ids are new each time a project is made; names stay (so Manim's pictures can be kept between runs)."""
    names = {m.id: m.name for m in project.scenes[0].mobjects}
    return {names[k]: v for k, v in by_id.items() if k in names}


def slug(name: str) -> str:
    return name.replace(" ", "_").replace("~", "_changed")


def manim_side(names: list[str], projects: dict, reuse: bool) -> dict:
    import manim
    import ManimFrames

    from manimator import codegen
    from ManimPreview import PreviewJob, PreviewRenderer

    ManimFrames._prepare()
    for cls in (manim.Text, manim.MarkupText, manim.Paragraph):
        cls.set_default(font="DejaVu Sans")
    renderer = PreviewRenderer(str(ManimFrames.MEDIA), W, H)
    cache = OUT / "manim.json"
    old = json.loads(cache.read_text()) if reuse and cache.exists() else {}
    results = {}
    folder = OUT / "files"
    sample_files(folder)
    for name in names:
        if name in old:
            results[name] = old[name]
            continue
        project = projects[name]
        try:
            with codegen.asset_root(folder.as_posix()):
                job = PreviewJob.from_scene(project.scenes[0], project)
            r = renderer.render(job)
            from PIL import Image

            path = OUT / "manim" / f"{slug(name)}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.frombytes("RGBA", (r.width, r.height), r.rgba).convert("RGB").save(path)
            results[name] = {"file": path.relative_to(OUT).as_posix(), "boxes": by_name(project, r.boxes),
                             "errors": by_name(project, r.errors),
                             "error": r.scene_error, "ms": round(r.seconds * 1000)}
        except Exception as e:  # noqa: BLE001 - shown in the report
            results[name] = {"file": None, "boxes": {}, "errors": {}, "error": f"{type(e).__name__}: {e}"[:300]}
        print(f"manim   {name}: {results[name]['error'] or 'ok'}")
    cache.write_text(json.dumps({**old, **results}, indent=1))
    return results


def browser_side(names: list[str], projects: dict) -> tuple[dict, dict]:
    from manimator.plan import scene_plan

    files = {k: base64.b64encode(v).decode() for k, v in sample_files(OUT / "files").items()}
    results = {}
    with serve() as base, page(base + "/dev/") as p:
        for name in names:
            project = projects[name]
            try:
                plan = scene_plan(project.scenes[0], project)
                info = p.evaluate("([plan, o]) => harness.show(plan, o)", [plan, {"width": W, "height": H, "files": files}])
                path = OUT / "browser" / f"{slug(name)}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(info["png"].split(",", 1)[1]))
                results[name] = {"file": path.relative_to(OUT).as_posix(), "boxes": by_name(project, info["boxes"]),
                                 "errors": by_name(project, info["errors"]), "error": info.get("scene_error"), "ms": info["ms"],
                                 "drawMs": info["drawMs"]}
            except Exception as e:  # noqa: BLE001 - shown in the report
                results[name] = {"file": None, "boxes": {}, "errors": {}, "error": str(e).splitlines()[0][:300]}
            print(f"browser {name}: {results[name]['error'] or 'ok'}")
        page_info = {"violations": p.evaluate("harness.violations()"), "external": p.external,
                     "console_errors": p.console_errors}
    return results, page_info


def difference(a: Path, b: Path) -> float:
    """Mean absolute difference of the two pictures' brightness, in percent of full scale."""
    import numpy as np
    from PIL import Image

    x = np.asarray(Image.open(a).convert("L").resize((W // 2, H // 2)), dtype=np.float32)
    y = np.asarray(Image.open(b).convert("L").resize((W // 2, H // 2)), dtype=np.float32)
    return round(float(np.abs(x - y).mean()) / 2.55, 2)


def box_problems(project, manim: dict, browser: dict) -> list[str]:
    """Objects that fail the gate: built on one side only, or boxes further apart than allowed."""
    out = []
    for m in project.scenes[0].mobjects:
        me, be = manim["errors"].get(m.name), browser["errors"].get(m.name)
        if bool(me) != bool(be):
            out.append(f"{m.name} ({m.type}): Manim {'error: ' + me if me else 'ok'}, browser {'error: ' + be if be else 'ok'}")
            continue
        a, b = manim["boxes"].get(m.name), browser["boxes"].get(m.name)
        if not a or not b:
            continue
        size = max(a[2] - a[0], a[3] - a[1])
        allowed = max(0.05, 0.02 * size) if m.type in TEXTLIKE else 0.05
        d = max(abs(x - y) for x, y in zip(a, b))
        if d > allowed:
            out.append(f"{m.name} ({m.type}): off by {d:.3f} (allowed {allowed:.3f}); "
                       f"Manim {[round(v, 2) for v in a]}, browser {[round(v, 2) for v in b]}")
    return out


def write_html(names, projects, manim, browser, info) -> Path:
    rows, failing = [], []
    for name in names:
        m, b = manim.get(name, {}), browser.get(name, {})
        diff = difference(OUT / m["file"], OUT / b["file"]) if m.get("file") and b.get("file") else None
        problems = box_problems(projects[name], m, b) if m.get("file") and b.get("file") else []
        notes = [html.escape(p) for p in problems]
        for side, r in (("Manim", m), ("browser", b)):
            if r.get("error"):
                notes.append(f"{side}: {html.escape(r['error'])}")
        if problems or diff is None or diff > 1.0 or m.get("error") or b.get("error"):
            failing.append(name)
        img = lambda f, who: f"<a href='{f}'><img src='{f}' title='{who}'></a>" if f else f"<div class=miss>no {who} picture</div>"  # noqa: E731
        timing = f"Manim {m.get('ms', '–')} ms · browser {b.get('ms', '–')} + {b.get('drawMs', '–')} ms"
        rows.append(f"<tr id='{slug(name)}'><th>{html.escape(name)}<div class=t>diff {diff if diff is not None else '–'}%"
                    f"<br>{timing}</div></th><td>{img(m.get('file'), 'Manim')}</td><td>{img(b.get('file'), 'browser')}</td>"
                    f"<td class=n>{'<br>'.join(notes) or 'ok'}</td></tr>")
    summary = "".join(f"<a href='#{slug(n)}'>{html.escape(n)}</a> " for n in failing) or "none"
    page_notes = html.escape(json.dumps(info, indent=1))
    doc = f"""<!doctype html><meta charset=utf-8><title>Engine parity</title>
<style>body{{background:#111;color:#ccc;font:12px system-ui;margin:16px}} table{{border-collapse:collapse}}
td,th{{border:1px solid #333;padding:4px;vertical-align:top}} th{{width:160px;text-align:left}} a{{color:#58C4DD}}
img{{display:block;width:480px;border:1px solid #222}} .t{{color:#888;font-weight:400}} .n{{color:#bbb;max-width:420px;
word-break:break-word}} .miss{{width:480px;height:270px;display:grid;place-items:center;color:#c55}}</style>
<h1>Engine parity: Manim (left) vs browser engine (right)</h1>
<p>{len(names)} cases. Needs a look ({len(failing)}): {summary}</p><pre>{page_notes}</pre>
<table><tr><th>case</th><th>Manim</th><th>browser</th><th>gate</th></tr>{''.join(rows)}</table>"""
    target = OUT / "index.html"
    target.write_text(doc, encoding="utf-8")
    return target


def main(argv: list[str]) -> None:
    reuse = "--reuse-manim" in argv
    makers = cases()
    names = [a for a in argv if not a.startswith("--")] or list(makers)
    unknown = [n for n in names if n not in makers]
    if unknown:
        raise SystemExit(f"unknown cases: {unknown}")
    OUT.mkdir(parents=True, exist_ok=True)
    projects = {n: makers[n]() for n in names}
    manim = manim_side(names, projects, reuse)
    browser, info = browser_side(names, projects)
    print(f"report: {write_html(names, projects, manim, browser, info)}")


if __name__ == "__main__":
    main(sys.argv[1:])
