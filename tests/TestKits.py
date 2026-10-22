"""Customizations: custom objects and their animations, uploaded as code packages (.manimkit, server/kits.py)."""

import io
import json
import re
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from manimator import codegen, export
from manimator.model import ops
from manimator.model.project import Project
from manimator.plan import scene_plan
from manimator.registry import ANIMATIONS, MOBJECTS
from manimator.registry.custom import UNAVAILABLE, kit_type
from manimator.server import kits as kits_module
from manimator.server.api import create_app
from manimator.server.catalog import catalog
from manimator.server.kits import (
    KitError, KitStore, check_javascript, check_python, demo_project, read_manifest, read_package,
)
from manimator.server.session import OpError, Session
from manimator.server.web import WebConfig
from tests.TestWeb import HEADERS

EXAMPLES = Path(__file__).resolve().parent / "Kits"  # copies of the example kits in the ManimKit repo
OLD = Path(__file__).resolve().parent / "OldKits"  # packages in the first format (one class), as uploaded before
SEND = {**HEADERS, "Content-Type": "application/octet-stream"}


def _folder(folder) -> Path:
    return folder if isinstance(folder, Path) else EXAMPLES / folder


def package(folder="Battery", **changes) -> bytes:
    """An example package as a .manimkit, with some files replaced (None drops one)."""
    files = {p.name: p.read_text(encoding="utf-8") for p in _folder(folder).iterdir() if p.is_file()}
    for name, text in changes.items():
        name = name.replace("_", ".", 1) if name in ("manifest_json", "kit_js", "kit_py", "README_md") else name
        if text is None:
            files.pop(name, None)
        else:
            files[name] = text
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


def manifest(folder="Battery", edit=None, **changes) -> str:
    """An example's manifest.json with top-level fields changed, then `edit(manifest)` (for the nested ones)."""
    m = json.loads((_folder(folder) / "manifest.json").read_text(encoding="utf-8"))
    m.update(changes)
    if edit is not None:
        edit(m)
    return json.dumps(m)


def renamed(cls: str, *animations: str):
    """An edit giving the object (and its animations, in order) other class names, and the package the object's."""
    def edit(m):
        m["name"] = m["object"]["class"] = cls
        for a, name in zip(m["animations"], animations):
            a["class"] = name
    return edit


def renamed_package(cls: str, *animations: str, folder="Battery") -> bytes:
    """An example package with its classes renamed in every file."""
    m = json.loads(manifest(folder))
    old = [m["object"]["class"], *(a["class"] for a in m["animations"])]
    code = {name: (EXAMPLES / folder / name).read_text(encoding="utf-8") for name in ("kit.js", "kit.py")}
    for before, after in zip(old, [cls, *animations]):
        code = {name: re.sub(rf"\b{before}\b", after, text) for name, text in code.items()}
    return package(folder, manifest_json=manifest(folder, edit=renamed(cls, *animations)), kit_js=code["kit.js"],
                   kit_py=code["kit.py"])


@pytest.fixture
def old_uploads(monkeypatch):
    """Lets the store take first-format packages, as it did before format 2 (to make the versions kept from then)."""
    monkeypatch.setattr(kits_module, "UPLOAD_FORMATS", (kits_module.OLD_FORMAT, kits_module.FORMAT))


# ---------------------------------------------------------------------- the package format


def test_the_examples_are_valid_packages():
    found = {}
    for folder in ("Battery", "NeuralNetwork", "Refraction"):
        files = read_package(package(folder))
        m = read_manifest(files["manifest.json"])
        check_python(files["kit.py"], m["classes"])
        check_javascript(files["kit.js"], m["classes"])
        found[folder] = m["classes"]
    assert found == {"Battery": ["Battery", "PopIn"], "NeuralNetwork": ["NeuralNetwork", "FeedForward"],
                     "Refraction": ["Refraction", "Shine", "SweepAngle"]}
    m = read_manifest(manifest())
    assert m["object"]["params"][0].default == 0.7 and m["animations"][0]["introducer"]
    assert (m["animations"][0]["name"], m["animations"][0]["run_time"]) == ("Pop in", 0.8)


@pytest.mark.parametrize("data, message", [
    (b"", "empty"),
    (b"not a zip at all", "zip"),
    (b"x" * (1024 * 1024 + 1), "up to 1024 KB"),
], ids=["empty", "not-zip", "too-big"])
def test_files_that_arent_packages_are_refused(data, message):
    with pytest.raises(KitError, match=message):
        read_package(data)


