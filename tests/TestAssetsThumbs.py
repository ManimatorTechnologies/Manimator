"""What the browser engine fetches and sends: scene plans, a visitor's uploaded files, and project thumbnails."""

import io

import pytest
from PIL import Image

from manimator.model.project import Project
from manimator.server.api import create_app
from manimator.server.web import WebConfig
from tests.TestWeb import HEADERS, first_scene, op, png, upload, visitor


@pytest.fixture
def cfg(tmp_path):
    return WebConfig(data_dir=tmp_path)


@pytest.fixture
def app(cfg):
    return create_app(web=cfg)


def svg() -> bytes:
    return b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'


# ---------------------------------------------------------------------- plans


def test_plan_of_a_scene_and_of_all(app):
    c = visitor(app)
    scene = first_scene(c)
    circle = op(c, "add_mobject", scene_id=scene["id"], type="Circle", x=1, y=2)
    op(c, "add_play_step", scene_id=scene["id"], anim="Create", target_id=circle)
    res = c.get(f"/api/plan?scene_id={scene['id']}")
    assert res.status_code == 200 and res.headers["cache-control"] == "no-store"
    body = res.json()
    assert body["scene_id"] == scene["id"] and body["version"] == c.get("/api/state").json()["version"]
    assert body["plan"]["objects"][0]["call"]["call"] == "Circle"
    assert body["plan"]["steps"][0]["statements"][0]["do"]["args"][0] == {"call": "Create", "args": [{"ref": circle}]}
    every = c.get("/api/plan?all=1").json()["plan"]
    assert len(every["scenes"]) == 1


def test_plan_of_an_unknown_scene_is_the_first(app):
    c = visitor(app)
    assert c.get("/api/plan?scene_id=nope").json()["scene_id"] == first_scene(c)["id"]


# ---------------------------------------------------------------------- uploaded files


def test_own_uploads_are_served_with_their_type(app):
    c = visitor(app)
    name = upload(c, "photo.png", png()).json()["name"]
    res = c.get(f"/api/assets/{name}")
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    assert "immutable" in res.headers["cache-control"]
    assert res.content == png()


def test_svg_uploads_cannot_run_or_show_as_a_page(app):
    c = visitor(app)
    name = upload(c, "drawing.svg", svg()).json()["name"]
    res = c.get(f"/api/assets/{name}")
    assert res.status_code == 200 and res.headers["content-type"].startswith("image/svg+xml")
    assert "sandbox" in res.headers["content-security-policy"]
    assert "default-src 'none'" in res.headers["content-security-policy"]
    assert res.headers["content-disposition"] == "attachment"


def test_another_visitors_files_are_not_reachable(app):
    a, b = visitor(app), visitor(app)
    name = upload(a, "photo.png", png()).json()["name"]
    b.get("/api/state")
    assert b.get(f"/api/assets/{name}").status_code == 404


@pytest.mark.parametrize("name", ["..%2Fprojects.json", "..%5C..%5Cprojects.json", ".hidden.png", "photo.exe",
                                  "projects.json", "%2Fetc%2Fpasswd", "a" * 200 + ".png"])
def test_no_path_outside_the_uploads(app, name):
    c = visitor(app)
    upload(c, "photo.png", png())
    assert c.get(f"/api/assets/{name}").status_code in (404, 405)


# ---------------------------------------------------------------------- thumbnails


def _pid(c):
    return c.get("/api/projects").json()["projects"][0]["id"]


def test_thumbnails_from_the_browser_are_kept_and_served(app):
    c = visitor(app)
    pid = _pid(c)
    assert c.get(f"/api/thumb/{pid}").status_code == 404  # nothing drawn yet, and the server doesn't draw
    picture = png((640, 360))
    res = c.post(f"/api/thumb/{pid}", content=picture, headers={**HEADERS, "Content-Type": "image/png"})
    assert res.status_code == 200, res.text
    got = c.get(f"/api/thumb/{pid}")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    with Image.open(io.BytesIO(got.content)) as img:
        assert img.size == (640, 360) and img.mode == "RGB"


@pytest.mark.parametrize("data", [png((641, 360)), png((640, 361)), png(fmt="JPEG"), b"not a picture", b""])
def test_thumbnails_must_be_small_pngs(app, data):
    c = visitor(app)
    res = c.post(f"/api/thumb/{_pid(c)}", content=data, headers={**HEADERS, "Content-Type": "image/png"})
    assert res.status_code == 422


def test_thumbnails_have_a_byte_limit(app):
    c = visitor(app)
    big = b"\x89PNG\r\n\x1a\n" + bytes(600 * 1024)
    res = c.post(f"/api/thumb/{_pid(c)}", content=big, headers={**HEADERS, "Content-Type": "image/png"})
    assert res.status_code == 413


def test_thumbnails_only_for_own_projects(app):
    a, b = visitor(app), visitor(app)
    pid = _pid(a)
    b.get("/api/state")
    res = b.post(f"/api/thumb/{pid}", content=png((64, 36)), headers={**HEADERS, "Content-Type": "image/png"})
    assert res.status_code == 400  # "That project doesn't exist any more." (not one of b's)
    assert a.get(f"/api/thumb/{pid}").status_code == 404


def test_thumbnail_uploads_are_throttled(app):
    c = visitor(app)
    pid = _pid(c)
    codes = [c.post(f"/api/thumb/{pid}", content=png((64, 36)), headers={**HEADERS, "Content-Type": "image/png"})
             .status_code for _ in range(14)]
    assert 429 in codes


def test_old_dashed_lines_keep_their_look():
    data = Project.new().to_dict()
    data["version"] = 2
    data["scenes"][0]["mobjects"] = [
        {"id": "a", "type": "DashedLine", "name": "d1", "params": {"dash_length": 0.1}},
        {"id": "b", "type": "DashedLine", "name": "d2", "params": {"dash_length": 0.3}},
        {"id": "c", "type": "DashedLine", "name": "d3", "params": {}}]
    project = Project.from_dict(data)
    assert [m.params.get("dash_length") for m in project.scenes[0].mobjects] == [0.05, 0.3, 0.05]
    assert project.version == 3
