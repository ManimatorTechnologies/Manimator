"""The gallery's customizations come from a GitHub repository's Kits/ folders (server/github.py): new folders join it,
changed ones get new versions, gone ones leave it, and GitHub's signed webhook makes the site look again."""

import hashlib
import hmac
import io
import json
import tarfile
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from manimator.registry import MOBJECTS
from manimator.registry.custom import kit_type
from manimator.server.api import create_app
from manimator.server.github import GitHubKits, read_archive
from manimator.server.kits import KitError, KitStore, read_manifest
from manimator.server.web import WebConfig
from tests.TestKits import EXAMPLES, SEND, package

REPO = "ManimatorTechnologies/ManimKit"
SECRET = "webhook secret"


def folder(name="Battery", author="ada-l", **changes) -> dict[str, bytes]:
    """An example kit's folder as the repository holds it, its manifest crediting `author` (None: no author)."""
    files = {p.name: p.read_bytes() for p in (EXAMPLES / name).iterdir() if p.is_file()}
    m = json.loads(files["manifest.json"])
    if author is not None:
        m["author"] = author
    files["manifest.json"] = json.dumps(m).encode()
    for key, value in changes.items():
        key = key.replace("_", ".", 1)
        if value is None:
            files.pop(key, None)
        else:
            files[key] = value.encode() if isinstance(value, str) else value
    return files


def archive(sha: str, folders: dict) -> bytes:
    """The repository at a commit, as GitHub's codeload sends it (one top folder named after it)."""
    buf = io.BytesIO()
    top = f"{REPO.replace('/', '-')}-{sha[:7]}"
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path, data in [("README.md", b"# ManimKit"), ("Build.py", b"print()"),
                           *((f"Kits/{f}/{n}", d) for f, files in folders.items() for n, d in files.items())]:
            info = tarfile.TarInfo(f"{top}/{path}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class FakeGitHub:
    """GitHub as the site reads it: the commit main is at, and the repository's archive at a commit."""

    def __init__(self):
        self.commits: dict[str, dict] = {}
        self.head = ""
        self.asked: list[str] = []

    def push(self, folders: dict) -> str:
        sha = hashlib.sha1(f"{len(self.commits)}{sorted(folders)}".encode()).hexdigest()
        self.commits[sha], self.head = folders, sha
        return sha

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        self.asked.append(f"{url.host}{url.path}")
        if url.host == "api.github.com" and url.path == f"/repos/{REPO}/commits/main":
            assert request.headers["accept"] == "application/vnd.github.sha"
            return httpx.Response(200, text=self.head)
        if url.host == "codeload.github.com" and url.path.startswith(f"/{REPO}/tar.gz/"):
            sha = url.path.rsplit("/", 1)[1]
            return httpx.Response(200, content=archive(sha, self.commits[sha]))
        return httpx.Response(404)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))


@pytest.fixture
def github(tmp_path):
    fake = FakeGitHub()
    store = KitStore(tmp_path / "kits")
    changed = []
    repo = GitHubKits(store, REPO, http=fake.client(), changed=lambda: changed.append(1))
    yield fake, store, repo, changed
    repo.close()
    store.close()


def gallery(store) -> list[tuple[str, str]]:
    return [(k["name"], k["owner_name"]) for k in store.gallery()]


def test_the_repositorys_folders_join_the_gallery_by_their_authors(github):
    fake, store, repo, changed = github
    sha = fake.push({"Battery": folder(), "NeuralNetwork": folder("NeuralNetwork", author=None)})
    assert repo.sync() == {"commit": sha, "changed": ["Battery: added", "NeuralNetwork: added"], "problems": []}
    assert changed == [1]
    # credited to the manifest's author, or to the repository's owner when it names none
    assert sorted(gallery(store)) == [("Battery", "ada-l"), ("Neural network", "ManimatorTechnologies")]
    battery = next(k for k in store.gallery() if k["name"] == "Battery")
    assert battery["owner"] == f"repo:{REPO}" and store.latest_public(battery["id"]) == 1
    page = store.summary(battery, "someone")
    assert page["source"] == {"repo": REPO, "folder": "Battery", "url": f"https://github.com/{REPO}/tree/{sha}/Kits/Battery"}
    assert page["author_url"] == "https://github.com/ada-l" and not page["mine"]
    assert MOBJECTS[kit_type(battery["id"], 1)].kit["author"] == "ada-l"
    # nobody owns them: they're no one's own, and only a library brings them to the editor
    assert store.owned("someone") == [] and store.usable("someone") == []
    store.set_library("someone", battery["id"], True)
    assert [s.key for s in store.usable("someone")][0] == kit_type(battery["id"], 1)


def test_the_same_commit_is_read_once(github):
    fake, store, repo, changed = github
    fake.push({"Battery": folder()})
    repo.sync()
    fake.asked.clear()
    assert repo.sync()["changed"] == [] and fake.asked == [f"api.github.com/repos/{REPO}/commits/main"]
    # a commit that leaves the folders as they were changes nothing either
    fake.push({"Battery": folder()})
    assert repo.sync()["changed"] == [] and changed == [1]
    assert repo.sync(force=True)["changed"] == []


