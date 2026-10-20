"""Where an add-on plugs into the server.

Without one, as on your own computer or server, there are no accounts: every visitor gets a private workspace with
the server's own limits (`WebConfig`) and may use everything. The hosted site, manimator.app, adds accounts, plans
and payments with an add-on of its own, kept in a separate private repository (the package `cloud`, next to
`manimator/`).

An add-on is an `Addon`. The app asks it who is signed in and what they may keep, lets it add routes (they come
before the app's own, so it may also take over a page such as "/"), and serves its web files in place of the app's
files of the same name (web/js/account.js, for one, is an empty stand-in here).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from .plans import Plan


@dataclass
class Core:
    """What the app hands an add-on to work with."""

    web: Any  # WebConfig
    store: Any  # WorkspaceStore: the visitors' workspaces
    kits: Any  # KitStore: customizations
    http: Any  # client for other services (tests pass one that never leaves the machine), or None
    current: Callable  # FastAPI dependency: the workspace of the visitor making the request
    csp: str  # the pages' Content-Security-Policy, as the add-on changed it
    web_dir: Path  # the app's own web files


class Addon:
    """An add-on that changes nothing. Add-ons override what they need."""

    web_dir: Path | None = None  # files served under /static/ in place of the app's own of the same name
    external_posts: frozenset = frozenset()  # paths other sites' servers post to (they send no X-Manimator header)
    self_limited: frozenset = frozenset()  # of those, the ones that read their own bodies up to a limit

    def csp(self, csp: str) -> str:
        """The pages' Content-Security-Policy (to allow a payment provider's scripts and frames, say)."""
        return csp

    def attach(self, app: FastAPI, core: Core) -> None:
        """Add routes. Called before the app adds its own, so the add-on's come first."""

    def user(self, request: Request) -> dict | None:
        """The signed-in account making the request ({"id", "email", "name"}), or None for a guest."""
        return None

    def plan(self, ws, user: dict | None) -> Plan:
        """What this visitor may keep (`ws.plan` holds what they had)."""
        return ws.plan

    def respond(self, request: Request, response) -> None:
        """A last look at every response (to set or clear the add-on's cookies)."""

    def account(self, ws) -> dict:
        """More for /api/account (its keys are in api.py)."""
        return {}

    def connections(self, ws) -> list:
        """The AI chat apps connected to the visitor's account (the User MCP)."""
        return []

    def mcp_account(self, token: str) -> dict | None:
        """The account a User MCP bearer token acts for ({"user", "workspace", "app"}), or None."""
        return None

    def plan_limits(self) -> str:
        """The plans' project limits, for the User MCP's guide ("Free 3, Pro 30")."""
        return ""

    def upgradable(self, ws) -> bool:
        """Whether this visitor could buy a bigger plan (messages about limits then say so)."""
        return False

    def close(self) -> None:
        """The server is stopping."""


def find() -> Addon | None:
    """The installed add-on, set up from the environment: None when there is none, or it isn't configured."""
    try:
        import cloud
    except ModuleNotFoundError as e:
        if e.name != "cloud":
            raise
        return None
    return cloud.from_env()


class LayeredFiles(StaticFiles):
    """Static files from several folders: the first one that has the file serves it."""

    def __init__(self, directories: list[Path]):
        self._layers = [os.fspath(d) for d in directories]
        super().__init__(directory=self._layers[-1])

    def get_directories(self, directory=None, packages=None) -> list[str]:
        return self._layers
