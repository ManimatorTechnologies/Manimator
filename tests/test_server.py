"""The API: editing, undo and code (test_web.py covers visitors, limits and files)."""

import pytest
from fastapi.testclient import TestClient

from manimator.registry import MOBJECTS
from manimator.server.api import create_app
from manimator.server.session import OpError, Session, operation_names
from manimator.server.web import WebConfig

HEADERS = {"X-Manimator": "1"}


@pytest.fixture
def app(tmp_path):
    return create_app(WebConfig(data_dir=tmp_path))


@pytest.fixture
def client(app):
    return TestClient(app, base_url="http://127.0.0.1")


def op(client, name, **args):
    res = client.post("/api/op", json={"op": name, "args": args}, headers=HEADERS)
    assert res.status_code == 200, res.text
    return res.json()


def scene_id(client):
    return client.get("/api/state").json()["project"]["scenes"][0]["id"]


# ---------------------------------------------------------------- security


def test_rejects_foreign_hosts_and_headerless_writes(app):
    evil = TestClient(app, base_url="http://attacker.example")
    assert evil.get("/api/state").status_code == 403
    local = TestClient(app, base_url="http://127.0.0.1")
    assert local.post("/api/op", json={"op": "add_scene"}).status_code == 403  # no custom header
    assert local.post("/api/op", json={"op": "add_scene"}, headers=HEADERS).status_code == 200


def test_hostile_values_are_rejected(client):
    sid = scene_id(client)
    mob = op(client, "add_mobject", scene_id=sid, type="Circle")["result"]
    for name, value in [("fill_color", "#FFF');import os#"), ("fill_opacity", "1; import os")]:
        res = client.post("/api/op", json={"op": "set_style", "args": {
            "scene_id": sid, "mob_id": mob, "name": name, "value": value}}, headers=HEADERS)
        assert res.status_code == 400, name
    res = client.post("/api/op", json={"op": "add_mobject", "args": {
        "scene_id": sid, "type": "__import__('os')"}}, headers=HEADERS)
    assert res.status_code == 400
    res = client.post("/api/op", json={"op": "rm_rf"}, headers=HEADERS)
    assert res.status_code == 400 and "Unknown operation" in res.json()["error"]


# ---------------------------------------------------------------- editing and undo


def test_edit_undo_redo_and_merging(client):
    sid = scene_id(client)
    mob = op(client, "add_mobject", scene_id=sid, type="Square", x=1, y=2)["result"]
    for x in (1.5, 2.0, 2.5):  # a drag: one undo step
        state = client.post("/api/op", json={"op": "set_position", "args": {"scene_id": sid, "mob_id": mob, "x": x, "y": 0},
                                             "merge_key": "live:drag:1"}, headers=HEADERS).json()["state"]
    assert state["undo_label"] == "Move object"
    state = client.post("/api/undo", headers=HEADERS).json()["state"]
    assert state["project"]["scenes"][0]["mobjects"][0]["position"] == [1.0, 2.0]
    assert state["undo_label"] == "Add object"  # the whole drag was one step
    state = client.post("/api/redo", headers=HEADERS).json()["state"]
    assert state["project"]["scenes"][0]["mobjects"][0]["position"] == [2.5, 0.0]


def test_a_merge_key_that_isnt_text_is_taken_as_text(client):
    sid = scene_id(client)
    mob = op(client, "add_mobject", scene_id=sid, type="Square")["result"]
    for x in (1, 2):  # once to record the key, then again to merge with it
        res = client.post("/api/op", json={"op": "set_position", "args": {"scene_id": sid, "mob_id": mob, "x": x, "y": 0},
                                           "merge_key": 7}, headers=HEADERS)
        assert res.status_code == 200, res.text
    assert res.json()["state"]["undo_label"] == "Move object"
    client.post("/api/undo", headers=HEADERS)
    assert client.get("/api/state").json()["undo_label"] == "Add object"  # both moves were one step


def test_failed_op_leaves_project_untouched():
    session = Session()
    sid = session.project.scenes[0].id
    before = session.project.to_dict()
    with pytest.raises(OpError):
        session.apply("add_mobject", {"scene_id": sid, "type": "Brace"})  # needs a target
    with pytest.raises(OpError):
        session.apply("set_step", {"scene_id": sid, "step": 5, "name": "run_time", "value": 2})
    assert session.project.to_dict() == before
    assert not session.dirty


def test_every_operation_has_a_label():
    assert {"add_mobject", "set_param", "add_play_step", "merge_steps", "set_animation_param"} <= set(operation_names())


def test_mobref_cycles_are_refused(client):
    sid = scene_id(client)
    a = op(client, "add_mobject", scene_id=sid, type="Circle")["result"]
    b = op(client, "add_mobject", scene_id=sid, type="Square")["result"]
    op(client, "add_method", scene_id=sid, mob_id=b, method="next_to")  # b next_to a
    op(client, "add_method", scene_id=sid, mob_id=a, method="next_to")
    res = client.post("/api/op", json={"op": "set_method_arg", "args": {
        "scene_id": sid, "mob_id": a, "index": 0, "name": "mobject_or_point", "value": b}}, headers=HEADERS)
    assert res.status_code == 400 and "loop" in res.json()["error"]


# ---------------------------------------------------------------- the server never draws, files, code


@pytest.mark.parametrize("method, url", [
    ("post", "/api/preview"), ("get", "/api/icon/Square"), ("post", "/api/render"), ("get", "/api/render"),
    ("post", "/api/render/cancel"), ("get", "/api/render/video/0"),
])
def test_there_is_no_server_rendering(client, method, url):
    """Pictures and videos are made in the visitor's browser: nothing on the server runs Manim."""
    res = client.post(url, json={"scope": "scene"}, headers=HEADERS) if method == "post" else client.get(url)
    assert res.status_code in (404, 405), url


def test_python_code(client):
    sid = scene_id(client)
    op(client, "add_mobject", scene_id=sid, type="Text", x=0, y=2)
    assert client.get("/api/code").text.startswith("# Generated by Manimator")
    res = client.get("/api/file/export.py")
    assert 'Text("Hello"' in res.text and "attachment" in res.headers["content-disposition"]


def test_catalog_describes_everything(client):
    cat = client.get("/api/catalog").json()
    assert len(cat["mobjects"]) == len(MOBJECTS) and cat["animate"] == "Animate"
    circle = next(m for m in cat["mobjects"] if m["key"] == "Circle")
    assert circle["params"][0]["name"] == "radius"