def test_a_package_holds_only_its_own_files():
    with pytest.raises(KitError, match="Unexpected file"):
        read_package(package(**{"../evil.py": "x"}))
    with pytest.raises(KitError, match="Unexpected file"):
        read_package(package(**{"extra.js": "x"}))
    with pytest.raises(KitError, match="needs kit.py"):
        read_package(package(kit_py=None))
    with pytest.raises(KitError, match="too large"):
        read_package(package(kit_js="//" + "x" * (256 * 1024)))
    # a folder zipped whole is fine
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name in ("manifest.json", "kit.js", "kit.py"):
            z.writestr(f"battery/{name}", (EXAMPLES / "Battery" / name).read_text(encoding="utf-8"))
    assert set(read_package(buf.getvalue())) == {"manifest.json", "kit.js", "kit.py"}


def test_a_zip_that_lies_about_its_size_is_refused():
    big = package(kit_js="export default 1;" + " " * (300 * 1024))
    with zipfile.ZipFile(io.BytesIO(big)) as z:
        info = z.getinfo("kit.js")
    # shrink the size the zip claims: reading stops at the limit anyway
    patched = big.replace(info.file_size.to_bytes(4, "little"), (100).to_bytes(4, "little"))
    with pytest.raises(KitError):
        read_package(patched)


def _set(path, value):
    """An edit setting manifest[path[0]][path[1]]... to value."""
    def edit(m):
        target = m
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
    return edit


POP = {"class": "Bounce", "params": []}


@pytest.mark.parametrize("changes, edit, message", [
    ({}, renamed("Circle"), "already a Manim or Manimator name"),
    ({}, renamed("battery"), "PascalCase"),
    ({}, renamed("Battery", "Battery"), "already a Manim or Manimator name"),  # an animation named as its object
    ({"manimkit": 1}, None, "must be 2.*isn't uploaded any more"),
    ({"manimkit": 3}, None, "must be 2"),
    ({"colour": "red"}, None, "unknown fields colour"),
    ({"kind": "object"}, None, "unknown fields kind"),
    ({"object": None}, None, "give the \"object\""),
    ({"description": "word " * 26}, None, "description can be up to 25 words"),
    ({"animations": {}}, None, "list of up to 10 animations"),
    ({"animations": [dict(POP, **{"class": f"Bounce{i}"}) for i in range(11)]}, None, "list of up to 10 animations"),
    ({"animations": [POP, POP]}, None, "\"Bounce\" is already"),
    ({"animations": [dict(POP, style="none")]}, None, r"animations\[0\]: unknown fields style"),
    ({"animations": [dict(POP, introducer=True, remover=True)]}, None, "can't both bring in and take away"),
    ({"animations": [dict(POP, run_time=100)]}, None, "between 0.05 and 60 seconds"),
    ({"animations": ["PopIn"]}, None, r"animations\[0\] must be an object"),
    ({}, _set(["object", "run_time"], 2), "object: unknown fields run_time"),
    ({}, _set(["object", "style"], "bold"), "style\" must be one of"),
    ({}, _set(["object", "params"], [{"name": "run_time", "kind": "float"}]), "lowercase Python name"),
    ({}, _set(["object", "params"], [{"name": "x", "kind": "mobref"}]), r"object.params\[0\].kind must be one of"),
    ({}, _set(["object", "params"], [{"name": "x", "kind": "float", "min": 0, "max": 1, "default": 5}]),
     "between min and max"),
    ({}, _set(["object", "params"], [{"name": "x", "kind": "enum"}]), "choices"),
    ({}, _set(["object", "params"], [{"name": "x", "kind": "float"}, {"name": "x", "kind": "int"}]), "same name"),
    ({}, _set(["animations", 0, "params"], [{"name": "x", "kind": "float"}, {"name": "x", "kind": "int"}]),
     r"two settings in animations\[0\].params have the same name"),
])
def test_manifest_mistakes_are_explained(changes, edit, message):
    with pytest.raises(KitError, match=message):
        read_manifest(manifest(edit=edit, **changes))


def test_a_long_description_kept_from_before_still_loads():
    words = "word " * 26
    assert read_manifest(manifest(description=words), stored=True)["description"] == words.strip()
    assert read_manifest(manifest(description="word " * 25))["description"]  # 25 is fine


def test_an_animation_is_named_after_its_class_unless_named():
    m = read_manifest(manifest(animations=[{"class": "SweepAngle"}, {"class": "PopIn", "name": "Pop!"},
                                           {"class": "XYZFade"}]))
    assert [a["name"] for a in m["animations"]] == ["Sweep angle", "Pop!", "XYZ fade"]
    assert read_manifest(manifest(animations=[]))["classes"] == ["Battery"]  # an object on its own is fine
    with pytest.raises(KitError, match="another of your customizations' classes"):
        read_manifest(manifest(), taken_names={"PopIn"})


