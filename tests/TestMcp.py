"""The MCP App: an AI chat writes a scene, the server checks it like editor edits and sends the plan to the player."""

import json
import re

import pytest
from fastapi.testclient import TestClient

from manimator.registry import ANIMATIONS, MOBJECTS
from manimator.registry.params import MOBREF, MOBREFS
from manimator.server.api import create_app
from manimator.server.mcp import APP_MIME
from manimator.server.McpScene import FILE_TYPES, GUIDE_HEAD, SceneSpecError, build_project, guide
from manimator.server.web import WebConfig


@pytest.fixture
def client(tmp_path):
    app = create_app(web=WebConfig(data_dir=tmp_path, site_url="https://manimator.example",
                                   allowed_hosts=frozenset({"manimator.example"})))
    return TestClient(app, base_url="http://manimator.example")  # the proxy in front speaks https


def test_a_server_reached_under_another_name_points_the_player_at_that_name(tmp_path):
    app = create_app(web=WebConfig(data_dir=tmp_path, site_url="https://manimator.example"))
    local = TestClient(app, base_url="http://localhost:8021")
    uri = rpc(local, "tools/list")["result"]["tools"][1]["_meta"]["ui"]["resourceUri"]
    page = rpc(local, "resources/read", {"uri": uri})["result"]["contents"][0]
    assert 'data-site="http://localhost:8021"' in page["text"]
    assert page["_meta"]["ui"]["csp"]["resourceDomains"] == ["http://localhost:8021"]


def test_browser_based_clients_may_call(client):
    pre = client.options("/mcp", headers={"Origin": "https://inspector.example", "Access-Control-Request-Method": "POST",
                                          "Access-Control-Request-Headers": "content-type, mcp-protocol-version"})
    assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == "*"
    assert "mcp-protocol-version" in pre.headers["access-control-allow-headers"].lower()
    res = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert res.headers["access-control-allow-origin"] == "*"


