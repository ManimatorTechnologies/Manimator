"""The hosted (website) version: private workspaces, uploads, limits and what a stranger must not be able to do."""

import io
import json
import os
import re
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from manimator.model import ops
from manimator.model.project import Project
from manimator.server import docs
from manimator.server.api import create_app
from manimator.server.session import ProjectLimits
from manimator.server.web import COOKIE, WebConfig, WorkspaceStore

HEADERS = {"X-Manimator": "1"}


@pytest.fixture
def cfg(tmp_path):
    return WebConfig(data_dir=tmp_path, max_upload_bytes=200_000, max_assets=3, asset_quota=300_000,
                     limits=ProjectLimits(max_scenes=3, max_objects=6, max_steps=10))


@pytest.fixture
def app(cfg):
    return create_app(web=cfg)


def visitor(app):
    return TestClient(app, base_url="http://localhost")


def op(client, op_name, /, **args):
    res = client.post("/api/op", json={"op": op_name, "args": args}, headers=HEADERS)
    assert res.status_code == 200, res.text
    return res.json()["result"]


def first_scene(client):
    return client.get("/api/state").json()["project"]["scenes"][0]


def png(size=(20, 10), fmt="PNG"):
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 60, 60)).save(buf, fmt)
    return buf.getvalue()


def upload(client, name, data):
    return client.post(f"/api/upload?name={name}", content=data, headers={**HEADERS, "Content-Type": "application/octet-stream"})


# ---------------------------------------------------------------------- visitors are separate


def test_each_visitor_gets_a_private_project_and_a_safe_cookie(app):
    a, b = visitor(app), visitor(app)
    res = a.get("/")
    cookie = res.headers["set-cookie"]
    assert COOKIE in cookie and "HttpOnly" in cookie and "samesite=lax" in cookie.lower() and "Path=/" in cookie
    sid = first_scene(a)["id"]
    op(a, "add_mobject", scene_id=sid, type="Circle")
    assert len(first_scene(a)["mobjects"]) == 1
    assert first_scene(b)["mobjects"] == []  # b never sees a's work
    assert len(first_scene(a)["mobjects"]) == 1  # and a keeps theirs


def test_a_cookie_the_server_never_issued_is_not_adopted(app, cfg):
    c = visitor(app)
    forged = "ab" * 16
    c.cookies.set(COOKIE, forged)
    res = c.get("/api/state")
    assert res.status_code == 200
    assert COOKIE in res.headers["set-cookie"] and forged not in res.headers["set-cookie"]  # given a fresh id instead
    assert not (cfg.data_dir / "workspaces" / forged).exists()
    for hostile in ("../../etc", "..\\..\\x", "a" * 64, ""):
        d = visitor(app)
        d.cookies.set(COOKIE, hostile)
        assert d.get("/api/state").status_code == 200


def test_work_survives_a_server_restart_and_old_visitors_are_cleaned_up(cfg):
    store = WorkspaceStore(cfg, sweep_every=3600)
    ws, issued = store.resolve(None, "1.1.1.1")
    assert issued
    ws.session.apply("add_mobject", {"scene_id": ws.session.project.scenes[0].id, "type": "Square"})
    store.close()  # writes everything to disk

    again = WorkspaceStore(cfg, sweep_every=3600)  # a restart
    back, issued = again.resolve(ws.id, "1.1.1.1")
    assert not issued and len(back.session.project.scenes[0].mobjects) == 1

    stale = cfg.data_dir / "workspaces" / ("cd" * 16)
    stale.mkdir()
    os.utime(stale, (time.time() - cfg.session_ttl - 100,) * 2)
    again.sweep()
    assert not stale.exists() and (cfg.data_dir / "workspaces" / ws.id).exists()
    again.close()


def test_new_visitors_per_address_are_limited(cfg):
    store = WorkspaceStore(replace(cfg, new_per_hour=3), sweep_every=3600)
    for _ in range(3):
        store.resolve(None, "9.9.9.9")
    from manimator.server.web import TooFast

    with pytest.raises(TooFast):
        store.resolve(None, "9.9.9.9")
    store.resolve(None, "8.8.8.8")  # someone else is fine
    store.close()


# ---------------------------------------------------------------------- what a stranger can't do


