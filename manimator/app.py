"""Start Manimator: a web server you use in your browser (on this computer, or as a website for others)."""

from __future__ import annotations

import argparse
import importlib.util
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path


def load_env_file(path: Path) -> None:
    """NAME=value lines from a .env file become settings; real environment variables win."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value:
            os.environ.setdefault(name.strip(), value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="manimator", description="Build Manim videos with buttons, in your browser.")
    parser.add_argument("--port", type=int, help="server port (default: $PORT or 8000)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to listen on (default: this computer only; 0.0.0.0 to serve others)")
    parser.add_argument("--data-dir", help="where projects and uploads are kept")
    parser.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)  # older name; the server is all there is
    args = parser.parse_args(argv)

    load_env_file(Path(os.environ.get("MANIMATOR_ENV_FILE") or Path.cwd() / ".env"))

    import uvicorn

    from .paths import app_data_dir
    from .server import addon
    from .server.api import create_app
    from .server.web import WebConfig

    data_dir = Path(args.data_dir or os.environ.get("MANIMATOR_DATA_DIR") or app_data_dir()).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = WebConfig.from_env(data_dir)
    port = args.port or int(os.environ.get("PORT", "8000"))
    loopback = args.host in ("127.0.0.1", "localhost", "::1")
    with socket.socket() as probe:  # say so plainly if something else already uses the port
        try:
            probe.bind((args.host, port))
        except OSError:
            print(f"Port {port} is already in use by another program on this computer.\n"
                  f"Pick a free one, for example:  python run.py --port {port + 10}")
            return 1
    url = f"http://{'127.0.0.1' if loopback or args.host == '0.0.0.0' else args.host}:{port}/"
    print(f"Manimator is running at {url}   (Ctrl+C to stop)   data: {data_dir}")
    if not loopback and not cfg.allowed_hosts:
        print("  NOTE: set MANIMATOR_ALLOWED_HOSTS to your site's domain (for example example.com), "
              "otherwise visitors using that name are refused.")
    if "*" in cfg.allowed_hosts:
        print("  WARNING: MANIMATOR_ALLOWED_HOSTS=* accepts any Host name. Use your real domain in production.")
    if not loopback and not cfg.https:
        print("  NOTE: put this behind HTTPS and set MANIMATOR_HTTPS=1 so the session cookie is marked Secure.")
    if loopback and not args.no_open:
        threading.Timer(1.5, webbrowser.open, [url]).start()
    renderer = None
    if os.environ.get("MANIMATOR_PREVIEWS", "1") != "0" and importlib.util.find_spec("playwright"):
        from .server.renderer import Renderer

        renderer = Renderer()  # previews for AI chats; the browser starts on the first one
    app = create_app(cfg, renderer=renderer, addon=addon.find())  # accounts, if an add-on brings them
    uvicorn.run(app, host=args.host, port=port, log_level="warning", proxy_headers=True,
                forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"), server_header=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
