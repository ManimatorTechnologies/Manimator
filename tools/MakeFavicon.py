"""Writes the site's icons from the logo (brand/logo.svg: the M mark, dark, for light grounds).

    .venv/Scripts/python tools/MakeFavicon.py

Out, in manimator/web/favicon/:
  icon.svg              the browser tab: the mark on a white tile with rounded corners (so it shows on dark tab bars
                        too), cropped so the drawing fills FILL of the tile's width
  favicon.ico           the same at 16, 32 and 48 px, for browsers without SVG icons
  icon192.png           the same at 192 px, for search results (Google wants more than 48 px) and Android
  apple-touch-icon.png  180 px for phone home screens: the logo as it is, on white (phones round the corners)
The SVG is drawn with svgelements + pycairo (Manim's own dependencies), drawn 8 times larger and made smaller.
"""

from __future__ import annotations

import io
import re
import struct
from pathlib import Path

import cairo
import numpy as np
from PIL import Image
from svgelements import SVG, Arc, Close, CubicBezier, Line, Move, QuadraticBezier, Shape

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "brand" / "logo.svg"
OUT = ROOT / "manimator" / "web" / "favicon"

FILL = 0.62  # the drawing's width over the tab icon's (the user asked twice for more white margin)
RADIUS = 0.22  # the tab icon's corners, over its width
TILE = "#ffffff"
SS = 8  # drawn this many times larger, then made smaller


def draw(ctx: cairo.Context, svg: SVG) -> None:
    """The logo's shapes, in the parsed file's pixel space (its width x height)."""
    scale = svg.width / svg.viewbox.width  # user units to pixels, for dash lengths
    for el in svg.elements():
        if not isinstance(el, Shape):
            continue
        ctx.new_path()
        for seg in el.segments():
            if isinstance(seg, Move):
                ctx.move_to(*seg.end)
            elif isinstance(seg, Line):
                ctx.line_to(*seg.end)
            elif isinstance(seg, CubicBezier):
                ctx.curve_to(*seg.control1, *seg.control2, *seg.end)
            elif isinstance(seg, QuadraticBezier):
                p0, c, p1 = seg.start, seg.control, seg.end
                ctx.curve_to(p0.x + 2 / 3 * (c.x - p0.x), p0.y + 2 / 3 * (c.y - p0.y),
                             p1.x + 2 / 3 * (c.x - p1.x), p1.y + 2 / 3 * (c.y - p1.y), p1.x, p1.y)
            elif isinstance(seg, Arc):
                for cubic in seg.as_cubic_curves():
                    ctx.curve_to(*cubic.control1, *cubic.control2, *cubic.end)
            elif isinstance(seg, Close):
                ctx.close_path()
        fill, stroke = el.fill, el.stroke
        if fill is not None and fill.value is not None:
            ctx.set_source_rgba(fill.red / 255, fill.green / 255, fill.blue / 255, fill.opacity)
            ctx.fill_preserve()
        if stroke is not None and stroke.value is not None and el.implicit_stroke_width:
            ctx.set_source_rgba(stroke.red / 255, stroke.green / 255, stroke.blue / 255, stroke.opacity)
            ctx.set_line_width(el.implicit_stroke_width)
            ctx.set_line_cap({"round": cairo.LINE_CAP_ROUND, "square": cairo.LINE_CAP_SQUARE}.get(
                el.values.get("stroke-linecap"), cairo.LINE_CAP_BUTT))
            ctx.set_line_join({"round": cairo.LINE_JOIN_ROUND, "bevel": cairo.LINE_JOIN_BEVEL}.get(
                el.values.get("stroke-linejoin"), cairo.LINE_JOIN_MITER))
            dashes = [float(v) * scale for v in re.split(r"[\s,]+", el.values.get("stroke-dasharray", "").strip())
                      if v and v != "none"]
            ctx.set_dash(dashes)
            ctx.stroke_preserve()
            ctx.set_dash([])


