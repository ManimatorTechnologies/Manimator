"""The HTTP API the browser UI talks to.

Many visitors can share the server. Each gets a private workspace behind a cookie, cannot name any path on the
server, uploads pictures instead, and is held to size and rate limits. Requests for a Host the site doesn't
answer to are refused (DNS rebinding), and every state-changing request needs a custom header, which browsers
won't send cross-origin without a CORS preflight this server never approves.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import mimetypes
import os
import re
from pathlib import Path

from fastapi import Body, Depends, FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .. import codegen
from ..export import export_zip
from ..model import ops
from ..model.project import FILE_SUFFIX, Project
from ..plan import plan_hash, project_plan, scene_plan
from . import docs
from .addon import Addon, Core, LayeredFiles
from .catalog import animation_json, catalog, mobject_json
from .kits import SUFFIX as KIT_SUFFIX, KitStore, demo_project
from ..registry.custom import kit_type
from .mcp import USER_PATH, mount_mcp, site_of
from .plans import local_plan
from .session import OpError
from .web import (
    ASSET_TYPES, COOKIE, MAX_KIT_BYTES, MAX_RENDER_BYTES, MAX_VIDEO_BYTES, THUMB_MAX, THUMB_MAX_BYTES, VIDEO_TYPES,
    TooFast,
    WebConfig, WorkspaceStore,
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
DEV_DIR = Path(__file__).resolve().parents[2] / "tests" / "browser" / "www"
CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
       "form-action 'self'; object-src 'none'")
SANDBOX_PAGE = "/static/sandbox/engine.html"
ICONS = ("/favicon.ico", "/apple-touch-icon.png")  # the site's icons (web/favicon/), also served at the top


def _import_map_hash() -> str:
    """The CSP hash of the sandbox page's import map (an inline script)."""
    text = (WEB_DIR / "sandbox" / "engine.html").read_text(encoding="utf-8")
    found = re.search(r'<script type="importmap">(.*?)</script>', text, re.S)
    return "'sha256-" + base64.b64encode(hashlib.sha256(found.group(1).encode()).digest()).decode() + "'"


def sandbox_csp(site: str, chat: bool = False) -> str:
    """The sandbox page's own policy: the site's engine and fonts (/static/) and the packages' code (blob:), nothing
    else: not the site's API, not other sites. Its origin is unique (sandboxed), so the site is named, not 'self'.
    Only this site frames it, except for the chat player's copy (`chat`): AI chats show the player from origins of
    their own, so any page may frame that one (it has no cookies, storage or API to give away)."""
    files = f"{site}/static/"
    return (f"default-src 'none'; script-src {files} blob: {_import_map_hash()}; connect-src {files}; "
            f"img-src blob: data:; style-src 'unsafe-inline'; frame-ancestors {'*' if chat else site}; "
            "base-uri 'none'; form-action 'none'; sandbox allow-scripts")


# Posted to by other sites' servers (AI chats): no X-Manimator. They read their own bodies, up to a limit, so they may
# come chunked. An add-on may add paths of its own.
SELF_LIMITED = frozenset({"/mcp", "/mcp/user"})
EXTERNAL_POSTS = SELF_LIMITED


class Refused(OpError):
    """A request turned down with a specific HTTP status (busy, too fast, too large...)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _checked_thumbnail(data: bytes) -> bytes:
    """A PNG of at most THUMB_MAX pixels, decoded and written again (only pixels are kept)."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format != "PNG" or img.width > THUMB_MAX[0] or img.height > THUMB_MAX[1]:
                raise Refused(f"Send a PNG of at most {THUMB_MAX[0]}x{THUMB_MAX[1]} pixels.", 422)
            img.load()
            rgb = img.convert("RGB")
    except Refused:
        raise
    except Exception:  # noqa: BLE001
        raise Refused("That isn't a valid PNG picture.", 422) from None
    buf = io.BytesIO()
    rgb.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def kit_specs_json(keys) -> dict:
    """Custom types (registry/custom.py) as the catalog writes object types and animations."""
    from ..registry import ANIMATIONS, MOBJECTS

    out = {"mobjects": [], "animations": []}
    for key in keys:
        if key in MOBJECTS.custom or key not in ANIMATIONS.custom:
            out["mobjects"].append(mobject_json(MOBJECTS[key]))
        if key in ANIMATIONS.custom or key not in MOBJECTS.custom:
            out["animations"].append(animation_json(ANIMATIONS[key]))
    return out


