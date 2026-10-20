"""Looking at a scene before showing it: frames from the server's renderer, and checks of its layout.

An assistant writes a scene blind. PreviewAnimation shows it frames (the end of each animation step, or moments it
asks for) and these checks: objects outside the picture, text over other text, text too small to read in the chat's
player, and where each object is. The other tools run the same checks and add any problems to their answer.
"""

from __future__ import annotations

import base64

from ..model.ops import kit_spec
from ..model.project import WAIT, Scene
from ..registry import MOBJECTS
from ..registry.custom import is_kit_type
from .renderer import Renderer, RenderUnavailable

MAX_FRAMES = 8
MIN_FONT = 28  # the chat's player is about 560 px wide: smaller text is hard to read there
MIN_TEXT_FONT = 32  # Text in Crimson Pro runs smaller than a formula of the same font_size
PANGO_TEXT = {"Text", "Paragraph", "MarkupText"}
TEXT_CATEGORIES = ("Text", "Tables")
EDGE = 0.05  # scene units outside the picture that still count as inside (antialiasing, rounding)


def _describe(step, names: dict) -> str:
    if step.kind == WAIT:
        return f"wait {step.duration:g} s"
    parts = []
    for a in step.animations:
        who = names.get(a.target) or next((names[v] for v in a.params.values() if isinstance(v, str) and v in names), "")
        parts.append(f"{a.method if a.anim == 'Animate' else _kit_class(a.anim) or a.anim} {who}".strip())
    text = ", ".join(parts)
    return text if len(text) <= 70 else text[:67] + "..."


def sample_times(scene: Scene, plan: dict) -> list[tuple[float, str]]:
    """Moments worth looking at: just before each animation step ends (it looks finished; at the boundary the next
    one has begun), and the very end. At most MAX_FRAMES, spread over the video."""
    names = {m.id: m.name for m in scene.mobjects}
    out, start = [], 0.0
    for i, (step, model) in enumerate(zip(plan["steps"], scene.steps)):
        end = start + step["run_time"]
        if step["kind"] == "play":
            out.append((max(start, end - 1 / 120), f"end of step {i + 1}: {_describe(model, names)}"))
        start = end
    if not out:
        out.append((plan["duration"], "the picture"))
    if len(out) > MAX_FRAMES:  # evenly spread, always with the last one
        n = len(out)
        out = [out[round(k * (n - 1) / (MAX_FRAMES - 1))] for k in range(MAX_FRAMES)]
    return out


def _kit_class(key) -> str:
    """A customization's class name ("" for built-in types)."""
    spec = kit_spec(key) if is_kit_type(key) else None
    return spec.kit["class"] if spec is not None and spec.kit else ("custom" if is_kit_type(key) else "")


def not_drawn(scene: Scene) -> list[str]:
    """The customizations previews leave out (their code runs only in the user's browser, server/kits.py): objects
    with where they were put, and steps with custom animations."""
    out = []
    for m in scene.mobjects:
        if is_kit_type(m.type):
            at = "placed by its methods" if m.methods else f"centered at ({m.position[0]:g}, {m.position[1]:g})"
            out.append(f"{m.name} ({_kit_class(m.type)}, {at}, scale {m.scale:g})")
    for i, step in enumerate(scene.steps, 1):
        for a in step.animations:
            if is_kit_type(a.anim):
                out.append(f"the {_kit_class(a.anim)} animation in step {i} (shown as nothing happening)")
    return out


