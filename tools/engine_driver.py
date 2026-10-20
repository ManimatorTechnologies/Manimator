"""Dev only: run the app with its engine test pages, and drive them in a headless Edge (Playwright).

    with serve() as base_url, page(base_url + "/dev/") as p:
        p.evaluate("harness.cases()")

The server runs in this process (a thread) with the dev pages on; it never draws, so it needs little memory. The page records requests to other sites and console errors, which the checks report.
"""

from __future__ import annotations

import contextlib
import os
import socket
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def serve(data_dir: Path | None = None):
    """The app in a thread."""
    import uvicorn

    os.environ["MANIMATOR_DEV_PAGES"] = "1"
    from manimator.server.api import create_app
    from manimator.server.web import WebConfig

    data = data_dir or ROOT / ".cache" / "web-data-driver"
    data.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    config = uvicorn.Config(create_app(WebConfig(data_dir=data)), host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


class Page:
    """A Playwright page plus what it saw: requests to other sites and console errors."""

    def __init__(self, page, origin: str):
        self.page = page
        self.origin = origin
        self.external: list[str] = []
        self.console_errors: list[str] = []
        page.on("request", self._request)
        page.on("console", lambda m: m.type == "error" and self.console_errors.append(m.text[:300]))
        page.on("pageerror", lambda e: self.console_errors.append(f"pageerror: {e}"[:300]))

    def _request(self, request) -> None:
        u = urlparse(request.url)
        if u.scheme in ("data", "blob"):
            return
        if f"{u.scheme}://{u.netloc}" != self.origin:
            self.external.append(request.url)

    def evaluate(self, expression: str, arg=None):
        return self.page.evaluate(expression, arg)


@contextlib.contextmanager
def page(url: str, width: int = 1400, height: int = 900, headless: bool = True, channel: str | None = None):
    """A page in headless Edge (or `channel`: "chrome", or MANIMATOR_TEST_BROWSER) that is ready when
    window.harness.ready is true."""
    from playwright.sync_api import sync_playwright

    parsed = urlparse(url)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel=channel or os.environ.get("MANIMATOR_TEST_BROWSER", "msedge"), headless=headless,
                                     args=["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"])
        try:
            context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            p = Page(context.new_page(), f"{parsed.scheme}://{parsed.netloc}")
            p.page.set_default_timeout(120_000)
            p.page.goto(url)
            # Not wait_for_function: it polls with eval inside the page, which the site's CSP forbids.
            for _ in range(1200):
                if p.evaluate("!!(window.harness && window.harness.ready)"):
                    break
                time.sleep(0.05)
            else:
                raise TimeoutError(f"{url} never became ready: {p.console_errors}")
            yield p
        finally:
            browser.close()