def test_the_first_format_is_read_only_from_stored_versions():
    old = (OLD / "PopIn" / "manifest.json").read_text(encoding="utf-8")
    with pytest.raises(KitError, match="isn't uploaded any more"):
        read_manifest(old)
    m = read_manifest(old, stored=True)
    assert m["object"] is None and m["classes"] == ["PopIn"] and m["animations"][0]["name"] == "Pop in"
    battery = read_manifest((OLD / "Battery" / "manifest.json").read_text(encoding="utf-8"), stored=True)
    assert battery["object"]["class"] == "Battery" and battery["animations"] == []


def test_the_python_is_parsed_never_run():
    check_python("import os\nos.system('echo hi')\nclass Battery: pass\n", "Battery")  # fine: only parsed
    check_python("class Battery: pass\nclass PopIn: pass\n", ["Battery", "PopIn"])
    with pytest.raises(KitError, match="must define class PopIn"):
        check_python("class Battery: pass\n", ["Battery", "PopIn"])
    with pytest.raises(KitError, match="must define class Battery"):
        check_python("class Other: pass\n", "Battery")
    with pytest.raises(KitError, match="syntax error on line 1"):
        check_python("class Battery(:\n", "Battery")


def test_kit_js_exports_each_class_by_its_name():
    both = ["Battery", "PopIn"]
    check_javascript("export class Battery {}\nexport class PopIn {}\n", both)
    check_javascript("class Battery {}\nclass PopIn {}\nexport { Battery, PopIn };\n", both)
    with pytest.raises(KitError, match="must export class PopIn by its name"):
        check_javascript("export class Battery {}\nclass PopIn {}\n", both)
    with pytest.raises(KitError, match="must export class Battery"):
        check_javascript("export default class Battery {}\n", ["Battery"])
    check_javascript("export default class PopIn {}\n")  # the first format's one class
    with pytest.raises(KitError, match="may import only from"):
        check_javascript('import x from "https://evil.example/x.js";\nexport class Battery {}\n', ["Battery"])


# ---------------------------------------------------------------------- the registry


def store_with_examples(tmp_path):
    """A store with the Battery example: its object type and its Pop in animation's type."""
    store = KitStore(tmp_path)
    kit = store.add("owner-1", "Ada", package("Battery"), 5)
    return store, kit_type(kit["id"], 1), kit_type(kit["id"], 1, "PopIn")


def test_custom_types_are_found_but_not_listed(tmp_path):
    before = (len(MOBJECTS), len(ANIMATIONS), json.dumps(catalog(), sort_keys=True))
    store, battery, pop = store_with_examples(tmp_path)
    assert pop == f"{battery}:PopIn"
    assert battery in MOBJECTS and MOBJECTS[battery].kit["class"] == "Battery" and not MOBJECTS[battery].blocked
    assert ANIMATIONS[pop].call_name == "PopIn" and ANIMATIONS[pop].introducer and ANIMATIONS[pop].label == "Pop in"
    assert ANIMATIONS[pop].only == (battery,) and ANIMATIONS[pop].kit["object"] == battery
    assert MOBJECTS[battery].kit["module"] == ANIMATIONS[pop].kit["module"] == "battery"
    assert [s.key for s in store.specs(battery.split(":")[1], 1)] == [battery, pop]
    assert (len(MOBJECTS), len(ANIMATIONS), json.dumps(catalog(), sort_keys=True)) == before
    unknown = kit_type("0" * 12, 1)
    assert unknown in MOBJECTS and MOBJECTS[unknown].blocked and MOBJECTS.get("Nope") is None
    assert ANIMATIONS[f"{unknown}:Gone"].blocked
    # a new store (a server restart) finds them again
    store.close()
    MOBJECTS.custom.pop(battery)
    ANIMATIONS.custom.pop(pop)
    KitStore(tmp_path).close()
    assert MOBJECTS[battery].kit["name"] == "Battery" and ANIMATIONS[pop].only == (battery,)