def create_app(web: WebConfig, http=None, renderer=None, addon: Addon | None = None) -> FastAPI:
    """The visitor's browser makes every picture and video (web/js/engine/). `renderer` (server/renderer.py) draws
    frames for AI chats that ask to see their animation; without one they don't get previews. `addon` brings
    accounts and plans (server/addon.py); `http` is the client it reaches other services with (tests pass one that
    never leaves the machine)."""
    kits = KitStore(web.data_dir / "kits")  # customizations: custom objects and animations (server/kits.py)
    store = WorkspaceStore(web, kits=kits)
    accounts = addon is not None  # people can sign in; without accounts every visitor may use everything
    csp = addon.csp(CSP) if addon else CSP
    self_limited = SELF_LIMITED | (addon.self_limited if addon else frozenset())
    external_posts = EXTERNAL_POSTS | (addon.external_posts if addon else frozenset())
    web_dirs = [addon.web_dir, WEB_DIR] if addon and addon.web_dir else [WEB_DIR]  # the add-on's files come first

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        yield
        store.close()
        kits.close()
        if addon:
            addon.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # ------------------------------------------------------------------ who is asking
    def current(request: Request):
        client = request.client.host if request.client else ""
        user = addon.user(request) if addon else None
        try:
            if user:
                ws = store.for_user(user)
            else:
                ws, issue = store.resolve(request.cookies.get(COOKIE), client)
                if issue:
                    request.state.new_cookie = ws.id
        except TooFast:
            raise Refused("Too many new visitors from your network. Please try again later.", 429) from None
        ws.plan = addon.plan(ws, user) if addon else local_plan(web)
        return ws

    def throttle(ws, kind: str) -> None:
        try:
            ws.take(kind)
        except TooFast:
            raise Refused("You're going a bit fast. Please wait a moment.", 429) from None

    def state(ws) -> dict:
        st = ws.session.state()
        st["name"] = ws.project_name
        st["id"] = ws.current_id  # the browser engine sends the project's card picture under it
        with ws.session.lock:
            used = ops.kit_types_in(ws.session.project)
        if used:  # the custom types in the project, for the editor's forms (unavailable ones too)
            st["kits"] = with_mine(kit_specs_json(used), ws)
        return st

    # ------------------------------------------------------------------ protection
    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if path != "/healthz" and not web.host_ok(host):
            return PlainTextResponse("Forbidden", status_code=403)
        # Other sites' servers post to the MCP endpoints (and to an add-on's webhooks and OAuth, which read their own
        # bodies, to a limit); a plain form may post to an add-on's OAuth Allow page, which checks its own token.
        if request.method not in ("GET", "HEAD") and request.headers.get("x-manimator") != "1" \
                and path not in external_posts:
            return PlainTextResponse("Forbidden", status_code=403)
        if request.method in ("POST", "PUT", "PATCH"):
            # uploads read their bodies themselves, to their own limits (videos and renders are streamed to disk)
            limit = MAX_RENDER_BYTES + 4096 if path in ("/api/upload", "/api/renders") else web.max_project_bytes + 4096
            if request.headers.get("transfer-encoding") and path not in ("/api/upload", "/api/renders") \
                    and path not in self_limited:
                return PlainTextResponse("Length required", status_code=411)
            try:
                length = int(request.headers.get("content-length") or 0)
            except ValueError:
                return PlainTextResponse("Bad request", status_code=400)
            if length > limit:
                return JSONResponse({"error": "That is too large to send."}, status_code=413)
        response = await call_next(request)
        # files named by their content keep the long cache their endpoint gives them (videos are fetched in parts: 206)
        if response.status_code not in (200, 206, 304) \
                or not path.startswith(("/api/thumb/", "/api/assets/", "/api/renders/")):
            response.headers["Cache-Control"] = "no-cache" if path.startswith("/static/") or path in ICONS else "no-store"
        sandbox = path == SANDBOX_PAGE  # customizations' code runs there (web/sandbox/): framed by this site only,
        chat = sandbox and request.query_params.get("embed") == "chat"  # or by the player in an AI chat (mcp.py)
        if sandbox:
            response.headers["Content-Security-Policy"] = sandbox_csp(site_of(request, web.site_url), chat)
        elif "content-security-policy" not in response.headers:  # an uploaded SVG brings a stricter one
            response.headers["Content-Security-Policy"] = csp
        response.headers.update({"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin"})
        if chat:  # framed inside a chat's frame, wherever that is; it holds nothing but what its parent sends it
            response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        else:
            response.headers["X-Frame-Options"] = "SAMEORIGIN" if sandbox else "DENY"
        if path.startswith("/static/"):  # the chat's player (server/mcp.py) loads the engine and fonts from here
            response.headers.update({"Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin"})
        if web.https:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        cookie = getattr(request.state, "new_cookie", None)
        if cookie:
            response.set_cookie(COOKIE, cookie, max_age=int(web.session_ttl), httponly=True, samesite="lax",
                                secure=web.https, path="/")
        if addon:
            addon.respond(request, response)
        return response

    @app.exception_handler(OpError)
    async def op_error(_request, exc: Exception):
        return JSONResponse({"error": str(exc)}, status_code=getattr(exc, "status", 400))

    # ------------------------------------------------------------------ the add-on's routes come before the app's
    if addon:
        addon.attach(app, Core(web=web, store=store, kits=kits, http=http, current=current, csp=csp, web_dir=WEB_DIR))

    # ------------------------------------------------------------------ pages
    @app.get("/")
    def home(request: Request):
        """The app opens (an add-on may have a home page of its own)."""
        query = request.url.query
        return RedirectResponse("/app" + (f"?{query}" if query else ""), status_code=302)

    @app.get("/manimkit")  # the guide to writing customizations (server/kits.py) is a docs page now
    def manimkit_page():
        return RedirectResponse("/docs/customizations#writing", status_code=301)

    @app.get("/docs/search.json")
    def docs_search():
        return Response(docs.search_json(web_dirs), media_type="application/json")

    @app.get("/docs")
    @app.get("/docs/{slug}")
    def docs_page(slug: str = ""):  # how to use Manimator (server/docs.py)
        page = docs.render(web_dirs, slug)
        if page is None:
            return HTMLResponse("Not found", status_code=404)
        return HTMLResponse(page)

    @app.get("/app")
    def index(_ws=Depends(current)):  # visiting the page is what hands out the cookie
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/favicon.ico")
    @app.get("/apple-touch-icon.png")
    def site_icon(request: Request):  # asked for by name, by browsers and phones, whatever the page links
        return FileResponse(WEB_DIR / "favicon" / request.url.path.strip("/"))

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    # ------------------------------------------------------------------ AI chats (MCP Apps)
    if renderer is not None:  # objects that show a file draw the account's own upload
        renderer.asset_path = lambda owner, name: (ws.asset_path(name) if (ws := store.loaded(owner)) else None)

    # Guest MCP: quick inline videos, for anyone. User MCP (with accounts): projects saved in the account.
    mount_mcp(app, web.site_url, account=addon.mcp_account if addon else None, renderer=renderer, kits=kits,
              limits=addon.plan_limits() if addon else "")

    @app.get("/api/connectors")
    def connectors(request: Request, ws=Depends(current)):
        """The MCP servers to add to an AI chat, for the account page; with an account, the apps connected to it."""
        here = site_of(request, web.site_url)
        return {"guest": f"{here}/mcp", "user": f"{here}{USER_PATH}" if accounts else None,
                "connections": addon.connections(ws) if addon and ws.user else []}

    for kind, ext in (("font/woff2", ".woff2"), ("font/ttf", ".ttf")):  # not in every system's table
        mimetypes.add_type(kind, ext)
    app.mount("/static", LayeredFiles(web_dirs), name="static")
    if os.environ.get("MANIMATOR_DEV_PAGES") == "1" and DEV_DIR.is_dir():  # the engine's test pages (development)
        app.mount("/dev", StaticFiles(directory=DEV_DIR, html=True), name="dev")

    # ------------------------------------------------------------------ accounts
    def need_accounts():
        if not accounts:
            raise Refused("Accounts aren't switched on for this server.", 404)

    @app.get("/api/account")
    def account(ws=Depends(current)):
        """Who is signed in and what their plan allows (without accounts: the server's own limits)."""
        info = {"accounts": accounts, "user": None, "plan": ws.plan.public(), "billing": None, "subscription": None,
                "plans": []}
        if addon:
            info.update(addon.account(ws))
        return info

    # ------------------------------------------------------------------ model
    @app.get("/api/catalog")
    def get_catalog():
        limits = {"maxUploadMb": web.max_upload_bytes // (1024 * 1024), "maxAssets": web.max_assets,
                  "maxProjects": web.max_projects}
        return {**catalog(), "limits": limits}

    @app.get("/api/plan")
    def get_plan(scene_id: str = "", all: int = 0, ws=Depends(current)):  # noqa: A002 - the query is ?all=1
        """What the browser engine builds and plays: one scene's plan, or every scene's (?all=1)."""
        throttle(ws, "plan")
        with ws.session.lock:
            project = ws.session.project
            version = ws.session.version
            if all:
                return {"version": version, "plan": project_plan(project)}
            scene = project.scene(scene_id) or project.scenes[0]
            return {"version": version, "scene_id": scene.id, "plan": scene_plan(scene, project)}

    @app.get("/api/state")
    def get_state(ws=Depends(current)):
        return state(ws)

    @app.post("/api/op")
    def apply_op(body: dict = Body(...), ws=Depends(current)):
        throttle(ws, "op")
        merge_key = body.get("merge_key")
        result = ws.session.apply(str(body.get("op", "")), body.get("args") or {},
                                  str(merge_key)[:200] if merge_key not in (None, "") else None)
        ws.save_soon()
        return {"result": result, "state": state(ws)}

    @app.post("/api/undo")
    def undo(ws=Depends(current)):
        ws.session.undo()
        ws.save_soon()
        return {"state": state(ws)}

    @app.post("/api/redo")
    def redo(ws=Depends(current)):
        ws.session.redo()
        ws.save_soon()
        return {"state": state(ws)}

    @app.get("/api/code")
    def code(ws=Depends(current)):
        with ws.session.lock, codegen.asset_root("assets"):
            return PlainTextResponse(codegen.project_source(ws.session.project, "scene.py"))

    # ------------------------------------------------------------------ projects
    @app.get("/api/projects")
    def projects(ws=Depends(current)):
        """The visitor's projects for the start screen, most recently opened first."""
        return {"projects": ws.list_projects(), "limit": ws.plan.projects}

    @app.get("/api/thumb/{pid}")
    def project_thumbnail(pid: str, ws=Depends(current)):
        """A project's card picture: its first scene as the editor shows it (the browser sends it, below). The page
        adds ?v=<last edit> to the address, so a browser can keep each picture until the project changes."""
        picture = ws.thumbnail(pid)
        if not picture.exists():  # not sent since the last change: the page makes it when the project is open
            return Response(status_code=404)
        return FileResponse(picture, media_type="image/png", headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.post("/api/thumb/{pid}")
    async def upload_thumbnail(pid: str, request: Request, ws=Depends(current)):
        """The browser's picture of a project's first scene, for its card on the Projects page."""
        throttle(ws, "thumb")
        data = bytearray()
        async for chunk in request.stream():
            data += chunk
            if len(data) > THUMB_MAX_BYTES:
                raise Refused("That picture is too large.", 413)
        png = await run_in_threadpool(_checked_thumbnail, bytes(data))
        ws.keep_thumbnail(ws.thumbnail(pid), png)
        return {"ok": True}

    @app.post("/api/file/new")
    def new_file(ws=Depends(current)):
        """A new project next to the others."""
        throttle(ws, "op")
        ws.create()
        return {"state": state(ws)}

    @app.post("/api/projects/open")
    def open_project(body: dict = Body(...), ws=Depends(current)):
        throttle(ws, "op")
        notes = ws.switch(body.get("id"))
        return {"state": state(ws), "notes": notes}

    @app.post("/api/projects/rename")
    def rename_project(body: dict = Body(...), ws=Depends(current)):
        throttle(ws, "op")
        ws.rename(body.get("id"), body.get("name"))
        return {"state": state(ws)}

    @app.post("/api/projects/delete")
    def delete_project(body: dict = Body(...), ws=Depends(current)):
        throttle(ws, "op")
        ws.delete(body.get("id"))
        return {"state": state(ws)}

    # ------------------------------------------------------------------ files
    @app.get("/api/file/download")
    def download_project(ws=Depends(current)):
        with ws.session.lock:
            text = json.dumps(ws.session.project.to_dict(), indent=2)
            ws.session.mark_downloaded()
        stem = re.sub(r"[^A-Za-z0-9 _-]", "", ws.project_name).strip()[:60] or "project"
        return Response(text, media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{stem}{FILE_SUFFIX}"'})

    @app.get("/api/file/export.py")
    def download_python(ws=Depends(current)):
        with ws.session.lock, codegen.asset_root("assets"):
            source = codegen.project_source(ws.session.project, "scene.py")
        return Response(source, media_type="text/x-python",
                        headers={"Content-Disposition": 'attachment; filename="scene.py"'})

    @app.get("/api/file/export.zip")
    def download_python_zip(ws=Depends(current)):
        """The project as a folder that renders with Manim CE: scene.py with the pictures and fonts it uses."""
        throttle(ws, "plan")
        with ws.session.lock:
            project = Project.from_dict(ws.session.project.to_dict())
        name, data = export_zip(project, ws.project_name, ws.asset_path,
                                lambda kid, version: kits.file(kid, version, "kit.py"))
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/assets")
    def list_assets(ws=Depends(current)):
        return {"files": ws.asset_names()}

    @app.get("/api/assets/{name}")
    def get_asset(name: str, ws=Depends(current)):
        """One of the visitor's uploaded files, for the browser engine. Stored names carry a hash of the content,
        so a file never changes under its name."""
        path = ws.asset_path(name)
        if path is None:
            return Response(status_code=404)
        headers = {"Cache-Control": "private, max-age=31536000, immutable"}
        if path.suffix.lower() == ".svg":  # opened on its own, it may not run anything or be shown as a page
            headers.update({"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                            "Content-Disposition": "attachment"})
        return FileResponse(path, media_type=ASSET_TYPES[path.suffix.lower()], headers=headers)

    async def stream_to_file(request: Request, ws, limit: int, what: str, replaces: int = 0):
        """A large upload, written to a file in the workspace as it arrives: (path, sha256 hex). `replaces`: bytes
        of stored files the upload takes the place of (they count as free room)."""
        room = ws.plan.asset_quota - ws.storage_used() + replaces
        tmp = ws.tmp_file()
        digest = hashlib.sha256()
        size = 0
        try:
            with open(tmp, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > limit:
                        raise Refused(f"That {what} is too large (the limit is {limit // (1024 * 1024)} MB).", 413)
                    if size > room:
                        raise Refused(ws._limit_message("That doesn't fit in your storage"), 413)
                    f.write(chunk)
                    digest.update(chunk)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        if not size:
            tmp.unlink(missing_ok=True)
            raise OpError(f"That {what} is empty.")
        return tmp, digest.hexdigest()

    def need_account(ws) -> None:
        """Presentations and videos belong to accounts (on your own computer, without accounts, to everyone)."""
        if accounts and not ws.user:
            raise Refused("Sign in to make presentations.", 401)

    @app.post("/api/upload")
    async def upload(request: Request, name: str = "", ws=Depends(current)):
        throttle(ws, "upload")
        if Path(name).suffix.lower() in VIDEO_TYPES:  # big: streamed to disk, for presentations
            need_account(ws)
            tmp, digest = await stream_to_file(request, ws, MAX_VIDEO_BYTES, "video")
            try:
                stored = await run_in_threadpool(ws.add_video, name, tmp, digest)
            finally:
                tmp.unlink(missing_ok=True)
            return {"name": stored, "files": ws.asset_names()}
        data = bytearray()
        async for chunk in request.stream():
            data += chunk
            if len(data) > web.max_upload_bytes:
                raise Refused(f"That file is too large (the limit is {web.max_upload_bytes // (1024 * 1024)} MB).", 413)
        if not data:
            raise OpError("That file is empty.")
        stored = await run_in_threadpool(ws.add_asset, name, bytes(data))
        return {"name": stored, "files": ws.asset_names()}

    # ------------------------------------------------------------------ storage (uploads and stored renders)
    @app.get("/api/storage")
    def storage(ws=Depends(current)):
        return ws.storage()

    @app.post("/api/storage/delete")
    def delete_stored(body: dict = Body(...), ws=Depends(current)):
        """Delete an uploaded file or a stored render; {"renders": true}: every stored render."""
        throttle(ws, "op")
        if body.get("renders") is True:
            ws.delete_renders()
        elif ws.render_path(str(body.get("name") or "")):
            ws.delete_renders(str(body["name"]))
        else:
            ws.delete_asset(str(body.get("name") or ""))
        return ws.storage()

    # ------------------------------------------------------------------ settings of the account's own
    @app.get("/api/prefs")
    def get_prefs(ws=Depends(current)):
        return ws.prefs()

    @app.post("/api/prefs")
    def set_prefs(body: dict = Body(...), ws=Depends(current)):
        throttle(ws, "op")
        prefs = ws.prefs()
        for name, value in body.items():
            prefs = ws.set_pref(str(name), value)
        return prefs

    # ------------------------------------------------------------------ presentations
    @app.get("/api/presentations")
    def presentations(ws=Depends(current)):
        need_account(ws)
        return {"presentations": ws.list_presentations()}

    @app.post("/api/presentations/new")
    def new_presentation(body: dict = Body(...), ws=Depends(current)):
        need_account(ws)
        throttle(ws, "op")
        prid = ws.create_presentation(body.get("name"), str(body.get("project") or ""))
        return ws.presentation(prid)

    @app.get("/api/presentations/{prid}")
    def get_presentation(prid: str, ws=Depends(current)):
        need_account(ws)
        return ws.presentation(prid)

    @app.post("/api/presentations/{prid}")
    def save_presentation(prid: str, body: dict = Body(...), ws=Depends(current)):
        need_account(ws)
        throttle(ws, "op")
        ws.save_presentation(prid, body.get("name"), body.get("items"))
        return ws.presentation(prid)

    @app.post("/api/presentations/{prid}/delete")
    def delete_presentation(prid: str, ws=Depends(current)):
        need_account(ws)
        throttle(ws, "op")
        ws.delete_presentation(prid)
        return {"presentations": ws.list_presentations()}

    @app.get("/api/presentations/{prid}/play")
    def play_presentation(prid: str, ws=Depends(current)):
        """Everything the presenter needs, in order: each scene's plan (and its stored render, if one is current),
        each video's address. Items whose scene or video is gone are marked missing."""
        need_account(ws)
        throttle(ws, "plan")
        p = ws.presentation(prid)
        project = ws.read_project(p["project"]) if p["project_name"] is not None else None
        quality = project.settings.quality if project else "m"
        items = []
        for it in p["items"]:
            if it["missing"] or project is None:
                items.append({"id": it["id"], "kind": "missing", "name": it.get("name") or "Missing"})
            elif it["kind"] == "scene":
                scene = project.scene(it["scene"])
                plan = scene_plan(scene, project)
                digest = plan_hash(plan, quality)
                render = ws.find_render(p["project"], scene.id, digest)
                items.append({"id": it["id"], "kind": "scene", "name": scene.name, "scene": scene.id, "plan": plan,
                              "hash": digest, "render": f"/api/renders/{render}" if render else None})
            else:
                items.append({"id": it["id"], "kind": "video", "name": it["file"],
                              "url": f"/api/assets/{it['file']}"})
        return {"id": prid, "name": p["name"], "project": p["project"], "mode": ws.prefs()["presentation_mode"],
                "quality": quality, "items": items}

    # ------------------------------------------------------------------ customizations (server/kits.py)
    def kit_owner_name(ws) -> str:
        if not ws.user:
            return ""
        return ws.user.get("name") or ws.user.get("email", "").split("@")[0]

    def kits_allowed(ws) -> str:
        """Why this visitor can't make customizations ("" if they can)."""
        if accounts and not ws.user:
            return "Sign in to make customizations."
        if ws.plan.kits <= 0:
            return "Custom objects and animations aren't part of this plan."
        return ""

    async def read_kit_body(request: Request) -> bytes:
        data = bytearray()
        async for chunk in request.stream():
            data += chunk
            if len(data) > MAX_KIT_BYTES:
                raise Refused(f"A {KIT_SUFFIX} file can be up to {MAX_KIT_BYTES // 1024} KB.", 413)
        return bytes(data)

    def is_admin(ws) -> bool:
        """The site's owner, who reviews public customizations (MANIMATOR_ADMINS)."""
        return bool(accounts and ws.user and ws.user.get("email", "").lower() in web.admins)

    def public_view(kit: dict, ws) -> dict:
        """A package as someone other than its author sees it: only approved versions, no review notes."""
        out = kits.summary(kit, ws.owner_key)
        if not out["mine"] and not is_admin(ws):
            out["versions"] = [{**v, "reason": ""} for v in out["versions"] if v["status"] == "public"]
            spec = kits.spec(kit["id"], kits.latest_public(kit["id"]))
            out.update(type=spec.key if spec else None, description=spec.description if spec else "")
        out["in_library"] = kits.in_library(ws.owner_key, kit["id"])
        return out

    def kits_listing(ws) -> dict:
        mine = [kits.summary(k, ws.owner_key) for k in kits.owned(ws.owner_key)]
        library = [public_view(k, ws) for k in kits.library(ws.owner_key) if k["owner"] != ws.owner_key]
        return {"kits": mine, "library": library, "limit": ws.plan.kits, "why": kits_allowed(ws),
                "admin": is_admin(ws), "public": accounts}

    def with_mine(specs: dict, ws) -> dict:
        """Marks each custom spec as the visitor's own or someone else's (the Python download warns about those)."""
        for entry in specs["mobjects"] + specs["animations"]:
            if entry.get("kit"):
                kit = kits.kit(entry["kit"]["id"])
                entry["kit"] = {**entry["kit"], "mine": bool(kit and kit["owner"] == ws.owner_key)}
        return specs

    @app.get("/api/kits")
    def list_kits(ws=Depends(current)):
        """The visitor's customizations (and whether they may make more)."""
        return kits_listing(ws)

    @app.post("/api/kits")
    async def upload_kit(request: Request, ws=Depends(current)):
        """A new customization from a .manimkit file."""
        throttle(ws, "upload")
        why = kits_allowed(ws)
        if why:
            raise Refused(why, 401 if "Sign in" in why else 403)
        data = await read_kit_body(request)
        kit = await run_in_threadpool(kits.add, ws.owner_key, kit_owner_name(ws), data, ws.plan.kits, None,
                                      bool(addon and addon.upgradable(ws)))
        return {"kit": kits.summary(kit, ws.owner_key), **kits_listing(ws)}

    @app.post("/api/kits/{kid}/versions")
    async def upload_kit_version(kid: str, request: Request, ws=Depends(current)):
        """A new version of one of the visitor's customizations (projects keep the version they use)."""
        throttle(ws, "upload")
        why = kits_allowed(ws)
        if why:
            raise Refused(why, 401 if "Sign in" in why else 403)
        data = await read_kit_body(request)
        kit = await run_in_threadpool(kits.add, ws.owner_key, kit_owner_name(ws), data, ws.plan.kits, kid)
        return {"kit": kits.summary(kit, ws.owner_key), **kits_listing(ws)}

    def visible_kit(ws, kid: str) -> dict:
        """A package the visitor may look at: their own, one in the gallery, or (for the reviewer) any."""
        kit = kits.kit(kid)
        if kit is None or not (kit["owner"] == ws.owner_key or is_admin(ws) or kits.latest_public(kid)):
            raise Refused("That customization doesn't exist.", 404)
        return kit

    def shown_version(ws, kit: dict, asked: int = 0) -> int:
        """Which version the visitor sees: the newest (or `asked`) for its author and the reviewer, else the newest
        approved one."""
        if kit["owner"] == ws.owner_key or is_admin(ws):
            return asked if asked and kits.readable(ws.owner_key, kit["id"], asked, True) else kits.latest_any(kit["id"])
        return kits.latest_public(kit["id"])

    @app.get("/api/kits/specs")
    def kit_specs(ws=Depends(current)):
        """The custom objects and animations the visitor can add, for the editor's palette and animation window."""
        if kits_allowed(ws):
            return {"mobjects": [], "animations": []}
        return with_mine(kit_specs_json([s.key for s in kits.usable(ws.owner_key)]), ws)

    @app.get("/api/kits/{kid}")
    def get_kit(kid: str, version: int = 0, ws=Depends(current)):
        kit = visible_kit(ws, kid)
        out = public_view(kit, ws)
        shown = shown_version(ws, kit, version)
        readme = kits.file(kid, shown, "README.md") if shown else None
        out.update(readme=readme.read_text(encoding="utf-8") if readme else "", shown_version=shown,
                   can_add=not kits_allowed(ws) and not out["mine"] and bool(kits.latest_public(kid)))
        if is_admin(ws):
            out["review"] = kits.review(kid)
        return out

    @app.get("/api/kits/{kid}/demo")
    def kit_demo(kid: str, version: int = 0, ws=Depends(current)):
        """A small scene showing a version of the customization (the one the visitor sees), for its preview."""
        kit = visible_kit(ws, kid)
        shown = shown_version(ws, kit, version)
        spec = kits.spec(kid, shown) if shown else None
        if spec is None or spec.blocked:
            raise Refused("That customization has no version to show.", 404)
        project = demo_project(kit_type(kid, shown))
        return {"plan": scene_plan(project.scenes[0], project)}

    @app.post("/api/kits/{kid}/delete")
    def delete_kit(kid: str, ws=Depends(current)):
        """Takes a customization off the lists; projects that use it keep working."""
        throttle(ws, "op")
        kits.unlist(ws.owner_key, kid)
        return kits_listing(ws)

    @app.get("/api/kits/{kid}/{version}/{name}")
    def kit_file(kid: str, version: int, name: str, ws=Depends(current)):
        """A file of a customization, as text (the editor runs kit.js only inside its sandbox, web/sandbox/)."""
        ok = kits.readable(ws.owner_key, kid, version, admin=is_admin(ws))
        path = kits.file(kid, version, name) if ok else None
        if path is None:
            return Response(status_code=404)
        return Response(path.read_bytes(), media_type="text/plain; charset=utf-8",
                        headers={"Cache-Control": "private, max-age=31536000, immutable",
                                 "Content-Security-Policy": "default-src 'none'; sandbox"})

    @app.post("/api/kits/{kid}/submit")
    def submit_kit(kid: str, ws=Depends(current)):
        """Ask for the newest version to be made public (the site's owner reviews it first)."""
        need_accounts()
        throttle(ws, "upload")
        if kits_allowed(ws):
            raise Refused(kits_allowed(ws), 403)
        kits.submit(ws.owner_key, kid)
        return kits_listing(ws)

    @app.get("/api/kits-gallery")
    def kit_gallery(q: str = "", ws=Depends(current)):
        """Approved customizations anyone can look at (adding them takes an account). The reviewer also
        sees the ones waiting for review, and each one's review; what waits for them comes first."""
        if not accounts:
            return {"kits": [], "can_add": False, "why": ""}
        admin = is_admin(ws)
        found = kits.gallery(q, waiting=admin)
        reviews = {k["id"]: kits.review(k["id"]) for k in found} if admin else {}
        if admin:  # what waits for the reviewer first (the sort is stable: the gallery's order stays within each)
            found.sort(key=lambda k: not (reviews[k["id"]]["version"] or reviews[k["id"]]["reports"]))
        listed = [public_view(k, ws) | ({"review": reviews[k["id"]]} if admin else {}) for k in found[:200]]
        return {"kits": listed, "can_add": not kits_allowed(ws), "why": kits_allowed(ws)}

    @app.post("/api/kits/{kid}/library")
    def kit_library(kid: str, body: dict = Body(...), ws=Depends(current)):
        """Add a gallery customization to the visitor's library (or remove it): it joins the editor's Custom groups."""
        need_accounts()
        throttle(ws, "op")
        add = bool(body.get("add", True))
        if add and kits_allowed(ws):
            raise Refused(kits_allowed(ws), 401 if "Sign in" in kits_allowed(ws) else 403)
        kits.set_library(ws.owner_key, kid, add)
        return kits_listing(ws)

    @app.post("/api/kits/{kid}/report")
    def report_kit(kid: str, body: dict = Body(...), ws=Depends(current)):
        """Tell the site's owner something is wrong with a public customization."""
        need_accounts()
        if not ws.user:
            raise Refused("Sign in to report a customization.", 401)
        throttle(ws, "upload")
        kits.report(ws.owner_key, kid, str(body.get("reason") or ""))
        return {"ok": True}

    def need_admin(ws) -> None:
        need_accounts()
        if not is_admin(ws):
            raise Refused("Only the site's owner reviews customizations.", 403)

    def review_queue() -> dict:
        return {"pending": kits.pending(), "reports": kits.reports()}

    @app.get("/api/admin/kits")
    def kit_review(ws=Depends(current)):
        """What waits for the reviewer: versions asking to be public, and reports about public ones."""
        need_admin(ws)
        return review_queue()

    @app.post("/api/admin/kits/{kid}/{version}/decide")
    def kit_decide(kid: str, version: int, body: dict = Body(...), ws=Depends(current)):
        need_admin(ws)
        action = body.get("action")
        if action not in ("approve", "reject"):
            raise Refused("Approve or reject.", 400)
        kits.decide(kid, version, action == "approve", str(body.get("reason") or ""))
        return review_queue()

    @app.post("/api/admin/kits/{kid}/take_down")
    def kit_take_down(kid: str, body: dict = Body(...), ws=Depends(current)):
        """Stop a customization everywhere (its code no longer runs; projects show its objects as unavailable)."""
        need_admin(ws)
        kits.take_down(kid, str(body.get("reason") or ""))
        return review_queue()

    @app.post("/api/admin/kits/{kid}/dismiss")
    def kit_dismiss(kid: str, ws=Depends(current)):
        """The reports about a customization were looked at and nothing needs doing."""
        need_admin(ws)
        kits.dismiss_reports(kid)
        return review_queue()

    @app.post("/api/renders")
    async def keep_render(request: Request, project: str = "", scene: str = "", hash: str = "", ext: str = "mp4",  # noqa: A002
                          ws=Depends(current)):
        """A scene rendered in the browser, kept for presentations ("Stored"). Only for the scene as it is now."""
        need_account(ws)
        throttle(ws, "upload")
        current_project = ws.read_project(project)
        sc = current_project.scene(scene)
        if sc is None:
            raise Refused("That scene doesn't exist any more.", 404)
        if plan_hash(scene_plan(sc, current_project), current_project.settings.quality) != hash:
            raise Refused("That scene changed while it was rendering. Start the presentation again.", 409)
        replaces = ws.replaced_render_bytes(project, sc.id)  # a new render of the scene takes the old one's place
        tmp, _digest = await stream_to_file(request, ws, MAX_RENDER_BYTES, "video", replaces)
        try:
            name = await run_in_threadpool(ws.keep_render, project, sc.id, hash, ext, tmp)
        finally:
            tmp.unlink(missing_ok=True)
        return {"url": f"/api/renders/{name}"}

    @app.get("/api/renders/{name}")
    def get_render(name: str, ws=Depends(current)):
        path = ws.render_path(name)
        if path is None:
            return Response(status_code=404)
        kind = "video/webm" if path.suffix == ".webm" else "video/mp4"
        return FileResponse(path, media_type=kind, headers={"Cache-Control": "private, max-age=31536000, immutable"})

    return app
