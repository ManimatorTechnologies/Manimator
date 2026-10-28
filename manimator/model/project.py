"""The project data model. Everything here is plain data that round-trips through JSON."""

from __future__ import annotations

import copy
import json
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

# 2: scene kinds (Scene.kind/options) replaced the three_d/phi/theta fields.
# 3: DashedLine's dash_length default became 0.05, Manim's own. Code left 0.1 out as the default, so Manim always
#    drew 0.05: a saved 0.1 (or none) becomes 0.05, which looks the same and now also does in the browser.
FILE_VERSION = 3
FILE_SUFFIX = ".manimator"
OLD_FILE_SUFFIX = ".manimproj"  # until 2026-10-14; projects kept on a server under this name are renamed when opened


def new_id() -> str:
    return uuid.uuid4().hex[:10]


@dataclass
class MethodCall:
    method: str
    args: dict = field(default_factory=dict)


@dataclass
class MobjectItem:
    id: str
    type: str
    name: str  # Python variable name in the generated code
    params: dict = field(default_factory=dict)
    style: dict = field(default_factory=dict)
    position: list = field(default_factory=lambda: [0.0, 0.0])
    rotation: float = 0.0  # degrees, counter-clockwise
    scale: float = 1.0
    z_index: int = 0
    z: float = 0.0  # height above the screen plane; only 3D objects use it
    on_screen_at_start: bool = True
    methods: list[MethodCall] = field(default_factory=list)
    fixed: str = ""  # 3D scenes: "", "in_frame" or "orientation" (see registry/scenes.py)
    transform_role: str = ""  # LinearTransformationScene: "" = automatic, or one of scenes.TRANSFORM_ROLES


@dataclass
class AnimationItem:
    anim: str
    target: str | None  # mobject id
    params: dict = field(default_factory=dict)
    method: str | None = None  # only for anim == "Animate"


PLAY = "play"
WAIT = "wait"


@dataclass
class Step:
    kind: str = PLAY
    animations: list[AnimationItem] = field(default_factory=list)
    run_time: float = 1.0
    rate_func: str = "default"
    lag_ratio: float = 0.0  # > 0 staggers the animations with LaggedStart
    duration: float = 1.0  # wait steps only


@dataclass
class Scene:
    id: str
    name: str
    mobjects: list[MobjectItem] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)
    kind: str = "Scene"  # the Manim scene class (registry/scenes.py)
    options: dict = field(default_factory=dict)  # that kind's settings; missing ones use their defaults

    def mob(self, mob_id: str | None) -> MobjectItem | None:
        return next((m for m in self.mobjects if m.id == mob_id), None)

    def mob_index(self, mob_id: str) -> int:
        return next((i for i, m in enumerate(self.mobjects) if m.id == mob_id), -1)


@dataclass
class Settings:
    background: str = "#000000"
    quality: str = "m"  # manim -q flag: l, m, h, p, k


@dataclass
class Project:
    scenes: list[Scene] = field(default_factory=list)
    settings: Settings = field(default_factory=Settings)
    version: int = FILE_VERSION
    # the Code view's script and its data files: {"text": str, "files": [{"name": shown name, "asset": stored name}]};
    # None until the project is first opened as code (and then left out of the file)
    code: dict | None = None

    @classmethod
    def new(cls) -> Project:
        return cls(scenes=[Scene(id=new_id(), name="Scene1")])

    def scene(self, scene_id: str | None) -> Scene | None:
        return next((s for s in self.scenes if s.id == scene_id), None)

    # ------------------------------------------------------------------ JSON
    def to_dict(self) -> dict:
        data = asdict(self)
        if data["code"] is None:
            del data["code"]
        return data

    @classmethod
    def from_dict(cls, data: dict) -> Project:
        data = copy.deepcopy(data)
        version = data.get("version", FILE_VERSION)
        if version > FILE_VERSION:
            raise ValueError(f"This project was made with a newer Manimator (file version {version}).")
        scenes = []
        for s in data.get("scenes", []):
            if version < 3:
                for m in s.get("mobjects", []):
                    if m.get("type") == "DashedLine" and isinstance(m.get("params"), dict)                             and m["params"].get("dash_length", 0.1) == 0.1:
                        m["params"]["dash_length"] = 0.05
            mobjects = [
                MobjectItem(
                    **{k: v for k, v in m.items() if k != "methods"},
                    methods=[MethodCall(**c) for c in m.get("methods", [])],
                )
                for m in s.get("mobjects", [])
            ]
            steps = [
                Step(
                    **{k: v for k, v in st.items() if k != "animations"},
                    animations=[AnimationItem(**a) for a in st.get("animations", [])],
                )
                for st in s.get("steps", [])
            ]
            options = dict(s.get("options") or {})
            kind = s.get("kind")
            if kind is None:  # version 1: a 3D switch and the camera angles
                kind = "ThreeDScene" if s.get("three_d") else "Scene"
                for name in ("phi", "theta"):
                    if name in s:
                        options[name] = s[name]
            scenes.append(Scene(id=s["id"], name=s["name"], mobjects=mobjects, steps=steps, kind=kind,
                                options=options))
        settings = Settings(**data.get("settings", {}))
        code = data.get("code")
        if isinstance(code, dict):
            files = [{"name": str(f["name"]), "asset": str(f["asset"])} for f in code.get("files") or []
                     if isinstance(f, dict) and f.get("name") and f.get("asset")]
            code = {"text": str(code.get("text") or ""), "files": files}
        else:
            code = None
        return cls(scenes=scenes, settings=settings, version=FILE_VERSION, code=code)

    def save(self, path: str | Path) -> None:
        text = json.dumps(self.to_dict(), indent=2)
        Path(path).write_text(text, encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> Project:
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