def test_code_plans_and_the_zip_use_the_package(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    s.apply("set_param", {"scene_id": sid, "mob_id": b, "name": "charge", "value": 0.3})
    s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b})
    source = codegen.project_source(s.project)
    assert "from customizations.battery import Battery" in source
    assert "from customizations.battery import PopIn" in source
    assert "battery = Battery(charge=0.3)" in source and "PopIn(battery)" in source
    plan = scene_plan(s.project.scenes[0], s.project)
    assert [(k["class"], k["kind"], k["export"]) for k in plan["kits"]] == [("Battery", "object", "Battery"),
                                                                          ("PopIn", "animation", "PopIn")]
    assert plan["kits"][0]["js"] == plan["kits"][1]["js"] and plan["kits"][0]["js_sha256"]
    assert plan["objects"][0]["call"]["call"] == "Battery" and not plan["objects"][0]["error"]
    assert ops.screen_states(s.project.scenes[0])[0] == set()  # PopIn brings the battery in, as declared
    name, data = export.export_zip(s.project, "Charge", lambda _n: None, lambda kid, v: store.file(kid, v, "kit.py"))
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()
        readme = z.read("Charge/README.txt").decode()
        module = z.read("Charge/customizations/battery.py").decode()
    assert sorted(n for n in names if "/customizations/" in n) == ["Charge/customizations/__init__.py",
                                                                    "Charge/customizations/battery.py"]
    assert module.startswith("# Battery 1.1 by Ada (MIT). A Manimator customization.\nfrom manim import *")
    assert "class PopIn(Animation)" in module
    assert "customizations/battery.py   Battery 1.1 by Ada (MIT)" in readme and "read the files" in readme


def test_an_objects_animations_play_only_on_it(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    square = s.apply("add_mobject", {"scene_id": sid, "type": "Square"})
    with pytest.raises(OpError, match="Pop in plays only on Battery"):
        s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": square})
    step = s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b})
    with pytest.raises(OpError, match="plays only on Battery"):
        s.apply("add_animation_to_step", {"scene_id": sid, "step": step, "anim": pop, "target_id": square})
    with pytest.raises(OpError, match="plays only on Battery"):
        s.apply("set_animation_target", {"scene_id": sid, "step": step, "index": 0, "target_id": square})
    fade = s.apply("add_play_step", {"scene_id": sid, "anim": "FadeIn", "target_id": square})
    with pytest.raises(OpError, match="plays only on Battery"):
        s.apply("change_animation", {"scene_id": sid, "step": fade, "index": 0, "anim": pop})
    other = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    s.apply("set_animation_target", {"scene_id": sid, "step": step, "index": 0, "target_id": other})  # a Battery
    s.apply("change_animation", {"scene_id": sid, "step": step, "index": 0, "anim": "FadeIn"})
    s.apply("set_animation_target", {"scene_id": sid, "step": step, "index": 0, "target_id": square})


def test_only_the_owner_may_add_their_packages(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    s = Session(kits=lambda key: store.check_use("someone-else", 10, key))
    with pytest.raises(OpError, match="isn't yours"):
        s.apply("add_mobject", {"scene_id": s.project.scenes[0].id, "type": battery})
    none = Session(kits=lambda key: store.check_use("owner-1", 0, key))  # a plan without customizations
    with pytest.raises(OpError, match="aren't part of this plan"):
        none.apply("add_mobject", {"scene_id": none.project.scenes[0].id, "type": battery})
    plain = Session()  # where customizations aren't switched on
    with pytest.raises(OpError, match="aren't available"):
        plain.apply("add_mobject", {"scene_id": plain.project.scenes[0].id, "type": battery})
    with pytest.raises(OpError, match="doesn't exist"):  # a class the package doesn't have
        store.check_use("owner-1", 10, f"{battery}:Nope")


def test_an_unavailable_package_never_empties_a_project(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    s.apply("set_param", {"scene_id": sid, "mob_id": b, "name": "charge", "value": 0.3})
    s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b, "index": 0})
    data = s.project.to_dict()
    MOBJECTS.custom.pop(battery)  # its package is gone (not on this server, or taken down)
    ANIMATIONS.custom.pop(pop)
    try:
        loaded = Session(limits=Session().limits or __import__("manimator.server.session", fromlist=["x"]).ProjectLimits())
        loaded.load(Project.from_dict(json.loads(json.dumps(data))))
        item = loaded.project.scenes[0].mobjects[0]
        assert item.type == battery and item.params == {"charge": 0.3}  # kept as it was
        assert loaded.project.scenes[0].steps[0].animations[0].anim == pop
        plan = scene_plan(loaded.project.scenes[0], loaded.project)
        assert plan["objects"][0]["error"] == UNAVAILABLE and "kits" not in plan
        assert "VMobject()" in codegen.project_source(loaded.project)
    finally:
        KitStore(tmp_path).close()  # registered again


