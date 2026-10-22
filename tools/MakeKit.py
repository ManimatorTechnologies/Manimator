"""Zip a customization's folder (manifest.json, kit.js, kit.py, README.md) into a .manimkit file, checked the way the
server checks uploads (server/kits.py).

    python tools/MakeKit.py tests/Kits/Battery     -> tests/Kits/Battery.manimkit
    python tools/MakeKit.py --examples             -> the downloadable example (Battery) into web/kits/
    python tools/MakeKit.py --fixture              -> tests/js/fixtures/Kits.json (needs Manim)

The examples are written in the ManimKit repo; tests/Kits holds copies of them. After changing one there, copy its
folder into tests/Kits and run --examples (and --fixture for Battery or Refraction).
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from manimator.server.kits import FILE_LIMITS, SUFFIX, check_javascript, check_python, read_manifest, read_package  # noqa: E402

EXAMPLES = ROOT / "tests" / "Kits"
DOWNLOADS = ROOT / "manimator" / "web" / "kits"  # served at /static/kits/, offered on the Customizations page
OFFERED = ["Battery"]  # the one example the docs offer for download (the others stay test kits)

# How Manim plays the Refraction example's animations, for tests/js/kits.test.mjs: [name, the refraction's settings,
# what is done to it first (method, args), the animation, its settings, the alphas to record]. Labels off: no LaTeX.
REFRACTION_CASES = [
    ["shine", {}, [], "Shine", {}, [0, 0.3, 0.55, 0.8, 1]],
    ["shine_from_below", {"source": "bottom", "n2": 1.5, "theta": 30}, [], "Shine", {}, [0.55, 0.8, 1]],
    ["sweep", {}, [], "SweepAngle", {"to": 70}, [0.5, 1]],
    ["sweep_past_critical", {"theta": 20, "source": "bottom", "n2": 1.5}, [], "SweepAngle", {"to": 60},
     [0.4, 0.7, 1]],
    ["sweep_without_reflection", {"theta": -20, "n1": 1.5, "n2": 1, "reflection": False}, [], "SweepAngle",
     {"to": -60}, [0.5, 1]],
    ["sweep_placed", {}, [["scale", [0.5]], ["rotate", [30]], ["shift", [[1, -1, 0]]]], "SweepAngle", {"to": -30},
     [0.5, 1]],
]


def build(folder: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in FILE_LIMITS:
            if (folder / name).is_file():
                z.writestr(name, (folder / name).read_text(encoding="utf-8"))
    data = buf.getvalue()
    files = read_package(data)  # the checks an upload gets
    manifest = read_manifest(files["manifest.json"])
    check_python(files["kit.py"], manifest["classes"])
    check_javascript(files["kit.js"], manifest["classes"])
    return data


def refraction_states(mobject_state) -> dict:
    """REFRACTION_CASES as Manim plays them: {name: [the refraction's state at each alpha]}."""
    import runpy

    from manim import DEGREES

    kit = runpy.run_path(str(EXAMPLES / "Refraction" / "kit.py"))
    out = {}
    for name, settings, methods, anim, anim_settings, alphas in REFRACTION_CASES:
        kwargs = {**settings, "labels": False}
        kwargs.update({k: v * DEGREES for k, v in kwargs.items() if k == "theta"})
        mob = kit["Refraction"](**kwargs)
        for method, args in methods:
            getattr(mob, method)(*[a * DEGREES if method == "rotate" else a for a in args])
        animation = kit[anim](mob, **{k: v * DEGREES for k, v in anim_settings.items()})
        animation.begin()
        states = []
        for alpha in alphas:
            animation.interpolate(alpha)
            states.append(mobject_state(mob))
        if alphas[-1] == 1:
            animation.finish()
            states.append(mobject_state(mob))  # after finish(): as at 1
        out[name] = states
    return out


def write_fixture() -> None:
    """tests/js/fixtures/Kits.json: a scene plan using the Battery example (two Batteries popping in), Manim's own
    Battery (the example's kit.py) to compare the engine's kit.js with, and Manim playing the Refraction example's
    animations (REFRACTION_CASES)."""
    import json
    import runpy
    import tempfile

    sys.path.insert(0, str(ROOT / "tools"))
    from MakeJsFixtures import mobject_state

    from manimator.plan import scene_plan
    from manimator.registry.custom import kit_type
    from manimator.server.kits import KitStore
    from manimator.server.session import Session

    with tempfile.TemporaryDirectory() as d:
        store = KitStore(Path(d))
        kit_id = store.add("o", "Ada", build(EXAMPLES / "Battery"), 5)["id"]
        battery, pop = kit_type(kit_id, 1), kit_type(kit_id, 1, "PopIn")
        s = Session(kits=lambda key: None)
        sid = s.project.scenes[0].id
        full = s.apply("add_mobject", {"scene_id": sid, "type": battery, "x": -3})
        low = s.apply("add_mobject", {"scene_id": sid, "type": battery, "x": 3})
        s.apply("set_param", {"scene_id": sid, "mob_id": low, "name": "charge", "value": 0.15})
        s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": full})
        s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": low})
        plan = scene_plan(s.project.scenes[0], s.project)
        store.close()
    battery_cls = runpy.run_path(str(EXAMPLES / "Battery" / "kit.py"))["Battery"]
    data = {"plan": plan, "manim": {"battery_full": mobject_state(battery_cls(charge=0.7)),
                                    "battery_low": mobject_state(battery_cls(charge=0.15))},
            "refraction_cases": REFRACTION_CASES, "refraction": refraction_states(mobject_state)}
    target = ROOT / "tests" / "js" / "fixtures" / "Kits.json"
    target.write_text(json.dumps(data, indent=1), encoding="utf-8")
    print(target)


def main(args: list[str]) -> None:
    if args == ["--fixture"]:
        write_fixture()
        return
    folders = [EXAMPLES / name for name in OFFERED] if args == ["--examples"] else [Path(a) for a in args]
    if not folders:
        raise SystemExit(__doc__)
    for folder in folders:
        target = (DOWNLOADS if args == ["--examples"] else folder.parent) / f"{folder.name}{SUFFIX}"
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(build(folder))
        print(f"{target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main(sys.argv[1:])
