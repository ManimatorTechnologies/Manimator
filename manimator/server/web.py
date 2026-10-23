"""Running the editor as a website: one private workspace per visitor.

A visitor gets a random, unguessable id in an HttpOnly cookie. Behind it sit their projects (the open one is
saved to disk as they edit) and the pictures they uploaded. Nothing a visitor sends is ever used as a path on the
server: files come in through the upload endpoint and are referred to by a plain name. Videos are made in the
visitor's browser and never reach the server.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import threading
import time
import weakref
from dataclasses import dataclass, field
from pathlib import Path

from ..model import ops
from ..model.project import FILE_SUFFIX, OLD_FILE_SUFFIX, Project
from ..registry.custom import KIT_TYPE_RE
from .kits import kit_versions_in
from .plans import Plan, local_plan
from .session import OpError, ProjectLimits, Session

COOKIE = "manimator_ws"
ID_RE = re.compile(r"^[0-9a-f]{32}$")
USER_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")  # an account's id (a UUID)
PROJECT_ID_RE = re.compile(r"^[0-9a-f]{16}$")
MAX_NAME = 80
DEFAULT_NAME = "Untitled project"
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "BMP", "WEBP"}
MAX_PIXELS = 16_000_000
VIDEO_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}
ASSET_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".bmp": "image/bmp", ".webp": "image/webp", ".svg": "image/svg+xml", **VIDEO_TYPES}
MAX_VIDEO_BYTES = 100 * 1024 * 1024  # one uploaded video (presentations play them between scenes)
MAX_RENDER_BYTES = 200 * 1024 * 1024  # one scene rendered in the browser and kept for presentations
MAX_KIT_BYTES = 1024 * 1024  # one .manimkit file (server/kits.py)
PRESENTATION_ID_RE = re.compile(r"^[0-9a-f]{12}$")
ITEM_ID_RE = re.compile(r"^[0-9a-f]{8}$")
RENDER_RE = re.compile(r"^([0-9a-f]{16})-([0-9a-f]{10})-([0-9a-f]{16})\.(mp4|webm)$")  # project-scene-hash
MAX_PRESENTATIONS = 100
MAX_ITEMS = 200
PRESENTATION_MODES = ("live", "render", "stored")
THUMB_MAX = (640, 360)  # pixels
THUMB_MAX_BYTES = 512 * 1024


class TooFast(Exception):
    """A visitor is sending requests faster than allowed."""


@dataclass
class WebConfig:
    data_dir: Path
    allowed_hosts: frozenset = frozenset()  # Host names this site answers to ("*" = any, not recommended)
    https: bool = False  # mark the cookie Secure
    session_ttl: float = 90 * 24 * 3600  # delete a visitor's projects after this long without a visit
    memory_ttl: float = 1800  # forget an idle visitor's project in memory (it stays on disk)
    max_workspaces: int = 300  # visitors held in memory at once
    new_per_hour: int = 40  # new visitors per IP address per hour
    max_upload_bytes: int = 8 * 1024 * 1024
    max_assets: int = 20
    asset_quota: int = 40 * 1024 * 1024
    max_project_bytes: int = 2 * 1024 * 1024
    max_projects: int = 20  # projects one visitor can keep
    max_kits: int = 100  # customizations one visitor can keep (server/kits.py)
    admins: frozenset = frozenset()  # account emails that review public customizations (MANIMATOR_ADMINS)
    limits: ProjectLimits = field(default_factory=ProjectLimits)
    site_url: str = ""  # the site's address, e.g. https://studio.example.com (else taken from each request)

    @classmethod
    def from_env(cls, data_dir: Path) -> WebConfig:
        env = os.environ.get

        def num(name, default, cast=float):
            try:
                return cast(env(name, default))
            except ValueError:
                raise SystemExit(f"{name} must be a number, not {env(name)!r}") from None

        hosts = {h.strip().lower() for h in env("MANIMATOR_ALLOWED_HOSTS", "").split(",") if h.strip()}
        return cls(
            data_dir=Path(data_dir),
            allowed_hosts=frozenset(hosts),
            https=env("MANIMATOR_HTTPS", "").lower() in ("1", "true", "yes"),
            session_ttl=num("MANIMATOR_SESSION_DAYS", 90) * 24 * 3600,
            max_workspaces=num("MANIMATOR_MAX_WORKSPACES", 300, int),
            max_projects=num("MANIMATOR_MAX_PROJECTS", 20, int),
            admins=frozenset(e.strip().lower() for e in env("MANIMATOR_ADMINS", "").split(",") if e.strip()),
            site_url=env("MANIMATOR_SITE_URL", "").strip().rstrip("/"),
        )

    def host_ok(self, host: str) -> bool:
        host = host.lower()
        return host in ("localhost", "127.0.0.1", "::1") or "*" in self.allowed_hosts or host in self.allowed_hosts


class Bucket:
    """Allows `burst` quick requests, then `rate` per second."""

    def __init__(self, rate: float, burst: float):
        self.rate, self.burst = rate, burst
        self.tokens, self.stamp = burst, time.monotonic()
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            now = time.monotonic()
            self.tokens = min(self.burst, self.tokens + (now - self.stamp) * self.rate)
            self.stamp = now
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False


# per kind of request: (requests per second, burst)
RATES = {"op": (40, 120), "upload": (0.4, 6), "auth": (0.1, 8), "plan": (10, 40), "thumb": (0.5, 10)}
# how often the sweeper looks for customization versions no project uses (sooner when told: kits_changed), about
# when an idle editor's undo steps are let go (memory_ttl)
KIT_PRUNE_EVERY = 1800


def rename_old_files(projects_dir: Path) -> None:
    """Projects saved under the old file name (.manimproj) take the current one."""
    for path in projects_dir.glob(f"*{OLD_FILE_SUFFIX}"):
        new = path.with_suffix(FILE_SUFFIX)
        try:
            if not new.exists():
                os.replace(path, new)
        except OSError:
            pass


class Workspace:
    """Everything one visitor owns."""

    def __init__(self, wid: str, root: Path, cfg: WebConfig, user: dict | None = None, kits=None):
        self.id = wid
        self.kits = kits  # the customizations (server/kits.py KitStore), or None
        self.root = root
        self.cfg = cfg
        self.user = user  # {"id", "email"} for a signed-in account, None for a guest
        self.plan: Plan = local_plan(cfg)  # set on every request from the account (see api.current)
        self.assets_dir = root / "assets"
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self.session = Session(limits=cfg.limits, assets=self.check_asset, kits=self.check_kit)
        self.last_seen = time.time()
        self._touched = 0.0
        self._timer: threading.Timer | None = None
        self._unsaved = False  # the open project has edits its file doesn't have yet (save_soon)
        self._buckets = {k: Bucket(*v) for k, v in RATES.items()}
        self.lock = threading.Lock()
        self._io = threading.RLock()  # switching projects vs. writing the open one
        self.projects_dir = root / "projects"
        self.projects_dir.mkdir(exist_ok=True)
        rename_old_files(self.projects_dir)
        self._index = self._read_index()

    # ------------------------------------------------------------------ requests
    def take(self, kind: str) -> None:
        if not self._buckets[kind].take():
            raise TooFast

    def touch(self) -> None:
        now = time.time()
        self.last_seen = now
        if now - self._touched > 60:  # tells the cleanup this visitor is still around
            self._touched = now
            try:
                os.utime(self.root)
            except OSError:
                pass

    # ------------------------------------------------------------------ projects, kept on disk
    # projects.json: {"current": id, "projects": {id: {"name", "created", "opened"}}}; each project is <id>.manimator.
    @property
    def index_file(self) -> Path:
        return self.root / "projects.json"

    def _file(self, pid: str) -> Path:
        return self.projects_dir / f"{pid}{FILE_SUFFIX}"

    @property
    def current_id(self) -> str:
        return self._index["current"]

    @property
    def project_name(self) -> str:
        return self._index["projects"][self.current_id]["name"]

    @property
    def project_file(self) -> Path:
        return self._file(self.current_id)

    def _read_index(self) -> dict:
        try:
            index = json.loads(self.index_file.read_text(encoding="utf-8"))
            projects = {k: v for k, v in index["projects"].items() if PROJECT_ID_RE.match(k)}
            if projects:
                current = index.get("current")
                return {"current": current if current in projects else next(iter(projects)), "projects": projects}
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
        pid = self._new_entry_id()
        now = time.time()
        index = {"current": pid, "projects": {pid: {"name": DEFAULT_NAME, "created": now, "opened": now}}}
        legacy = self.root / f"project{OLD_FILE_SUFFIX}"  # workspaces from before there were several projects
        if legacy.exists():
            try:
                os.replace(legacy, self._file(pid))
            except OSError:
                pass
        self._index = index
        self._write_index()
        return index

    def _write_index(self) -> None:
        tmp = self.index_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._index), encoding="utf-8")
        os.replace(tmp, self.index_file)

    @staticmethod
    def _new_entry_id() -> str:
        return secrets.token_hex(8)

    @staticmethod
    def clean_name(name) -> str:
        name = re.sub(r"[\x00-\x1f\x7f]", "", str(name or "")).strip()[:MAX_NAME].strip()
        return name or DEFAULT_NAME

    def _entry(self, pid: str) -> dict:
        entry = self._index["projects"].get(pid) if isinstance(pid, str) else None
        if entry is None:
            raise OpError("That project doesn't exist any more.")
        return entry

    def load_from_disk(self) -> None:
        if not self.project_file.exists():
            return
        try:
            data = json.loads(self.project_file.read_text(encoding="utf-8"))
            self.session.load(Project.from_dict(data))
            self._bring_history(self.current_id)
        except Exception:  # noqa: BLE001 - a damaged file means starting fresh, but the next save would write the
            try:  # empty project over it: keep it next to the projects instead
                os.replace(self.project_file, self.projects_dir / f"{self.current_id}.damaged-{int(time.time())}.json")
            except OSError:
                pass
            with self.lock:
                self._unsaved = True  # the fresh project takes its place

    def persist(self) -> None:
        with self._io:
            with self.session.lock:
                text = json.dumps(self.session.project.to_dict())
            tmp = self.project_file.with_suffix(".tmp")
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, self.project_file)

    def list_projects(self) -> list[dict]:
        """Every project with what the start screen shows on its card, most recently opened first."""
        with self._io:
            if self._timer is not None:  # the open project's latest edits, so its card and picture are current
                self.flush_now()
            items = []
            for pid, entry in self._index["projects"].items():
                path = self._file(pid)
                item = {"id": pid, "name": entry["name"], "created": entry.get("created", 0),
                        "opened": entry.get("opened", 0), "current": pid == self.current_id, "broken": False}
                try:
                    if pid == self.current_id:
                        with self.session.lock:
                            data = self.session.project.to_dict()
                        item["modified"] = max(path.stat().st_mtime if path.exists() else 0, item["opened"])
                    elif path.exists():
                        item["modified"] = path.stat().st_mtime
                        data = json.loads(path.read_text(encoding="utf-8"))
                    else:
                        item["modified"], data = item["created"], {"scenes": [{}]}
                    scenes = data.get("scenes", [])
                    item["scenes"] = len(scenes)
                    item["objects"] = sum(len(s.get("mobjects", [])) for s in scenes)
                    item["three_d"] = any("ThreeD" in str(s.get("kind", "")) for s in scenes)
                except (OSError, ValueError, AttributeError, TypeError):
                    item.update(broken=True, modified=item.get("modified", 0), scenes=0, objects=0, three_d=False)
                items.append(item)
        return sorted(items, key=lambda p: -p["opened"])

    def switch(self, pid: str) -> list[str]:
        """Open another of this visitor's projects (the current one is written first)."""
        with self._io:
            entry = self._entry(pid)
            if pid == self.current_id:
                return []
            path = self._file(pid)
            try:
                project = Project.from_dict(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else Project.new()
            except Exception:  # noqa: BLE001 - a damaged file
                raise OpError("That project's file is damaged and can't be opened.") from None
            self.flush_now()
            notes = self.session.load(project)
            self._index["current"] = pid
            entry["opened"] = time.time()
            self._write_index()
            self._bring_history(pid)
            return notes

    def create(self) -> None:
        """Add an empty project and switch to it."""
        with self._io:
            if len(self._index["projects"]) >= self.plan.projects:
                raise OpError(self._limit_message(f"You can keep up to {self.plan.projects} "
                                                  f"project{'s' if self.plan.projects != 1 else ''}"))
            self.flush_now()
            self.session.load(Project.new())
            self._add_entry(DEFAULT_NAME)
            self.persist()

    # ------------------------------------------------------------------ changes from AI chats (server/mcp.py)
    def _history_file(self, pid: str) -> Path:
        return self.projects_dir / f"{pid}.history.json"

    def edit_project(self, pid: str, change, label: str):
        """Change one of the visitor's projects from outside the editor: `change(project)` changes a copy (raising
        leaves everything as it was) and returns what the caller wants back. The open project changes in the
        editor's session, as an edit that can be undone; a closed one on disk, and when it is opened next, the
        change is there to undo too. Returns (project, change's result)."""
        with self._io:
            self._entry(pid)
            if pid == self.current_id:
                with self.session.lock:  # an edit made in the editor meanwhile would be written over: it waits
                    project = Project.from_dict(self.session.project.to_dict())
                    result = change(project)
                    self.session.replace(project, label)
                self.persist()
                return project, result
            path = self._file(pid)
            try:
                project = Project.from_dict(json.loads(path.read_text(encoding="utf-8"))) if path.exists() \
                    else Project.new()
            except Exception:  # noqa: BLE001 - a damaged file
                raise OpError("That project's file is damaged and can't be changed.") from None
            before = project.to_dict()
            result = change(project)
            self.session.check_limits(project)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(project.to_dict()), encoding="utf-8")
            os.replace(tmp, path)
            history_file = self._history_file(pid)
            try:
                history = json.loads(history_file.read_text(encoding="utf-8")) if history_file.exists() else []
            except (OSError, ValueError):
                history = []
            history = (history + [{"label": label, "before": before}])[-20:]
            tmp = history_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(history), encoding="utf-8")
            os.replace(tmp, history_file)
            return project, result

    def read_project(self, pid: str) -> Project:
        """One of the visitor's projects as it is now (the open one with its latest edits)."""
        with self._io:
            self._entry(pid)
            if pid == self.current_id:
                with self.session.lock:
                    return Project.from_dict(self.session.project.to_dict())
            path = self._file(pid)
            try:
                return Project.from_dict(json.loads(path.read_text(encoding="utf-8"))) if path.exists() \
                    else Project.new()
            except Exception:  # noqa: BLE001 - a damaged file
                raise OpError("That project's file is damaged and can't be read.") from None

    def _bring_history(self, pid: str) -> None:
        """The changes made while the project was closed become undo steps, now it is open."""
        history_file = self._history_file(pid)
        try:
            history = json.loads(history_file.read_text(encoding="utf-8")) if history_file.exists() else []
            history_file.unlink(missing_ok=True)
        except (OSError, ValueError):
            return
        if not isinstance(history, list) or not history:
            return
        with self.session.lock:
            states = [h.get("before") for h in history] + [self.session.project.to_dict()]
        for h, before, after in zip(history, states, states[1:]):
            if isinstance(before, dict):
                self.session.add_history(str(h.get("label") or "Change"), before, after)

    def add_project(self, project: Project, name: str) -> str:
        """Keep a project made elsewhere (an AI chat, server/mcp.py) next to the others, without opening it: the
        project open in the visitor's editor stays open. Returns its id."""
        with self._io:
            if len(self._index["projects"]) >= self.plan.projects:
                raise OpError(self._limit_message(f"You can keep up to {self.plan.projects} "
                                                  f"project{'s' if self.plan.projects != 1 else ''}"))
            pid, now = self._new_entry_id(), time.time()
            path = self._file(pid)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(project.to_dict()), encoding="utf-8")
            os.replace(tmp, path)
            self._index["projects"][pid] = {"name": self.clean_name(name), "created": now, "opened": now}
            self._write_index()
            return pid

    def _add_entry(self, name: str) -> None:
        pid, now = self._new_entry_id(), time.time()
        self._index["projects"][pid] = {"name": self.clean_name(name), "created": now, "opened": now}
        self._index["current"] = pid
        self._write_index()

    def rename(self, pid: str, name: str) -> None:
        with self._io:
            self._entry(pid)["name"] = self.clean_name(name)
            self._write_index()

    def delete(self, pid: str) -> None:
        """Delete a project for good. Deleting the open one opens the next, or a new empty one."""
        with self._io:
            self._entry(pid)
            if pid == self.current_id:
                with self.lock:  # its pending write must not bring the file back
                    timer, self._timer = self._timer, None
                    self._unsaved = False
                if timer is not None:
                    timer.cancel()
            self._index["projects"].pop(pid)
            try:
                (self._file(pid)).unlink(missing_ok=True)
                self._history_file(pid).unlink(missing_ok=True)
                for render in self.renders_dir.glob(f"{pid}-*") if self.renders_dir.is_dir() else []:
                    render.unlink(missing_ok=True)  # its scenes' stored videos
            except OSError:
                pass
            self._drop_thumbs(pid)
            if pid != self.current_id:
                self._write_index()
                return
            rest = sorted(self._index["projects"], key=lambda k: -self._index["projects"][k].get("opened", 0))
            for other in rest:
                path = self._file(other)
                try:
                    project = Project.from_dict(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else Project.new()
                    self.session.load(project)
                except Exception:  # noqa: BLE001 - try the next one
                    continue
                self._index["current"] = other
                self._write_index()
                self._bring_history(other)
                return
            self.session.load(Project.new())
            self._add_entry(DEFAULT_NAME)

    def _limit_message(self, what: str) -> str:
        return what + self.plan.limit_note

    def is_untouched(self) -> bool:
        """Only the empty project every workspace starts with."""
        if len(self._index["projects"]) != 1 or self.project_name != DEFAULT_NAME:
            return False
        with self.session.lock:
            return not any(s.mobjects or s.steps for s in self.session.project.scenes)

    def import_from(self, other: Path) -> int:
        """Take over a guest's projects and uploads (on sign-in), as far as this plan allows. Returns how many."""
        try:
            index = json.loads((other / "projects.json").read_text(encoding="utf-8"))
            entries = sorted(((k, v) for k, v in index["projects"].items() if PROJECT_ID_RE.match(k)),
                             key=lambda kv: kv[1].get("opened", 0))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return 0
        rename_old_files(other / "projects")
        with self._io:
            self.flush_now()
            drop = self.current_id if self.is_untouched() else None
            room = self.plan.projects - len(self._index["projects"]) + (1 if drop else 0)
            keep = []
            for pid, entry in entries:
                src = other / "projects" / f"{pid}{FILE_SUFFIX}"
                try:
                    data = json.loads(src.read_text(encoding="utf-8"))
                    Project.from_dict(data)
                except Exception:  # noqa: BLE001 - damaged or missing: nothing to keep
                    continue
                if entry.get("name") == DEFAULT_NAME and not any(sc.get("mobjects") for sc in data.get("scenes", [])):
                    continue  # an empty project nobody worked on
                keep.append((src, entry))
            moved = []
            for src, entry in keep[len(keep) - max(0, room):] if room > 0 else []:  # the most recently opened
                new = self._new_entry_id()
                shutil.copyfile(src, self._file(new))
                self._index["projects"][new] = {"name": self.clean_name(entry.get("name")),
                                                "created": entry.get("created", time.time()),
                                                "opened": entry.get("opened", time.time())}
                moved.append(new)
            if not moved:
                return 0
            self._write_index()
            assets = sorted((other / "assets").iterdir()) if (other / "assets").is_dir() else []
            for asset in assets:
                if asset.is_file() and NAME_RE.match(asset.name) and not (self.assets_dir / asset.name).exists():
                    existing = [f for f in self.assets_dir.iterdir() if f.is_file()]
                    used = sum(f.stat().st_size for f in existing)
                    if len(existing) < self.plan.max_assets and used + asset.stat().st_size <= self.plan.asset_quota:
                        shutil.copyfile(asset, self.assets_dir / asset.name)
            self.switch(moved[-1])
            if drop:
                self.delete(drop)
            return len(moved)

    # ------------------------------------------------------------------ card pictures
    # thumbs/<id>-<file mtime>.png: the project's first scene, as the browser drew it; an edit makes a new name.
    @property
    def thumbs_dir(self) -> Path:
        return self.root / "thumbs"

    def thumbnail(self, pid: str) -> Path:
        """Where the card picture of the project as it is now is kept (it may not have been sent yet)."""
        with self._io:
            self._entry(pid)
            if pid == self.current_id and self._timer is not None:
                self.flush_now()
            try:
                stamp = self._file(pid).stat().st_mtime_ns
            except OSError:
                stamp = 0
            return self.thumbs_dir / f"{pid}-{stamp}.png"

    def keep_thumbnail(self, picture: Path, png: bytes) -> None:
        with self._io:
            self._drop_thumbs(picture.name.split("-")[0])
            self.thumbs_dir.mkdir(exist_ok=True)
            tmp = picture.with_suffix(".tmp")
            tmp.write_bytes(png)
            os.replace(tmp, picture)

    def _drop_thumbs(self, pid: str) -> None:
        for old in self.thumbs_dir.glob(f"{pid}-*.png"):
            try:
                old.unlink()
            except OSError:
                pass

    def save_soon(self) -> None:
        """Write the project shortly after the latest edit (many quick edits make one write)."""
        with self.lock:
            self._unsaved = True
            if self._timer is not None:
                return
            self._timer = threading.Timer(2.0, self._flush)
            self._timer.daemon = True
            self._timer.start()

    def _flush(self) -> None:
        with self.lock:
            self._timer = None
        self._write_unsaved()

    def flush_now(self) -> None:
        with self.lock:
            timer, self._timer = self._timer, None
        if timer is not None:
            timer.cancel()
        self._write_unsaved()

    def _write_unsaved(self) -> None:
        """Write the open project if it has edits its file doesn't (or it has no file yet). An unchanged file is left
        alone: its time names the project's card picture (thumbnail()), which would be lost."""
        with self.lock:
            unsaved, self._unsaved = self._unsaved, False
        if not unsaved and self.project_file.exists():
            return
        try:
            self.persist()
        except OSError:
            with self.lock:
                self._unsaved = True

    # ------------------------------------------------------------------ customizations (server/kits.py)
    @property
    def owner_key(self) -> str:
        """Who owns the customizations made here: the account, or (without accounts) this visitor."""
        return self.user["id"] if self.user else self.id

    def check_kit(self, key: str, project: Project | None = None) -> None:
        """Raise unless this visitor may add the custom type `key` to `project` now (the Session asks about the open
        one): a version the project uses already stays usable in it, anything new takes the newest."""
        if self.kits is None:
            raise OpError("Customizations aren't switched on here.")
        m = KIT_TYPE_RE.match(key) if isinstance(key, str) else None
        project = self.session.project if project is None else project
        used = m is not None and any(KIT_TYPE_RE.match(k).group(1, 2) == m.group(1, 2)
                                     for k in ops.kit_types_in(project))
        self.kits.check_use(self.owner_key, self.plan.kits, key, used)

    # ------------------------------------------------------------------ uploaded files
    def check_asset(self, name: str) -> str:
        if not NAME_RE.match(name) or name.startswith(".") or not (self.assets_dir / name).is_file():
            raise OpError("Upload the file first, then choose it from the list.")
        return name

    def asset_path(self, name: str) -> Path | None:
        """An uploaded file of this visitor's, by its stored name (never anything else on the server)."""
        if not isinstance(name, str) or not NAME_RE.match(name) or name.startswith("."):
            return None
        if Path(name).suffix.lower() not in ASSET_TYPES:
            return None
        path = self.assets_dir / name
        return path if path.is_file() else None

    def asset_names(self) -> list[str]:
        return sorted(p.name for p in self.assets_dir.iterdir() if p.is_file())

    def _room_for(self, size: int) -> None:
        """Raise unless one more file of `size` bytes fits the plan (uploads and stored renders count)."""
        if len([p for p in self.assets_dir.iterdir() if p.is_file()]) >= self.plan.max_assets:
            raise OpError(self._limit_message(f"You can keep up to {self.plan.max_assets} uploaded files"))
        if self.storage_used() + size > self.plan.asset_quota:
            raise OpError(self._limit_message(f"Your storage holds up to {_size(self.plan.asset_quota)}"))

    def add_asset(self, filename: str, data: bytes) -> str:
        base = Path(str(filename).replace("\\", "/")).name
        ext = Path(base).suffix.lower()
        if ext in IMAGE_EXTENSIONS:
            check_image(data)
        elif ext == ".svg":
            check_svg(data)
        else:
            raise OpError("Upload a PNG, JPG, GIF, WebP, BMP or SVG file.")
        stem = re.sub(r"[^A-Za-z0-9_-]", "_", Path(base).stem)[:40] or "file"
        stored = f"{stem}-{hashlib.sha256(data).hexdigest()[:8]}{ext}"
        target = self.assets_dir / stored
        if not target.exists():
            self._room_for(len(data))
            target.write_bytes(data)
        return stored

    def add_video(self, filename: str, tmp: Path, digest: str) -> str:
        """Keep an uploaded video (already written to `tmp`, its sha256 `digest`): checked, then moved in."""
        base = Path(str(filename).replace("\\", "/")).name
        ext = Path(base).suffix.lower()
        if ext not in VIDEO_TYPES:
            raise OpError("Upload an MP4, WebM or MOV video.")
        check_video(tmp, ext)
        stem = re.sub(r"[^A-Za-z0-9_-]", "_", Path(base).stem)[:40] or "video"
        stored = f"{stem}-{digest[:8]}{ext}"
        target = self.assets_dir / stored
        if not target.exists():
            self._room_for(tmp.stat().st_size)
            os.replace(tmp, target)
        return stored

    def delete_asset(self, name: str) -> None:
        path = self.asset_path(name)
        if path is None:
            raise OpError("That file is already gone.")
        path.unlink(missing_ok=True)

    # ------------------------------------------------------------------ storage: uploads and stored renders
    # (project files don't count: they are small, and the plan's project limit covers them)
    @property
    def renders_dir(self) -> Path:
        return self.root / "renders"

    def tmp_file(self) -> Path:
        """A new file to stream a large upload into (in the workspace, so it can be moved in place)."""
        folder = self.root / "tmp"
        folder.mkdir(exist_ok=True)
        for old in folder.iterdir():  # ones left by an upload that broke off
            try:
                if time.time() - old.stat().st_mtime > 3600:
                    old.unlink()
            except OSError:
                pass
        return folder / f"{secrets.token_hex(8)}.part"

    def storage_used(self) -> int:
        return sum(p.stat().st_size for d in (self.assets_dir, self.renders_dir) if d.is_dir()
                   for p in d.iterdir() if p.is_file())

    def storage(self) -> dict:
        """What the storage bar shows: the plan's room, what is used, and every file in it."""
        files = []
        for p in sorted(self.assets_dir.iterdir()) if self.assets_dir.is_dir() else []:
            if p.is_file():
                kind = "video" if p.suffix.lower() in VIDEO_TYPES else "picture"
                files.append({"name": p.name, "kind": kind, "size": p.stat().st_size, "modified": p.stat().st_mtime})
        scene_names = {}
        for p in sorted(self.renders_dir.iterdir()) if self.renders_dir.is_dir() else []:
            m = RENDER_RE.match(p.name)
            if not m or not p.is_file():
                continue
            pid, sid = m.group(1), m.group(2)
            if pid not in scene_names:
                try:
                    scene_names[pid] = {s.id: s.name for s in self.read_project(pid).scenes}
                except OpError:
                    scene_names[pid] = {}
            project = self._index["projects"].get(pid, {}).get("name", "Deleted project")
            files.append({"name": p.name, "kind": "render", "size": p.stat().st_size, "modified": p.stat().st_mtime,
                          "label": f"{project}: {scene_names[pid].get(sid, 'deleted scene')}"})
        totals = {k: sum(f["size"] for f in files if f["kind"] == k) for k in ("video", "picture", "render")}
        return {"used": sum(totals.values()), "quota": self.plan.asset_quota, "videos": totals["video"],
                "pictures": totals["picture"], "renders": totals["render"], "files": files}

    def render_path(self, name: str) -> Path | None:
        if not isinstance(name, str) or not RENDER_RE.match(name):
            return None
        path = self.renders_dir / name
        return path if path.is_file() else None

    def find_render(self, pid: str, sid: str, digest: str) -> str | None:
        for ext in ("mp4", "webm"):
            name = f"{pid}-{sid}-{digest}.{ext}"
            if (self.renders_dir / name).is_file():
                return name
        return None

    def _scene_renders(self, pid: str, sid: str) -> list[Path]:
        return [p for p in self.renders_dir.glob(f"{pid}-{sid}-*") if p.is_file()] if self.renders_dir.is_dir() else []

    def replaced_render_bytes(self, pid: str, sid: str) -> int:
        """The size of the scene's stored renders, which a new render of it replaces (room it may use)."""
        return sum(p.stat().st_size for p in self._scene_renders(pid, sid))

    def keep_render(self, pid: str, sid: str, digest: str, ext: str, tmp: Path) -> str:
        """Keep a scene rendered in the browser; older renders of the scene go (only once the new one fits)."""
        if ext not in ("mp4", "webm"):
            raise OpError("Send an MP4 or WebM video.")
        check_video(tmp, f".{ext}")
        name = f"{pid}-{sid}-{digest}.{ext}"
        if not RENDER_RE.match(name):
            raise OpError("Unknown scene.")
        self.renders_dir.mkdir(exist_ok=True)
        with self._io:
            old = self._scene_renders(pid, sid)
            freed = sum(p.stat().st_size for p in old)
            if self.storage_used() - freed + tmp.stat().st_size > self.plan.asset_quota:
                raise OpError(self._limit_message(f"Your storage holds up to {_size(self.plan.asset_quota)}"))
            for p in old:
                p.unlink(missing_ok=True)
            os.replace(tmp, self.renders_dir / name)
        return name

    def delete_renders(self, name: str | None = None) -> None:
        """Delete one stored render, or all of them."""
        if name is not None:
            path = self.render_path(name)
            if path is None:
                raise OpError("That render is already gone.")
            path.unlink(missing_ok=True)
        elif self.renders_dir.is_dir():
            shutil.rmtree(self.renders_dir, ignore_errors=True)

    # ------------------------------------------------------------------ presentations
    # presentations.json: {"presentations": {id: {"name", "project", "created", "modified", "items": [item]}}};
    # an item is {"id", "kind": "scene", "scene": scene id} or {"id", "kind": "video", "file": asset name}.
    @property
    def _presentations_file(self) -> Path:
        return self.root / "presentations.json"

    def _read_presentations(self) -> dict:
        try:
            data = json.loads(self._presentations_file.read_text(encoding="utf-8"))
            return {k: v for k, v in data["presentations"].items() if PRESENTATION_ID_RE.match(k) and isinstance(v, dict)}
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return {}

    def _write_presentations(self, items: dict) -> None:
        tmp = self._presentations_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"presentations": items}), encoding="utf-8")
        os.replace(tmp, self._presentations_file)

    def _presentation(self, items: dict, prid) -> dict:
        p = items.get(prid) if isinstance(prid, str) else None
        if p is None:
            raise OpError("That presentation doesn't exist any more.")
        return p

    def list_presentations(self) -> list[dict]:
        with self._io:
            out = []
            for prid, p in self._read_presentations().items():
                project = self._index["projects"].get(p.get("project"))
                out.append({"id": prid, "name": p.get("name", ""), "project": p.get("project"),
                            "project_name": project["name"] if project else None, "items": len(p.get("items", [])),
                            "videos": sum(1 for i in p.get("items", []) if i.get("kind") == "video"),
                            "created": p.get("created", 0), "modified": p.get("modified", 0)})
        return sorted(out, key=lambda x: -x["modified"])

    def create_presentation(self, name, pid: str) -> str:
        with self._io:
            self._entry(pid)
            items = self._read_presentations()
            if len(items) >= MAX_PRESENTATIONS:
                raise OpError(f"You can keep up to {MAX_PRESENTATIONS} presentations.")
            project = self.read_project(pid)
            prid, now = secrets.token_hex(6), time.time()
            items[prid] = {"name": self.clean_name(name or self._index["projects"][pid]["name"]), "project": pid,
                           "created": now, "modified": now,
                           "items": [{"id": secrets.token_hex(4), "kind": "scene", "scene": s.id} for s in project.scenes]}
            self._write_presentations(items)
            return prid

    def presentation(self, prid: str) -> dict:
        """One presentation with what its editor shows: each item's name and state, and the project's scenes."""
        with self._io:
            p = self._presentation(self._read_presentations(), prid)
            entry = self._index["projects"].get(p.get("project"))
            scenes = []
            if entry is not None:
                try:
                    scenes = [{"id": s.id, "name": s.name, "steps": len(s.steps), "objects": len(s.mobjects)}
                              for s in self.read_project(p["project"]).scenes]
                except OpError:
                    scenes = []
            names = {s["id"]: s["name"] for s in scenes}
            items = []
            for it in p.get("items", []):
                if it.get("kind") == "scene":
                    items.append({**it, "name": names.get(it.get("scene")), "missing": it.get("scene") not in names})
                else:
                    path = self.asset_path(it.get("file", ""))
                    items.append({**it, "name": it.get("file"), "missing": path is None,
                                  "size": path.stat().st_size if path else 0})
            return {"id": prid, "name": p.get("name", ""), "project": p.get("project"),
                    "project_name": entry["name"] if entry else None, "items": items, "scenes": scenes,
                    "created": p.get("created", 0), "modified": p.get("modified", 0)}

    def save_presentation(self, prid: str, name=None, items=None) -> None:
        with self._io:
            data = self._read_presentations()
            p = self._presentation(data, prid)
            if name is not None:
                p["name"] = self.clean_name(name)
            if items is not None:
                if not isinstance(items, list) or len(items) > MAX_ITEMS:
                    raise OpError(f"A presentation holds up to {MAX_ITEMS} scenes and videos.")
                # a video deleted from storage stays where it was (shown as deleted) until it is removed: it
                # mustn't stop the rest of the presentation from being changed
                had = {i.get("file") for i in p.get("items", []) if isinstance(i, dict) and i.get("kind") == "video"}
                kept = []
                for it in items:
                    if not isinstance(it, dict):
                        raise OpError("Unknown item.")
                    iid = it.get("id") if isinstance(it.get("id"), str) and ITEM_ID_RE.match(it["id"]) \
                        else secrets.token_hex(4)
                    file = it.get("file")
                    if it.get("kind") == "scene" and isinstance(it.get("scene"), str) and len(it["scene"]) <= 40:
                        kept.append({"id": iid, "kind": "scene", "scene": it["scene"]})
                    elif it.get("kind") == "video" and isinstance(file, str) and Path(file).suffix.lower() in VIDEO_TYPES \
                            and (self.asset_path(file) is not None or file in had):
                        kept.append({"id": iid, "kind": "video", "file": file})
                    else:
                        raise OpError("That video isn't in your uploads any more.")
                p["items"] = kept
            p["modified"] = time.time()
            self._write_presentations(data)

    def delete_presentation(self, prid: str) -> None:
        with self._io:
            data = self._read_presentations()
            self._presentation(data, prid)
            data.pop(prid)
            self._write_presentations(data)

    # ------------------------------------------------------------------ settings of the account's own
    @property
    def _prefs_file(self) -> Path:
        return self.root / "prefs.json"

    def prefs(self) -> dict:
        try:
            data = json.loads(self._prefs_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        mode = data.get("presentation_mode") if isinstance(data, dict) else None
        return {"presentation_mode": mode if mode in PRESENTATION_MODES else "live"}

    def set_pref(self, name: str, value) -> dict:
        prefs = self.prefs()
        if name == "presentation_mode" and value in PRESENTATION_MODES:
            prefs[name] = value
        else:
            raise OpError(f"Unknown setting {name!r}.")
        self._prefs_file.write_text(json.dumps(prefs), encoding="utf-8")
        return prefs


def _size(n: int) -> str:
    return f"{n / (1024 ** 3):g} GB" if n >= 1024 ** 3 else f"{n // (1024 * 1024)} MB"


def check_video(path: Path, ext: str) -> None:
    """A real MP4/MOV (an ISO media file: "ftyp" first) or WebM (an EBML header), going by its first bytes. Browsers
    decode them in their own sandboxed media code; the server only stores and sends them."""
    with open(path, "rb") as f:
        head = f.read(16)
    if ext == ".webm":
        ok = head[:4] == b"\x1a\x45\xdf\xa3"
    else:
        ok = len(head) >= 12 and head[4:8] == b"ftyp"
    if not ok:
        raise OpError("That doesn't look like a video file.")


def check_image(data: bytes) -> None:
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt, (w, h) = img.format, img.size
            img.verify()
    except Exception:  # noqa: BLE001
        raise OpError("That doesn't look like a valid picture.") from None
    if fmt not in IMAGE_FORMATS:
        raise OpError("Upload a PNG, JPG, GIF, WebP or BMP picture.")
    if w * h > MAX_PIXELS:
        raise OpError("That picture is too large. Please use one under 16 megapixels.")


_SVG_BANNED = re.compile(
    r"<\s*(script|image|foreignobject|iframe|embed|object|audio|video|style)\b|<!doctype|<!entity|javascript:|file:|data:",
    re.IGNORECASE)
_SVG_EXTERNAL_HREF = re.compile(r"href\s*=\s*[\"'](?!#)", re.IGNORECASE)


def check_svg(data: bytes) -> None:
    if len(data) > 2 * 1024 * 1024:
        raise OpError("That SVG is too large (limit 2 MB).")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise OpError("That SVG isn't valid text.") from None
    if "<svg" not in text.lower() or _SVG_BANNED.search(text) or _SVG_EXTERNAL_HREF.search(text):
        raise OpError("That SVG can't be used: it must be a plain drawing, with no scripts or links to other files.")


class WorkspaceStore:
    """Finds the right workspace for a cookie, creates new ones, and cleans up old ones."""

    def __init__(self, cfg: WebConfig, sweep_every: float = 60.0, kits=None):
        self.cfg = cfg
        self.kits = kits
        self.root = cfg.data_dir / "workspaces"
        self.root.mkdir(parents=True, exist_ok=True)
        self._by_id: dict[str, Workspace] = {}
        # Workspaces made room for (written to disk and let go) that a request may still be using: such a visitor
        # gets the same one back, never a second copy of the same folder that would write over its changes.
        self._evicted: weakref.WeakValueDictionary[str, Workspace] = weakref.WeakValueDictionary()
        self._lock = threading.RLock()
        self._creations: dict[str, Bucket] = {}
        self._prune_due = True  # customizations' versions to look over (prune_kits): at start, then when told
        self._pruned = 0.0
        self._unused: set[tuple[str, int]] = set()  # versions the last look found unneeded and unused (prune_kits)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._sweeper, args=(sweep_every,), name="manimator-sweeper", daemon=True)
        self._thread.start()

    def resolve(self, cookie: str | None, client: str = "") -> tuple[Workspace, bool]:
        """The workspace for this cookie. The bool says whether the cookie must be (re)issued."""
        with self._lock:
            if cookie and ID_RE.match(cookie):
                ws = self._by_id.get(cookie) or self._take_back(cookie)
                if ws is None and (self.root / cookie).is_dir():  # known from before a restart
                    ws = self._adopt(cookie)
                if ws is not None:
                    ws.touch()
                    return ws, False
            # first visit, or a cookie we never issued: only issued ids are ever opened
            bucket = self._creations.setdefault(client, Bucket(self.cfg.new_per_hour / 3600, self.cfg.new_per_hour))
            if not bucket.take():
                raise TooFast
            self._make_room()
            wid = secrets.token_hex(16)
            ws = Workspace(wid, self.root / wid, self.cfg, kits=self.kits)
            self._by_id[wid] = ws
            ws.touch()
            return ws, True

    def for_user(self, user: dict) -> Workspace:
        """A signed-in user's workspace (kept until the account is deleted, never swept)."""
        uid = user["id"]
        if not USER_ID_RE.match(uid):
            raise ValueError("bad user id")
        key = f"u:{uid}"
        with self._lock:
            ws = self._by_id.get(key) or self._take_back(key)
            if ws is None:
                self._make_room()
                ws = Workspace(key, self.root / "u" / uid, self.cfg, user=user, kits=self.kits)
                ws.load_from_disk()
                self._by_id[key] = ws
            ws.user = user
            ws.touch()
            return ws

    def loaded(self, wid: str) -> Workspace | None:
        """A workspace in memory, by id (the renderer drawing an account's uploaded file)."""
        with self._lock:
            return self._by_id.get(wid)

    def take_guest(self, cookie: str | None, account: Workspace) -> int:
        """Move a guest's projects into the account they just signed in to, then delete the guest workspace."""
        if not cookie or not ID_RE.match(cookie):
            return 0
        with self._lock:
            guest = self._by_id.pop(cookie, None) or self._evicted.pop(cookie, None)
            folder = self.root / cookie
            if not folder.is_dir():
                return 0
        if guest is not None:
            guest.flush_now()
        moved = account.import_from(folder)
        shutil.rmtree(folder, ignore_errors=True)
        return moved

    def _adopt(self, wid: str) -> Workspace:
        self._make_room()
        ws = Workspace(wid, self.root / wid, self.cfg, kits=self.kits)
        ws.load_from_disk()
        self._by_id[wid] = ws
        return ws

    def _take_back(self, key: str) -> Workspace | None:
        """A workspace let go of to make room, if something still holds it (see _evicted)."""
        ws = self._evicted.pop(key, None)
        if ws is not None:
            self._make_room()
            self._by_id[key] = ws
        return ws

    def _make_room(self) -> None:
        """Lets go of the visitor seen longest ago when memory holds as many as allowed. Even one active a moment ago
        can go: its changes are on disk, and while a request still uses it, it is taken back (never read twice)."""
        if len(self._by_id) < self.cfg.max_workspaces or not self._by_id:
            return
        self._evict(min(self._by_id.values(), key=lambda w: w.last_seen))

    def _evict(self, ws: Workspace) -> None:
        ws.flush_now()
        self._by_id.pop(ws.id, None)
        self._evicted[ws.id] = ws

    # ------------------------------------------------------------------ cleanup
    def sweep(self, now: float | None = None) -> None:
        now = now or time.time()
        with self._lock:
            for ws in list(self._by_id.values()):
                if now - ws.last_seen > self.cfg.memory_ttl:
                    self._evict(ws)
            for key in [k for k, b in self._creations.items() if now - b.stamp > 7200 and b.tokens >= b.burst - 0.5]:
                self._creations.pop(key, None)
            live = set(self._by_id)
        for d in self.root.iterdir():  # visitors who never came back
            if d.is_dir() and d.name not in live and ID_RE.match(d.name):
                try:
                    if now - d.stat().st_mtime > self.cfg.session_ttl:
                        shutil.rmtree(d, ignore_errors=True)
                except OSError:
                    pass

    def _sweeper(self, every: float) -> None:
        while not self._stop.wait(every):
            try:
                self.sweep()
                if self._prune_due or time.time() - self._pruned > KIT_PRUNE_EVERY:
                    self.prune_kits()
            except Exception:  # noqa: BLE001 - cleanup must never take the server down
                pass

    # ------------------------------------------------------------------ customizations' old versions
    def kits_changed(self) -> None:
        """Something may have left a customization version unused (a project deleted or opened, a newer version,
        a project moved to it): the sweeper looks within a minute (prune_kits)."""
        self._prune_due = True

    def kit_versions_in_use(self) -> set[tuple[str, int]] | None:
        """Every customization version a project names: the projects on disk with the changes made to them while
        closed, and the editors open now (their projects and undo steps). None when a file couldn't be read."""
        with self._lock:
            open_now = [*self._by_id.values(), *self._evicted.values()]
        found: set[tuple[str, int]] = set()
        for ws in open_now:
            for state in ws.session.kept_states():
                found |= kit_versions_in(state)
        for folder in [*self.root.glob("*/projects"), *self.root.glob("u/*/projects")]:
            try:
                files = list(folder.iterdir())
            except FileNotFoundError:  # a visitor's workspace swept meanwhile
                continue
            except OSError:
                return None
            for path in files:
                if path.suffix not in (FILE_SUFFIX, OLD_FILE_SUFFIX, ".json"):
                    continue
                try:
                    found |= kit_versions_in(path.read_bytes())
                except FileNotFoundError:  # deleted meanwhile
                    continue
                except OSError:
                    return None
        return found

    def prune_kits(self) -> int:
        """Delete for good the customization versions nothing offers any more (KitStore.unneeded) that no project
        uses, once two looks in a row found them so: a look reads the editors and then the files one by one, so a
        project's state that moved meanwhile (its changes from a chat brought into the editor as undo steps, a chat's
        change written to its file and then to its history) can be missed by one look, never by the next. Returns
        how many went."""
        self._prune_due, self._pruned = False, time.time()
        unneeded = set(self.kits.unneeded()) if self.kits is not None else set()
        used = self.kit_versions_in_use() if unneeded else set()
        if used is None:  # a project couldn't be read: nothing goes, and the next sweep tries again
            self._unused = set()
            self._prune_due = True
            return 0
        unused = unneeded - used
        gone = sorted(unused & self._unused)
        self._unused = unused - set(gone)
        if self._unused:  # the next look lets them go, if it finds them unused too
            self._prune_due = True
        for kit_id, version in gone:
            self.kits.forget(kit_id, version)
        return len(gone)

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            for ws in [*self._by_id.values(), *self._evicted.values()]:
                ws.flush_now()