def test_two_packages_with_one_class_or_module_cant_share_a_project(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    other = store.add("owner-2", "Bo", package("Battery"), 5)  # another author's Battery
    cells = store.add("owner-2", "Bo", renamed_package("Cell", "Grow"), 5)
    caps = store.add("owner-3", "Cy", renamed_package("CELL", "Shrink"), 5)
    s = Session(kits=lambda key: None)
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    with pytest.raises(OpError, match="another customization called Battery"):
        s.apply("add_mobject", {"scene_id": sid, "type": kit_type(other["id"], 1)})
    s.apply("add_mobject", {"scene_id": sid, "type": battery})  # the same one again is fine
    s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b})  # and its own animation
    s.apply("add_mobject", {"scene_id": sid, "type": kit_type(cells["id"], 1)})
    # both would be customizations/cell.py in the download
    with pytest.raises(OpError, match="another customization called Cell"):
        s.apply("add_mobject", {"scene_id": sid, "type": kit_type(caps["id"], 1)})


def test_versions_and_deleting(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    kid = battery.split(":")[1]
    newer = package(manifest_json=manifest(version="1.2", description="Now with more charge"))
    store.add("owner-1", "Ada", newer, 5, kid)
    assert [v["label"] for v in store.summary(store.kit(kid))["versions"]] == ["1.1", "1.2"]
    assert {s.key for s in store.usable("owner-1")} == {kit_type(kid, 2), kit_type(kid, 2, "PopIn")}
    assert ANIMATIONS[kit_type(kid, 2, "PopIn")].only == (kit_type(kid, 2),)  # each version's on its own object
    with pytest.raises(KitError, match="another of your customizations' classes"):  # its PopIn is taken
        store.add("owner-1", "Ada", package(manifest_json=manifest(edit=renamed("Cell"))), 5)
    # its animations may change; its object stays
    alone = package(manifest_json=manifest(version="1.3", animations=[]))
    store.add("owner-1", "Ada", alone, 5, kid)
    assert store.summary(store.kit(kid))["animations"] == [] and store.classes(kid) == {"Battery"}
    with pytest.raises(KitError, match="must keep the object Battery"):
        store.add("owner-1", "Ada", package(manifest_json=manifest(edit=renamed("Cell"))), 5, kid)
    with pytest.raises(KitError, match="isn't yours"):
        store.add("owner-2", "Bo", newer, 5, kid)
    with pytest.raises(KitError, match="up to 1 customization. "):
        store.add("owner-1", "Ada", package(manifest_json=manifest(edit=renamed("Cell"))), 1)
    store.unlist("owner-1", kid)
    assert kid not in {k["id"] for k in store.owned("owner-1")}
    assert MOBJECTS[battery].kit["class"] == "Battery" and ANIMATIONS[pop].call_name == "PopIn"  # projects keep working


def test_the_summary_lists_the_shown_versions_animations(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    kid = battery.split(":")[1]
    store.add("owner-1", "Ada", package(manifest_json=manifest(version="1.2", animations=[])), 5, kid)
    assert store.summary(store.kit(kid))["animations"] == []
    first = store.summary(store.kit(kid), "owner-1", 1)
    assert first["type"] == battery and first["mine"]
    assert first["animations"] == [{"type": pop, "class": "PopIn", "name": "Pop in",
                                    "description": "Grow from nothing, a little past full size, and settle"}]


def test_demo_scenes_show_the_object_or_one_of_its_animations(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    scene = demo_project(battery).scenes[0]
    assert [m.type for m in scene.mobjects] == [battery] and scene.steps[0].animations[0].anim == "FadeIn"
    scene = demo_project(pop).scenes[0]
    assert [m.type for m in scene.mobjects] == [battery] and scene.steps[0].animations[0].anim == pop
    assert not scene.mobjects[0].on_screen_at_start  # Pop in brings it in


# ---------------------------------------------------------------------- packages in the first format


def test_first_format_packages_keep_working(tmp_path, old_uploads):
    store = KitStore(tmp_path)
    old_pop = kit_type(store.add("owner-1", "Ada", package(OLD / "PopIn"), 5)["id"], 1)
    old_battery = kit_type(store.add("owner-1", "Ada", package(OLD / "Battery"), 5)["id"], 1)
    assert ANIMATIONS[old_pop].only == () and ANIMATIONS[old_pop].kit["export"] == "default"  # plays on anything
    assert MOBJECTS[old_battery].kit["module"] == "battery" and ANIMATIONS[old_pop].kit["module"] == "pop_in"
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    square = s.apply("add_mobject", {"scene_id": sid, "type": "Square"})
    b = s.apply("add_mobject", {"scene_id": sid, "type": old_battery})
    s.apply("add_play_step", {"scene_id": sid, "anim": old_pop, "target_id": square})
    s.apply("add_play_step", {"scene_id": sid, "anim": old_pop, "target_id": b})
    plan = scene_plan(s.project.scenes[0], s.project)
    # their entries stay as they were (no "export"), so plans that use them keep their hashes and stored renders
    assert [sorted(k) for k in plan["kits"]] == [["class", "js", "js_sha256", "kind", "type"]] * 2
    assert "from customizations.pop_in import PopIn" in codegen.project_source(s.project)
    assert [m.type for m in demo_project(old_pop).scenes[0].mobjects] == ["Square"]
    assert store.summary(store.kit(old_pop.split(":")[1]))["animations"] == []
    # stored ones load after a restart, though new uploads must be format 2
    store.close()
    MOBJECTS.custom.pop(old_battery)
    ANIMATIONS.custom.pop(old_pop)
    kits_module.UPLOAD_FORMATS = (kits_module.FORMAT,)
    store = KitStore(tmp_path)
    assert MOBJECTS[old_battery].kit["class"] == "Battery" and ANIMATIONS[old_pop].call_name == "PopIn"
    with pytest.raises(KitError, match="isn't uploaded any more"):
        store.add("owner-1", "Ada", package(OLD / "PopIn"), 5)


def test_an_old_object_gets_new_versions_with_animations(tmp_path, old_uploads):
    store = KitStore(tmp_path)
    kid = store.add("owner-1", "Ada", package(OLD / "Battery"), 5)["id"]
    kits_module.UPLOAD_FORMATS = (kits_module.FORMAT,)
    store.add("owner-1", "Ada", package("Battery"), 5, kid)  # the same object, now with Pop in
    assert {s.key for s in store.usable("owner-1")} == {kit_type(kid, 2), kit_type(kid, 2, "PopIn")}
    assert ANIMATIONS[kit_type(kid, 2, "PopIn")].only == (kit_type(kid, 2),)
    assert MOBJECTS[kit_type(kid, 1)].kit["export"] == "default"  # the old version as it was


def test_an_old_animation_on_its_own_gets_no_new_versions(tmp_path, old_uploads):
    store = KitStore(tmp_path)
    kid = store.add("owner-1", "Ada", package(OLD / "PopIn"), 5)["id"]
    kits_module.UPLOAD_FORMATS = (kits_module.FORMAT,)
    with pytest.raises(KitError, match="animation on its own .* can't get new versions"):
        store.add("owner-1", "Ada", package("Battery"), 5, kid)


# ---------------------------------------------------------------------- moving a project to a newer version


def test_an_old_object_moves_to_a_newer_version_and_gets_its_animations(tmp_path, old_uploads):
    store = KitStore(tmp_path)
    kid = store.add("owner-1", "Ada", package(OLD / "Battery"), 5)["id"]  # the first format: an object alone
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": kit_type(kid, 1)})
    s.apply("set_param", {"scene_id": sid, "mob_id": b, "name": "charge", "value": 0.3})
    s.apply("add_play_step", {"scene_id": sid, "anim": "FadeIn", "target_id": b})
    kits_module.UPLOAD_FORMATS = (kits_module.FORMAT,)
    store.add("owner-1", "Ada", package("Battery"), 5, kid)  # version 2: with Pop in
    pop = kit_type(kid, 2, "PopIn")
    with pytest.raises(OpError, match="plays only on Battery"):  # the old object isn't version 2's
        s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b})
    assert s.apply("update_kit", {"kit_id": kid, "version": 2}) == {"objects": 1, "animations": 0}
    item = s.project.scenes[0].mobjects[0]
    assert item.type == kit_type(kid, 2) and item.params == {"charge": 0.3} and item.style == {}
    s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b})
    assert "from customizations.battery import PopIn" in codegen.project_source(s.project)
    s.undo()
    s.undo()  # back to version 1, as it was
    assert s.project.scenes[0].mobjects[0].type == kit_type(kid, 1)


