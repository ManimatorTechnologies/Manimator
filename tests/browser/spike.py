"""Phase 0 go/no-go checks for drawing and exporting in the browser (dev only; needs Playwright and Edge).

    python tests/browser/spike.py [--headed] [--quality h] [--seconds 5]

Runs /dev/perf.html under the site's real Content-Security-Policy, encodes a busy 1080p60 clip with WebCodecs,
checks the file with PyAV, and reports speed, memory, CSP violations and requests to other sites as JSON.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

from EngineDriver import page, serve  # noqa: E402

SIZES = {"l": (854, 480, 15), "m": (1280, 720, 30), "h": (1920, 1080, 60), "p": (2560, 1440, 60), "k": (3840, 2160, 60)}
BITRATE = {"l": 1.5e6, "m": 4e6, "h": 10e6, "p": 16e6, "k": 35e6}


def check_mp4(data: bytes) -> dict:
    import av

    with av.open(io.BytesIO(data)) as f:
        v = f.streams.video[0]
        frames = sum(1 for _ in f.decode(v))
        return {"codec": v.codec_context.name, "width": v.codec_context.width, "height": v.codec_context.height,
                "frames": frames, "duration": float(f.duration / 1e6) if f.duration else None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--quality", default="h", choices=list(SIZES))
    ap.add_argument("--seconds", type=float, default=5)
    args = ap.parse_args()
    w, h, fps = SIZES[args.quality]
    with serve() as base, page(base + "/dev/perf.html", headless=not args.headed) as p:
        t0 = time.time()
        result = p.evaluate("(o) => harness.run(o)", {"width": w, "height": h, "fps": fps, "seconds": args.seconds,
                                                     "bitrate": BITRATE[args.quality]})
        result["wall_s"] = round(time.time() - t0, 1)
        mp4 = result.pop("mp4", None)
        if mp4:
            data = base64.b64decode(mp4)
            (ROOT / ".cache" / f"spike-export-{args.quality}.mp4").write_bytes(data)
            result["file"] = check_mp4(data)
        result["violations"] = p.evaluate("[]")
        result["external_requests"] = p.external
        result["console_errors"] = p.console_errors
        result["gpu"] = p.evaluate("""(() => { const c = document.createElement('canvas').getContext('webgl');
            const d = c && c.getExtension('WEBGL_debug_renderer_info');
            return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; })()""")
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
