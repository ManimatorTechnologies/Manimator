"""Customizations: custom objects and animations uploaded as code packages (.manimkit, server/kits.py)."""

import io
import json
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
from manimator.server.api import create_app
from manimator.server.catalog import catalog
from manimator.server.kits import KitError, KitStore, check_javascript, check_python, read_manifest, read_package
from manimator.server.session import OpError, Session
from manimator.server.web import WebConfig
from tests.test_web import HEADERS

EXAMPLES = Path(__file__).resolve().parent.parent / "examples" / "kits"
SEND = {**HEADERS, "Content-Type": "application/octet-stream"}


def package(folder="battery", **changes) -> bytes:
    """An example package as a .manimkit, with some files replaced (None drops one)."""
    files = {p.name: p.read_text(encoding="utf-8") for p in (EXAMPLES / folder).iterdir() if p.is_file()}
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


def manifest(folder="battery", **changes) -> str:
    m = json.loads((EXAMPLES / folder / "manifest.json").read_text(encoding="utf-8"))
    m.update(changes)
    return json.dumps(m)


# ---------------------------------------------------------------------- the package format


def test_the_examples_are_valid_packages():
    for folder in ("battery", "pop_in"):
        files = read_package(package(folder))
        m = read_manifest(files["manifest.json"])
        check_python(files["kit.py"], m["class"])
        check_javascript(files["kit.js"])
    assert read_manifest(manifest())["params"][0].default == 0.7


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
            z.writestr(f"battery/{name}", (EXAMPLES / "battery" / name).read_text(encoding="utf-8"))
    assert set(read_package(buf.getvalue())) == {"manifest.json", "kit.js", "kit.py"}


def test_a_zip_that_lies_about_its_size_is_refused():
    big = package(kit_js="export default 1;" + " " * (300 * 1024))
    with zipfile.ZipFile(io.BytesIO(big)) as z:
        info = z.getinfo("kit.js")
    # shrink the size the zip claims: reading stops at the limit anyway
    patched = big.replace(info.file_size.to_bytes(4, "little"), (100).to_bytes(4, "little"))
    with pytest.raises(KitError):
        read_package(patched)


@pytest.mark.parametrize("changes, message", [
    ({"class": "Circle"}, "already a Manim or Manimator name"),
    ({"class": "battery"}, "PascalCase"),
    ({"kind": "thing"}, "kind"),
    ({"manimkit": 2}, "manimkit"),
    ({"colour": "red"}, "unknown fields colour"),
    ({"params": [{"name": "run_time", "kind": "float"}]}, "lowercase Python name"),
    ({"params": [{"name": "x", "kind": "mobref"}]}, "kind must be one of"),
    ({"params": [{"name": "x", "kind": "float", "min": 0, "max": 1, "default": 5}]}, "between min and max"),
    ({"params": [{"name": "x", "kind": "enum"}]}, "choices"),
    ({"params": [{"name": "x", "kind": "float"}, {"name": "x", "kind": "int"}]}, "same name"),
    ({"run_time": 2}, "for animations"),
])
def test_manifest_mistakes_are_explained(changes, message):
    with pytest.raises(KitError, match=message):
        read_manifest(manifest(**changes))


def test_the_python_is_parsed_never_run():
    check_python("import os\nos.system('echo hi')\nclass Battery: pass\n", "Battery")  # fine: only parsed
    with pytest.raises(KitError, match="must define class Battery"):
        check_python("class Other: pass\n", "Battery")
    with pytest.raises(KitError, match="syntax error on line 1"):
        check_python("class Battery(:\n", "Battery")


# ---------------------------------------------------------------------- the registry


def test_custom_types_are_found_but_not_listed(tmp_path):
    before = (len(MOBJECTS), len(ANIMATIONS), json.dumps(catalog(), sort_keys=True))
    store = KitStore(tmp_path)
    obj = store.add("owner-1", "Ada", package("battery"), 5)
    anim = store.add("owner-1", "Ada", package("pop_in"), 5)
    battery, pop = kit_type(obj["id"], 1), kit_type(anim["id"], 1)
    assert battery in MOBJECTS and MOBJECTS[battery].kit["class"] == "Battery" and not MOBJECTS[battery].blocked
    assert ANIMATIONS[pop].call_name == "PopIn" and ANIMATIONS[pop].introducer
    assert (len(MOBJECTS), len(ANIMATIONS), json.dumps(catalog(), sort_keys=True)) == before
    unknown = kit_type("0" * 12, 1)
    assert unknown in MOBJECTS and MOBJECTS[unknown].blocked and MOBJECTS.get("Nope") is None
    # a new store (a server restart) finds them again
    store.close()
    MOBJECTS.custom.pop(battery)
    KitStore(tmp_path).close()
    assert MOBJECTS[battery].kit["name"] == "Battery"


def store_with_examples(tmp_path):
    store = KitStore(tmp_path)
    obj = store.add("owner-1", "Ada", package("battery"), 5)
    anim = store.add("owner-1", "Ada", package("pop_in"), 5)
    return store, kit_type(obj["id"], 1), kit_type(anim["id"], 1)


