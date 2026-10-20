"""Dev only: draw objects with Manim (Cairo) and with the browser engine, and compare the pictures.

    python tools/DrawParity.py                 # every case
    python tools/DrawParity.py geometry 3 5    # some cases of one set, by index

The cases are MakeJsFixtures.py's [class, args, kwargs, ...method calls] specs. The report goes to
.cache/draw-parity/index.html: both pictures, their difference, and two numbers per case: the mean difference
(percent of full scale) and the share of pixels that differ by more than a quarter of full scale.
"""

from __future__ import annotations

import base64
import html
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from EngineDriver import ROOT, page, serve  # noqa: E402
from MakeJsFixtures import GEOMETRY_CASES, OUT as FIXTURES, TEX_CASES, TEXT_CASES  # noqa: E402

OUT = ROOT / ".cache" / "draw-parity"
W, H = 1280, 720
SETS = {"geometry": GEOMETRY_CASES, "text": [["Text", [], {"font": "DejaVu Sans"} | kw] for kw in TEXT_CASES],
        "tex": [["MathTex", [f], {}] for f in json.loads((FIXTURES / "TexCorpus.json").read_text("utf-8"))]
        + TEX_CASES}
FUNCS = {"wave": "lambda p: p + np.array([0.0, 0.3 * np.sin(2 * p[0]), 0.0])"}


def py_value(v) -> str:
    if isinstance(v, str) and (v.endswith("Tip") or v in FUNCS):
        return FUNCS.get(v, v)
    return repr(v)


def py_args(args, kwargs) -> str:
    return ", ".join([*(py_value(a) for a in args), *(f"{k}={py_value(v)}" for k, v in kwargs.items())])


def manim_code(spec) -> str:
    cls, args, kwargs, *calls = spec
    lines = [f"m = {cls}({py_args(args, kwargs)})", *(f"m.{n}({py_args(a, k)})" for n, a, k in calls), "self.add(m)"]
    return "\n".join(lines)


def compare(a: bytes, b: bytes) -> tuple[float, float, bytes]:
    import numpy as np
    from PIL import Image

    x = np.asarray(Image.open(io.BytesIO(a)).convert("RGB"), dtype=np.int16)
    y = np.asarray(Image.open(io.BytesIO(b)).convert("RGB"), dtype=np.int16)
    d = np.abs(x - y)
    mean = float(d.mean()) / 255 * 100
    big = float((d.max(axis=2) > 64).mean()) * 100
    buf = io.BytesIO()
    Image.fromarray(np.clip(d * 4, 0, 255).astype(np.uint8)).save(buf, "PNG")
    return mean, big, buf.getvalue()


def main(argv: list[str]) -> None:
    from ManimFrames import render

    names = [a for a in argv if not a.isdigit()] or list(SETS)
    picks = {int(a) for a in argv if a.isdigit()}
    cases = [(f"{s}-{i}", spec) for s in names for i, spec in enumerate(SETS[s]) if not picks or i in picks]
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    with serve() as base, page(base + "/dev/draw.html") as p:
        for name, spec in cases:
            ref = render(manim_code(spec), None, "Scene", "", (0,), W, H)
            if ref.error:
                rows.append((name, spec, None, None, None, ref.error))
                print(f"{name}: manim {ref.error}")
                continue
            got = p.evaluate("([s, w, h]) => harness.draw([s], {width: w, height: h})", [spec, W, H])
            ours = base64.b64decode(got["png"].split(",", 1)[1])
            mean, big, diff = compare(ref.pngs[0], ours)
            for suffix, data in (("manim", ref.pngs[0]), ("engine", ours), ("diff", diff)):
                (OUT / f"{name}_{suffix}.png").write_bytes(data)
            rows.append((name, spec, mean, big, got["ms"], None))
            print(f"{name}: mean {mean:.3f}%  >25%: {big:.3f}%  ({got['ms']:.1f} ms)")
        problems = p.console_errors + p.external
    cells = []
    for name, spec, mean, big, ms, error in rows:
        head = f"<b>{name}</b> <code>{html.escape(repr(spec))}</code>"
        if error:
            cells.append(f"<tr><td colspan=3>{head}<br>Manim failed: {html.escape(error)}</td></tr>")
            continue
        imgs = "".join(f'<td><img src="{name}_{s}.png" width="420"></td>' for s in ("manim", "engine", "diff"))
        cells.append(f"<tr><td colspan=3>{head} mean {mean:.3f}% · over 25%: {big:.3f}% · {ms:.1f} ms</td></tr>"
                     f"<tr>{imgs}</tr>")
    note = f"<p>Page problems: {html.escape(repr(problems))}</p>" if problems else ""
    (OUT / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Draw parity</title><body style='background:#333;color:#eee;"
        f"font:13px sans-serif'>{note}<table><tr><th>Manim</th><th>Engine</th><th>Difference ×4</th></tr>"
        + "".join(cells) + "</table>", encoding="utf-8")
    print(OUT / "index.html", "page problems:", problems or "none")


if __name__ == "__main__":
    main(sys.argv[1:])
