"""Dev only: draws the palette's object icons with Manim, once, into manimator/web/icons/<key>.png.

    python tools/MakeIcons.py            # every object
    python tools/MakeIcons.py Circle     # some

The pictures are what the server's /api/icon drew (PreviewRenderer.render_icon), with the server's fonts (DejaVu),
so the editor needs no Manim to show them. An object that can't be drawn on its own (one that needs an uploaded
file) gets no icon; the palette shows its symbol instead.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

OUT = ROOT / "manimator" / "web" / "icons"


def main(argv: list[str]) -> None:
    import manim
    import ManimFrames
    from PIL import Image

    from ManimPreview import PreviewRenderer
    from manimator.registry import MOBJECTS

    ManimFrames._prepare()
    for cls in (manim.Text, manim.MarkupText, manim.Paragraph):
        cls.set_default(font="DejaVu Sans")
    renderer = PreviewRenderer(str(ManimFrames.MEDIA))
    OUT.mkdir(parents=True, exist_ok=True)
    keys = argv or list(MOBJECTS)
    for key in keys:
        try:
            rgba, w, h = renderer.render_icon(key)
        except Exception as e:  # noqa: BLE001 - no icon; the palette shows the symbol
            (OUT / f"{key}.png").unlink(missing_ok=True)
            print(f"{key}: no icon ({type(e).__name__}: {str(e)[:80]})")
            continue
        Image.frombytes("RGBA", (w, h), rgba).save(OUT / f"{key}.png", optimize=True)
        print(f"{key}: ok")


if __name__ == "__main__":
    main(sys.argv[1:])
