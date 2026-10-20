"""Presentations (scenes of a project in any order, with uploaded videos between them), stored renders, the storage
bar and the playback setting."""

import pytest
from fastapi.testclient import TestClient

from manimator.server import api as api_module
from manimator.server.web import WebConfig
from tests.test_web import HEADERS

MP4 = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 2000
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 2000


@pytest.fixture
def cfg(tmp_path):
    return WebConfig(data_dir=tmp_path)


@pytest.fixture
def app(cfg):
    return api_module.create_app(web=cfg)


def browser(app):
    c = TestClient(app, base_url="http://localhost")
    c.get("/app")
    return c


def account(app):  # without accounts (as here) everyone may make presentations; with them, accounts only
    return browser(app)


def post(c, url, body=None):
    res = c.post(url, json=body or {}, headers=HEADERS)
    assert res.status_code == 200, res.text
    return res.json()


def op(c, op_name, /, **args):
    return post(c, "/api/op", {"op": op_name, "args": args})["result"]


def upload(c, name, data):
    return c.post(f"/api/upload?name={name}", content=data, headers={**HEADERS, "Content-Type": "application/octet-stream"})


def two_scene_project(c) -> str:
    sid = c.get("/api/state").json()["project"]["scenes"][0]["id"]
    circle = op(c, "add_mobject", scene_id=sid, type="Circle")
    op(c, "add_play_step", scene_id=sid, anim="Create", target_id=circle)
    op(c, "add_scene")
    return c.get("/api/state").json()["id"]


def test_a_presentation_starts_with_the_projects_scenes_and_can_be_reordered(app):
    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid, "name": "Talk"})
    assert p["name"] == "Talk" and p["project"] == pid and [i["kind"] for i in p["items"]] == ["scene", "scene"]
    assert [s["name"] for s in p["scenes"]] == ["Scene1", "Scene2"]
    first, second = p["items"]
    video = upload(c, "intro clip.mp4", MP4).json()["name"]
    assert video.startswith("intro_clip-") and video.endswith(".mp4")
    items = [second, {"kind": "video", "file": video}, first, {"kind": "scene", "scene": first["scene"]}]
    p = post(c, f"/api/presentations/{p['id']}", {"items": items, "name": "Talk, again"})
    assert [(i["kind"], i["name"]) for i in p["items"]] == [("scene", "Scene2"), ("video", video), ("scene", "Scene1"),
                                                            ("scene", "Scene1")]
    assert p["name"] == "Talk, again" and all(len(i["id"]) == 8 for i in p["items"])
    listed = c.get("/api/presentations").json()["presentations"]
    assert listed[0]["items"] == 4 and listed[0]["videos"] == 1 and listed[0]["project_name"]
    res = c.post(f"/api/presentations/{p['id']}", json={"items": [{"kind": "video", "file": "nope.mp4"}]},
                 headers=HEADERS)
    assert res.status_code == 400  # only the account's own uploads


def test_playing_gives_plans_videos_and_the_chosen_mode(app):
    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid})
    video = upload(c, "clip.webm", WEBM).json()["name"]
    post(c, f"/api/presentations/{p['id']}", {"items": [*p["items"], {"kind": "video", "file": video}]})
    play = c.get(f"/api/presentations/{p['id']}/play").json()
    assert play["mode"] == "live" and [i["kind"] for i in play["items"]] == ["scene", "scene", "video"]
    scene = play["items"][0]
    assert scene["plan"]["scene"]["name"] == "Scene1" and len(scene["hash"]) == 16 and scene["render"] is None
    assert play["items"][2]["url"] == f"/api/assets/{video}"
    assert post(c, "/api/prefs", {"presentation_mode": "stored"})["presentation_mode"] == "stored"
    assert c.get(f"/api/presentations/{p['id']}/play").json()["mode"] == "stored"
    assert c.post("/api/prefs", json={"presentation_mode": "nope"}, headers=HEADERS).status_code == 400
    # a deleted scene or video is shown as missing, not an error
    post(c, "/api/storage/delete", {"name": video})
    assert c.get(f"/api/presentations/{p['id']}/play").json()["items"][2]["kind"] == "missing"


