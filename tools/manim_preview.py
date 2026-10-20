"""Dev only (needs Manim): renders a scene's starting layout to an image with Manim's own Cairo camera.

This was the server's preview renderer before the browser engine replaced it. It stays as the Manim reference for
tools/parity_report.py and tools/make_icons.py.

Runs the exact setup code the exporter writes (see codegen.scene_objects), one
object at a time, so one broken object (say, bad LaTeX) doesn't blank the frame.
The scene class itself (a ZoomedScene, a LinearTransformationScene...) is really
created and set up the way the exported script does it, so its camera, grids,
basis vectors and zoom display appear exactly as in the video.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field

from manimator.codegen import MobCode, class_lines, scene_objects, scene_setup
from manimator.model.project import Project, Scene
from manimator.plan import layout
from manimator.registry.scenes import FIXED_IN_FRAME, FIXED_ORIENTATION

PREVIEW_WIDTH = 1280
PREVIEW_HEIGHT = 720
GHOST_FADE = 0.75  # objects that only appear later are drawn at 25% opacity


@dataclass
class PreviewJob:
    """Everything the worker thread needs, detached from the live model."""

    codes: list[MobCode]
    layer_order: list[str]  # mobject ids, bottom to top
    ghost_ids: set[str]  # not on screen at the start
    background: str
    token: int = 0
    scene_class: str = ""  # source of the scene class (its __init__), with an empty construct()
    setup: list[str] = field(default_factory=list)  # the first lines of construct(): camera, grids, zoom...
    fixed: dict[str, str] = field(default_factory=dict)  # 3D: id -> FIXED_IN_FRAME / FIXED_ORIENTATION

    @classmethod
    def from_scene(cls, scene: Scene, project: Project, token: int = 0) -> PreviewJob:
        codes, _ = scene_objects(scene)
        drawn = layout(scene)  # the same rules the browser's scene plan uses
        setup = scene_setup(scene, project)
        return cls(
            codes=codes,
            layer_order=drawn["order"],
            ghost_ids=set(drawn["hidden"]),
            background=project.settings.background,
            token=token,
            scene_class="\n".join([*class_lines("_ManimatorPreview", setup), "        pass"]) + "\n",
            setup=setup.lines,
            fixed=drawn["fixed"],
        )


@dataclass
class PreviewResult:
    token: int
    width: int
    height: int
    rgba: bytes
    # mobject id -> (xmin, ymin, xmax, ymax) in scene units
    boxes: dict[str, tuple[float, float, float, float]] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    seconds: float = 0.0
    # The part of the scene in the picture, in scene units: center x, center y and width (a moved camera).
    view: tuple[float, float, float] = (0.0, 0.0, 128 / 9)
    scene_error: str | None = None  # the scene's own setup failed; the frame falls back to a plain Scene


class PreviewRenderer:
    def __init__(self, media_dir: str, width: int = PREVIEW_WIDTH, height: int = PREVIEW_HEIGHT):
        from manim import config, logger

        config.media_dir = media_dir
        logger.setLevel("ERROR")
        self.width = width
        self.height = height
        self._base_ns: dict = {}
        exec("from manim import *", self._base_ns)
        # Constructor results keyed by their source, so dragging a MathTex around
        # doesn't recompile LaTeX on every frame.
        self._ctor_cache: OrderedDict[str, object] = OrderedDict()
        self._scenes: OrderedDict[tuple, object] = OrderedDict()  # set-up scene objects, by their setup code

    def _construct(self, code: MobCode, ns: dict):
        if code.deps:  # depends on other objects' current state; can't cache
            return eval(code.ctor, ns)
        cached = self._ctor_cache.get(code.ctor)
        if cached is None:
            cached = eval(code.ctor, ns)
            self._ctor_cache[code.ctor] = cached
            if len(self._ctor_cache) > 300:
                self._ctor_cache.popitem(last=False)
        else:
            self._ctor_cache.move_to_end(code.ctor)
        return cached.copy()

    def _scene(self, job: PreviewJob):
        """The scene class, created and set up like the exported script does it (cached: grids take a while).

        Returns (scene, error). On failure the scene is a plain one and `error` says what went wrong."""
        from manim import tempconfig

        key = (job.scene_class, tuple(job.setup), job.background, self.width, self.height)
        cached = self._scenes.get(key)
        if cached is not None:
            self._scenes.move_to_end(key)
            return cached
        # dry_run: no movie files or folders; the pixel size is the preview's.
        with tempconfig({"dry_run": True, "pixel_width": self.width, "pixel_height": self.height}):
            try:
                ns = dict(self._base_ns)
                exec(job.scene_class or "class _ManimatorPreview(Scene):\n    pass\n", ns)
                scene = ns["_ManimatorPreview"]()
                scene.setup()
                ns["self"] = scene
                for line in job.setup:
                    exec(line, ns)
                result = (scene, None)
            except Exception as e:  # noqa: BLE001 - shown to the user; the objects are still drawn
                fallback = self._base_ns["Scene"]()
                fallback.camera.background_color = job.background
                result = (fallback, f"Scene setup failed: {_describe(e)}")
        self._scenes[key] = result
        if len(self._scenes) > 4:
            self._scenes.popitem(last=False)
        return result

    def _build(self, job: PreviewJob) -> tuple[dict[str, object], dict[str, str]]:
        ns = dict(self._base_ns)
        built: dict[str, object] = {}
        errors: dict[str, str] = {}
        for code in job.codes:
            broken = code.deps & (set(errors) | {c.mob_id for c in job.codes if c.error})
            if code.error:
                errors[code.mob_id] = code.error
                continue
            if broken:
                errors[code.mob_id] = "depends on an object that failed to build"
                continue
            try:
                mob = self._construct(code, ns)
                ns[code.var] = mob
                for line in code.post:
                    exec(line, ns)
                built[code.mob_id] = mob
            except Exception as e:  # show the problem on the object, keep the rest
                errors[code.mob_id] = _describe(e)
        return built, errors

    def render(self, job: PreviewJob) -> PreviewResult:
        t0 = time.perf_counter()
        built, errors = self._build(job)
        scene, scene_error = self._scene(job)
        camera = scene.camera
        three_d = hasattr(camera, "fixed_in_frame_mobjects")
        fixed = {FIXED_IN_FRAME: [], FIXED_ORIENTATION: []}
        if three_d:
            for mob_id, how in job.fixed.items():
                if mob_id in built:
                    fixed[how].append(built[mob_id])

        drawn = []
        for mob_id in job.layer_order:
            mob = built.get(mob_id)
            if mob is None:
                continue
            if mob_id in job.ghost_ids:
                mob.fade(GHOST_FADE)
            drawn.append(mob)
        # The scene's own objects (grids, basis vectors...) go underneath; foreground ones (the zoom lens and
        # its display) on top, as Scene.add keeps them.
        front = list(dict.fromkeys(scene.foreground_mobjects))
        back = [m for m in dict.fromkeys(scene.mobjects) if not any(m is f for f in front)]

        if three_d:
            camera.add_fixed_in_frame_mobjects(*fixed[FIXED_IN_FRAME])
            camera.add_fixed_orientation_mobjects(*fixed[FIXED_ORIENTATION])
        try:
            camera.reset()
            camera.capture_mobjects(back + drawn + front)
            image = camera.get_image().convert("RGBA")
            boxes = {}
            for mob_id, mob in built.items():
                try:
                    boxes[mob_id] = _screen_box(camera, mob, three_d)
                except Exception:
                    pass
        finally:
            if three_d:
                camera.remove_fixed_in_frame_mobjects(*fixed[FIXED_IN_FRAME])
                camera.remove_fixed_orientation_mobjects(*fixed[FIXED_ORIENTATION])
        frame = getattr(camera, "frame", None)
        if frame is not None and not three_d:
            x, y = frame.get_center()[:2]
            view = (float(x), float(y), float(frame.width))
        else:
            view = (0.0, 0.0, float(camera.frame_width))
        return PreviewResult(
            token=job.token,
            width=image.width,
            height=image.height,
            rgba=image.tobytes("raw", "RGBA"),
            boxes=boxes,
            errors=errors,
            seconds=time.perf_counter() - t0,
            view=view,
            scene_error=scene_error,
        )

    def render_icon(self, type_key: str, size: int = 96) -> tuple[bytes, int, int]:
        """A transparent thumbnail of a default object of this type, for the palette."""
        from manim import DEGREES, Camera, Group
        from manim.camera.three_d_camera import ThreeDCamera

        from manimator.model import ops
        from manimator.registry import MOBJECTS

        project = Project.new()
        scene = project.scenes[0]
        target = None
        if MOBJECTS[type_key].needs_target:
            anchor = ops.create_mobject(scene, "Text")
            anchor.params["text"] = "Ab"
            anchor.style["opacity"] = 0.35
            target = anchor.id
        item = ops.create_mobject(scene, type_key, 0, 0, target)
        item.params.update(_ICON_SAMPLES.get(type_key, {}))
        three_d = MOBJECTS[type_key].three_d
        built, _errors = self._build(PreviewJob.from_scene(scene, project))
        mobs = [built[m.id] for m in scene.mobjects if m.id in built]
        if not mobs:
            raise ValueError(f"could not build {type_key}")
        # Scale the objects (not the camera) so strokes keep their normal on-screen width.
        group = Group(*mobs).move_to([0, 0, 0])
        group.scale((1.6 if three_d else 2.2) / max(group.width, group.height, 0.2))
        if three_d:
            camera = ThreeDCamera(pixel_width=size, pixel_height=size, frame_width=2.6, frame_height=2.6,
                                  background_color="#000000", background_opacity=0,
                                  phi=70 * DEGREES, theta=-50 * DEGREES)
        else:
            camera = Camera(pixel_width=size, pixel_height=size, frame_width=2.6, frame_height=2.6,
                            background_color="#000000", background_opacity=0)
        camera.capture_mobjects(mobs)
        image = camera.get_image().convert("RGBA")
        return image.tobytes("raw", "RGBA"), image.width, image.height


_ICON_SAMPLES = {
    "Text": {"text": "Aa"},
    "MarkupText": {"text": "<b>A</b><i>a</i>"},
    "MathTex": {"tex": r"\sum x^2"},
    "Tex": {"tex": r"\TeX"},
    "Line": {"start": [-1.0, -0.6], "end": [1.0, 0.6]},
    "Arrow": {"start": [-1.0, -0.6], "end": [1.0, 0.6]},
    "DoubleArrow": {"start": [-1.0, -0.6], "end": [1.0, 0.6]},
    "DashedLine": {"start": [-1.0, -0.6], "end": [1.0, 0.6]},
    "NumberLine": {"x_range": [-3.0, 3.0, 1.0], "length": 6.0},
    "NumberPlane": {"x_range": [-3.0, 3.0, 1.0], "y_range": [-3.0, 3.0, 1.0]},
    "Axes": {"x_range": [-3.0, 3.0, 1.0], "y_range": [-3.0, 3.0, 1.0], "x_length": 6.0, "y_length": 6.0},
}


def _screen_box(camera, mob, three_d: bool) -> tuple[float, float, float, float]:
    """Where the object is drawn, in scene units (for a 3D camera: after projecting it, as the camera does)."""
    import numpy as np

    if three_d:
        pts = [camera.transform_points_pre_display(m, m.points) for m in mob.family_members_with_points()]
        pts = np.concatenate([p for p in pts if len(p)])[:, :2]
        (x0, y0), (x1, y1) = pts.min(axis=0), pts.max(axis=0)
    else:
        x0, y0 = mob.get_corner([-1, -1, 0])[:2]
        x1, y1 = mob.get_corner([1, 1, 0])[:2]
    return float(x0), float(y0), float(x1), float(y1)


def _describe(e: Exception) -> str:
    msg = str(e).strip().splitlines()
    text = msg[0] if msg else ""
    if "latex" in text.lower() or "tex" in type(e).__name__.lower():
        return "LaTeX error - check the formula"
    return f"{type(e).__name__}: {text}"[:300]


def frame_size() -> tuple[float, float]:
    from manim import config

    return float(config.frame_width), float(config.frame_height)