def _overlap(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _area(b) -> float:
    return max(1e-9, (b[2] - b[0]) * (b[3] - b[1]))


def check(scene: Scene, plan: dict, result: dict | None, times: list[tuple[float, str]]) -> tuple[list[str], list[str]]:
    """(problems, where things are). `result` is the renderer's for `times` (None: only the checks without frames)."""
    # customizations aren't drawn here (not_drawn): nothing to check about them
    names = {m.id: m.name for m in scene.mobjects if not is_kit_type(m.type)}
    kinds = {m.id: m.type for m in scene.mobjects}
    problems: list[str] = []
    for m in scene.mobjects:
        if is_kit_type(m.type):
            continue
        size = m.params.get("font_size")
        least = MIN_TEXT_FONT if m.type in PANGO_TEXT else MIN_FONT
        if isinstance(size, (int, float)) and size < least and "font_size" in {p.name for p in MOBJECTS[m.type].params}:
            problems.append(f"{m.name}: font_size {size:g} is hard to read in the chat's player; use {least} or more")
    if result is None:
        return problems, []
    for oid, err in (result.get("errors") or {}).items():
        if not is_kit_type(kinds.get(oid)):
            problems.append(f"{names.get(oid, oid)} can't be drawn: {err}")
    if result.get("scene_error"):
        problems.append(str(result["scene_error"]))
    outside: dict[str, str] = {}
    overlaps: dict[tuple[str, str], str] = {}
    last: dict[str, list] = {}
    for (t, _label), frame in zip(times, result["frames"]):
        cx, cy, w = frame.get("view") or [0, 0, 128 / 9]
        h = w * 9 / 16
        left, right, bottom, top = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2
        texts = []
        for item in frame["objects"]:
            oid, (x0, y0, x1, y1) = item["id"], item["box"]
            if oid not in names:
                continue
            last[oid] = item["box"]
            if (x0 < left - EDGE or x1 > right + EDGE or y0 < bottom - EDGE or y1 > top + EDGE) and oid not in outside:
                outside[oid] = (f"{names[oid]} goes outside the picture at {t:.1f} s: x {x0:.2f} to {x1:.2f}, "
                                f"y {y0:.2f} to {y1:.2f} (the picture: x {left:.2f} to {right:.2f}, "
                                f"y {bottom:.2f} to {top:.2f})")
            if MOBJECTS[kinds[oid]].category in TEXT_CATEGORIES:
                texts.append((oid, item["box"]))
        for i, (a, ba) in enumerate(texts):
            for b, bb in texts[i + 1:]:
                if _overlap(ba, bb) > 0.15 * min(_area(ba), _area(bb)) and (a, b) not in overlaps:
                    overlaps[(a, b)] = f"{names[a]} and {names[b]} overlap at {t:.1f} s"
    problems += list(outside.values()) + list(overlaps.values())
    where = [f"{names[oid]} ({kinds[oid]}): x {b[0]:.2f} to {b[2]:.2f}, y {b[1]:.2f} to {b[3]:.2f}"
             for oid, b in sorted(last.items(), key=lambda kv: scene.mob_index(kv[0]))]
    return problems, where


def layout_problems(renderer: Renderer | None, scene: Scene, plan: dict, owner: str = "") -> list[str]:
    """The checks, for tools that show or save a scene: frames are drawn but not sent. Without a renderer (or when it
    is busy), only the checks that need no frames."""
    times = sample_times(scene, plan)
    result = None
    if renderer is not None:
        try:
            result = renderer.render(plan, [t for t, _ in times], 320, 180, owner)
        except RenderUnavailable:
            result = None
    return check(scene, plan, result, times)[0]


def preview(renderer: Renderer, scene: Scene, plan: dict, title: str, times: list[float] | None = None,
            owner: str = "") -> list[dict]:
    """PreviewAnimation's answer: the checks, then each frame (a line saying when, and the picture). Raises
    RenderUnavailable."""
    if times:
        moments = [(min(max(0.0, float(t)), plan["duration"]), "asked for") for t in times[:MAX_FRAMES]]
    else:
        moments = sample_times(scene, plan)
    result = renderer.render(plan, [t for t, _ in moments], 800, 450, owner)
    problems, where = check(scene, plan, result, moments)
    lines = [f"Preview of \"{title}\": {plan['duration']:g} s. {len(moments)} frame{'s' if len(moments) != 1 else ''} "
             "below, each the whole 16:9 picture (14.2 x 8 units, 0, 0 in the middle)."]
    if problems:
        lines += ["", "Problems found:"] + [f"- {p}" for p in problems]
    else:
        lines += ["", "The checks found no problems (nothing outside the picture, no text over text, no tiny text). "
                      "Still look at the frames: is anything crowded, misaligned, unbalanced or hard to follow?"]
    missing = not_drawn(scene)
    if missing:
        lines += ["", "Not in these frames: the user's customizations, whose code runs only in their browser (the "
                      "user sees them in the chat). Here each is a single point at its center, so anything placed "
                      "next to one is closer than it will be. Leave room for them:"] + [f"- {m}" for m in missing]
    if where:
        lines += ["", "Where each object was when last seen (scene units):"] + [f"- {w}" for w in where]
    lines += ["", "Fix what you see by changing the scene and preview again. Once it looks right, show it in your "
                  "answer, right after the paragraph it illustrates (text explains, the clip illustrates)."]
    content: list[dict] = [{"type": "text", "text": "\n".join(lines)}]
    for k, ((t, label), frame) in enumerate(zip(moments, result["frames"]), 1):
        content.append({"type": "text", "text": f"Frame {k}: {t:.2f} s ({label})"})
        content.append({"type": "image", "data": base64.b64encode(frame["jpeg"]).decode(), "mimeType": "image/jpeg"})
    return content