def test_stored_renders_are_kept_for_the_scene_as_it_is(app):
    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid})
    scene = c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]
    url = f"/api/renders?project={pid}&scene={scene['scene']}&hash={scene['hash']}&ext=mp4"
    res = c.post(url, content=MP4, headers={**HEADERS, "Content-Type": "application/octet-stream"})
    assert res.status_code == 200, res.text
    render_url = res.json()["url"]
    assert c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]["render"] == render_url
    got = c.get(render_url, headers={"Range": "bytes=0-99"})
    assert got.status_code == 206 and got.content == MP4[:100]  # a video player can seek
    stale = url.replace(scene["hash"], "0" * 16)
    assert c.post(stale, content=MP4, headers={**HEADERS, "Content-Type": "application/octet-stream"}).status_code == 409
    bad = c.post(url, content=b"not a video" * 10, headers={**HEADERS, "Content-Type": "application/octet-stream"})
    assert bad.status_code == 400
    # the scene changes: its render isn't current any more
    sid = scene["scene"]
    mob = c.get("/api/state").json()["project"]["scenes"][0]["mobjects"][0]["id"]
    op(c, "set_param", scene_id=sid, mob_id=mob, name="radius", value=2)
    assert c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]["render"] is None


def test_a_new_render_of_a_scene_may_use_the_room_of_the_one_it_replaces(app, cfg, monkeypatch):
    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid})
    first = c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]
    send = {**HEADERS, "Content-Type": "application/octet-stream"}
    old = b"\x00\x00\x00\x20ftypisom" + b"\x00" * 3000
    assert c.post(f"/api/renders?project={pid}&scene={first['scene']}&hash={first['hash']}&ext=mp4", content=old,
                  headers=send).status_code == 200
    # storage almost full: room for the scene's new render only because the old one goes
    monkeypatch.setattr(cfg, "asset_quota", len(old) + 500)
    mob = c.get("/api/state").json()["project"]["scenes"][0]["mobjects"][0]["id"]
    op(c, "set_param", scene_id=first["scene"], mob_id=mob, name="radius", value=2)
    changed = c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]
    new = old + b"\x00" * 300
    res = c.post(f"/api/renders?project={pid}&scene={first['scene']}&hash={changed['hash']}&ext=mp4", content=new,
                 headers=send)
    assert res.status_code == 200, res.text
    assert c.get("/api/storage").json()["renders"] == len(new)  # the old render is gone, the new one kept
    # one that doesn't fit even so is refused, and the render kept before stays
    monkeypatch.setattr(cfg, "asset_quota", len(new) + 10)
    op(c, "set_param", scene_id=first["scene"], mob_id=mob, name="radius", value=3)
    again = c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]
    res = c.post(f"/api/renders?project={pid}&scene={first['scene']}&hash={again['hash']}&ext=mp4",
                 content=new + b"\x00" * 100, headers=send)
    assert res.status_code == 413 and "storage" in res.json()["error"]
    assert c.get("/api/storage").json()["renders"] == len(new)


def test_the_storage_bar_counts_uploads_and_renders_not_projects(app):
    from tests.test_web import png

    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid})
    picture = upload(c, "dot.png", png()).json()["name"]
    video = upload(c, "clip.mp4", MP4).json()["name"]
    scene = c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]
    c.post(f"/api/renders?project={pid}&scene={scene['scene']}&hash={scene['hash']}&ext=webm", content=WEBM,
           headers={**HEADERS, "Content-Type": "application/octet-stream"})
    s = c.get("/api/storage").json()
    assert s["quota"] == WebConfig(data_dir=".").asset_quota  # the server's own limit (no accounts here)
    assert s["videos"] == len(MP4) and s["renders"] == len(WEBM) and s["pictures"] == len(png())
    assert s["used"] == s["videos"] + s["renders"] + s["pictures"]
    kinds = {f["kind"]: f for f in s["files"]}
    assert kinds["render"]["label"].endswith(": Scene1") and kinds["video"]["name"] == video
    assert kinds["picture"]["name"] == picture
    s = post(c, "/api/storage/delete", {"renders": True})
    assert s["renders"] == 0 and s["videos"] == len(MP4)