@pytest.mark.parametrize("method, url, body", [
    ("post", "/api/file/open", {"path": "C:/secrets.manimator"}),
    ("post", "/api/file/save", {"path": "C:/anywhere"}),
    ("post", "/api/file/export", {"path": "C:/anywhere.py"}),
    ("post", "/api/open-folder", {}),
    ("post", "/api/dialog", {"kind": "open"}),
    ("get", "/api/file/recent", None),
])
def test_there_is_no_way_to_name_a_path_on_the_server(app, method, url, body):
    c = visitor(app)
    res = c.post(url, json=body, headers=HEADERS) if method == "post" else c.get(url)
    assert res.status_code in (404, 405)


def test_only_the_configured_host_is_served_and_writes_need_the_header(cfg):
    app = create_app(web=replace(cfg, allowed_hosts=frozenset({"studio.example.com"})))
    assert TestClient(app, base_url="http://studio.example.com").get("/api/state").status_code == 200
    assert TestClient(app, base_url="http://evil.example.net").get("/api/state").status_code == 403
    assert TestClient(app, base_url="http://localhost").get("/api/state").status_code == 200
    assert TestClient(app, base_url="http://evil.example.net").get("/healthz").status_code == 200
    c = TestClient(app, base_url="http://studio.example.com")
    assert c.post("/api/undo").status_code == 403  # no X-Manimator header: a cross-site form can't do this
    assert c.post("/api/undo", headers=HEADERS).status_code == 200


def test_security_headers(app):
    res = visitor(app).get("/")
    policy = res.headers["content-security-policy"]
    # scripts only from the site's own files: not from /mcp/kit-js/, where the chat player finds anyone's customization
    assert "script-src http://localhost/static/;" in policy and "'self'" not in policy.split("script-src")[1].split(";")[0]
    assert "frame-ancestors 'none'" in policy
    assert res.headers["x-content-type-options"] == "nosniff"
    assert "camera=()" in res.headers["permissions-policy"] and "microphone=()" in res.headers["permissions-policy"]
    app_page = visitor(app).get("/app")  # every script the editor's page loads is one of those files
    assert re.findall(r'<script[^>]* src="([^"]+)"', app_page.text) == ["/static/js/main.js"]


def test_the_site_icon_is_served_where_browsers_look(app):
    c = visitor(app)
    for path in ("/favicon.ico", "/static/favicon/favicon.ico", "/static/favicon/icon192.png", "/apple-touch-icon.png"):
        res = c.get(path)
        assert res.status_code == 200 and res.headers["cache-control"] == "no-cache", path
    assert c.get("/favicon.ico").content[:4] == b"\0\0\1\0"  # an .ico
    svg = c.get("/static/favicon/icon.svg")  # what browsers show, drawn from brand/logo.svg
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    page = c.get("/app").text
    assert 'href="/static/favicon/favicon.ico"' in page and 'href="/static/favicon/icon.svg"' in page


def test_pages_answer_head_like_get(app):
    c = visitor(app)
    for path in ("/app", "/docs", "/favicon.ico", "/static/favicon/icon.svg"):  # link checkers and crawlers ask HEAD
        get, head = c.get(path), c.head(path)
        assert head.status_code == 200 and head.headers["content-type"] == get.headers["content-type"], path
    assert c.head("/api/op").status_code == 405  # only what GET answers


def test_docs_pages_link_each_other_and_their_sections(app):
    c = visitor(app)
    for i, (slug, title, _, _) in enumerate(docs.PAGES):
        page = c.get(docs.address(slug))
        assert page.status_code == 200 and f"<h1>{title}</h1>" in page.text, slug
        assert all(f'href="{docs.address(s)}"' in page.text for s, *_ in docs.PAGES)  # the sidebar
        assert f'href="{docs.address(slug)}" aria-current="page"' in page.text
        for hid in re.findall(r'<h[23] id="([a-z0-9-]+)">', page.text):  # On this page lists every heading
            assert f'<li class="l2"><a href="#{hid}">' in page.text or f'<li class="l3"><a href="#{hid}">' in page.text
        if i + 1 < len(docs.PAGES):  # Next
            assert f'class="d-next" href="{docs.address(docs.PAGES[i + 1][0])}"' in page.text
    assert c.get("/docs/nothing-here").status_code == 404
    assert "Sign in" not in c.get("/docs").text  # no accounts here: the docs only lead to the app
    found = c.get("/docs/search.json").json()
    assert {"page": "Customizations", "url": "/docs/customizations#writing", "title": "Writing a customization"} \
        .items() <= next(e for e in found if e["url"] == "/docs/customizations#writing").items()


