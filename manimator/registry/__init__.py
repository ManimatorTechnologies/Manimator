"""Data-driven catalog of what the editor can create: mobjects, methods and animations.

Adding a new mobject/method/animation is a matter of adding one spec entry; the
inspector forms, the code generator and the preview all read from these specs.
"""

from .animations import ANIMATIONS, ANIM_CATEGORIES, AnimSpec
from .methods import METHODS, MethodSpec
from .mobjects import MOBJECTS, MOB_CATEGORIES, MobjectSpec
from .params import Param

__all__ = [
    "ANIMATIONS",
    "ANIM_CATEGORIES",
    "AnimSpec",
    "METHODS",
    "MethodSpec",
    "MOBJECTS",
    "MOB_CATEGORIES",
    "MobjectSpec",
    "Param",
]
