"""Custom objects and animations from code packages (.manimkit, see server/kits.py), next to the built-in ones.

A project stores a custom type as "kit:<package id>:<version>". MOBJECTS and ANIMATIONS are SpecTables: looking a
type up also finds the packages' specs, while listing them (iteration, values(), items(), len) gives only the
built-ins, so the palette, the AI guide and everything that walks the catalog stay as they were.

A custom type nobody registered (a package taken down, or not loaded) still looks up: as a stand-in that draws
nothing and says why, so a project is never quietly emptied of its objects.
"""

from __future__ import annotations

import re
from typing import Callable

KIT_PREFIX = "kit:"
KIT_TYPE_RE = re.compile(r"^kit:([0-9a-f]{12}):([1-9][0-9]{0,3})$")
UNAVAILABLE = "This custom object or animation isn't available any more."


class Unavailable(ValueError):
    """Code can't be made for a custom type: its package isn't available (codegen reports it on the object)."""


def is_kit_type(key) -> bool:
    return isinstance(key, str) and KIT_TYPE_RE.match(key) is not None


def kit_type(kit_id: str, version: int) -> str:
    return f"{KIT_PREFIX}{kit_id}:{version}"


class SpecTable(dict):
    """Built-in specs by key; lookups also find custom ones (see the module's notes)."""

    def __init__(self, items: dict, stand_in: Callable[[str], object]):
        super().__init__(items)
        self.custom: dict = {}
        self._stand_in = stand_in

    def __missing__(self, key):
        if is_kit_type(key):
            return self.custom.get(key) or self._stand_in(key)
        raise KeyError(key)

    def __contains__(self, key):
        return super().__contains__(key) or is_kit_type(key)

    def get(self, key, default=None):
        if super().__contains__(key):
            return super().__getitem__(key)
        if is_kit_type(key):
            return self.custom.get(key) or self._stand_in(key)
        return default

    def is_available(self, key) -> bool:
        """A built-in, or a registered custom type that isn't blocked."""
        if super().__contains__(key):
            return True
        spec = self.custom.get(key) if isinstance(key, str) else None
        return spec is not None and not getattr(spec, "blocked", False)