def test_a_changed_folder_gets_a_new_version_and_projects_keep_theirs(github):
    fake, store, repo, _ = github
    fake.push({"Battery": folder()})
    repo.sync()
    kid = store.gallery()[0]["id"]
    files = folder(kit_js=(EXAMPLES / "Battery" / "kit.js").read_text(encoding="utf-8") + "\n// faster\n")
    files["manifest.json"] = json.dumps(json.loads(files["manifest.json"]) | {"version": "1.2"}).encode()
    sha = fake.push({"Battery": files})
    assert repo.sync()["changed"] == ["Battery: updated"]
    assert [v["manifest"]["version"] for v in store.versions(kid)] == ["1.1", "1.2"]
    assert store.latest_public(kid) == 2 and store.file(kid, 2, "kit.js").read_text(encoding="utf-8").endswith("faster\n")
    assert store.source(kid, 2)["url"].endswith(f"/tree/{sha}/Kits/Battery")
    assert store.readable("anyone", kid, 1)  # the older version stays readable while a project may use it
    assert (kid, 1) in store.unneeded()  # and goes for good once none does (server/web.py prune_kits)


def test_a_gone_folder_leaves_the_gallery_and_libraries_and_can_come_back(github):
    fake, store, repo, _ = github
    fake.push({"Battery": folder(), "Refraction": folder("Refraction")})
    repo.sync()
    kid = next(k["id"] for k in store.gallery() if k["name"] == "Battery")
    store.set_library("bo", kid, True)
    fake.push({"Refraction": folder("Refraction")})
    assert repo.sync()["changed"] == ["Battery: removed"]
    assert gallery(store) == [("Refraction", "ada-l")] and store.library("bo") == []
    assert store.readable("bo", kid, 1)  # projects that use it keep playing it
    fake.push({"Battery": folder(), "Refraction": folder("Refraction")})
    assert repo.sync()["changed"] == ["Battery: back"]
    assert sorted(gallery(store)) == [("Battery", "ada-l"), ("Refraction", "ada-l")]
    assert store.latest_public(kid) == 1  # the same customization, still at version 1


def test_a_folder_that_fails_the_checks_is_left_out_and_the_gallery_keeps_its_version(github):
    fake, store, repo, _ = github
    fake.push({"Battery": folder()})
    repo.sync()
    kid = store.gallery()[0]["id"]
    bad_js = 'import { x } from "https://example.com/x.js";\nexport class Battery {}\nexport class PopIn {}\n'
    fake.push({"Battery": folder(kit_js=bad_js), "Empty": {"notes.txt": b"soon"}, "Pendulum": folder("Refraction", kit_py=None),
               "Huge": folder("Refraction", README_md=b"x" * (64 * 1024 + 1))})
    result = repo.sync()
    assert result["changed"] == [] and result["problems"] == [
        'Battery: kit.js imports \'https://example.com/x.js\': packages may import only from "manimator".',
        "Empty: The package needs manifest.json, kit.js, kit.py.",
        "Huge: README.md is too large (up to 64 KB).",
        "Pendulum: The package needs kit.py.",
    ]
    assert repo.state["problems"] == result["problems"] and gallery(store) == [("Battery", "ada-l")]
    assert store.latest_public(kid) == 1


def test_class_names_dont_repeat_in_the_repository_and_a_folder_keeps_its_object(github):
    fake, store, repo, _ = github
    copy = folder()  # the same classes in a second folder
    fake.push({"Battery": folder(), "Battery2": copy})
    assert repo.sync()["problems"] == ['Battery2: manifest.json: "Battery" is already a Manim or Manimator name, '
                                       "or another of your customizations' classes; choose another class name."]
    fake.push({"Battery": folder("Refraction")})  # another object in the same folder
    assert repo.sync()["problems"] == ["Battery: A new version must keep the object Battery (a new folder starts a "
                                       "new customization)."]


def test_a_taken_down_customization_gets_no_new_versions_from_the_repository(github):
    fake, store, repo, _ = github
    fake.push({"Battery": folder()})
    repo.sync()
    kid = store.gallery()[0]["id"]
    store.take_down(kid, "It hides a tracker")
    fake.push({"Battery": folder(README_md="# Battery\n\nNew words.\n")})
    assert repo.sync()["problems"] == ["Battery: It was taken down, so it gets no new versions."]
    assert store.gallery() == [] and not store.readable("anyone", kid, 1)


def test_a_failed_look_is_kept_and_tried_again(github, capsys):
    fake, store, repo, _ = github
    fake.head = "not a commit"
    assert repo.sync()["error"] == "GitHub didn't answer with a commit"
    assert repo.state["error"] and "couldn't read ManimatorTechnologies/ManimKit" in capsys.readouterr().err
    fake.push({"Battery": folder()})
    assert repo.sync()["changed"] == ["Battery: added"] and repo.state["error"] == ""