def test_code_plans_and_the_zip_use_the_package(tmp_path):
    store, battery, pop = store_with_examples(tmp_path)
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    s.apply("set_param", {"scene_id": sid, "mob_id": b, "name": "charge", "value": 0.3})
    s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": b})
    source = codegen.project_source(s.project)
    assert "from customizations.battery import Battery" in source
    assert "from customizations.pop_in import PopIn" in source
    assert "battery = Battery(charge=0.3)" in source and "PopIn(battery)" in source
    plan = scene_plan(s.project.scenes[0], s.project)
    assert [k["class"] for k in plan["kits"]] == ["Battery", "PopIn"]
    assert plan["objects"][0]["call"]["call"] == "Battery" and not plan["objects"][0]["error"]
    assert ops.screen_states(s.project.scenes[0])[0] == set()  # PopIn brings the battery in, as declared
    name, data = export.export_zip(s.project, "Charge", lambda _n: None, lambda kid, v: store.file(kid, v, "kit.py"))
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()
        readme = z.read("Charge/README.txt").decode()
        module = z.read("Charge/customizations/battery.py").decode()
    assert "Charge/customizations/__init__.py" in names and "Charge/customizations/pop_in.py" in names
    assert module.startswith("# Battery 1.0 by Ada (MIT). A Manimator customization.\nfrom manim import *")
    assert "customizations/battery.py   Battery 1.0 by Ada (MIT)" in readme and "read the files" in readme


def test_only_the_owner_may_add_their_packages(tmp_path):
    store, battery, _pop = store_with_examples(tmp_path)
    s = Session(kits=lambda key: store.check_use("someone-else", 10, key))
    with pytest.raises(OpError, match="isn't yours"):
        s.apply("add_mobject", {"scene_id": s.project.scenes[0].id, "type": battery})
    none = Session(kits=lambda key: store.check_use("owner-1", 0, key))  # a plan without customizations
    with pytest.raises(OpError, match="aren't part of this plan"):
        none.apply("add_mobject", {"scene_id": none.project.scenes[0].id, "type": battery})
    plain = Session()  # where customizations aren't switched on
    with pytest.raises(OpError, match="aren't available"):
        plain.apply("add_mobject", {"scene_id": plain.project.scenes[0].id, "type": battery})


def test_an_unavailable_package_never_empties_a_project(tmp_path):
    store, battery, _pop = store_with_examples(tmp_path)
    s = Session(kits=lambda key: store.check_use("owner-1", 10, key))
    sid = s.project.scenes[0].id
    b = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    s.apply("set_param", {"scene_id": sid, "mob_id": b, "name": "charge", "value": 0.3})
    data = s.project.to_dict()
    MOBJECTS.custom.pop(battery)  # its package is gone (not on this server, or taken down)
    try:
        loaded = Session(limits=Session().limits or __import__("manimator.server.session", fromlist=["x"]).ProjectLimits())
        loaded.load(Project.from_dict(json.loads(json.dumps(data))))
        item = loaded.project.scenes[0].mobjects[0]
        assert item.type == battery and item.params == {"charge": 0.3}  # kept as it was
        plan = scene_plan(loaded.project.scenes[0], loaded.project)
        assert plan["objects"][0]["error"] == UNAVAILABLE and "kits" not in plan
        assert "VMobject()" in codegen.project_source(loaded.project)
    finally:
        KitStore(tmp_path).close()  # registered again


def test_two_packages_with_one_class_name_cant_share_a_project(tmp_path):
    store, battery, _pop = store_with_examples(tmp_path)
    other = store.add("owner-2", "Bo", package("battery"), 5)  # another author's Battery
    s = Session(kits=lambda key: None)
    sid = s.project.scenes[0].id
    s.apply("add_mobject", {"scene_id": sid, "type": battery})
    with pytest.raises(OpError, match="another customization called Battery"):
        s.apply("add_mobject", {"scene_id": sid, "type": kit_type(other["id"], 1)})
    s.apply("add_mobject", {"scene_id": sid, "type": battery})  # the same one again is fine


def test_versions_and_deleting(tmp_path):
    store, battery, _pop = store_with_examples(tmp_path)
    kid = battery.split(":")[1]
    newer = package(manifest_json=manifest(version="1.1", description="Now with more charge"))
    store.add("owner-1", "Ada", newer, 5, kid)
    assert [v["label"] for v in store.summary(store.kit(kid))["versions"]] == ["1.0", "1.1"]
    assert {s.key for s in store.usable("owner-1")} >= {kit_type(kid, 2)}
    with pytest.raises(KitError, match="must stay an object named Battery"):
        store.add("owner-1", "Ada", package(manifest_json=manifest(**{"class": "Cell"})), 5, kid)
    with pytest.raises(KitError, match="isn't yours"):
        store.add("owner-2", "Bo", newer, 5, kid)
    with pytest.raises(KitError, match="up to 2"):
        store.add("owner-1", "Ada", package(manifest_json=manifest(**{"class": "Cell"})), 2)
    store.unlist("owner-1", kid)
    assert kid not in {k["id"] for k in store.owned("owner-1")}
    assert MOBJECTS[battery].kit["class"] == "Battery"  # projects that use it keep working


# ---------------------------------------------------------------------- the API


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n) for n in z.namelist()}


def test_without_accounts_everyone_can_make_them(tmp_path):
    c = TestClient(create_app(web=WebConfig(data_dir=tmp_path)), base_url="http://localhost")
    res = c.post("/api/kits", content=package("pop_in"), headers=SEND)
    assert res.status_code == 200, res.text
    assert c.get("/api/kits/specs").json()["animations"][0]["label"] == "Pop in"
    assert c.get("/api/kits").json()["limit"] == 100


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
    """Only the signed-in User MCP can (tests/test_mcp_kits.py)."""
    from manimator.server.mcp_scene import SceneSpecError, build_project

    store, battery, pop = store_with_examples(tmp_path)
    with pytest.raises(SceneSpecError, match="signed in to the user's account"):
        build_project({"objects": [{"name": "b", "type": battery}], "steps": []})
    with pytest.raises(SceneSpecError, match="signed in to the user's account"):
        build_project({"objects": [{"name": "c", "type": "Circle"}], "steps": [{"play": [{"anim": pop, "target": "c"}]}]})
