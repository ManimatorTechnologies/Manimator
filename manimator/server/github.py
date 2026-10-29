"""The gallery's customizations, read from a GitHub repository (MANIMATOR_KITS_REPO, like "ManimatorTechnologies/ManimKit").

Each folder Kits/<Name> on the repository's branch is one customization: the manifest.json, kit.js, kit.py and
README.md a .manimkit file holds (server/kits.py). People add theirs there with a pull request. Once one is merged,
GitHub tells the site (its webhook posts to /api/kits/github, signed with MANIMATOR_KITS_SECRET) and the site reads
the branch again: a new folder joins the gallery, a folder whose files changed gets a new version, and one that is
gone leaves the gallery (projects that use it keep it). The site also looks every SYNC_EVERY seconds, in case a
webhook went missing. The files pass the checks an upload passes; their code never runs here.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import re
import sys
import tarfile
import threading
import time

import httpx

from .kits import FILE_LIMITS, KitError, KitStore

REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}/[A-Za-z0-9._-]{1,100}$")
FOLDER_RE = re.compile(r"^[A-Za-z0-9]{1,40}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SYNC_EVERY = 900  # seconds between looks at the branch (unsigned API calls: GitHub allows 60 an hour)
MAX_ARCHIVE = 64 * 1024 * 1024  # the branch as a .tar.gz
API = "https://api.github.com"
CODELOAD = "https://codeload.github.com"


def read_archive(data: bytes) -> dict[str, dict[str, bytes]]:
    """The Kits/<Name>/ folders in a repository's .tar.gz: {folder: {file name: bytes}}, only the files a package
    holds (each read up to its size limit, so one too large still fails its checks). Nothing is written out."""
    out: dict[str, dict[str, bytes]] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar:
            parts = member.name.split("/")  # "<repo>-<commit>/Kits/Battery/kit.js"
            if len(parts) != 4 or parts[1] != "Kits" or not FOLDER_RE.match(parts[2]):
                continue
            files = out.setdefault(parts[2], {})
            limit = FILE_LIMITS.get(parts[3])
            if limit is None or not member.isfile():
                continue
            f = tar.extractfile(member)
            files[parts[3]] = f.read(limit + 1) if f else b""
    return out


class GitHubKits:
    """Keeps the gallery in step with one branch of a GitHub repository."""

    def __init__(self, kits: KitStore, repo: str, branch: str = "main", secret: str = "", http=None,
                 every: float = SYNC_EVERY, changed=None):
        if not REPO_RE.match(repo):
            raise ValueError(f"not a GitHub repository: {repo!r} (owner/name)")
        self.kits, self.repo, self.branch, self.secret, self.every = kits, repo, branch, secret, every
        self.changed = changed  # called when a look changed the gallery (old versions may go: kits_changed)
        self._own_http = http is None
        self._http = http or httpx.Client(timeout=30, headers={"User-Agent": "Manimator"})
        self._lock = threading.Lock()  # one look at a time
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.state = {"commit": "", "checked": 0.0, "problems": [], "error": ""}  # the last look (GET /api/admin/kits)

    # ------------------------------------------------------------------ the webhook
    def signed(self, body: bytes, signature: str) -> bool:
        """Whether GitHub signed this webhook body with our secret (X-Hub-Signature-256)."""
        if not self.secret:
            return False
        good = "sha256=" + hmac.new(self.secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(good, signature or "")

    def poke(self) -> None:
        """The branch moved: look now."""
        self._wake.set()

    # ------------------------------------------------------------------ looking
    def head(self) -> str:
        """The commit the branch is at."""
        r = self._http.get(f"{API}/repos/{self.repo}/commits/{self.branch}",
                           headers={"Accept": "application/vnd.github.sha"})
        r.raise_for_status()
        commit = r.text.strip()
        if not COMMIT_RE.match(commit):
            raise ValueError("GitHub didn't answer with a commit")
        return commit

    def folders(self, commit: str) -> dict[str, dict[str, bytes]]:
        """The Kits/ folders at a commit, from the repository's archive."""
        data = bytearray()
        with self._http.stream("GET", f"{CODELOAD}/{self.repo}/tar.gz/{commit}") as r:
            r.raise_for_status()
            for chunk in r.iter_bytes():
                data += chunk
                if len(data) > MAX_ARCHIVE:
                    raise ValueError(f"the repository is over {MAX_ARCHIVE // 2**20} MB")
        return read_archive(bytes(data))

    def sync(self, force: bool = False) -> dict:
        """Look at the branch, and bring the gallery in step if it moved (`force`: even if it didn't). Returns what
        changed: {"commit", "changed": ["Battery: added", ...], "problems": ["Pendulum: <why it was left out>"]}."""
        with self._lock:
            try:
                commit = self.head()
                if commit == self.state["commit"] and not force:
                    self.state.update(checked=time.time(), error="")
                    return {"commit": commit, "changed": [], "problems": self.state["problems"]}
                found = self.folders(commit)
            except (httpx.HTTPError, ValueError, tarfile.TarError, OSError, EOFError) as e:
                self.state.update(checked=time.time(), error=str(e)[:300])
                print(f"manimator: couldn't read {self.repo}: {e}", file=sys.stderr, flush=True)
                return {"commit": "", "changed": [], "problems": [], "error": str(e)}
            changed, problems = [], []
            for folder in sorted(found):
                try:
                    what = self.kits.from_repo(self.repo, folder, found[folder], commit)
                except KitError as e:
                    problems.append(f"{folder}: {e}")
                    continue
                if what:
                    changed.append(f"{folder}: {what}")
            changed += [f"{folder}: removed" for folder in self.kits.drop_missing(self.repo, set(found))]
            self.state.update(commit=commit, checked=time.time(), problems=problems, error="")
            for line in changed + problems:
                print(f"manimator: {self.repo} {commit[:7]} {line}", file=sys.stderr, flush=True)
            if changed and self.changed:
                self.changed()
            return {"commit": commit, "changed": changed, "problems": problems}

    # ------------------------------------------------------------------ in the background
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="manimator-kits-repo", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.sync()
            except Exception as e:  # noqa: BLE001 - the gallery must never take the server down
                print(f"manimator: reading {self.repo} failed: {e!r}", file=sys.stderr, flush=True)
            self._wake.wait(self.every)
            self._wake.clear()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._own_http:
            self._http.close()