def test_without_an_add_on_there_are_no_accounts(app):
    c = visitor(app)
    info = c.get("/api/account").json()
    assert info["accounts"] is False and info["user"] is None and info["plan"]["key"] == "local"
    assert c.get("/", follow_redirects=False).headers["location"] == "/app"  # no home page: the app opens
    for path in ("/pricing", "/terms", "/auth/callback"):
        assert c.get(path).status_code == 404, path
    assert c.post("/api/auth/signin", json={"email": "a@b.co", "password": "x"}, headers=HEADERS).status_code == 404
    stand_in = c.get("/static/js/account.js").text  # the page's account code shows and does nothing
    assert "export const AuthDialog = () => null;" in stand_in and "fetch" not in stand_in


def test_big_requests_are_refused_before_they_are_read(app):
    res = visitor(app).post("/api/op", content=b"x" * 2_200_000, headers={**HEADERS, "Content-Type": "application/json"})
    assert res.status_code == 413


def test_requests_per_visitor_are_throttled(app):
    c = visitor(app)
    codes = [upload(c, "notes.txt", b"x").status_code for _ in range(8)]
    assert 429 in codes  # a few are fine, a flood is not


# ---------------------------------------------------------------------- files


def test_a_project_can_be_downloaded(app):
    a = visitor(app)
    op(a, "add_mobject", scene_id=first_scene(a)["id"], type="Star")
    res = a.get("/api/file/download")
    assert "attachment" in res.headers["content-disposition"] and ".manimator" in res.headers["content-disposition"]
    assert a.get("/api/state").json()["dirty"] is False  # a copy was taken
    assert json.loads(res.text)["scenes"][0]["mobjects"][0]["type"] == "Star"


def test_a_project_file_cannot_be_uploaded(app):
    """Projects only come from the visitor's own workspace: there is no way to send the server a project file."""
    for url in ("/api/file/load", "/api/file/open"):
        res = visitor(app).post(url, json={"content": "{}"}, headers=HEADERS)
        assert res.status_code in (404, 405), url


def test_a_visitor_keeps_several_projects(app, cfg):
    c = visitor(app)
    first = c.get("/api/projects").json()["projects"]
    assert len(first) == 1 and first[0]["current"] and first[0]["name"] == "Untitled project"
    op(c, "add_mobject", scene_id=first_scene(c)["id"], type="Circle")
    c.post("/api/projects/rename", json={"id": first[0]["id"], "name": "  Circles\x00 "}, headers=HEADERS)
    assert c.get("/api/state").json()["name"] == "Circles"

    c.post("/api/file/new", headers=HEADERS)  # a second project; the first is kept
    assert first_scene(c)["mobjects"] == []
    listed = c.get("/api/projects").json()["projects"]
    assert [p["name"] for p in listed] == ["Untitled project", "Circles"] and listed[1]["objects"] == 1

    res = c.post("/api/projects/open", json={"id": first[0]["id"]}, headers=HEADERS).json()
    assert res["state"]["name"] == "Circles" and len(res["state"]["project"]["scenes"][0]["mobjects"]) == 1
    assert "Circles.manimator" in c.get("/api/file/download").headers["content-disposition"]

    c.post("/api/projects/delete", json={"id": first[0]["id"]}, headers=HEADERS)  # deleting the open one
    listed = c.get("/api/projects").json()["projects"]
    assert len(listed) == 1 and listed[0]["current"] and first_scene(c)["mobjects"] == []
    for bad in ("../x", "ab" * 8, None, 5):
        assert c.post("/api/projects/open", json={"id": bad}, headers=HEADERS).status_code == 400

    for _ in range(cfg.max_projects - 1):
        assert c.post("/api/file/new", headers=HEADERS).status_code == 200
    res = c.post("/api/file/new", headers=HEADERS)
    assert res.status_code == 400 and "up to" in res.json()["error"]


