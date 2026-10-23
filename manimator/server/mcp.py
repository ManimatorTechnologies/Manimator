"""Manimator as an MCP App: an assistant such as Claude explains things with animations that play inside the chat.

Two remote MCP servers (Streamable HTTP, stateless, JSON responses). Tool names are PascalCase, as the owner likes
them shown in the chat.
- The Guest MCP, /mcp: nobody signs in and nothing is kept.
  - ReadMe: the scene format (McpScene.guide()), read once before the first animation;
  - ShowAnimation: the assistant's scene, checked like editor edits (McpScene.build_project) and turned into the
    scene plan the browser engine plays. Its result carries the plan for the player (structuredContent), and a
    short text for the assistant.
- The User MCP, /mcp/user (only with accounts, which an add-on brings: server/addon.py): acts for one Manimator
  account, signed in with OAuth (a call without a valid token gets 401 pointing at the metadata). The same two
  tools, plus
  - CreateProject: one or more scenes saved as a project in the account (and the first one played);
  - ListProjects: the account's projects.
ShowAnimation and CreateProject name a UI resource (MCP Apps, io.modelcontextprotocol/ui): web/mcp/player.html,
which the chat shows in a sandboxed frame. It loads the engine from this site (hence the CSP domains below and
the CORS header on /static/) and plays the plan.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from ..model import ops
from ..model.project import Project
from ..plan import scene_plan
from .McpPreview import layout_problems, preview
from ..registry import MOBJECTS
from ..registry.custom import KIT_TYPE_RE, is_kit_type
from .McpScene import (
    GUEST, MAX_SCENES, KitAccess, Rules, SceneSpecError, build_project, build_saved_project, guide, kit_clash,
    scene_spec,
)
from .session import OpError
from .renderer import Renderer, RenderUnavailable
from .web import Bucket, TooFast

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
APP_MIME = "text/html;profile=mcp-app"
MAX_BODY = 1024 * 1024
MAX_KIT_CODE = 1024 * 1024  # customizations' code sent with one clip (server/kits.py)
PLAYER_FILE = Path(__file__).resolve().parent.parent / "web" / "mcp" / "player.html"
VERSION = "1.0.0"

INSTRUCTIONS = (
    "Manimator explains with short Manim animations inline in the chat (math, geometry, graphs, physics, algorithms, "
    "linear algebra, 3D shapes). Each ShowAnimation call carries the part of your explanation it illustrates, in "
    "\"text\" (Markdown, $...$ for math): the user reads that text with the clip right under it. So a complex topic "
    "is a series of ShowAnimation calls, each one paragraph or a few of the real explanation followed by its clip; "
    "after the last clip, write in your reply only what's left (a short wrap-up), without repeating the clips' text. "
    "Call ReadMe once first, and check each scene with PreviewAnimation. Weigh the topic: a simple idea needs one "
    "short clip or none."
)
USER_INSTRUCTIONS = (
    "Manimator plays Manim animations inline in the chat and keeps them as projects in the user's Manimator account. "
    "Call ReadMe once to learn the scene format and how to pace an explanation. Check each scene with "
    "PreviewAnimation, which shows you its frames. ShowAnimation shows a quick clip under the part of your explanation "
    "it illustrates (its \"text\"), so text and clips alternate. CreateProject saves scenes as a project the user can open and edit; "
    "ListProjects lists them; GetProject reads one as it is now (the user may have changed it in Manimator); "
    "UpdateScene, AddScene and DeleteScene change it."
)
READ_ME, SHOW_ANIMATION, PREVIEW_ANIMATION = "ReadMe", "ShowAnimation", "PreviewAnimation"
CREATE_PROJECT, LIST_PROJECTS, GET_PROJECT = "CreateProject", "ListProjects", "GetProject"
UPDATE_SCENE, ADD_SCENE, DELETE_SCENE = "UpdateScene", "AddScene", "DeleteScene"
OLD_NAMES = {"read_me": READ_ME, "show_animation": SHOW_ANIMATION}  # before 2026-10-15; chats begun then still call them
GUEST_PATH, USER_PATH = "/mcp", "/mcp/user"
USER_METADATA_PATH = "/.well-known/oauth-protected-resource" + USER_PATH  # RFC 9728: the resource's path appended
# The User MCP's sign-in: an OAuth server at <site>/oauth (an add-on's, see server/addon.py) gives tokens for this scope
ISSUER_PATH, SCOPE = "/oauth", "projects"
TAB_NAME = ("The scene's tab name in Manimator: one or two short PascalCase words, no numbers or spaces (e.g. Theorem, "
            "Squares, Proof)")
PROJECT_REF = {"type": "string", "description": "The project's id (shown by ListProjects and CreateProject) or its "
                                                "exact name"}
SCENE_REF = {"type": "string", "description": "A scene of the project: its name (the tab) or its number (1 = first)"}


def _scene_schema() -> dict:
    named = {"type": "string", "description": "Name of an object"}
    animation = {
        "type": "object",
        "properties": {
            "anim": {"type": "string", "description": "Animation name (Create, Write, FadeIn, Transform, Animate, ...)"},
            "target": {**named, "description": "The object to animate (scene actions have none)"},
            "method": {"type": "string", "description": "For anim \"Animate\": the method to animate (shift, ...)"},
            "params": {"type": "object", "description": "The animation's settings (or the method's arguments)"},
        },
        "required": ["anim"],
    }
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "A short name for the animation"},
            "scene": {"type": "string", "description": "Scene type (default \"Scene\"; see ReadMe)"},
            "scene_options": {"type": "object", "description": "The scene type's options"},
            "background": {"type": "string", "description": "Background color (default black)"},
            "objects": {
                "type": "array",
                "description": "Everything in the scene, each with a unique name",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "type": {"type": "string", "description": "Object type (Circle, MathTex, Axes, ...)"},
                        "params": {"type": "object", "description": "The type's settings"},
                        "style": {"type": "object", "description": "Colors, widths, opacity"},
                        "position": {"type": "array", "items": {"type": "number"}, "description": "[x, y] of the center"},
                        "rotation": {"type": "number"},
                        "scale": {"type": "number"},
                        "z_index": {"type": "integer"},
                        "z": {"type": "number"},
                        "methods": {"type": "array", "items": {
                            "type": "object",
                            "properties": {"method": {"type": "string"}, "args": {"type": "object"}},
                            "required": ["method"]}},
                        "on_screen_at_start": {"type": "boolean"},
                        "fixed": {"type": "string"},
                        "transform_role": {"type": "string"},
                    },
                    "required": ["type"],
                },
            },
            "steps": {
                "type": "array",
                "description": "What happens, in order: {\"play\": [animations]} or {\"wait\": seconds}",
                "items": {
                    "type": "object",
                    "properties": {
                        "play": {"type": "array", "items": animation},
                        "wait": {"type": "number"},
                        "run_time": {"type": "number"},
                        "rate_func": {"type": "string"},
                        "lag_ratio": {"type": "number"},
                    },
                },
            },
        },
        "required": ["objects", "steps"],
    }


def _saved_scene_schema() -> dict:
    """A scene for a project: as ShowAnimation's, its title being the tab name."""
    scene = _scene_schema()
    scene["description"] = "A scene, written exactly like ShowAnimation's input"
    scene["properties"] = {**scene["properties"], "title": {"type": "string", "description": TAB_NAME}}
    return scene


