"""Zip a customization's folder (manifest.json, kit.js, kit.py, README.md) into a .manimkit file, checked the way the
server checks uploads (server/kits.py).

    python tools/make_kit.py examples/kits/battery            -> examples/kits/battery.manimkit
    python tools/make_kit.py --examples                       -> every example, also into web/kits/ for download
    python tools/make_kit.py --fixture                        -> tests/js/fixtures/kits.json (needs Manim)
"""

from __future__ import annotations

import io
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from manimator.server.kits import FILE_LIMITS, SUFFIX, check_javascript, check_python, read_manifest, read_package  # noqa: E402

EXAMPLES = ROOT / "examples" / "kits"
DOWNLOADS = ROOT / "manimator" / "web" / "kits"  # served at /static/kits/, offered on the Customizations page


def build(folder: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in FILE_LIMITS:
            if (folder / name).is_file():
                z.writestr(name, (folder / name).read_text(encoding="utf-8"))
    data = buf.getvalue()
    files = read_package(data)  # the checks an upload gets
    manifest = read_manifest(files["manifest.json"])
    check_python(files["kit.py"], manifest["class"])
    check_javascript(files["kit.js"])
    return data


def write_fixture() -> None:
    """tests/js/fixtures/kits.json: a scene plan using both examples (two Batteries popping in), and Manim's own
    Battery (the example's kit.py) to compare the engine's kit.js with."""
    import json
    import runpy
    import tempfile

    sys.path.insert(0, str(ROOT / "tools"))
    from make_js_fixtures import mobject_state

    from manimator.plan import scene_plan
    from manimator.registry.custom import kit_type
    from manimator.server.kits import KitStore
    from manimator.server.session import Session

    with tempfile.TemporaryDirectory() as d:
        store = KitStore(Path(d))
        battery = kit_type(store.add("o", "Ada", build(EXAMPLES / "battery"), 5)["id"], 1)
        pop = kit_type(store.add("o", "Ada", build(EXAMPLES / "pop_in"), 5)["id"], 1)
        s = Session(kits=lambda key: None)
        sid = s.project.scenes[0].id
        full = s.apply("add_mobject", {"scene_id": sid, "type": battery, "x": -3})
        low = s.apply("add_mobject", {"scene_id": sid, "type": battery, "x": 3})
        s.apply("set_param", {"scene_id": sid, "mob_id": low, "name": "charge", "value": 0.15})
        s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": full})
        s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": low})
        plan = scene_plan(s.project.scenes[0], s.project)
        store.close()
    battery_cls = runpy.run_path(str(EXAMPLES / "battery" / "kit.py"))["Battery"]
    data = {"plan": plan, "manim": {"battery_full": mobject_state(battery_cls(charge=0.7)),
                                    "battery_low": mobject_state(battery_cls(charge=0.15))}}
    target = ROOT / "tests" / "js" / "fixtures" / "kits.json"
    target.write_text(json.dumps(data, indent=1), encoding="utf-8")
    print(target)


def main(args: list[str]) -> None:
    if args == ["--fixture"]:
        write_fixture()
        return
    folders = sorted(p for p in EXAMPLES.iterdir() if p.is_dir()) if args == ["--examples"] else [Path(a) for a in args]
    if not folders:
        raise SystemExit(__doc__)
    for folder in folders:
        target = folder.parent / f"{folder.name}{SUFFIX}"
        target.write_bytes(build(folder))
        print(f"{target} ({target.stat().st_size} bytes)")
        if args == ["--examples"]:
            DOWNLOADS.mkdir(exist_ok=True)
            shutil.copyfile(target, DOWNLOADS / target.name)


if __name__ == "__main__":
    main(sys.argv[1:])