def test_updating_keeps_settings_and_refuses_a_missing_animation(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    kid = battery.split(":")[1]
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    s.apply("set_param", {"scene_id": sid, "mob_id": b, "name": "charge", "value": 0.3})
    step = s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b})
    s.apply("set_animation_param", {"scene_id": sid, "step": step, "index": 0, "name": "bounce", "value": 2.5})
    s.apply("add_mobject", {"scene_id": s.apply("add_scene", {}), "type": battery})  # in another scene too

    def more_settings(m):
        m["object"]["params"].append({"name": "label", "kind": "str", "default": "AA"})
        m["object"]["params"][0].update(max=0.2, default=0.1)  # charge 0.3 is past the new max
        m["animations"][0]["params"].append({"name": "twist", "kind": "angle", "default": 30})
    store.add("owner-1", "Ada", package(manifest_json=manifest(version="1.2", edit=more_settings)), 5, kid)
    store.add("owner-1", "Ada", package(manifest_json=manifest(version="1.3", animations=[])), 5, kid)

    before = s.project.to_dict()
    with pytest.raises(OpError, match="has no Pop in animation, and step 1 of Scene1 plays it"):
        s.apply("update_kit", {"kit_id": kid, "version": 3})
    assert s.project.to_dict() == before  # nothing moved
    assert s.apply("update_kit", {"kit_id": kid, "version": 2}) == {"objects": 2, "animations": 1}
    first, second = s.project.scenes
    assert {m.type for sc in (first, second) for m in sc.mobjects} == {kit_type(kid, 2)}
    assert first.mobjects[0].params == {"charge": 0.2, "label": "AA"}  # held to the new max, as the editor would
    anim = first.steps[0].animations[0]
    assert anim.anim == kit_type(kid, 2, "PopIn") and anim.params == {"bounce": 2.5, "twist": 30.0}
    assert not first.mobjects[0].on_screen_at_start  # Pop in still brings it in
    assert s.apply("update_kit", {"kit_id": kid, "version": 2}) == {"objects": 0, "animations": 0}  # already