def test_project_cards_show_the_picture_of_the_project_as_it_is(app, cfg):
    """The browser sends a project's picture; after an edit the old one isn't shown, so the page makes a new one."""
    c = visitor(app)
    pid = c.get("/api/projects").json()["projects"][0]["id"]
    picture = {**HEADERS, "Content-Type": "image/png"}
    assert c.post(f"/api/thumb/{pid}", content=png((64, 36)), headers=picture).status_code == 200
    res = c.get(f"/api/thumb/{pid}?v=1")
    assert res.status_code == 200 and "immutable" in res.headers["cache-control"] and res.content.startswith(b"\x89PNG")

    time.sleep(0.02)  # a later file time
    op(c, "add_mobject", scene_id=first_scene(c)["id"], type="Circle")  # the unsaved edit counts too
    missing = c.get(f"/api/thumb/{pid}?v=2")
    assert missing.status_code == 404 and "no-store" in missing.headers["cache-control"]  # a miss isn't cached
    assert c.post(f"/api/thumb/{pid}", content=png((64, 36)), headers=picture).status_code == 200
    assert c.get(f"/api/thumb/{pid}?v=2").status_code == 200

    assert visitor(app).get(f"/api/thumb/{pid}").status_code == 400  # another visitor's project
    for bad in ("..", "ab" * 8, "x" * 16):
        assert c.get(f"/api/thumb/{bad}").status_code in (400, 404)
    thumbs = cfg.data_dir / "workspaces" / c.cookies[COOKIE] / "thumbs"
    assert len(list(thumbs.glob(f"{pid}-*.png"))) == 1  # the old picture is gone
    c.post("/api/file/new", headers=HEADERS)
    c.post("/api/projects/delete", json={"id": pid}, headers=HEADERS)
    assert not any(thumbs.glob(f"{pid}-*.png"))


def test_python_export_points_at_an_assets_folder(app):
    c = visitor(app)
    sid = first_scene(c)["id"]
    img = op(c, "add_mobject", scene_id=sid, type="ImageMobject")
    name = upload(c, "cat.png", png()).json()["name"]
    op(c, "set_param", scene_id=sid, mob_id=img, name="file", value=name)
    code = c.get("/api/file/export.py")
    assert f'"assets/{name}"' in code.text and "attachment" in code.headers["content-disposition"]


# ---------------------------------------------------------------------- uploads


def test_uploading_a_picture(app):
    c = visitor(app)
    res = upload(c, "my cat.png", png())
    assert res.status_code == 200
    name = res.json()["name"]
    assert name.startswith("my_cat-") and name.endswith(".png")
    assert c.get("/api/assets").json()["files"] == [name]
    assert upload(c, "my cat.png", png()).json()["name"] == name  # same file, same name
    assert visitor(app).get("/api/assets").json()["files"] == []  # nobody else sees it


