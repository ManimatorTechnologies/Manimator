"""Dev only: draw frames of a scene with Manim itself (Cairo), at chosen moments of one animation step.

The reference side of the parity report: the same calls Scene.play makes (compile_animation_data, begin_animations,
update_to_time), but frames are taken only at the requested times, and the objects' boxes are read alongside.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / ".cache" / "parity-media"  # never a short 8.3 temp path: TeX can't open paths with "~"
FONTS = ROOT / "manimator" / "web" / "fonts" / "dejavu"

_ready = False


def _prepare() -> None:
    """Manim settings for in-process frames, and the server's fonts (Pango on the live server only has DejaVu)."""
    global _ready
    if _ready:
        return
    import manimpango
    from manim import config, logger

    MEDIA.mkdir(parents=True, exist_ok=True)
    config.media_dir = str(MEDIA)
    logger.setLevel("ERROR")
    for font in sorted(FONTS.glob("*.ttf")):
        manimpango.register_font(str(font))
    _ready = True


@dataclass
class Frames:
    pngs: list[bytes] = field(default_factory=list)
    boxes: dict[str, list[float]] = field(default_factory=dict)  # name -> [xmin, ymin, xmax, ymax] at the start
    run_time: float = 0.0
    error: str | None = None


def render(code: str, anim: str | None = None, kind: str = "Scene", setup: str = "", fractions=(0, .25, .5, .75, 1),
           width: int = 1280, height: int = 720) -> Frames:
    """`setup` runs on the scene first (camera lines), `code` builds and adds the objects, `anim` is the step's
    animation (an expression). Frames are taken at these fractions of the step."""
    _prepare()
    import numpy as np
    from manim import tempconfig
    from PIL import Image

    out = Frames()
    with tempconfig({"pixel_width": width, "pixel_height": height, "dry_run": True, "disable_caching": True,
                     "frame_rate": 60}):
        ns: dict = {}
        exec("from manim import *", ns)
        init = ""
        if kind == "SpecialThreeDScene":  # its __init__ fails in recent Manim (see codegen._SPECIAL_INIT)
            init = ("    def __init__(self, **kw):\n        try:\n            super().__init__(**kw)\n"
                    "        except AttributeError:\n            ThreeDScene.__init__(self, **kw)\n")
        exec(f"class _Ref({kind}):\n{init}    def construct(self):\n        pass\n", ns)
        scene = ns["_Ref"]()
        scene.setup()
        ns["self"] = scene
        try:
            exec(setup, ns)
            exec(code, ns)
        except Exception as e:  # noqa: BLE001 - reported in the report
            out.error = f"{type(e).__name__}: {e}"[:300]
            return out
        for name, value in list(ns.items()):
            if hasattr(value, "get_corner") and not name.startswith("_") and name != "self":
                try:
                    (x0, y0), (x1, y1) = value.get_corner([-1, -1, 0])[:2], value.get_corner([1, 1, 0])[:2]
                    out.boxes[name] = [round(float(v), 4) for v in (x0, y0, x1, y1)]
                except Exception:  # noqa: BLE001
                    pass
        renderer = scene.renderer

        def grab() -> bytes:
            renderer.static_image = None
            renderer.update_frame(scene, ignore_skipping=True)
            img = Image.fromarray(np.asarray(renderer.get_frame())).convert("RGB")
            buf = io.BytesIO()
            img.save(buf, "PNG")
            return buf.getvalue()

        if not anim:
            out.pngs = [grab() for _ in fractions]
            return out
        try:
            animation = eval(anim, ns)
            scene.compile_animation_data(animation)
            scene.begin_animations()
            out.run_time = scene.get_run_time(scene.animations)
            for f in fractions:
                scene.update_to_time(f * out.run_time)
                out.pngs.append(grab())
        except Exception as e:  # noqa: BLE001
            out.error = f"{type(e).__name__}: {e}"[:300]
    return out


if __name__ == "__main__":
    f = render("c = Circle(radius=1.5, color=RED)", "Create(c)")
    print(f.error, f.run_time, f.boxes, [len(p) for p in f.pngs])
    target = ROOT / ".cache" / "spike-report"
    target.mkdir(parents=True, exist_ok=True)
    for i, png in enumerate(f.pngs):
        (target / f"probe_{i}.png").write_bytes(png)