def rpc(client, method, params=None, mid=1):
    res = client.post("/mcp", json={"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}},
                      headers={"Accept": "application/json, text/event-stream"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"] == mid
    return body


def call(client, name, arguments=None):
    return rpc(client, "tools/call", {"name": name, "arguments": arguments or {}})["result"]


def example() -> dict:
    return json.loads(GUIDE_HEAD.split("```json")[1].split("```")[0])


# ---------------------------------------------------------------------- the protocol


def test_initialize_needs_no_browser_header_and_names_the_server(client):
    res = rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {
        "extensions": {"io.modelcontextprotocol/ui": {"mimeTypes": [APP_MIME]}}},
        "clientInfo": {"name": "test", "version": "1"}})["result"]
    assert res["protocolVersion"] == "2025-06-18"
    assert res["serverInfo"]["name"] == "manimator"
    assert "tools" in res["capabilities"] and "resources" in res["capabilities"]
    assert "ShowAnimation" in res["instructions"]
    unknown = rpc(client, "initialize", {"protocolVersion": "1999-01-01"})["result"]
    assert unknown["protocolVersion"] == "2025-11-25"  # the newest one this server speaks


def test_each_clip_carries_the_part_of_the_explanation_it_illustrates(client):
    """The user wants the explanation as text with clips between paragraphs. Claude makes its tool calls one after
    another and writes its reply at the end, so the text travels with each clip ("text", shown above it): the
    instructions, the tool, the guide and each result say so, and the player gets the text."""
    init = rpc(client, "initialize", {"protocolVersion": "2025-06-18"})["result"]["instructions"]
    assert "carries the part of your explanation it illustrates" in init and "without repeating" in init
    show = next(t for t in rpc(client, "tools/list")["result"]["tools"] if t["name"] == "ShowAnimation")
    assert show["inputSchema"]["required"][0] == "text" and next(iter(show["inputSchema"]["properties"])) == "text"
    assert "Markdown" in show["inputSchema"]["properties"]["text"]["description"]
    assert "## Pacing: the explanation is text, each clip illustrates its part" in call(client, "ReadMe")["content"][0]["text"]
    res = call(client, "ShowAnimation", example())
    assert res["structuredContent"]["text"] == example()["text"] and "under its text" in res["content"][0]["text"]
    bare = call(client, "ShowAnimation", {k: v for k, v in example().items() if k != "text"})
    assert not bare.get("isError") and "put the explanation in" in bare["content"][0]["text"]


def test_notifications_get_202_and_other_methods_405(client):
    res = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert res.status_code == 202 and res.content == b""
    assert client.get("/mcp").status_code == 405
    assert client.delete("/mcp").status_code == 405
    assert rpc(client, "ping")["result"] == {}
    assert rpc(client, "no/such/method")["error"]["code"] == -32601
    bad = client.post("/mcp", content=b"{nope", headers={"Content-Type": "application/json"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == -32700


def test_a_batch_gets_one_answer_per_request(client):
    res = client.post("/mcp", json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])
    assert [a["id"] for a in res.json()] == [1, 2]


def test_the_tool_names_the_player_page_which_loads_the_engine_from_the_site(client):
    tools = {t["name"]: t for t in rpc(client, "tools/list")["result"]["tools"]}
    assert set(tools) == {"ReadMe", "ShowAnimation"}
    uri = tools["ShowAnimation"]["_meta"]["ui"]["resourceUri"]
    assert re.fullmatch(r"ui://manimator/player-[0-9a-f]{10}\.html", uri)
    assert tools["ShowAnimation"]["_meta"]["ui/resourceUri"] == uri  # the older spelling, for older hosts
    assert tools["ShowAnimation"]["inputSchema"]["required"] == ["text", "objects", "steps"]
    listed = rpc(client, "resources/list")["result"]["resources"]
    assert [r["uri"] for r in listed] == [uri] and listed[0]["mimeType"] == APP_MIME
    page = rpc(client, "resources/read", {"uri": uri})["result"]["contents"][0]
    assert page["mimeType"] == APP_MIME
    assert 'data-site="https://manimator.example"' in page["text"]
    assert "__MANIMATOR_SITE__" not in page["text"]
    assert page["_meta"]["ui"]["csp"] == {"resourceDomains": ["https://manimator.example"],
                                          "connectDomains": ["https://manimator.example"],
                                          # the sandbox customizations play in (server/kits.py), framed in the player
                                          "frameDomains": ["https://manimator.example"]}
    old = rpc(client, "resources/read", {"uri": "ui://manimator/player-0123456789.html"})["result"]
    assert old["contents"][0]["text"] == page["text"]  # an old conversation still gets a player
    missing = rpc(client, "resources/read", {"uri": "ui://other/thing.html"})
    assert missing["error"]["code"] == -32002


def test_the_engine_and_fonts_can_be_loaded_from_another_origin(client):
    for path in ("/static/js/engine/index.js", "/static/fonts/dejavu/DejaVuSans.ttf",
                 "/static/fonts/crimson-pro/CrimsonPro-Regular.ttf"):
        res = client.get(path, headers={"Origin": "null"})
        assert res.status_code == 200
        assert res.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-origin" not in client.get("/api/catalog").headers  # the API stays same-origin


def test_read_me_is_the_guide(client):
    res = call(client, "ReadMe")
    assert res["content"][0]["text"] == guide()
    for word in ("MathTex", "ReplacementTransform", "camera_move3d", "next_to", "LinearTransformationScene"):
        assert word in guide()
    for kind in FILE_TYPES:
        assert f"- {kind}(" not in guide()


def test_show_animation_returns_the_plan_for_the_player(client):
    res = call(client, "ShowAnimation", example())
    assert not res.get("isError"), res
    assert "Pythagorean theorem" in res["content"][0]["text"]
    plan = res["structuredContent"]["plan"]
    assert sorted(o["var"] for o in plan["objects"]) == ["a", "b", "c", "corner", "law", "title", "tri"]
    assert plan["duration"] == res["structuredContent"]["duration"] == 8.5
    assert len(plan["steps"]) == 7


def test_the_old_snake_case_names_still_answer(client):
    assert call(client, "read_me")["content"][0]["text"] == guide()
    assert "plan" in call(client, "show_animation", example())["structuredContent"]
    tools = [t["name"] for t in rpc(client, "tools/list")["result"]["tools"]]
    assert "read_me" not in tools and "show_animation" not in tools  # listed only under the new names


def test_problems_come_back_as_a_tool_error_to_fix(client):
    res = call(client, "ShowAnimation", {"objects": [{"name": "c", "type": "Circel"}],
                                          "steps": [{"play": [{"anim": "Create", "target": "c"}]}]})
    assert res["isError"] is True
    text = res["content"][0]["text"]
    assert "1 problem" in text and "Did you mean 'Circle'" in text
    assert "structuredContent" not in res


# ---------------------------------------------------------------------- scenes


def problems(spec) -> list[str]:
    with pytest.raises(SceneSpecError) as e:
        build_project(spec)
    return e.value.problems


def test_names_become_ids_and_visibility_follows_the_editor_rules():
    project = build_project({
        "objects": [{"name": "a", "type": "Circle"}, {"name": "b", "type": "Square"}, {"name": "label", "type": "Text"},
                    {"name": "x", "type": "Dot", "on_screen_at_start": False}],
        "steps": [{"play": [{"anim": "Write", "target": "label"}]},
                  {"play": [{"anim": "Transform", "target": "a", "params": {"target_mobject": "b"}}]}],
    })
    scene = project.scenes[0]
    by = {m.name: m for m in scene.mobjects}
    assert {n: m.on_screen_at_start for n, m in by.items()} == {"a": True, "b": False, "label": False, "x": False}
    assert scene.steps[1].animations[0].params["target_mobject"] == by["b"].id


def test_settings_style_position_and_methods_are_checked_and_kept():
    project = build_project({
        "title": "A demo!", "background": "#111",
        "objects": [
            {"name": "t", "type": "Text", "params": {"text": "Hi", "font_size": 30}, "style": {"color": "BLUE"},
             "methods": [{"method": "to_edge", "args": {"edge": "UP"}}]},
            {"name": "s", "type": "Square", "style": {"color": "RED", "fill_opacity": 0.5}, "position": [2, -1],
             "rotation": 30, "scale": 1.5, "methods": [{"method": "next_to", "args": {"mobject_or_point": "t"}}]},
            {"name": "l", "type": "Line", "params": {"start": [0, 0], "end": [2, 0]}, "position": [0, 2]},
        ],
        "steps": [{"play": [{"anim": "Animate", "target": "s", "method": "shift", "params": {"vector": [1, 0]}}],
                   "run_time": 2, "rate_func": "ease_in_sine", "lag_ratio": 0.3}, {"wait": 1.5}],
    })
    scene = project.scenes[0]
    t, s, line = scene.mobjects
    assert scene.name == "ADemo" and project.settings.background == "#111111"
    assert t.params["text"] == "Hi" and t.style["color"] == "#58C4DD"
    assert s.style["stroke_color"] == s.style["fill_color"] == "#FC6255" and s.style["fill_opacity"] == 0.5
    assert s.position == [2.0, -1.0] and s.rotation == 30 and s.scale == 1.5
    assert s.methods[0].args["mobject_or_point"] == t.id
    assert line.params["start"] == [-1.0, 2.0] and line.params["end"] == [1.0, 2.0]  # moved by its center
    step = scene.steps[0]
    assert (step.run_time, step.rate_func, step.lag_ratio) == (2.0, "rate_functions.ease_in_sine", 0.3)
    assert scene.steps[1].kind == "wait" and scene.steps[1].duration == 1.5


def test_scene_names_are_short_pascal_case_without_numbering():
    from manimator.server.McpScene import _class_name

    assert _class_name("1. The theorem") == "TheTheorem"  # was _1TheTheorem
    assert _class_name("3 - Proof by rearrangement") == "ProofByRearrangement"
    assert _class_name("3ProofByRearrangement") == "ProofByRearrangement"  # was _3ProofByRearrangement
    assert _class_name("05UsingTheTheorem") == "UsingTheTheorem" and _class_name("4_TheAlgebra") == "TheAlgebra"
    assert _class_name("Squares") == "Squares" and _class_name("SquaresOnSides") == "SquaresOnSides"
    assert _class_name("Step 2") == "Step2"  # a number inside the name stays
    assert _class_name("A very long title that goes on and on") == "AVeryLongTitleThatGoesOn"  # whole words, <= 24
    assert _class_name("42") == _class_name("") == "Explainer"


def test_polygon_corners_and_vectors_are_where_manim_puts_them():
    scene = build_project({"objects": [
        {"name": "tri", "type": "Polygon", "params": {"points": [[-4, -1.5], [-1, -1.5], [-4, 0.75]]}},
        {"name": "moved", "type": "Polygon", "params": {"points": [[0, 0], [2, 0], [0, 2]]}, "position": [3, 1]},
        {"name": "v", "type": "Vector", "params": {"direction": [2, 1]}},
    ], "steps": []}).scenes[0]
    tri, moved, v = scene.mobjects
    assert tri.position == [-2.5, -0.375]  # the center of the corners as listed: they stay where they are
    assert moved.position == [3.0, 1.0]
    assert v.position == [1.0, 0.5]  # its tail at the origin


def test_every_problem_is_reported_with_where_it_is():
    found = problems({
        "objects": [{"name": "eq", "type": "MathTex", "params": {"text": "x"}}, {"name": "b", "type": "Brace"},
                    {"type": "Square", "style": {"colour": "RED"}}, {"name": "eq", "type": "Circle"},
                    {"name": "img", "type": "ImageMobject"}, {"name": "g", "type": "FunctionGraph", "position": [1, 1]},
                    {"name": "f", "type": "FunctionGraph", "params": {"expr": "import os"}}],
        "steps": [{"play": [{"anim": "Transform", "target": "eq"}]}, {"play": [{"anim": "GrowArrow", "target": "eq"}]},
                  {"wait": "x"}, {"play": [{"anim": "camera_zoom"}]}, {"play": [{"anim": "Create", "target": "nope"}]},
                  {"play": [{"anim": "FadeIn", "target": "img"}]}, {"jump": 1}],
    })
    joined = "\n".join(found)
    assert "objects[0] (eq).params: MathTex has no setting 'text'. Did you mean 'tex'?" in joined
    assert "objects[1] (b).params: Brace needs 'mobject'" in joined
    assert "objects[2].style: a Square's style has no setting 'colour'" in joined
    assert "objects[3] (eq): another object is already named 'eq'" in joined
    assert "objects[4] (img): needs an uploaded file" in joined
    assert "objects[5] (g).position: a FunctionGraph is drawn where its settings put it" in joined
    assert "objects[6] (f).params.expr:" in joined
    assert "steps[0].play[0].params: Transform needs 'target_mobject'" in joined
    assert "steps[1].play[0]: GrowArrow only works on Arrow, DoubleArrow" in joined
    assert "steps[2].wait: expected a number" in joined
    assert 'steps[3].play[0]: camera_zoom needs "scene": "MovingCameraScene" or "ZoomedScene"' in joined
    assert 'steps[4].play[0].target: no object named "nope"' in joined
    assert "img" not in "\n".join(p for p in found if p.startswith("steps[5]"))  # already reported, not again
    assert 'steps[6]: a step is {"play"' in joined


def test_loops_and_bad_shapes_of_json_are_refused():
    assert "a loop" in problems({"objects": [
        {"name": "a", "type": "Circle", "methods": [{"method": "next_to", "args": {"mobject_or_point": "b"}}]},
        {"name": "b", "type": "Circle", "methods": [{"method": "next_to", "args": {"mobject_or_point": "a"}}]}],
        "steps": []})[0]
    assert problems([1, 2]) == ['The scene must be a JSON object with "objects" and "steps".']
    assert problems({"objects": "x", "steps": {}}) == ["objects: expected a list of objects",
                                                       "steps: expected a list of steps"]
    assert "unknown field 'colour'" in problems({"colour": 1, "objects": [], "steps": []})[0]
    too_long = problems({"objects": [{"name": "c", "type": "Circle"}], "steps": [{"wait": 60}] * 11})
    assert "under 600 s" in too_long[0]


def test_scene_types_their_options_and_actions():
    project = build_project({
        "scene": "MovingCameraScene", "scene_options": {"camera_zoom": 1.5},
        "objects": [{"name": "d", "type": "Dot"}],
        "steps": [{"play": [{"anim": "camera_focus", "target": "d"}]}, {"play": [{"anim": "camera_restore"}]}],
    })
    scene = project.scenes[0]
    assert scene.kind == "MovingCameraScene" and scene.options["camera_zoom"] == 1.5
    focus = scene.steps[0].animations[0]
    assert focus.target is None and focus.params["object"] == scene.mobjects[0].id  # "target" means the object
    three_d = build_project({"objects": [{"name": "s", "type": "Sphere"}],
                             "steps": [{"play": [{"anim": "camera_move3d", "params": {"phi": 45}}]}]})
    scene = three_d.scenes[0]
    assert scene.kind == "ThreeDScene"  # a 3D object needs a 3D camera
    assert scene.steps[0].animations[0].params["theta"] == -50  # angles not given stay where they are
    assert scene.steps[0].run_time == 2.0
    assert "unknown scene type" in problems({"scene": "Nope", "objects": [], "steps": []})[0]


def test_every_object_type_can_be_made_with_its_defaults():
    for key, spec in MOBJECTS.items():
        if key in FILE_TYPES:
            continue
        objects = [{"name": "other", "type": "Circle"}, {"name": "thing", "type": key}]
        params = {}
        for p in spec.params:
            if p.kind == MOBREF:
                params[p.name] = "other"
            elif p.kind == MOBREFS:
                params[p.name] = ["other"]
        objects[1]["params"] = params
        project = build_project({"objects": objects, "steps": [{"play": [{"anim": "FadeIn", "target": "thing"}]}]})
        from manimator.plan import scene_plan

        plan = scene_plan(project.scenes[0], project)
        assert not [o for o in plan["objects"] if o["error"]], key


def test_every_object_animation_can_be_played():
    for key, spec in ANIMATIONS.items():
        if spec.scene_action or key == "Animate":  # Animate is tested with its method above
            continue
        target =(spec.only or ("Circle",))[0]
        params = {p.name: "other" for p in spec.params if p.kind == MOBREF}
        build_project({"objects": [{"name": "it", "type": target}, {"name": "other", "type": target}],
                       "steps": [{"play": [{"anim": key, "target": "it", "params": params}]}]})


# ---------------------------------------------------------------------- sessions, and clips in a row


def show_in(client, session, spec):
    res = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                    "params": {"name": "ShowAnimation", "arguments": spec}},
                      headers={"Accept": "application/json, text/event-stream", "Mcp-Session-Id": session})
    return res.json()["result"]


