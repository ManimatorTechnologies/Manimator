import importlib.util
import os
from pathlib import Path

import pytest

# Keep the LaTeX/text caches of the tests inside the repo (never a short 8.3 temp path:
# TeX cannot open paths containing "~").
CACHE = Path(__file__).resolve().parent.parent / ".cache" / "test-media"
# Keep the test app's data away from the real app data.
os.environ["MANIMATOR_DATA_DIR"] = str(CACHE.parent / "test-appdata")
# The server never needs Manim. The tests that check the exported Python against it (dev only) skip without it.
HAVE_MANIM = importlib.util.find_spec("manim") is not None


@pytest.fixture(scope="session", autouse=True)
def manim_media_dir():
    if not HAVE_MANIM:
        return None
    from manim import config

    CACHE.mkdir(parents=True, exist_ok=True)
    config.media_dir = str(CACHE)
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    return CACHE


@pytest.fixture
def manim_ns():
    pytest.importorskip("manim")
    ns: dict = {}
    exec("from manim import *", ns)
    return ns