def test_only_versions_the_user_may_use_and_only_ones_the_project_has(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    kid = battery.split(":")[1]
    store.add("owner-1", "Ada", package(manifest_json=manifest(version="1.2")), 5, kid)
    bo = Session(kits=lambda key: store.check_use("owner-2", 10, key))
    bo.project.scenes[0].mobjects.append(Project.from_dict({"scenes": [{"id": "s", "name": "S", "mobjects": [
        {"id": "m", "type": battery, "name": "battery"}]}]}).scenes[0].mobjects[0])  # in a project Bo was given
    with pytest.raises(OpError, match="isn't yours or in your library"):
        bo.apply("update_kit", {"kit_id": kid, "version": 2})
    ada = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    with pytest.raises(OpError, match="doesn't use that customization"):
        ada.apply("update_kit", {"kit_id": kid, "version": 2})
    ada.apply("add_mobject", {"scene_id": ada.project.scenes[0].id, "type": battery})
    with pytest.raises(OpError, match="That version of Battery can't be used here"):
        ada.apply("update_kit", {"kit_id": kid, "version": 7})
    with pytest.raises(OpError, match="aren't available here"):
        Session(project=ada.project).apply("update_kit", {"kit_id": kid, "version": 2})


# ---------------------------------------------------------------------- the API


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n) for n in z.namelist()}


def test_without_accounts_everyone_can_make_them(tmp_path):
    c = TestClient(create_app(web=WebConfig(data_dir=tmp_path)), base_url="http://localhost")
    res = c.post("/api/kits", content=package("Battery"), headers=SEND)
    assert res.status_code == 200, res.text
    kit = res.json()["kit"]
    assert kit["animations"][0]["name"] == "Pop in" and kit["kind"] == "object"
    specs = c.get("/api/kits/specs").json()
    assert [m["label"] for m in specs["mobjects"]] == ["Battery"]
    assert [(a["label"], a["only"]) for a in specs["animations"]] == [("Pop in", [kit["type"]])]
    assert c.get("/api/kits").json()["limit"] == 100
    refused = c.post("/api/kits", content=package(OLD / "PopIn"), headers=SEND)
    assert refused.status_code == 400 and "isn't uploaded any more" in refused.json()["error"]


def test_the_demo_plays_the_object_or_one_of_its_animations(tmp_path):
    c = TestClient(create_app(web=WebConfig(data_dir=tmp_path)), base_url="http://localhost")
    kit = c.post("/api/kits", content=package("Refraction"), headers=SEND).json()["kit"]
    assert [a["class"] for a in c.get(f"/api/kits/{kit['id']}").json()["animations"]] == ["Shine", "SweepAngle"]
    plan = c.get(f"/api/kits/{kit['id']}/demo").json()["plan"]
    assert [k["class"] for k in plan["kits"]] == ["Refraction"]
    plan = c.get(f"/api/kits/{kit['id']}/demo?anim=SweepAngle").json()["plan"]
    assert [k["class"] for k in plan["kits"]] == ["Refraction", "SweepAngle"]
    assert plan["steps"][0]["kind"] == "play" and plan["duration"] > 2
    assert c.get(f"/api/kits/{kit['id']}/demo?anim=Nope").status_code == 404
    still = c.get(f"/api/kits/{kit['id']}/demo?still=1").json()["plan"]  # the card's picture: no fading in
    assert [s["kind"] for s in still["steps"]] == ["wait"]


