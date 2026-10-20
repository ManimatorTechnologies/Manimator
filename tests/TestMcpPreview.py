"""PreviewAnimation and the layout checks, with the real renderer (a headless Chromium; skipped without one)."""

import base64
import importlib.util
import json

import pytest
from fastapi.testclient import TestClient

from manimator.server.api import create_app
from manimator.server.McpScene import GUIDE_HEAD
from manimator.server.renderer import Renderer, RenderUnavailable
from manimator.server.web import WebConfig

pytestmark = pytest.mark.skipif(importlib.util.find_spec("playwright") is None, reason="needs Playwright")


@pytest.fixture(scope="module")
def renderer():
    r = Renderer(timeout=90)
    try:
        r.render({"version": 1, "scene": {"id": "x", "name": "S", "kind": "Scene", "three_d": False,
                                          "moving_camera": False, "init": {}}, "background": "#000000", "setup": [],
                  "objects": [], "add": [], "steps": [], "duration": 0, "layout": {}, "screen_states": [],
                  "screen_orders": []}, [0])
    except RenderUnavailable as e:
        pytest.skip(f"no browser to draw with: {e}")
    return r


@pytest.fixture
def chat(tmp_path, renderer):
    return TestClient(create_app(web=WebConfig(data_dir=tmp_path), renderer=renderer), base_url="http://localhost")


def call(chat, name, arguments):
    res = chat.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                  "params": {"name": name, "arguments": arguments}})
    return res.json()["result"]


def example() -> dict:
    return json.loads(GUIDE_HEAD.split("```json")[1].split("```")[0])


def test_preview_is_offered_and_draws_the_end_of_each_step(chat):
    tools = [t["name"] for t in chat.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
             .json()["result"]["tools"]]
    assert tools == ["ReadMe", "ShowAnimation", "PreviewAnimation"]
    res = call(chat, "PreviewAnimation", example())
    assert not res.get("isError"), res
    text, *frames = res["content"]
    assert "The checks found no problems" in text["text"] and "law (MathTex): x 1.00 to 4.20" in text["text"]
    images = [c for c in frames if c["type"] == "image"]
    labels = [c["text"] for c in frames if c["type"] == "text"]
    assert len(images) == 5  # five play steps (the waits change nothing)
    assert labels[0].startswith("Frame 1: 0.99 s (end of step 1: Write title)")
    assert base64.b64decode(images[0]["data"])[:3] == b"\xff\xd8\xff" and images[0]["mimeType"] == "image/jpeg"


def test_preview_at_chosen_moments(chat):
    res = call(chat, "PreviewAnimation", {**example(), "times": [0, 100]})
    labels = [c["text"] for c in res["content"] if c["type"] == "text"][1:]
    assert labels == ["Frame 1: 0.00 s (asked for)", "Frame 2: 8.50 s (asked for)"]
    assert call(chat, "PreviewAnimation", {**example(), "times": "soon"})["isError"]


def test_the_checks_find_what_a_person_would_see_wrong(chat):
    spec = {"objects": [
        {"name": "long", "type": "Text", "params": {"text": "This sentence is much, much too long for one line on the screen",
                                                    "font_size": 48}},
        {"name": "one", "type": "MathTex", "params": {"tex": "a^2 + b^2"}, "position": [0, -2]},
        {"name": "two", "type": "MathTex", "params": {"tex": "c^2"}, "position": [0.2, -2]},
        {"name": "tiny", "type": "Text", "params": {"text": "small print", "font_size": 16}, "position": [0, 2]},
    ], "steps": [{"play": [{"anim": "Write", "target": "long"}]}]}
    text = call(chat, "PreviewAnimation", spec)["content"][0]["text"]
    assert "long goes outside the picture at 1.0 s: x -8.34 to 8.34" in text
    assert "one and two overlap" in text
    assert "tiny: font_size 16 is hard to read" in text
    shown = call(chat, "ShowAnimation", {**spec, "text": "Look."})["content"][0]["text"]  # the same checks
    assert "The layout check found problems" in shown and "one and two overlap" in shown


def test_a_clean_scene_shows_without_warnings(chat):
    assert "layout check" not in call(chat, "ShowAnimation", example())["content"][0]["text"]


def test_customizations_are_drawn_as_stand_ins_and_their_code_never_loads(tmp_path):
    """The server never runs a package's code (server/kits.py): render.html registers stand-ins of its own."""
    from manimator.plan import scene_plan
    from manimator.registry.custom import kit_type
    from manimator.server.kits import KitStore
    from manimator.server.session import Session
    from tests.TestKits import package

    store = KitStore(tmp_path)
    battery = kit_type(store.add("u", "Ada", package("battery"), 5)["id"], 1)
    pop = kit_type(store.add("u", "Ada", package("PopIn"), 5)["id"], 1)
    s = Session(kits=lambda key: store.check_use("u", 10, key))
    sid = s.project.scenes[0].id
    cell = s.apply("add_mobject", {"scene_id": sid, "type": battery})
    dot = s.apply("add_mobject", {"scene_id": sid, "type": "Circle"})
    s.apply("add_method", {"scene_id": sid, "mob_id": dot, "method": "next_to"})
    s.apply("set_method_arg", {"scene_id": sid, "mob_id": dot, "index": 0, "name": "mobject_or_point", "value": cell})
    s.apply("add_play_step", {"scene_id": sid, "anim": pop, "target_id": dot})
    s.apply("add_play_step", {"scene_id": sid, "anim": "FadeIn", "target_id": cell})
    plan = scene_plan(s.project.scenes[0], s.project)
    assert [k["class"] for k in plan["kits"]] == ["Battery", "PopIn"]

    r = Renderer(timeout=90)
    asked = []
    serve = r._serve
    r._serve = lambda route: (asked.append(route.request.url), serve(route))[1]
    try:
        result = r.render(plan, [0.5, 1.5, plan["duration"]], 320, 180)
    except RenderUnavailable as e:
        pytest.skip(f"no browser to draw with: {e}")
    assert result["errors"] == {} and result["scene_error"] is None
    assert len(result["frames"]) == 3
    seen = {o["id"] for o in result["frames"][-1]["objects"]}
    assert dot in seen  # placed next to the stand-in, drawn as usual
    assert not [u for u in asked if "/api/" in u or "kit.js" in u]
    assert all(u.startswith("http://render.manimator/") for u in asked)
