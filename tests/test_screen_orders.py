"""ops.screen_orders against Manim (dev only: needs Manim).

Each fixture scene is run by Manim (no video) with a marker call before the first step and after every step; the
marker reads the drawing order of the scene's objects from Scene.mobjects. The browser engine draws in the order
the plan predicts, so this keeps the prediction honest.
"""

import inspect

import pytest

pytest.importorskip("manim")

from manimator import codegen  # noqa: E402
from manimator.model import ops  # noqa: E402
from manimator.registry import ANIMATIONS  # noqa: E402
from manimator.registry.animations import ANIMATE  # noqa: E402
from tests.fixture_projects import FILES, _new, golden_projects  # noqa: E402

SKIP = {"hostile"}  # not valid Manim on purpose


def _marked_source(project, scene) -> str:
    """scene_source with `self._mark(k)` before the first step and after each step."""
    sc = codegen.scene_code(scene, project)
    ind = codegen.INDENT
    out = codegen.class_lines(codegen.safe_identifier(scene.name), sc.setup)
    out += [ind + line for line in sc.setup.lines]
    for c in sc.objects:
        out += [ind + line for line in c.lines()]
    out += [line for s in sc.adds for line in s.lines(ind)]
    out.append(f"{ind}self._mark(0)")
    for k, st in enumerate(sc.steps):
        out += [line for s in st.statements for line in s.lines(ind)]
        out.append(f"{ind}self._mark({k + 1})")
    return "from manim import *\n\n" + "\n".join(out) + "\n"


def sample_assets(folder) -> None:
    """The uploaded files the fixtures name."""
    from PIL import Image

    Image.new("RGBA", (40, 20), (200, 80, 80, 255)).save(folder / FILES["ImageMobject"])
    (folder / FILES["SVGMobject"]).write_text('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">'
                                              '<rect width="40" height="40" fill="red"/></svg>', encoding="utf-8")


def manim_orders(project, scene, manim_ns, assets=None) -> list[list[str]]:
    from manim import tempconfig
    from manim.utils.family import extract_mobject_family_members

    tops = [m.id for m in ops.top_level(scene)]
    names = codegen.scene_names(scene)
    seen: dict[int, list[str]] = {}

    def mark(self, k):
        local = inspect.currentframe().f_back.f_locals
        family = extract_mobject_family_members(self.mobjects, use_z_index=False)
        where = {}
        for i in tops:
            mob = local.get(names[i])
            if mob is not None and any(f is mob for f in family):
                where[i] = next(n for n, f in enumerate(family) if f is mob)
        seen[k] = sorted(where, key=where.get)

    ns = dict(manim_ns)
    with codegen.asset_root(assets):
        exec(_marked_source(project, scene), ns)
    cls = ns[codegen.safe_identifier(scene.name)]
    cls._mark = mark
    with tempconfig({"dry_run": True, "pixel_width": 160, "pixel_height": 90, "frame_rate": 5}):
        cls().render()
    return [seen[k] for k in sorted(seen)]


def _cases():
    projects = golden_projects()
    for name, project in sorted(projects.items()):
        if name in SKIP:
            continue
        for scene in project.scenes:
            yield pytest.param(project, scene, id=f"{name}-{scene.name}")
    yield from _effect_cases()


def _effect_cases():
    """Every object animation on an object that is on screen or not, alone and in a LaggedStart with others."""
    for key in [k for k, a in ANIMATIONS.items() if k != ANIMATE and not a.scene_action]:
        for shown in (False, True):
            for lagged in (False, True):
                project, scene = _new(name=f"Effect{key}")
                spec = ANIMATIONS[key]
                kind = spec.only[0] if spec.only else "Circle"
                a = ops.create_mobject(scene, kind, -2, 0)
                b = ops.create_mobject(scene, "MathTex" if kind in ("MathTex", "Tex") else "Square", 2, 0)
                c = ops.create_mobject(scene, "Star", 0, 2)
                ops.add_play_step(scene, key, a.id)
                if lagged:
                    ops.add_animation_to_step(scene, 0, "Indicate", c.id)
                    ops.add_animation_to_step(scene, 0, "FadeIn", b.id) if not shown else None
                    scene.steps[0].lag_ratio = 0.5
                a.on_screen_at_start = shown
                b.on_screen_at_start = False
                ops.add_play_step(scene, "Indicate", c.id)
                ops.add_play_step(scene, "FadeIn", a.id)
                yield pytest.param(project, scene, id=f"effect-{key}-{'shown' if shown else 'hidden'}"
                                                      f"{'-lagged' if lagged else ''}")


@pytest.mark.parametrize(("project", "scene"), list(_cases()))
def test_screen_orders_match_manim(project, scene, manim_ns, tmp_path):
    sample_assets(tmp_path)
    predicted = ops.screen_orders(scene)
    actual = manim_orders(project, scene, manim_ns, tmp_path)
    assert len(actual) == len(predicted)
    for k, (p, a) in enumerate(zip(predicted, actual)):
        assert p == a, f"before step {k}: predicted {p}, Manim has {a}"