def test_only_a_packages_own_files_are_read_from_the_archive():
    data = archive("a" * 40, {"Battery": {"kit.js": b"js", "logo.png": b"png", "manifest.json": b"{}"},
                              "bad name": {"kit.js": b"js"}})
    assert read_archive(data) == {"Battery": {"kit.js": b"js", "manifest.json": b"{}"}}


def test_an_author_is_a_github_user_name_and_an_upload_is_credited_to_its_account(tmp_path):
    good = json.loads((EXAMPLES / "Battery" / "manifest.json").read_text(encoding="utf-8"))
    assert read_manifest(json.dumps(good | {"author": "Savith-Online"}))["author"] == "Savith-Online"
    assert read_manifest(json.dumps(good))["author"] == ""
    for bad in ("Ada Lovelace", "-ada", "ada--l", 7):
        with pytest.raises(KitError, match="author must be"):
            read_manifest(json.dumps(good | {"author": bad}))
    with pytest.raises(KitError, match="author can be up to 39 characters"):
        read_manifest(json.dumps(good | {"author": "a" * 40}))
    store = KitStore(tmp_path)
    kit = store.add("owner-1", "Ada", package(manifest_json=json.dumps(good | {"author": "someone-else"})), 5)
    assert kit["owner_name"] == "Ada" and store.summary(kit)["source"] is None and store.summary(kit)["author_url"] == ""
    store.close()


# ---------------------------------------------------------------------- the site


def signed(body: bytes, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def wait_for(check, seconds=10.0):
    end = time.time() + seconds
    while not check():
        assert time.time() < end, "timed out"
        time.sleep(0.02)


def test_githubs_signed_webhook_makes_the_site_look_again(tmp_path):
    fake = FakeGitHub()
    fake.push({"Battery": folder()})
    cfg = WebConfig(data_dir=tmp_path, kits_repo=REPO, kits_secret=SECRET)
    with TestClient(create_app(cfg, http=fake.client()), base_url="http://localhost") as c:
        looks = lambda: fake.asked.count(f"api.github.com/repos/{REPO}/commits/main")  # noqa: E731
        wait_for(lambda: looks() == 1)  # it looks when it starts
        push = json.dumps({"ref": "refs/heads/main"}).encode()
        for headers in ({}, {"X-Hub-Signature-256": signed(push, "another secret")}):
            assert c.post("/api/kits/github", content=push, headers={"X-GitHub-Event": "push", **headers}).status_code == 401
        other = json.dumps({"ref": "refs/heads/draft"}).encode()
        assert c.post("/api/kits/github", content=other,
                      headers={"X-GitHub-Event": "push", "X-Hub-Signature-256": signed(other)}).status_code == 200
        ping = b'{"zen": "Keep it logically awesome."}'
        assert c.post("/api/kits/github", content=ping,
                      headers={"X-GitHub-Event": "ping", "X-Hub-Signature-256": signed(ping)}).json() == {"ok": True}
        time.sleep(0.2)
        assert looks() == 1  # neither another branch nor a ping is a reason to look
        # no X-Manimator header: GitHub's servers post here
        assert c.post("/api/kits/github", content=push,
                      headers={"X-GitHub-Event": "push", "X-Hub-Signature-256": signed(push)}).status_code == 200
        wait_for(lambda: looks() == 2)


def test_without_a_secret_there_is_no_webhook(tmp_path):
    c = TestClient(create_app(WebConfig(data_dir=tmp_path, kits_repo=REPO), http=FakeGitHub().client()),
                   base_url="http://localhost")
    body = b"{}"
    assert c.post("/api/kits/github", content=body, headers={"X-Hub-Signature-256": signed(body, "")}).status_code == 404
    plain = TestClient(create_app(WebConfig(data_dir=tmp_path / "plain")), base_url="http://localhost")
    assert plain.post("/api/kits/github", content=body).status_code == 404
    assert plain.post("/api/kits/github", content=body, headers=SEND).status_code == 404


def test_a_repository_must_look_like_owner_and_name(tmp_path, monkeypatch):
    monkeypatch.setenv("MANIMATOR_KITS_REPO", "https://github.com/ManimatorTechnologies/ManimKit")
    with pytest.raises(SystemExit, match="owner/name"):
        WebConfig.from_env(tmp_path)
    monkeypatch.setenv("MANIMATOR_KITS_REPO", REPO)
    monkeypatch.setenv("MANIMATOR_KITS_SECRET", " s3cret ")
    cfg = WebConfig.from_env(tmp_path)
    assert (cfg.kits_repo, cfg.kits_branch, cfg.kits_secret) == (REPO, "main", "s3cret")
    store = KitStore(Path(tmp_path) / "k")
    with pytest.raises(ValueError, match="not a GitHub repository"):
        GitHubKits(store, "ManimatorTechnologies/Manim Kit")
    store.close()