def to_image(surface: cairo.ImageSurface) -> Image.Image:
    """Cairo's premultiplied BGRA as a PIL image."""
    w, h = surface.get_width(), surface.get_height()
    a = np.ndarray((h, surface.get_stride() // 4, 4), np.uint8, surface.get_data())[:, :w].astype(np.float32)
    alpha = a[..., 3:4]
    rgb = np.where(alpha > 0, a[..., 2::-1] * 255 / np.maximum(alpha, 1), 0)
    return Image.fromarray(np.dstack([rgb, alpha]).clip(0, 255).astype(np.uint8), "RGBA")


def ink_box(svg: SVG) -> tuple[float, float, float, float]:
    """Where the logo draws anything, in its viewBox's units: left, top, right, bottom."""
    w, h = int(svg.width), int(svg.height)
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
    draw(cairo.Context(surface), svg)
    alpha = np.ndarray((h, surface.get_stride()), np.uint8, surface.get_data())[:, 3:w * 4:4]
    ys, xs = np.nonzero(alpha > 8)
    k = svg.viewbox.width / svg.width
    return svg.viewbox.x + xs.min() * k, svg.viewbox.y + ys.min() * k, \
        svg.viewbox.x + (xs.max() + 1) * k, svg.viewbox.y + (ys.max() + 1) * k


def tile_box(svg: SVG) -> tuple[float, float, float]:
    """The tab icon's square around the drawing, in the logo's units: left, top, side."""
    left, top, right, bottom = ink_box(svg)
    side = max(right - left, bottom - top) / FILL
    return (left + right - side) / 2, (top + bottom - side) / 2, side


def render(svg: SVG, size: int, box: tuple[float, float, float], ground: str, radius: float) -> Image.Image:
    """The part `box` of the logo (left, top, side, in its units) at size x size px on `ground`."""
    big = size * SS
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, big, big)
    ctx = cairo.Context(surface)
    r = radius * big
    ctx.new_sub_path()
    for cx, cy, a0 in ((big - r, r, -90), (big - r, big - r, 0), (r, big - r, 90), (r, r, 180)):
        ctx.arc(cx, cy, r, np.radians(a0), np.radians(a0 + 90))
    ctx.close_path()
    g = ground.lstrip("#")
    ctx.set_source_rgb(*(int(g[i:i + 2], 16) / 255 for i in (0, 2, 4)))
    ctx.fill()
    left, top, side = box
    ctx.scale(big / side, big / side)
    ctx.translate(-left, -top)
    ctx.scale(svg.viewbox.width / svg.width, svg.viewbox.height / svg.height)  # the file's pixels to its units
    ctx.translate(svg.viewbox.x * svg.width / svg.viewbox.width, svg.viewbox.y * svg.height / svg.viewbox.height)
    draw(ctx, svg)
    return to_image(surface).resize((size, size), Image.LANCZOS)


def icon_svg(source: str, box: tuple[float, float, float]) -> str:
    """The tab icon as SVG: the tile, then the logo's own shapes as they are written."""
    inner = re.search(r"<svg\b[^>]*>(.*)</svg>", source, re.S)[1].strip()
    left, top, side = box
    f = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")  # noqa: E731
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(left)} {f(top)} {f(side)} {f(side)}">\n'
            f'<rect x="{f(left)}" y="{f(top)}" width="{f(side)}" height="{f(side)}" rx="{f(RADIUS * side)}" '
            f'fill="{TILE}"/>\n{inner}\n</svg>\n')


def ico(images: list[Image.Image]) -> bytes:
    """An .ico holding each image as PNG (every browser reads those)."""
    blobs = []
    for im in images:
        buf = io.BytesIO()
        im.save(buf, "PNG")
        blobs.append(buf.getvalue())
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = len(head) + 16 * len(images)
    entries = b""
    for im, blob in zip(images, blobs):
        side = im.width % 256  # 0 means 256
        entries += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    return head + entries + b"".join(blobs)


def main() -> None:
    source = LOGO.read_text(encoding="utf-8")
    svg = SVG.parse(str(LOGO))
    box = tile_box(svg)
    OUT.mkdir(exist_ok=True)
    (OUT / "icon.svg").write_text(icon_svg(source, box), encoding="utf-8", newline="\n")
    (OUT / "favicon.ico").write_bytes(ico([render(svg, size, box, TILE, RADIUS) for size in (16, 32, 48)]))
    render(svg, 192, box, TILE, RADIUS).save(OUT / "icon192.png", optimize=True)
    whole = (svg.viewbox.x, svg.viewbox.y, max(svg.viewbox.width, svg.viewbox.height))
    render(svg, 180, whole, TILE, 0).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    for name in ("icon.svg", "favicon.ico", "icon192.png", "apple-touch-icon.png"):
        print(name, (OUT / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