CLIP_TEXT = ("The part of your explanation this clip illustrates: one paragraph or a few, in Markdown (**bold**, "
             "*italic*, lists, ### headings, $...$ and $$...$$ for math). The user reads it in the chat with the clip "
             "right under it, so write it as the real explanation, the way you would write your reply. Text and clips "
             "alternate: the next idea's text goes in the next clip's \"text\".")
MAX_CLIP_TEXT = 6000


def _show_schema() -> dict:
    schema = _scene_schema()
    schema["properties"] = {"text": {"type": "string", "description": CLIP_TEXT}, **schema["properties"]}
    schema["required"] = ["text", *schema.get("required", [])]
    return schema


def _preview_schema() -> dict:
    schema = _scene_schema()
    schema["properties"] = {**schema["properties"], "times": {
        "type": "array", "items": {"type": "number"}, "maxItems": 8,
        "description": "Seconds to look at (default: the end of each animation step)"}}
    return schema


def _project_schema() -> dict:
    scene = _saved_scene_schema()
    return {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "The project's name, as the user will see it in Manimator"},
            "scenes": {"type": "array", "items": scene, "minItems": 1, "maxItems": MAX_SCENES,
                       "description": "The project's scenes, in order"},
        },
        "required": ["name", "scenes"],
    }


def _usable(ws) -> list:
    """The customizations (server/kits.py specs) this account may add now, as the editor's palette lists them."""
    if ws.kits is None or ws.plan.kits <= 0:
        return []
    return ws.kits.usable(ws.owner_key)


