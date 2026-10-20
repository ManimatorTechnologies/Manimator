"""Dev only: the app with the engine's test pages at /dev.

    python tools/DevServer.py [port]        (default 8021; data in .cache/web-data-engine)
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("MANIMATOR_DEV_PAGES", "1")

from manimator.app import main  # noqa: E402

if __name__ == "__main__":
    port = sys.argv[1] if len(sys.argv) > 1 else "8021"
    sys.exit(main(["--no-open", "--port", port, "--data-dir", str(ROOT / ".cache" / "web-data-engine")]))
