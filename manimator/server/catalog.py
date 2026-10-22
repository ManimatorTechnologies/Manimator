"""The registry as JSON, so the browser UI can build its palettes, menus and forms."""

from __future__ import annotations

from functools import lru_cache

from ..model.ops import auto_transform_role
from ..registry import ANIM_CATEGORIES, ANIMATIONS, METHODS, MOB_CATEGORIES, MOBJECTS
from ..registry.animations import ANIMATE, RATE_FUNCS
from ..registry.colors import HEX_OF, NAME_OF_HEX, PALETTE_ROWS
from ..registry.methods import METHOD_GROUPS
from ..registry.mobjects import STYLE_FIELDS
from ..registry.params import DIRECTION_GRID, Param
from ..registry.scenes import FIXED_CHOICES, SCENE_KINDS, TRANSFORM_ROLES, VECTOR_TYPES
from ..registry.qualities import QUALITIES


def param_json(p: Param) -> dict:
    return {
        "name": p.name,
        "kind": p.kind,
        "default": p.default,
        "label": p.title,
        "min": p.min,
        "max": p.max,
        "step": p.step,
        "decimals": p.decimals,
        "choices": [list(c) if isinstance(c, tuple) else c for c in p.choices],
        "optional": p.optional,
        "slider": p.slider,
        "tooltip": p.tooltip,
        "accept": p.accept,
        "numeric": p.numeric,
        "minItems": p.min_items,
    }


def mobject_json(s) -> dict:
    """An object type as the editor reads it (custom ones too: server/kits.py)."""
    out = {
        "key": s.key,
        "category": s.category,
        "icon": s.icon,
        "name": s.name,
        "styleKind": s.style_kind,
        "params": [param_json(p) for p in s.params],
        "pointParams": list(s.point_params),
        "positioned": s.positioned,
        "needsTarget": s.needs_target,
        "acceptsSelection": s.accepts_selection,
        "threeD": s.three_d,
        "description": s.description,
        "transformRole": auto_transform_role(s.key),
    }
    if s.kit is not None or s.blocked:
        out.update(label=(s.kit or {}).get("name", "Unavailable"), kit=_kit_json(s.kit), blocked=s.blocked)
    return out


def animation_json(a) -> dict:
    """An animation as the editor reads it (custom ones too: server/kits.py)."""
    out = {"key": a.key, "label": a.title, "category": a.category, "description": a.description,
           "introducer": a.introducer, "remover": a.remover, "runTime": a.run_time, "only": list(a.only),
           "sceneKinds": list(a.scene_kinds), "channel": a.channel, "fixedTime": a.fixed_time,
           "params": [param_json(p) for p in a.params]}
    if a.kit is not None or a.blocked:
        out.update(kit=_kit_json(a.kit), blocked=a.blocked)
    return out


def kit_part_json(s) -> dict:
    """One class of a customization as its page shows it: its object or one of its animations, what it does and the
    settings it offers."""
    kit = s.kit or {}
    out = {"type": s.key, "kind": kit.get("kind", ""), "class": kit.get("class", ""), "description": s.description,
           "settings": [param_json(p) for p in s.params]}
    if kit.get("kind") == "animation":
        out.update(name=s.title, introducer=s.introducer, remover=s.remover, runTime=s.run_time)
    else:
        out["name"] = kit.get("name", "")
    return out


def _kit_json(kit: dict | None) -> dict | None:
    """What the editor may know about a custom type's package (never where its files are on the server)."""
    if kit is None:
        return None
    return {k: kit[k] for k in ("id", "version", "label", "name", "class", "author", "mine") if k in kit}


# The fonts videos can use: the ones the browser engine has (manimator/web/fonts/, FONT_FILES in its fonts.js).
# Text that names none gets Crimson Pro (codegen.TEXT_FONT); any other name falls back to DejaVu Sans, as Pango does
# where only DejaVu is installed.
FONTS = ["Crimson Pro", "STIX Two Text", "Tinos", "CMU Serif", "Source Serif 4", "Inter", "Geist", "Source Sans 3",
         "IBM Plex Sans", "Lato", "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono"]


@lru_cache(maxsize=1)
def catalog() -> dict:
    return {
        "frame": {"width": 128 / 9, "height": 8.0},
        "mobjects": [mobject_json(s) for s in MOBJECTS.values()],
        "mobCategories": MOB_CATEGORIES,
        "styleFields": {kind: [param_json(p) for p in params] for kind, params in STYLE_FIELDS.items()},
        "methods": [
            {"key": m.key, "label": m.label, "group": m.group, "description": m.description,
             "params": [param_json(p) for p in m.params]}
            for m in METHODS.values()
        ],
        "methodGroups": METHOD_GROUPS,
        "animations": [animation_json(a) for a in ANIMATIONS.values()],
        "animCategories": ANIM_CATEGORIES,
        "sceneKinds": [
            {"key": k.key, "description": k.description, "threeD": k.three_d,
             "movingCamera": k.moving_camera, "requires": k.requires,
             "options": [param_json(p) for p in k.options]}
            for k in SCENE_KINDS.values()
        ],
        "transformRoles": [list(r) for r in TRANSFORM_ROLES],
        "vectorTypes": list(VECTOR_TYPES),
        "fixedChoices": [list(c) for c in FIXED_CHOICES],
        "animate": ANIMATE,
        "rateFuncs": [list(r) for r in RATE_FUNCS],
        "palette": {"rows": PALETTE_ROWS, "hex": HEX_OF, "names": NAME_OF_HEX},
        "qualities": [list(q) for q in QUALITIES],
        "directionGrid": [list(r) for r in DIRECTION_GRID],
        "fonts": FONTS,
    }