def test_uploads_must_fit_the_storage(app):
    c = account(app)
    from manimator.server import web

    big = b"\x00\x00\x00\x20ftypisom" + b"\x00" * (web.MAX_VIDEO_BYTES)  # just over the limit for one video
    res = upload(c, "big.mp4", big)
    assert res.status_code == 413 and "too large" in res.json()["error"]
    fake = upload(c, "fake.mp4", b"hello" * 500)
    assert fake.status_code == 400 and "doesn't look like a video" in fake.json()["error"]


def test_an_image_setting_never_takes_a_video(app):
    c = account(app)
    video = upload(c, "clip.mp4", MP4).json()["name"]
    sid = c.get("/api/state").json()["project"]["scenes"][0]["id"]
    mob = op(c, "add_mobject", scene_id=sid, type="ImageMobject")
    res = c.post("/api/op", json={"op": "set_param", "args": {"scene_id": sid, "mob_id": mob, "name": "file",
                                                               "value": video}}, headers=HEADERS)
    assert res.status_code == 400 and "image file" in res.json()["error"]


def test_deleting_a_project_deletes_its_renders(app):
    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid})
    scene = c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]
    c.post(f"/api/renders?project={pid}&scene={scene['scene']}&hash={scene['hash']}&ext=mp4", content=MP4,
           headers={**HEADERS, "Content-Type": "application/octet-stream"})
    post(c, "/api/file/new")
    post(c, "/api/projects/delete", {"id": pid})
    assert c.get("/api/storage").json()["renders"] == 0
    shown = c.get(f"/api/presentations/{p['id']}").json()
    assert shown["project_name"] is None and all(i["missing"] for i in shown["items"])


def test_a_deleted_video_doesnt_stop_the_presentation_from_changing(app):
    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid})
    video = upload(c, "clip.mp4", MP4).json()["name"]
    p = post(c, f"/api/presentations/{p['id']}", {"items": [*p["items"], {"kind": "video", "file": video}]})
    post(c, "/api/storage/delete", {"name": video})
    items = c.get(f"/api/presentations/{p['id']}").json()["items"]
    assert items[2]["missing"]
    # the scenes are reordered: the deleted video stays where it was, shown as deleted, until it is removed
    p = post(c, f"/api/presentations/{p['id']}", {"items": [items[1], items[0], items[2]]})
    assert [i["kind"] for i in p["items"]] == ["scene", "scene", "video"] and p["items"][2]["missing"]
    res = c.post(f"/api/presentations/{p['id']}", json={"items": [*items, {"kind": "video", "file": "other-0a1b2c3d.mp4"}]},
                 headers=HEADERS)
    assert res.status_code == 400  # a video it never had must still be one of the account's uploads
    assert len(post(c, f"/api/presentations/{p['id']}", {"items": items[:2]})["items"]) == 2


def test_videos_and_stored_renders_stay_in_the_browsers_cache(app):
    c = account(app)
    pid = two_scene_project(c)
    p = post(c, "/api/presentations/new", {"project": pid})
    scene = c.get(f"/api/presentations/{p['id']}/play").json()["items"][0]
    render = c.post(f"/api/renders?project={pid}&scene={scene['scene']}&hash={scene['hash']}&ext=mp4", content=MP4,
                    headers={**HEADERS, "Content-Type": "application/octet-stream"}).json()["url"]
    video = upload(c, "clip.mp4", MP4).json()["name"]
    for address in (render, f"/api/assets/{video}"):
        for headers, status in (({}, 200), ({"Range": "bytes=0-99"}, 206)):  # players fetch videos in parts
            res = c.get(address, headers=headers)
            assert res.status_code == status and res.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert c.get("/api/renders/gone.mp4").headers["cache-control"] == "no-store"