class McpServer:
    """The JSON-RPC side, independent of HTTP. `site` is where the player loads the engine from. With `user`, it is
    the User MCP: each call comes with the account it acts for (`ctx`: {"user", "workspace", "app"}). `renderer`
    draws frames for PreviewAnimation and the layout checks (None: previews aren't offered)."""

    def __init__(self, bucket: Bucket | None = None, user: bool = False, renderer: Renderer | None = None,
                 limits: str = ""):
        self.bucket = bucket or Bucket(rate=10, burst=60)  # shared by everyone: Claude's servers make the calls
        self.previews = Bucket(rate=1, burst=10)  # drawing frames is the costly part
        self.user = user
        self.limits = limits  # each plan's projects, for the guide ("Free 3, Pro 30")
        self.renderer = renderer
        self._player: tuple[float, str] | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ the player page
    def player_html(self, site: str) -> str:
        with self._lock:
            mtime = PLAYER_FILE.stat().st_mtime
            if self._player is None or self._player[0] != mtime:
                self._player = (mtime, PLAYER_FILE.read_text(encoding="utf-8"))
            html = self._player[1]
        return html.replace("__MANIMATOR_SITE__", site)

    def player_uri(self, site: str) -> str:
        """Changes when the page does, so a host that keeps resources by address fetches the new one."""
        digest = hashlib.sha256(self.player_html(site).encode()).hexdigest()[:10]
        return f"ui://manimator/player-{digest}.html"

    def tools(self, site: str) -> list[dict]:
        uri = self.player_uri(site)
        quiet = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
        ui = {"ui": {"resourceUri": uri}, "ui/resourceUri": uri}
        changes = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False}
        tools = [
            {
                "name": READ_ME,
                "title": "Manimator guide",
                "description": "Returns the scene format for ShowAnimation" + (" and the project tools" if self.user
                                                                              else "")
                               + ": how objects and steps are written, every object type, animation, method and scene "
                               "type with their settings" + (", the user's own custom objects and animations"
                                                             if self.user else "")
                               + ", how to lay a scene out, and how to pace an explanation (one "
                               "clip or several). Call it once before your first animation in a conversation.",
                "inputSchema": {"type": "object", "properties": {}},
                "annotations": quiet,
            },
            {
                "name": SHOW_ANIMATION,
                "title": "Show animation",
                "description": "Shows part of your explanation in the chat: its \"text\" (Markdown, $...$ for math) with "
                               "a short Manim animation right under it that the user can pause, scrub and replay. "
                               "Use it to explain math, geometry, graphs, physics, algorithms and other ideas: a "
                               "complex topic is several calls in order, each with the paragraph(s) it illustrates "
                               "and its clip; a simple idea needs one or none. After the last clip, write only a short "
                               "wrap-up in your reply. Describe the scene as named objects plus steps that animate "
                               "them, in Manimator's format: call ReadMe first, and check the scene with "
                               "PreviewAnimation. Problems in the scene come back as a list to fix.",
                "inputSchema": _show_schema(),
                "annotations": quiet,
                "_meta": ui,
            },
        ]
        if self.renderer is not None:
            tools.append({
                "name": PREVIEW_ANIMATION,
                "title": "Preview animation",
                "description": "Draws frames of a scene (the same input as ShowAnimation) and returns them to you as "
                               "pictures, with a layout check: objects outside the picture, text over text, text too "
                               "small, and where every object is. The user sees nothing. Use it before ShowAnimation"
                               + (", CreateProject, UpdateScene or AddScene" if self.user else "")
                               + ": look at the frames, fix what is crowded, overlapping, cut off or unbalanced, and "
                               "preview again until it looks right. Optional \"times\": seconds to look at instead "
                               "of the end of each step (at most 8).",
                "inputSchema": _preview_schema(),
                "annotations": quiet,
            })
        if not self.user:
            return tools
        return tools + [
            {
                "name": CREATE_PROJECT,
                "title": "Create Manimator project",
                "description": "Saves one or more scenes as a new project in the user's Manimator account, where they "
                               "can open and edit it, and plays the first scene inline. Each scene is written exactly "
                               "like ShowAnimation's input (call ReadMe first); its title becomes the scene's tab name, "
                               "so use one or two short PascalCase words (Theorem, Proof). Returns a link that opens "
                               "the project. "
                               "Use it when the user wants to keep, save or edit an animation in Manimator.",
                "inputSchema": _project_schema(),
                "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False,
                                "openWorldHint": False},
                "_meta": ui,
            },
            {
                "name": LIST_PROJECTS,
                "title": "List Manimator projects",
                "description": "Lists the projects in the user's Manimator account (name, id, size, last edit, link) "
                               "and how many more their plan can keep.",
                "inputSchema": {"type": "object", "properties": {}},
                "annotations": quiet,
            },
            {
                "name": GET_PROJECT,
                "title": "Get Manimator project",
                "description": "Reads a project from the user's account as it is now, including changes they made in "
                               "Manimator: each scene in ShowAnimation's format (custom objects and animations "
                               "included), ready to change and send back with UpdateScene. Read it before changing a "
                               "project.",
                "inputSchema": {"type": "object", "properties": {"project": PROJECT_REF}, "required": ["project"]},
                "annotations": quiet,
            },
            {
                "name": UPDATE_SCENE,
                "title": "Update scene",
                "description": "Replaces one scene of a saved project with a new version (the whole scene, in "
                               "ShowAnimation's format: usually GetProject's, changed) and plays it inline. The user "
                               "can undo it in Manimator. Its title renames the scene (one or two short PascalCase "
                               "words); leave the title as it was to keep the name.",
                "inputSchema": {"type": "object", "properties": {
                    "project": PROJECT_REF, "scene": SCENE_REF,
                    "replace_with": {**_saved_scene_schema(), "description": "The scene's new version, complete"}},
                    "required": ["project", "scene", "replace_with"]},
                "annotations": changes,
                "_meta": ui,
            },
            {
                "name": ADD_SCENE,
                "title": "Add scene",
                "description": "Adds a scene (ShowAnimation's format; its title is the tab name, one or two short "
                               "PascalCase words) to a saved project, at the end or after a given scene, and plays it "
                               "inline. The user can undo it in Manimator.",
                "inputSchema": {"type": "object", "properties": {
                    "project": PROJECT_REF, "new_scene": _saved_scene_schema(),
                    "after": {**SCENE_REF, "description": "Put it after this scene (default: at the end)"}},
                    "required": ["project", "new_scene"]},
                "annotations": changes,
                "_meta": ui,
            },
            {
                "name": DELETE_SCENE,
                "title": "Delete scene",
                "description": "Deletes a scene from a saved project (not its last one). The user can undo it in "
                               "Manimator. Only when the user asks for it.",
                "inputSchema": {"type": "object", "properties": {"project": PROJECT_REF, "scene": SCENE_REF},
                                "required": ["project", "scene"]},
                "annotations": {**changes, "destructiveHint": True},
            },
        ]

    def resource(self, site: str) -> dict:
        return {
            "uri": self.player_uri(site),
            "name": "Manimator player",
            "description": "Plays a Manimator scene with the browser engine",
            "mimeType": APP_MIME,
        }

    def read_resource(self, uri: str, site: str) -> dict:
        if not re.fullmatch(r"ui://manimator/player(-[0-9a-f]{1,64})?\.html", uri or ""):
            raise _RpcError(-32002, f"Resource not found: {uri}")
        # frameDomains: scenes with customizations play in the site's sandbox page, framed inside the player
        meta = {"ui": {"csp": {"resourceDomains": [site], "connectDomains": [site], "frameDomains": [site]},
                       "prefersBorder": False}}
        # Any version of the address gets today's page: an old conversation shown again still plays.
        return {"contents": [{"uri": uri, "mimeType": APP_MIME, "text": self.player_html(site), "_meta": meta}]}

    # ------------------------------------------------------------------ tools
    def call_tool(self, name: str, args: dict, ctx: dict | None = None, site: str = "") -> dict:
        name = OLD_NAMES.get(name, name)
        if name == READ_ME:
            kits = _usable(ctx["workspace"]) if self.user and ctx else []
            return {"content": [{"type": "text", "text": guide(user=self.user, kits=kits, limits=self.limits)}]}
        if name == SHOW_ANIMATION:
            return self.show_animation(args, ctx)
        if name == PREVIEW_ANIMATION and self.renderer is not None:
            return self.preview_animation(args, ctx)
        if self.user:
            handler = {CREATE_PROJECT: self.create_project, LIST_PROJECTS: self.list_projects,
                       GET_PROJECT: self.get_project, UPDATE_SCENE: self.update_scene, ADD_SCENE: self.add_scene,
                       DELETE_SCENE: self.delete_scene}.get(name)
            if handler is not None:
                try:
                    ctx["workspace"].take("op")
                except TooFast:
                    return _tool_error("That's a lot of changes at once. Wait a moment, then try again.")
                return handler(args, ctx, site)
        raise _RpcError(-32602, f"Unknown tool: {name}")

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _broken(project) -> tuple[list[dict], list[str]]:
        """Each scene's plan, and the objects that can't be built (named with their scene when there are several)."""
        plans, broken = [], []
        for scene in project.scenes:
            plan = scene_plan(scene, project)
            plans.append(plan)
            where = f"{scene.name}." if len(project.scenes) > 1 else ""
            broken += [f"{where}{o['var']}: {o['error']}" for o in plan["objects"] if o.get("error") and not _gone(o)]
        return plans, broken

    @staticmethod
    def _refuse_broken(scene, project) -> None:
        """A scene with objects that can't be built isn't saved (as ShowAnimation and CreateProject refuse it)."""
        broken = [f"{o['var']}: {o['error']}" for o in scene_plan(scene, project)["objects"]
                  if o.get("error") and not _gone(o)]
        if broken:
            raise OpError("some objects can't be built:\n- " + "\n- ".join(broken))

    @staticmethod
    def _rules(ctx: dict | None, project=None, scene=None) -> Rules:
        """What a scene may hold: an account gets the editor's limits, may keep files it uploaded, and may use its
        customizations as the editor allows them; those already in `scene` (the one being replaced) stay, and a class
        name means the version `project` already uses."""
        if not ctx:
            return GUEST
        ws = ctx["workspace"]
        kits = None
        if ws.kits is not None:
            # a version the project uses already stays usable in it; anything new takes the newest
            into = project if project is not None else Project(scenes=[])
            kits = KitAccess(check=lambda key: ws.check_kit(key, into),
                             usable={s.kit["class"]: s.key for s in reversed(_usable(ws))},
                             keep=frozenset(ops.kit_types_in(Project(scenes=[scene]))) if scene else frozenset(),
                             prefer=frozenset(ops.kit_types_in(project)) if project else frozenset())
        return Rules(max_objects=ws.cfg.limits.max_objects, max_steps=ws.cfg.limits.max_steps, assets=ws.check_asset,
                     kits=kits)

    @staticmethod
    def _kit_code(plan: dict, ctx: dict | None) -> dict:
        """kit.js of each customization the plan uses (type -> text), for the player's sandbox: it can't fetch them
        (no cookies). Only versions this account may read, at most MAX_KIT_CODE in all. A version's code comes once,
        under its first type: its other types (an object's animations) share it (the plan's js_sha256 says so)."""
        ws = ctx["workspace"] if ctx else None
        out, total, sent = {}, 0, set()
        for kit in plan.get("kits") or []:
            m = KIT_TYPE_RE.match(kit.get("type") or "")
            if ws is None or ws.kits is None or m is None:
                continue
            kid, version = m.group(1), int(m.group(2))
            if (kid, version) in sent:
                continue
            sent.add((kid, version))
            path = ws.kits.file(kid, version, "kit.js") if ws.kits.readable(ws.owner_key, kid, version) else None
            if path is None:
                continue
            text = path.read_text(encoding="utf-8")
            total += len(text)
            if total > MAX_KIT_CODE:
                break
            out[kit["type"]] = text
        return out

    def _kits_for(self, plan: dict, ctx: dict | None) -> dict:
        """The player's share of a result whose plan uses customizations: their code, by type."""
        return {"kits": self._kit_code(plan, ctx)} if plan.get("kits") else {}

    @staticmethod
    def _kit_note(plan: dict) -> str:
        """What the assistant should know when a clip plays customizations."""
        names = [k["class"] for k in plan.get("kits") or []]
        if not names:
            return ""
        return (f" It uses customizations ({', '.join(names)}): the player runs their code to play them; if one "
                "fails to load, the player says so.")

    @staticmethod
    def _owner(ctx: dict | None) -> str:
        return ctx["workspace"].id if ctx else ""

    def _check(self, scene, plan, ctx) -> str:
        """The layout checks, as a paragraph for a tool's answer ("" when they found nothing)."""
        problems = layout_problems(self.renderer if self.previews.take() else None, scene, plan, self._owner(ctx))
        if not problems:
            return ""
        return ("\n\nThe layout check found problems in what the user is seeing:\n- " + "\n- ".join(problems)
                + "\nPreview the scene to look at it, and fix what matters.")

    @staticmethod
    def _spec_problems(e: SceneSpecError, what: str, nothing: str) -> dict:
        n = len(e.problems)
        return _tool_error(f"The {what} has {n} problem{'s' if n > 1 else ''} to fix ({nothing}):\n- "
                           + "\n- ".join(e.problems))

    # ------------------------------------------------------------------ both MCPs
    def show_animation(self, spec: dict, ctx: dict | None = None) -> dict:
        if not self.bucket.take():
            return _tool_error("Manimator is busy right now. Try again in a few seconds.")
        try:
            project = build_project(spec, self._rules(ctx))
        except SceneSpecError as e:
            return self._spec_problems(e, "scene", "nothing was shown")
        scene = project.scenes[0]
        (plan,), broken = self._broken(project)
        if broken:
            return _tool_error("Some objects can't be built (nothing was shown):\n- " + "\n- ".join(broken))
        title = str(spec.get("title") or "").strip()[:120] or "Animation"
        text = str(spec.get("text") or "").strip()[:MAX_CLIP_TEXT]
        plays = sum(1 for s in scene.steps if s.kind == "play")
        summary = (f"Showing \"{title}\" to the user inline: {plan['duration']:g} s, {len(scene.mobjects)} object"
                   f"{'s' if len(scene.mobjects) != 1 else ''}, {plays} animation step{'s' if plays != 1 else ''}, "
                   + ("under its text. " if text else "with no text above it (put the explanation in \"text\"). ")
                   + "Next: the following part of the explanation with its clip (another ShowAnimation), or, after "
                   "the last clip, a short wrap-up in your reply that doesn't repeat the clips' text.")
        return {
            "content": [{"type": "text", "text": summary + self._kit_note(plan) + self._check(scene, plan, ctx)}],
            "structuredContent": {"title": title, "duration": plan["duration"], "plan": plan, "text": text,
                                  **self._kits_for(plan, ctx)},
        }

    def preview_animation(self, args: dict, ctx: dict | None = None) -> dict:
        if not self.previews.take():
            return _tool_error("Previews are busy right now. Try again in a few seconds.")
        spec = {k: v for k, v in args.items() if k != "times"}
        times = args.get("times")
        if times is not None and (not isinstance(times, list)
                                  or not all(isinstance(t, (int, float)) and not isinstance(t, bool) for t in times)):
            return _tool_error("times: expected a list of seconds, like [1.5, 4]")
        try:
            project = build_project(spec, self._rules(ctx))
        except SceneSpecError as e:
            return self._spec_problems(e, "scene", "fix these first")
        (plan,), broken = self._broken(project)
        if broken:
            return _tool_error("Some objects can't be built:\n- " + "\n- ".join(broken))
        title = str(spec.get("title") or "").strip()[:120] or "Animation"
        try:
            content = preview(self.renderer, project.scenes[0], plan, title, times, self._owner(ctx))
        except RenderUnavailable:
            return _tool_error("The preview couldn't be drawn just now. Try again in a moment.")
        return {"content": content}

    # ------------------------------------------------------------------ the account (User MCP)
    def _project(self, ws, ref) -> tuple[str, dict]:
        """The account's project with this id, or this exact name (any case). Raises OpError listing them."""
        items = ws.list_projects()
        ref = str(ref or "").strip()
        for p in items:
            if p["id"] == ref:
                return p["id"], p
        named = [p for p in items if p["name"].casefold() == ref.casefold()]
        if len(named) == 1:
            return named[0]["id"], named[0]
        listing = "; ".join(f"{p['name']} (id {p['id']})" for p in items) or "none"
        if named:
            raise OpError(f"Several projects are named {ref!r}: use the id. Projects: {listing}")
        raise OpError(f"No project {ref!r} in this account. Projects: {listing}")

    @staticmethod
    def _scene_index(project, ref) -> int:
        """Which scene: its name (any case) or its number from 1."""
        text = str(ref if ref is not None else "").strip()
        if text.isdigit() and 1 <= int(text) <= len(project.scenes):
            return int(text) - 1
        for i, s in enumerate(project.scenes):
            if s.name.casefold() == text.casefold():
                return i
        names = ", ".join(f"{i + 1} {s.name}" for i, s in enumerate(project.scenes))
        raise OpError(f"No scene {text!r} in this project. Its scenes: {names}")

    def _saved(self, project, scene, pid: str, site: str, text: str, ctx: dict) -> dict:
        """The answer for a scene just saved: it plays in the chat, with the project's link."""
        plan = scene_plan(scene, project)
        url = f"{site}/app?project={pid}"
        gone = [m.name for m in scene.mobjects if is_kit_type(m.type) and MOBJECTS[m.type].blocked]
        if gone:
            text += (f" {', '.join(gone)}: {'its' if len(gone) == 1 else 'their'} customization isn't available any "
                     "more, so it stays in the scene but draws nothing (remove it if it isn't wanted).")
        return {
            "content": [{"type": "text", "text": f"{text}{self._kit_note(plan)} Link to the project: {url}"
                                                 + self._check(scene, plan, ctx)}],
            "structuredContent": {"title": scene.name, "duration": plan["duration"], "plan": plan, "open_url": url,
                                  **self._kits_for(plan, ctx)},
        }

    def create_project(self, spec: dict, ctx: dict, site: str) -> dict:
        if not self.bucket.take():
            return _tool_error("Manimator is busy right now. Try again in a few seconds.")
        try:
            project, name = build_saved_project(spec, self._rules(ctx))
        except SceneSpecError as e:
            return self._spec_problems(e, "project", "nothing was saved")
        plans, broken = self._broken(project)
        if broken:
            return _tool_error("Some objects can't be built (nothing was saved):\n- " + "\n- ".join(broken))
        ws = ctx["workspace"]
        try:
            pid = ws.add_project(project, name)
        except OpError as e:
            return _tool_error(f"Nothing was saved: {e}")
        url = f"{site}/app?project={pid}"
        n = len(project.scenes)
        checks = "".join(self._check(s, p, ctx).replace("\n\nThe layout check", f"\n\n{s.name}: the layout check")
                         for s, p in zip(project.scenes, plans))
        text = (f"Saved \"{ws.clean_name(name)}\" (id {pid}) in the user's Manimator account ({n} scene"
                f"{'s' if n != 1 else ''}, {sum(p['duration'] for p in plans):g} s in all). Its first scene plays here. "
                f"Give the user this link to open and edit it in Manimator: {url}")
        return {
            "content": [{"type": "text", "text": text + self._kit_note(plans[0]) + checks}],
            "structuredContent": {"title": name, "duration": plans[0]["duration"], "plan": plans[0], "open_url": url,
                                  **self._kits_for(plans[0], ctx)},
        }

    def list_projects(self, args: dict, ctx: dict, site: str) -> dict:
        ws = ctx["workspace"]
        items = ws.list_projects()
        plan = ws.plan
        lines = [f"{len(items)} of {plan.projects} project{'s' if plan.projects != 1 else ''} used "
                 f"({plan.label} plan)."]
        for p in items:
            when = time.strftime("%Y-%m-%d", time.gmtime(p.get("modified") or p.get("created") or 0))
            size = "can't be read" if p.get("broken") else \
                f"{p['scenes']} scene{'s' if p['scenes'] != 1 else ''}, {p['objects']} object{'s' if p['objects'] != 1 else ''}"
            lines.append(f"- {p['name']} (id {p['id']}): {size}, last edited {when}. {site}/app?project={p['id']}")
        return {"content": [{"type": "text", "text": "\n".join(lines)}]}

    def get_project(self, args: dict, ctx: dict, site: str) -> dict:
        ws = ctx["workspace"]
        try:
            pid, entry = self._project(ws, args.get("project"))
            project = ws.read_project(pid)
        except OpError as e:
            return _tool_error(str(e))
        lines = [f"Project \"{entry['name']}\" (id {pid}), as it is now: {site}/app?project={pid}"]
        for i, scene in enumerate(project.scenes, 1):
            lines.append(f"Scene {i}: {scene.name}, {len(scene.mobjects)} objects, {len(scene.steps)} steps")
        background = project.settings.background
        lines += ["", "Each scene in ShowAnimation's format (the project's background is "
                  f"{background}; settings at their defaults are left out). To change one, send it back whole, "
                  "changed, with UpdateScene; AddScene adds one, DeleteScene removes one.", ""]
        used = ops.kit_types_in(project)
        if used:
            def kit(key):
                spec = ops.kit_spec(key)
                if spec is None or spec.blocked:
                    return f"{key} (isn't available any more: it stays, drawing nothing)"
                return f"{key} = {spec.kit['class']} (custom {spec.kit['kind']})"
            lines += ["It uses customizations (the user's custom objects and animations; keep their types as they "
                      "are): " + "; ".join(kit(k) for k in used) + ".", ""]
        lines += [json.dumps(scene_spec(s), ensure_ascii=False, separators=(",", ":")) for s in project.scenes]
        return {"content": [{"type": "text", "text": "\n".join(lines)}]}

    def update_scene(self, args: dict, ctx: dict, site: str) -> dict:
        ws, app = ctx["workspace"], ctx.get("app") or "AI"
        spec = args.get("replace_with")
        try:
            pid, _entry = self._project(ws, args.get("project"))

            def change(project):
                i = self._scene_index(project, args.get("scene"))
                built = build_project(spec, self._rules(ctx, project, project.scenes[i]))
                new, old = built.scenes[0], project.scenes[i]
                new.id = old.id
                title = spec.get("title") if isinstance(spec, dict) else None
                new.name = old.name if not title or title == old.name else \
                    ops.unique_scene_name(project, new.name, exclude_id=old.id)
                project.scenes[i] = new
                if isinstance(spec, dict) and spec.get("background") is not None:
                    project.settings.background = built.settings.background
                self._refuse_broken(new, project)
                if kit_clash(project):
                    raise OpError(kit_clash(project))
                return old.name, new

            project, (old_name, scene) = ws.edit_project(pid, change, f"{app}: change {args.get('scene')}")
        except SceneSpecError as e:
            return self._spec_problems(e, "scene", "nothing was changed")
        except OpError as e:
            return _tool_error(f"Nothing was changed: {e}")
        renamed = f" (now {scene.name})" if scene.name != old_name else ""
        return self._saved(project, scene, pid, site, f"Changed scene {old_name}{renamed}; it plays here. The user can "
                                                      "undo it in Manimator.", ctx)

    def add_scene(self, args: dict, ctx: dict, site: str) -> dict:
        ws, app = ctx["workspace"], ctx.get("app") or "AI"
        spec = args.get("new_scene")
        try:
            pid, _entry = self._project(ws, args.get("project"))

            def change(project):
                at = len(project.scenes)
                if args.get("after") not in (None, ""):
                    at = self._scene_index(project, args.get("after")) + 1
                built = build_project(spec, self._rules(ctx, project))
                scene = built.scenes[0]
                scene.name = ops.unique_scene_name(project, scene.name)
                project.scenes.insert(at, scene)
                if isinstance(spec, dict) and spec.get("background") is not None:
                    project.settings.background = built.settings.background
                self._refuse_broken(scene, project)
                if kit_clash(project):
                    raise OpError(kit_clash(project))
                return scene

            title = spec.get("title") if isinstance(spec, dict) else None
            project, scene = ws.edit_project(pid, change, f"{app}: add {title or 'a scene'}")
        except SceneSpecError as e:
            return self._spec_problems(e, "scene", "nothing was added")
        except OpError as e:
            return _tool_error(f"Nothing was added: {e}")
        number = project.scenes.index(scene) + 1
        return self._saved(project, scene, pid, site, f"Added scene {scene.name} as scene {number} of "
                                                      f"{len(project.scenes)}; it plays here.", ctx)

    def delete_scene(self, args: dict, ctx: dict, site: str) -> dict:
        ws, app = ctx["workspace"], ctx.get("app") or "AI"
        try:
            pid, _entry = self._project(ws, args.get("project"))

            def change(project):
                if len(project.scenes) <= 1:
                    raise OpError("a project needs at least one scene")
                return project.scenes.pop(self._scene_index(project, args.get("scene"))).name

            project, gone = ws.edit_project(pid, change, f"{app}: delete {args.get('scene')}")
        except OpError as e:
            return _tool_error(f"Nothing was deleted: {e}")
        rest = ", ".join(s.name for s in project.scenes)
        return {"content": [{"type": "text", "text": f"Deleted scene {gone}. The user can undo it in Manimator. "
                                                      f"Scenes now: {rest}. {site}/app?project={pid}"}]}

    # ------------------------------------------------------------------ JSON-RPC
    def handle(self, message, site: str, ctx: dict | None = None) -> dict | None:
        """One JSON-RPC message; None for a notification (or a response, which this server never asks for)."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return _error(None, -32600, "Invalid Request")
        method = message.get("method")
        mid = message.get("id")
        if not isinstance(method, str):
            return None  # a response to something we never sent
        if "id" not in message:
            return None  # notifications/initialized, notifications/cancelled, ...
        params = message.get("params") or {}
        try:
            result = self.dispatch(method, params if isinstance(params, dict) else {}, site, ctx)
        except _RpcError as e:
            return _error(mid, e.code, e.message)
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def dispatch(self, method: str, params: dict, site: str, ctx: dict | None = None):
        if method == "initialize":
            asked = params.get("protocolVersion")
            version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
            return {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}, "resources": {"listChanged": False},
                                 "extensions": {"io.modelcontextprotocol/ui": {}}},
                "serverInfo": {"name": "manimator-user" if self.user else "manimator",
                               "title": "Manimator" if self.user else "Manimator (Guest)", "version": VERSION,
                               "websiteUrl": site},
                "instructions": USER_INSTRUCTIONS if self.user else INSTRUCTIONS,
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": self.tools(site)}
        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            if not isinstance(args, dict):
                raise _RpcError(-32602, "arguments must be an object")
            return self.call_tool(str(name), args, ctx, site)
        if method == "resources/list":
            return {"resources": [self.resource(site)]}
        if method == "resources/templates/list":
            return {"resourceTemplates": []}
        if method == "resources/read":
            return self.read_resource(str(params.get("uri") or ""), site)
        if method == "prompts/list":
            return {"prompts": []}
        raise _RpcError(-32601, f"Method not found: {method}")


class _RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _gone(plan_object: dict) -> bool:
    """A custom object whose package isn't available any more (taken down): it can only be in a scene because it was
    there already, and it stays (as in the editor), drawing nothing."""
    kind = plan_object.get("type")
    return is_kit_type(kind) and MOBJECTS[kind].blocked


def _error(mid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def _tool_error(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": True}



# Browser-based MCP clients may call too: no cookies are used (the User MCP takes a bearer token), so any origin.
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate"}
PREFLIGHT = {**CORS, "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Max-Age": "86400",
             "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, "
                                             "Last-Event-ID"}


def site_of(request: Request, site_url: str) -> str:
    """This site's address as the caller sees it: its own (https behind the proxy) when reached under that name, else
    the address used (a server on this computer)."""
    if site_url and urlsplit(site_url).netloc.lower() == (request.headers.get("host") or "").lower():
        return site_url
    return str(request.base_url).rstrip("/")


def log_call(server: McpServer, message: dict, reply: dict | None, session: str | None, started: float) -> None:
    """One line per tool call in the server's log: which tool, which conversation (a short hash), how it went. No
    scene contents, no account."""
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    result = (reply or {}).get("result") or {}
    outcome = "error" if result.get("isError") or (reply or {}).get("error") else "ok"
    if params.get("name") == SHOW_ANIMATION and outcome == "ok":
        outcome += f" text={len((result.get('structuredContent') or {}).get('text') or '')}"
    tag = hashlib.sha256(session.encode()).hexdigest()[:6] if session else "------"
    print(f"mcp {'user' if server.user else 'guest'} {str(params.get('name'))[:32]} session={tag} "
          f"{(time.monotonic() - started) * 1000:.0f}ms {outcome}", flush=True)


def mount_mcp(app: FastAPI, site_url: str = "", account=None,
              renderer: Renderer | None = None, kits=None, limits: str = "") -> tuple[McpServer, McpServer | None]:
    """The Guest MCP at /mcp, and with `account` the User MCP at /mcp/user. `account(token)` gives the account a
    bearer token acts for ({"user", "workspace"}), or None. POST answers JSON-RPC; GET and DELETE get 405 (no event
    stream). initialize hands out an Mcp-Session-Id, used only to tell conversations apart in the log."""
    guest = McpServer(renderer=renderer)
    user = McpServer(bucket=guest.bucket, user=True, renderer=renderer, limits=limits) if account else None
    if user is not None:
        user.previews = guest.previews  # one budget for drawing frames

    def answer(body, status: int = 200, headers: dict | None = None) -> Response:
        if body is None:
            return Response(status_code=202, headers=CORS)
        return JSONResponse(body, status_code=status, headers={**CORS, **(headers or {})})

    async def serve(server: McpServer, request: Request, ctx: dict | None = None) -> Response:
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY:
                return answer(_error(None, -32600, "Request too large"), 413)
        try:
            message = json.loads(body)
        except ValueError:
            return answer(_error(None, -32700, "Parse error"), 400)
        here = site_of(request, site_url)
        # Sessions only tell conversations apart in the log (log_call): any id is accepted, none is required.
        session = (request.headers.get("mcp-session-id") or "")[:128] or None
        headers = {}
        if isinstance(message, dict) and message.get("method") == "initialize":
            session = secrets.token_urlsafe(18)
            headers["Mcp-Session-Id"] = session
        if session is None and ctx is not None:  # the User MCP: the account, when the client keeps no session
            session = "account:" + str((ctx.get("user") or {}).get("id") or "")
        if isinstance(message, list):  # a batch (protocol versions before 2025-06-18)
            answers = [a for a in [await run_in_threadpool(server.handle, m, here, ctx) for m in message[:20]] if a]
            return answer(answers or None, headers=headers)
        started = time.monotonic()
        reply = await run_in_threadpool(server.handle, message, here, ctx)
        if isinstance(message, dict) and message.get("method") == "tools/call":
            log_call(server, message, reply, session, started)
        return answer(reply, headers=headers)

    @app.get("/mcp/style")
    def host_style(request: Request):
        """The player reports which fonts and style variables the chat gives it (names and font values only), so its
        text can be matched to the chat's. Nothing about the conversation."""
        print("mcp host style: " + str(request.query_params.get("s") or "")[:900].replace("\n", " "), flush=True)
        return Response(status_code=204, headers=CORS)

    @app.get("/mcp/kit-js/{sha}.js")
    def kit_js(sha: str):
        """A customization's kit.js by its sha256 (KitStore.js_by_sha), for the chat player."""
        path = kits.js_by_sha(sha) if kits is not None and re.fullmatch(r"[0-9a-f]{64}", sha) else None
        if path is None:
            return Response(status_code=404, headers=CORS)
        return Response(path.read_bytes(), media_type="text/javascript",
                        headers={**CORS, "Cache-Control": "public, max-age=31536000, immutable",
                                 "X-Content-Type-Options": "nosniff"})

    @app.get("/mcp/kit-frame")
    def kit_frame(request: Request):
        """The player says whether a scene's customizations played: ok, or failed (blocked: the old player, whose
        nested sandbox frame the chat didn't allow). One log line, nothing about the conversation."""
        said = str(request.query_params.get("s") or "")[:16]
        print(f"mcp kit-frame {said if said in ('ok', 'failed', 'blocked') else '?'}", flush=True)
        return Response(status_code=204, headers=CORS)

    @app.post(GUEST_PATH)
    async def guest_post(request: Request):
        return await serve(guest, request)

    @app.options(GUEST_PATH)
    def guest_preflight():
        return Response(status_code=204, headers=PREFLIGHT)

    @app.api_route(GUEST_PATH, methods=["GET", "DELETE"])
    def guest_other():
        return Response(status_code=405, headers={"Allow": "POST", **CORS})

    if user is None:
        return guest, None

    def resource(request: Request) -> str:
        return site_of(request, site_url) + USER_PATH

    async def signed_in(request: Request):
        """The account the request acts for, or the 401 (or 503) to answer with."""
        header = request.headers.get("authorization") or ""
        token = header[7:].strip() if header[:7].lower() == "bearer " else ""
        try:
            ctx = await run_in_threadpool(account, token) if token else None
        except Exception:  # noqa: BLE001 - the server is full, or the account service unreachable
            return answer(_error(None, -32000, "Manimator is busy right now. Try again shortly."), 503)
        if ctx is not None:
            return ctx
        meta = site_of(request, site_url) + USER_METADATA_PATH
        challenge = f'Bearer resource_metadata="{meta}", scope="{SCOPE}"' + (', error="invalid_token"' if token else "")
        return answer({"error": "invalid_token" if token else "unauthorized",
                       "error_description": "Sign in to Manimator: connect again." if token else
                       "The User MCP acts for a Manimator account: connect with OAuth."},
                      401, {"WWW-Authenticate": challenge})

    @app.post(USER_PATH)
    async def user_post(request: Request):
        ctx = await signed_in(request)
        if isinstance(ctx, Response):
            return ctx
        return await serve(user, request, ctx)

    @app.options(USER_PATH)
    def user_preflight():
        return Response(status_code=204, headers=PREFLIGHT)

    @app.api_route(USER_PATH, methods=["GET", "DELETE"])
    async def user_other(request: Request):
        ctx = await signed_in(request)
        return ctx if isinstance(ctx, Response) else Response(status_code=405, headers={"Allow": "POST", **CORS})

    @app.get(USER_METADATA_PATH)
    def user_metadata(request: Request):
        """RFC 9728: what the User MCP is, and who signs people in to it (this site's OAuth server, at ISSUER_PATH)."""
        here = site_of(request, site_url)
        return answer({"resource": resource(request), "authorization_servers": [here + ISSUER_PATH],
                       "scopes_supported": [SCOPE],
                       "bearer_methods_supported": ["header"], "resource_name": "Manimator",
                       "resource_documentation": f"{here}/app"})

    return guest, user
