"""Frames of a scene, drawn on the server, for AI chats: they can't see the player, so they look at these instead.

A headless Chromium (Playwright) opens web/mcp/render.html and draws scene plans with the browser engine, the same
code the player and the editor run, so a frame here is what the person will see. The page is served straight from
the web folder (no HTTP server needed) and can't reach anything else. One browser, one page, one job at a time on
its own thread; the browser starts on the first job and starts again if it dies.
"""

from __future__ import annotations

import base64
import concurrent.futures
import mimetypes
import os
import queue
import threading
from pathlib import Path
from typing import Callable

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
ORIGIN = "http://render.manimator"  # not a real address: every request to it is answered from WEB_DIR
MAX_PENDING = 4


class RenderUnavailable(Exception):
    """Frames can't be made here now (no browser on this server, too busy, or it failed)."""


class Renderer:
    def __init__(self, timeout: float = 30.0, asset_path: Callable[[str, str], Path | None] | None = None):
        self.timeout = timeout
        self.asset_path = asset_path  # (owner, name) -> an uploaded file, for objects that show one
        self._jobs: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._owner = ""  # whose files the job being drawn may use
        self.broken: str | None = None

    def render(self, plan: dict, times: list[float], width: int = 800, height: int = 450, owner: str = "") -> dict:
        """The plan's frames at `times`: {"duration", "errors", "scene_error", "frames": [{"t", "jpeg" (bytes),
        "objects": [{"id", "box"}], "view"}]}. Raises RenderUnavailable."""
        if self.broken:
            raise RenderUnavailable(self.broken)
        if self._jobs.qsize() >= MAX_PENDING:
            raise RenderUnavailable("busy")
        self._start()
        job = concurrent.futures.Future()
        self._jobs.put((job, plan, {"times": times, "width": width, "height": height}, owner))
        try:
            result = job.result(timeout=self.timeout)
        except concurrent.futures.TimeoutError:
            job.cancel()  # nobody waits for it now: if it hasn't started, the browser skips it
            raise RenderUnavailable("timed out") from None
        for frame in result["frames"]:
            frame["jpeg"] = base64.b64decode(frame.pop("image").split(",", 1)[1])
        return result

    def _start(self) -> None:
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="manimator-renderer", daemon=True)
                self._thread.start()

    # ------------------------------------------------------------------ the browser's thread
    def _serve(self, route) -> None:
        url = route.request.url
        if not url.startswith(ORIGIN + "/"):
            route.abort()  # nothing outside this page
            return
        path = url[len(ORIGIN) + 1:].split("?", 1)[0]
        if path.startswith("assets/") and self.asset_path is not None:
            from urllib.parse import unquote
            file = self.asset_path(self._owner, unquote(path[len("assets/"):]))
        elif path.startswith("static/"):
            file = (WEB_DIR / path[len("static/"):]).resolve()
            if WEB_DIR not in file.parents:
                file = None
        else:
            file = None
        if file is None or not file.is_file():
            route.fulfill(status=404, body="")
            return
        kind = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if file.suffix in (".js", ".mjs"):
            kind = "text/javascript"
        route.fulfill(status=200, body=file.read_bytes(), headers={"Content-Type": kind})

    def _launch(self, playwright):
        args = ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"]
        channel = os.environ.get("MANIMATOR_RENDER_CHANNEL") or None  # e.g. msedge on a PC without Playwright's own
        browser = playwright.chromium.launch(headless=True, args=args, channel=channel)
        page = browser.new_page()
        page.route("**/*", self._serve)
        page.goto(f"{ORIGIN}/static/mcp/render.html")
        page.wait_for_function("window.renderReady === true", timeout=60_000)
        return browser, page

    def _run(self) -> None:
        try:
            from playwright.sync_api import Error as PlaywrightError
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.broken = "previews need Playwright, which this server doesn't have"
            self._fail_waiting()
            return
        with sync_playwright() as playwright:
            browser = page = None
            while True:
                job, plan, options, owner = self._jobs.get()
                if not job.set_running_or_notify_cancel():  # it timed out while waiting
                    continue
                try:
                    if page is None:
                        browser, page = self._launch(playwright)
                    self._owner = owner
                    job.set_result(page.evaluate("([plan, options]) => window.renderPlan(plan, options)",
                                                 [plan, options]))
                except PlaywrightError as e:
                    if not job.done():
                        job.set_exception(RenderUnavailable(str(e).splitlines()[0][:200]))
                    if browser is not None and browser.is_connected() and page is not None and not page.is_closed():
                        continue  # the plan failed, not the browser
                    try:  # start over with a fresh browser for the next job
                        if browser is not None:
                            browser.close()
                    except PlaywrightError:
                        pass
                    browser = page = None
                except Exception as e:  # noqa: BLE001 - one bad job must not stop the thread
                    if not job.done():
                        job.set_exception(RenderUnavailable(str(e)[:200]))

    def _fail_waiting(self) -> None:
        while not self._jobs.empty():
            job = self._jobs.get_nowait()[0]
            if not job.done():
                job.set_exception(RenderUnavailable(self.broken))