@pytest.mark.parametrize("name, data, why", [
    ("notes.exe", b"hello", "extension"),
    ("evil.png", b"<?php system($_GET[0]); ?>", "content"),
    ("big.png", png((5000, 5000)), "pixels"),
    ("tiff.tif", png(fmt="TIFF"), "format"),
    ("a.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "script"),
    ("b.svg", b"<svg><image href='file:///etc/passwd'/></svg>", "image"),
    ("c.svg", b"<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><svg>&x;</svg>", "entity"),
    ("d.svg", b"<svg><a href='http://evil.example'><rect width='5' height='5'/></a></svg>", "link"),
    ("e.svg", b"just text", "not svg"),
    ("f.svg", b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><rect width='5' height='5'/></svg>", "handler"),
    ("g.svg", b"<svg><rect width='5'\n  ONCLICK = 'alert(1)'/></svg>", "handler"),
], ids=["extension", "content", "pixels", "format", "script", "image", "entity", "link", "not-svg", "onload", "onclick"])
def test_uploads_that_are_not_plain_pictures_are_refused(app, name, data, why):
    res = upload(visitor(app), name, data)
    assert res.status_code in (400, 413), (why, res.text)


def test_a_clean_svg_is_accepted(app):
    svg = b"<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><defs><linearGradient id='g'/></defs><rect fill='url(#g)' width='10' height='10'/></svg>"
    assert upload(visitor(app), "ok.svg", svg).status_code == 200
    words = (b"<svg xmlns='http://www.w3.org/2000/svg'><text font-family='Montserrat' id='online'>one = 1, on = off"
             b"</text></svg>")  # "on" in names and words is no event handler
    assert upload(visitor(app), "words.svg", words).status_code == 200


def test_checking_an_svg_takes_no_time_whatever_it_holds():
    from manimator.server.web import check_svg

    started = time.monotonic()
    for text in ("<" * 1_000_000, "< on" * 250_000, "<a " + "onx" * 300_000):
        try:
            check_svg(f"<svg>{text}".encode())
        except Exception:  # noqa: BLE001 - refused or not, it must be quick
            pass
    assert time.monotonic() - started < 2


def test_upload_size_count_and_storage_limits(app, cfg):
    c = visitor(app)
    assert upload(c, "x.png", b"\0" * (cfg.max_upload_bytes + 10)).status_code == 413
    for i in range(cfg.max_assets):
        assert upload(c, f"p{i}.png", png((20 + i, 10))).status_code == 200
    assert upload(c, "one-too-many.png", png((50, 10))).status_code == 400


def test_objects_can_only_use_files_the_visitor_uploaded(app):
    a, b = visitor(app), visitor(app)
    sid_a, sid_b = first_scene(a)["id"], first_scene(b)["id"]
    img_a = op(a, "add_mobject", scene_id=sid_a, type="ImageMobject")
    img_b = op(b, "add_mobject", scene_id=sid_b, type="ImageMobject")
    name = upload(a, "mine.png", png()).json()["name"]
    op(a, "set_param", scene_id=sid_a, mob_id=img_a, name="file", value=name)
    for bad in ("../../etc/passwd.png", "/etc/passwd.png", "C:\\Windows\\x.png", "missing-12345678.png", ".hidden.png"):
        res = a.post("/api/op", json={"op": "set_param", "args": {"scene_id": sid_a, "mob_id": img_a, "name": "file", "value": bad}}, headers=HEADERS)
        assert res.status_code == 400, bad
    other = b.post("/api/op", json={"op": "set_param", "args": {"scene_id": sid_b, "mob_id": img_b, "name": "file", "value": name}}, headers=HEADERS)
    assert other.status_code == 400  # b can't borrow a's upload
    assert name in a.get(f"/api/plan?scene_id={sid_a}").text  # the browser fetches it from a's own uploads
    assert a.get(f"/api/assets/{name}").status_code == 200 and b.get(f"/api/assets/{name}").status_code == 404


def test_a_project_file_on_disk_cannot_point_at_the_servers_files_or_be_huge(app, cfg):
    """Nothing uploads project files any more, but one found on disk is still never trusted when it is opened."""
    project = Project.new()
    scene = project.scenes[0]
    img = ops.create_mobject(scene, "ImageMobject")
    img.params["file"] = "/etc/passwd.png"
    poly = ops.create_mobject(scene, "Polygon")
    poly.params["points"] = [[i, i] for i in range(5000)]
    sphere = ops.create_mobject(scene, "Sphere")
    sphere.params["radius"] = 1e9
    c = visitor(app)
    first = c.get("/api/projects").json()["projects"][0]["id"]
    c.post("/api/file/new", headers=HEADERS)  # the first project is put away, so it can be opened again
    path = cfg.data_dir / "workspaces" / c.cookies[COOKIE] / "projects" / f"{first}.manimator"
    path.write_text(json.dumps(project.to_dict()), encoding="utf-8")
    res = c.post("/api/projects/open", json={"id": first}, headers=HEADERS)
    assert res.status_code == 200
    mobs = {m["type"]: m for m in first_scene(c)["mobjects"]}
    assert mobs["ImageMobject"]["params"]["file"] == ""
    assert len(mobs["Polygon"]["params"]["points"]) == 5 and mobs["Sphere"]["params"]["radius"] == 50
    assert any("reset" in n for n in res.json()["notes"])


def test_project_size_limits(app, cfg):
    c = visitor(app)
    sid = first_scene(c)["id"]
    for _ in range(cfg.limits.max_objects):
        op(c, "add_mobject", scene_id=sid, type="Dot")
    res = c.post("/api/op", json={"op": "add_mobject", "args": {"scene_id": sid, "type": "Dot"}}, headers=HEADERS)
    assert res.status_code == 400 and "at most" in res.json()["error"]
    assert len(first_scene(c)["mobjects"]) == cfg.limits.max_objects  # the refused edit changed nothing


def test_numbers_that_json_allows_but_python_cant_use_are_refused(app):
    c = visitor(app)
    sid = first_scene(c)["id"]
    for args in (f'{{"scene_id": "{sid}", "delta": Infinity}}', f'{{"scene_id": "{sid}", "index": -Infinity}}',
                 f'{{"scene_id": "{sid}", "index": NaN}}'):
        name = "move_scene" if "delta" in args else "add_wait_step"
        res = c.post("/api/op", content=f'{{"op": "{name}", "args": {args}}}',
                     headers={**HEADERS, "Content-Type": "application/json"})
        assert res.status_code == 400 and "finite" in res.json()["error"]
    assert first_scene(c)["steps"] == []


def test_a_damaged_project_file_is_kept_aside_not_written_over(cfg):
    from manimator.server.web import Workspace

    wid = "a" * 32
    Workspace(wid, cfg.data_dir / "workspaces" / wid, cfg).project_file.write_text("{damaged", encoding="utf-8")
    ws = Workspace(wid, cfg.data_dir / "workspaces" / wid, cfg)
    ws.load_from_disk()
    ws.flush_now()  # what leaving the editor, or the cleanup, does
    kept = list(ws.projects_dir.glob("*.damaged-*.json"))
    assert len(kept) == 1 and kept[0].read_text(encoding="utf-8") == "{damaged"
    assert json.loads(ws.project_file.read_text(encoding="utf-8"))["scenes"]  # a fresh project in its place


def test_projects_saved_under_the_old_file_name_are_renamed(cfg):
    from manimator.server.web import Workspace

    wid = "b" * 32
    ws = Workspace(wid, cfg.data_dir / "workspaces" / wid, cfg)
    project = Project.new()
    ops.create_mobject(project.scenes[0], "Star")
    ws.project_file.with_suffix(".manimproj").write_text(json.dumps(project.to_dict()), encoding="utf-8")
    ws = Workspace(wid, cfg.data_dir / "workspaces" / wid, cfg)
    ws.load_from_disk()
    assert ws.project_file.name.endswith(".manimator") and ws.project_file.exists()
    assert not list(ws.projects_dir.glob("*.manimproj"))
    assert ws.session.project.scenes[0].mobjects[0].type == "Star"


def test_the_catalog_tells_the_page_the_limits(app):
    cat = visitor(app).get("/api/catalog").json()
    assert cat["limits"] == {"maxUploadMb": 0, "maxAssets": 3, "maxProjects": 20}  # nothing about videos


# ---------------------------------------------------------------------- memory, files and races


def test_the_undo_history_keeps_only_so_many_bytes(monkeypatch):
    import secrets

    from manimator.server import session as session_module

    s = session_module.Session()
    sid = s.project.scenes[0].id
    mob = s.apply("add_mobject", {"scene_id": sid, "type": "Text"})
    monkeypatch.setattr(session_module, "UNDO_BYTES", 4000)
    texts = []
    for i in range(60):
        texts.append(f"{i} {secrets.token_hex(100)}")  # doesn't compress: each step costs its size
        s.apply("set_param", {"scene_id": sid, "mob_id": mob, "name": "text", "value": texts[-1]})
    text = lambda: s.project.scenes[0].mobjects[0].params["text"]  # noqa: E731
    undos = 0
    while s.state()["can_undo"]:
        s.undo()
        undos += 1
    assert 3 <= undos < 60 and text() == texts[-undos - 1]  # the oldest steps were forgotten
    while s.state()["can_redo"]:
        s.redo()
    assert text() == texts[-1]
    monkeypatch.setattr(session_module, "UNDO_BYTES", 1)
    s.apply("set_param", {"scene_id": sid, "mob_id": mob, "name": "text", "value": "last"})
    s.undo()  # the newest step always stays
    assert text() == texts[-1] and not s.state()["can_undo"]


def test_a_project_cant_grow_past_the_size_limit(monkeypatch):
    from manimator.server import session as session_module

    s = session_module.Session()
    sid = s.project.scenes[0].id
    mob = s.apply("add_mobject", {"scene_id": sid, "type": "Text"})
    size = len(json.dumps(s.project.to_dict(), separators=(",", ":")))
    monkeypatch.setattr(session_module, "MAX_PROJECT_CHARS", size + 200)
    s.apply("set_param", {"scene_id": sid, "mob_id": mob, "name": "text", "value": "a" * 100})
    with pytest.raises(session_module.OpError, match="too large"):
        s.apply("set_param", {"scene_id": sid, "mob_id": mob, "name": "text", "value": "a" * 1000})
    assert s.project.scenes[0].mobjects[0].params["text"] == "a" * 100  # unchanged
    monkeypatch.setattr(session_module, "MAX_PROJECT_CHARS", 10)  # already too large: it may still shrink
    s.apply("set_param", {"scene_id": sid, "mob_id": mob, "name": "text", "value": "a"})
    with pytest.raises(session_module.OpError, match="too large"):
        s.apply("set_param", {"scene_id": sid, "mob_id": mob, "name": "text", "value": "ab"})


def test_opening_another_project_keeps_the_card_picture_of_an_unchanged_one(app):
    c = visitor(app)
    op(c, "add_mobject", scene_id=first_scene(c)["id"], type="Circle")
    first = c.get("/api/state").json()["id"]
    assert c.post("/api/file/new", headers=HEADERS).status_code == 200
    second = c.get("/api/state").json()["id"]
    sent = c.post(f"/api/thumb/{first}", content=png(), headers={**HEADERS, "Content-Type": "image/png"})
    assert sent.status_code == 200 and c.get(f"/api/thumb/{first}").status_code == 200
    for pid in (first, second):  # looked at, nothing changed
        assert c.post("/api/projects/open", json={"id": pid}, headers=HEADERS).status_code == 200
    assert c.get(f"/api/thumb/{first}").status_code == 200
    c.post("/api/projects/open", json={"id": first}, headers=HEADERS)
    op(c, "add_mobject", scene_id=first_scene(c)["id"], type="Square")
    c.post("/api/projects/open", json={"id": second}, headers=HEADERS)
    assert c.get(f"/api/thumb/{first}").status_code == 404  # changed: its picture is made again


def test_an_edit_made_in_the_editor_while_a_chat_changes_the_project_is_kept(cfg):
    import threading

    from manimator.server.web import Workspace

    wid = "c" * 32
    ws = Workspace(wid, cfg.data_dir / "workspaces" / wid, cfg)
    sid = ws.session.project.scenes[0].id
    editor = threading.Thread(target=ws.session.apply, args=("add_mobject", {"scene_id": sid, "type": "Square"}))

    def change(project):
        editor.start()
        editor.join(0.3)  # the editor's edit waits for the chat's change (it used to land here and then be lost)
        ops.create_mobject(project.scenes[0], "Circle")

    ws.edit_project(ws.current_id, change, "Claude: add a circle")
    editor.join(5)
    assert sorted(m.type for m in ws.session.project.scenes[0].mobjects) == ["Circle", "Square"]


def test_a_full_server_makes_room_instead_of_turning_visitors_away(tmp_path):
    app = create_app(web=WebConfig(data_dir=tmp_path, max_workspaces=2))
    clients = [visitor(app) for _ in range(4)]
    for c in clients:
        assert c.get("/api/state").status_code == 200  # every one of them was seen a moment ago
    op(clients[0], "add_mobject", scene_id=first_scene(clients[0])["id"], type="Circle")
    for c in clients[1:]:
        assert c.get("/api/state").status_code == 200
    assert [m["type"] for m in first_scene(clients[0])["mobjects"]] == ["Circle"]  # back from disk, with its edit


def test_a_workspace_let_go_while_still_in_use_is_taken_back_not_read_twice(tmp_path):
    store = WorkspaceStore(WebConfig(data_dir=tmp_path, max_workspaces=1), sweep_every=3600)
    try:
        a, _ = store.resolve(None, "1.2.3.4")
        store.resolve(None, "1.2.3.4")  # makes room: a is let go
        assert store.loaded(a.id) is None
        again, issued = store.resolve(a.id, "1.2.3.4")
        assert again is a and not issued  # the request still holding it and the next one share one workspace
    finally:
        store.close()
