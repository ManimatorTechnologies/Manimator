"""Where Manimator keeps its data by default (projects, uploads, renders, caches)."""

from __future__ import annotations

import os
from pathlib import Path


def app_data_dir() -> Path:
    override = os.environ.get("MANIMATOR_DATA_DIR")  # used by the tests
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
    # resolve() expands Windows 8.3 short names ("JOHNSM~1"); TeX cannot open paths with "~".
    path = Path(override).resolve() if override else Path(base).resolve() / "Manimator"
    path.mkdir(parents=True, exist_ok=True)
    return path
