"""The Code view: the project's script and data files, their uploads and download, and the sandbox they run in."""

import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from manimator.model.project import Project
from manimator.server.api import create_app
from manimator.server.session import OpError, Session
from manimator.server.web import WebConfig

HEADERS = {"X-Manimator": "1"}


@pytest.fixture
def cfg(tmp_path):
    return WebConfig(data_dir=tmp_path, max_upload_bytes=200_000, max_assets=5, asset_quota=1_000_000)


@pytest.fixture
def client(cfg):
    return TestClient(create_app(web=cfg), base_url="http://localhost")


def op(client, name, /, **args):
    return client.post("/api/op", json={"op": name, "args": args}, headers=HEADERS)


def upload(client, name, data):
    return client.post(f"/api/upload?name={name}", content=data,
                       headers={**HEADERS, "Content-Type": "application/octet-stream"})


def code_of(client):
    return client.get("/api/state").json()["project"].get("code")


def test_a_project_keeps_no_code_until_it_has_some():
    project = Project.new()
    assert "code" not in project.to_dict()  # project files without code look as before
    s = Session(project)
    s.apply("set_code", {"text": "from manim import *\n"})
    again = Project.from_dict(s.project.to_dict())
    assert again.code == {"text": "from manim import *\n", "files": []}


def test_typing_merges_into_one_undo_step_and_undo_brings_the_text_back():
    s = Session(Project.new())
    s.apply("set_code", {"text": "a"}, "code")
    s.apply("set_code", {"text": "ab"}, "code")
    assert s.state()["undo_label"] == "Edit code"
    s.undo()
    assert s.project.code is None


def test_code_files_are_named_safely_and_can_be_renamed_and_removed():
    s = Session(Project.new())
    s.apply("add_code_file", {"name": "data.csv", "asset": "data-12345678.csv"})
    s.apply("add_code_file", {"name": "data.csv", "asset": "data-87654321.csv"})  # the same name replaces it
    assert s.project.code["files"] == [{"name": "data.csv", "asset": "data-87654321.csv"}]
    for bad in ("../x.csv", "x.py", "", ".hidden.csv", "a/b.csv"):
        with pytest.raises(OpError):
            s.apply("add_code_file", {"name": bad, "asset": "data-12345678.csv"})
    assert s.apply("rename_code_file", {"name": "data.csv", "new_name": "points.csv"}) == "points.csv"
    s.apply("remove_code_file", {"name": "points.csv"})
    assert s.project.code["files"] == []
    with pytest.raises(OpError):
        s.apply("set_code", {"text": "x" * 300_000})


def test_data_files_have_no_size_limit_of_their_own_only_the_storage(client, cfg):
    big = b"x,y\n" + b"1,2\n" * 100_000  # 400 KB: twice the per-file limit of pictures
    assert len(big) > cfg.max_upload_bytes
    res = upload(client, "my data.csv", big)
    assert res.status_code == 200, res.text
    stored = res.json()["name"]
    assert stored.startswith("my_data-") and stored.endswith(".csv")
    storage = client.get("/api/storage").json()
    assert storage["data"] == len(big) and [f["kind"] for f in storage["files"]] == ["data"]
    assert upload(client, "huge.csv", b"1\n" * 400_000).status_code == 413  # more than the storage has room for
    got = client.get(f"/api/assets/{stored}")
    assert got.status_code == 200 and got.content == big
    assert got.headers["content-disposition"] == "attachment"  # never shown as a page of the site
    assert upload(client, "run.py", b"print(1)").status_code == 400  # only data kinds


def test_a_visitor_can_add_only_their_own_uploads_and_download_the_code_with_them(cfg):
    app = create_app(web=cfg)
    a, b = TestClient(app, base_url="http://localhost"), TestClient(app, base_url="http://localhost")
    stored = upload(a, "points.json", b'{"x": [1, 2, 3]}').json()["name"]
    assert op(b, "add_code_file", name="points.json", asset=stored).status_code == 400  # not b's upload
    assert op(a, "add_code_file", name="points.json", asset=stored).status_code == 200
    assert op(a, "set_code", text="from manim import *\n").status_code == 200
    assert code_of(a) == {"text": "from manim import *\n", "files": [{"name": "points.json", "asset": stored}]}
    res = a.get("/api/file/code.zip")
    assert res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(res.content)) as z:
        assert sorted(z.namelist()) == ["points.json", "scene.py"]
        assert z.read("points.json") == b'{"x": [1, 2, 3]}' and z.read("scene.py") == b"from manim import *\n"


def test_the_code_sandbox_runs_locked_down(client):
    """The Code view's Python runs only in web/sandbox/code.html: framed by this site alone, sandboxed, allowed the
    site's /static/ files and Pyodide, nothing else."""
    res = client.get("/static/sandbox/code.html")
    csp = res.headers["content-security-policy"]
    assert res.status_code == 200 and res.headers["x-frame-options"] == "SAMEORIGIN"
    assert "sandbox allow-scripts" in csp and "frame-ancestors http://localhost;" in csp
    pyodide = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
    assert f"script-src http://localhost/static/ {pyodide} 'wasm-unsafe-eval';" in csp
    assert f"connect-src http://localhost/static/ {pyodide};" in csp
    assert "unsafe-inline" not in csp.split("style-src")[0] and "unsafe-eval'" not in csp.replace("wasm-unsafe-eval", "")
    app_csp = client.get("/app").headers["content-security-policy"]
    assert "jsdelivr" not in app_csp and "wasm" not in app_csp  # the app's own page doesn't get them