def test_a_customizations_page_lists_its_parts_and_their_settings(tmp_path):
    c = TestClient(create_app(web=WebConfig(data_dir=tmp_path)), base_url="http://localhost")
    kit = c.post("/api/kits", content=package("Refraction"), headers=SEND).json()["kit"]
    page = c.get(f"/api/kits/{kit['id']}").json()
    assert page["license"] == "MIT"
    obj, shine, sweep = page["parts"]
    assert (obj["kind"], obj["name"], obj["class"]) == ("object", "Refraction", "Refraction")
    assert obj["settings"][0] == {**obj["settings"][0], "name": "theta", "kind": "angle", "default": 40,
                                  "label": "Incoming angle"}
    assert (shine["kind"], shine["name"], shine["introducer"], shine["runTime"], shine["settings"]) == (
        "animation", "Shine", True, 2, [])
    assert sweep["name"] == "Sweep angle" and [s["label"] for s in sweep["settings"]] == ["To angle"]


def test_the_author_changes_the_description_until_a_new_manifest_brings_another(tmp_path):
    c = TestClient(create_app(web=WebConfig(data_dir=tmp_path)), base_url="http://localhost")
    kit = c.post("/api/kits", content=package("Refraction"), headers=SEND).json()["kit"]
    describe = lambda text: c.post(f"/api/kits/{kit['id']}/describe", json={"description": text}, headers=HEADERS)
    listed = describe("  A ray of   light, bent.  ").json()["kits"][0]
    assert listed["description"] == "A ray of light, bent."
    assert c.get(f"/api/kits/{kit['id']}").json()["description"] == "A ray of light, bent."
    assert describe("word " * 26).status_code == 400
    # a new version with the same manifest description keeps the author's
    c.post(f"/api/kits/{kit['id']}/versions", content=package("Refraction", manifest_json=manifest(
        "Refraction", version="1.1")), headers=SEND)
    assert c.get("/api/kits").json()["kits"][0]["description"] == "A ray of light, bent."
    # one whose manifest.json says something else shows that (and older versions their own again)
    c.post(f"/api/kits/{kit['id']}/versions", content=package("Refraction", manifest_json=manifest(
        "Refraction", version="1.2", description="Snell's law.")), headers=SEND)
    assert c.get("/api/kits").json()["kits"][0]["description"] == "Snell's law."
    assert c.get(f"/api/kits/{kit['id']}?version=1").json()["description"].startswith("Light crossing")
    # only its author may change it
    other = TestClient(create_app(web=WebConfig(data_dir=tmp_path / "other")), base_url="http://localhost")
    assert other.post(f"/api/kits/{kit['id']}/describe", json={"description": "Mine."},
                      headers=HEADERS).status_code in (400, 403, 404)


def test_the_sandbox_page_runs_locked_down(tmp_path):
    """Customizations' code runs only in web/sandbox/: framed by this site alone, sandboxed even if opened directly,
    and allowed only the site's /static/ files (not its API, not other sites)."""
    import base64
    import hashlib
    import re

    c = TestClient(create_app(web=WebConfig(data_dir=tmp_path)), base_url="http://localhost")
    res = c.get("/static/sandbox/engine.html")
    csp = res.headers["content-security-policy"]
    assert res.status_code == 200 and res.headers["x-frame-options"] == "SAMEORIGIN"
    assert "sandbox allow-scripts" in csp and "frame-ancestors http://localhost;" in csp
    assert "connect-src http://localhost/static/;" in csp and "script-src http://localhost/static/ blob: 'sha256-" in csp
    inline = re.search(r'<script type="importmap">(.*?)</script>', res.text, re.S).group(1)
    assert base64.b64encode(hashlib.sha256(inline.encode()).digest()).decode() in csp  # the import map may run
    app_page = c.get("/app")
    assert app_page.headers["x-frame-options"] == "DENY" and "frame-ancestors 'none'" in app_page.headers[
        "content-security-policy"]
    guide = c.get("/manimkit", follow_redirects=False)  # the guide is public, a docs page now
    assert guide.status_code == 301 and guide.headers["location"] == "/docs/customizations#writing"
    assert '<h2 id="writing">' in c.get("/docs/customizations").text


def test_the_guest_mcp_cant_use_customizations(tmp_path):
    """Only the signed-in User MCP can (cloud/tests/TestMcpKits.py)."""
    from manimator.server.McpScene import SceneSpecError, build_project

    store, battery, pop = store_with_examples(tmp_path)
    with pytest.raises(SceneSpecError, match="signed in to the user's account"):
        build_project({"objects": [{"name": "b", "type": battery}], "steps": []})
    with pytest.raises(SceneSpecError, match="signed in to the user's account"):
        build_project({"objects": [{"name": "c", "type": "Circle"}], "steps": [{"play": [{"anim": pop, "target": "c"}]}]})