def test_initialize_hands_out_a_session(client):
    res = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                    "params": {"protocolVersion": "2025-06-18"}})
    assert len(res.headers["mcp-session-id"]) >= 20
    assert "mcp-session-id" in res.headers["access-control-expose-headers"].lower()


def test_clips_in_a_row_are_all_shown(client):
    """Each clip brings its own text, so clips sent one after another (or together) read fine: none is held back."""
    for i in range(3):
        res = show_in(client, "chat-a", {**example(), "text": f"Part {i + 1} of the explanation."})
        assert not res.get("isError") and res["structuredContent"]["text"] == f"Part {i + 1} of the explanation."


def test_chats_begun_with_text_before_still_play(client):
    old = {k: v for k, v in example().items() if k != "text"}
    assert not show_in(client, "chat-old", {**old, "text_before": "The last sentence."}).get("isError")
    assert build_project({**old, "text_before": "x"}).scenes[0].mobjects  # scenes ignore it


def test_the_player_reports_the_chats_fonts_to_the_log(client, capsys):
    res = client.get("/mcp/style", params={"s": '{"families":["Anthropic Serif"]}'})
    assert res.status_code == 204 and res.headers["access-control-allow-origin"] == "*"
    assert 'mcp host style: {"families":["Anthropic Serif"]}' in capsys.readouterr().out
    client.get("/mcp/style", params={"s": "a\rmcp forged line\n\x1b[2Jb"})  # anyone may send it: one plain line
    out = capsys.readouterr().out
    assert out == "mcp host style: a mcp forged line  [2Jb\n"
    for _ in range(200):  # and only so many lines, however many are sent
        client.get("/mcp/style", params={"s": "x"})
    assert capsys.readouterr().out.count("mcp host style") < 120


def test_a_frame_job_that_timed_out_is_never_drawn():
    """The caller has given up on it: if the browser hasn't started it, it skips it (a slow job doesn't pile up work)."""
    from manimator.server.renderer import Renderer, RenderUnavailable

    r = Renderer(timeout=0.05)
    r._start = lambda: None  # no browser thread: the job waits in the queue until the caller gives up
    with pytest.raises(RenderUnavailable):
        r.render({}, [0])
    job = r._jobs.get_nowait()[0]
    assert job.cancelled() and not job.set_running_or_notify_cancel()
