"""The scene plan: what the browser needs to build, show and play a scene.

It comes from the same call trees as the downloadable Python (codegen.scene_code), as JSON (calltree.py lists the
node forms). The browser runs the statements against its port of Manim (manimator/web/js/engine/), so it never
copies the rules worked out here: build order, which objects are drawn where, what each step plays, how long, and
what is on screen before each step.
"""

from __future__ import annotations

import hashlib
import json

from . import codegen
from .calltree import statements_json
from .CodeHighlight import highlight
from .model.ops import (
    group_owners, kit_spec, kit_types_in, screen_orders, screen_states, scene_kind, top_level, transform_role,
)
from .model.project import WAIT, Project, Scene
from .registry import MOBJECTS
from .registry.scenes import FIXED_IN_FRAME, FIXED_ORIENTATION, FOREGROUND, LINEAR

PLAN_VERSION = 1


def _family(scene: Scene, mob_id: str) -> set[str]:
    """The object and, for a group, everything in it."""
    result, todo = set(), [mob_id]
    while todo:
        i = todo.pop()
        if i in result:
            continue
        result.add(i)
        m = scene.mob(i)
        p = MOBJECTS[m.type].group_param if m is not None else None
        if p is not None and p.name == "members":
            todo += m.params.get("members") or []
    return result


def _draws_through_members(m) -> bool:
    """A VGroup or Group is drawn through its members."""
    p = MOBJECTS[m.type].group_param
    return p is not None and p.name == "members"


def layout(scene: Scene) -> dict:
    """How the editor draws the scene's starting layout: every object (bottom first), the ones that only appear
    later (drawn faded), and in a 3D scene the ones fixed to the frame or facing the camera."""
    owners = group_owners(scene)

    def shown(m) -> bool:  # members follow the group that holds them
        for _ in range(len(scene.mobjects)):
            owner = scene.mob(owners.get(m.id))
            if owner is None:
                break
            m = owner
        return m.on_screen_at_start

    order = [m.id for m in scene.mobjects if not _draws_through_members(m)]
    fixed: dict[str, str] = {}
    if scene_kind(scene).three_d:  # members are fixed along with their group
        for m in top_level(scene):
            if m.fixed in (FIXED_IN_FRAME, FIXED_ORIENTATION):
                for member in _family(scene, m.id):
                    fixed[member] = m.fixed
    if scene.kind == LINEAR:  # objects kept in front stay on top of the others
        front = set()
        for m in top_level(scene):
            if transform_role(m) == FOREGROUND:
                front |= _family(scene, m.id)
        order = [i for i in order if i not in front] + [i for i in order if i in front]
    fixed = {i: fixed[i] for i in sorted(fixed, key=scene.mob_index)}
    return {"order": order, "hidden": [m.id for m in scene.mobjects if not shown(m)], "fixed": fixed}


def _code_listing(item) -> dict | None:
    """Code objects: the listing's lines and colours (Pygments, the way Manim's Code applies them)."""
    params = {p.name: item.params.get(p.name, p.default) for p in MOBJECTS[item.type].params}
    try:
        return highlight(str(params["code"]), str(params["language"]), str(params["style"]))
    except Exception:  # noqa: BLE001 - an unknown language or style: the object reports an error instead
        return None


def scene_plan(scene: Scene, project: Project) -> dict:
    with codegen.asset_root("assets"):  # uploaded files become {"asset": name}
        sc = codegen.scene_code(scene, project)
    kind = scene_kind(scene)
    objects = []
    for c in sc.objects:
        item = scene.mob(c.mob_id)
        entry = {"id": c.mob_id, "var": c.var, "type": item.type, "call": c.call.json(),
                 "post": [p.json() for p in c.post_calls], "deps": sorted(c.deps, key=scene.mob_index),
                 "error": c.error}
        if item.type == "Code" and not c.error:
            entry["code"] = _code_listing(item)
        objects.append(entry)
    steps = []
    for st, step in zip(sc.steps, scene.steps):
        steps.append({
            "kind": "wait" if step.kind == WAIT else "play",
            "statements": statements_json(st.statements),
            "play": None if st.play is None else len(statements_json(st.statements[:st.play])),
            "run_time": st.run_time,
        })
    plan = {
        "version": PLAN_VERSION,
        "scene": {
            "id": scene.id, "name": codegen.safe_identifier(scene.name), "kind": kind.key,
            "three_d": kind.three_d, "moving_camera": kind.moving_camera,
            "init": {k: v.json() for k, v in sc.setup.init_kwargs},
        },
        "background": _background(project),
        "setup": statements_json(sc.setup.statements),
        "objects": objects,
        "add": statements_json(sc.adds),
        "steps": steps,
        "duration": round(sum(s["run_time"] for s in steps), 6),
        "layout": layout(scene),
        "screen_states": [sorted(s, key=scene.mob_index) for s in screen_states(scene)],
        "screen_orders": screen_orders(scene),
    }
    kits = scene_kits(scene)
    if kits:  # only then: plans without custom types (and so their stored renders' names) stay as they were
        plan["kits"] = kits
    return plan


def scene_kits(scene: Scene) -> list[dict]:
    """The packages (server/kits.py) whose code the browser engine needs for this scene: each available custom type
    it uses, with where its JavaScript is (GET /api/kits/<id>/<version>/kit.js), the file's hash, and which of its
    exports the class is (format 2; a first-format package's is its default export, and its entries stay as they
    were, so plans that use it keep their hashes)."""
    single = Project(scenes=[scene])
    out = []
    for key in kit_types_in(single):
        spec = kit_spec(key)
        if spec is None or spec.blocked or not spec.kit:
            continue
        k = spec.kit
        entry = {"type": key, "class": k["class"], "kind": k["kind"], "js_sha256": k.get("js_sha256", ""),
                 "js": f"/api/kits/{k['id']}/{k['version']}/kit.js"}
        if k.get("export", "default") != "default":
            entry["export"] = k["export"]
        out.append(entry)
    return out


# Raised when the engine draws the same plan differently (2: text in Crimson Pro), so stored renders are made again.
DRAWING = 2


def plan_hash(plan: dict, quality: str) -> str:
    """Names a scene's video as made at `quality`: a stored render is reused while the scene's plan is the same."""
    text = json.dumps({"plan": plan, "quality": quality, "drawing": DRAWING}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _background(project: Project) -> str:
    try:
        return codegen.color_node(project.settings.background).value
    except codegen.BAD_DATA:
        return "#000000"


def project_plan(project: Project) -> dict:
    """Every scene, for exporting them all."""
    return {"version": PLAN_VERSION, "quality": project.settings.quality,
            "scenes": [scene_plan(s, project) for s in project.scenes]}
