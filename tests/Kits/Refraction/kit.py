import math

from manim import *


def bent_angle(theta, n1, n2):
    """Snell's law, n1 sin(theta1) = n2 sin(theta2): the bent ray's angle for light going from index n1 into n2, or
    None when it can't get through (total internal reflection)."""
    s = math.sin(theta) * n1 / n2
    return math.asin(s) if abs(s) <= 1 else None


def reflectance(n1, n2, cos1, cos2):
    """The share of unpolarized light the boundary reflects (the Fresnel equations): the reflectances of its s and p
    polarizations, averaged. The rest of the light goes through."""
    rs = (n1 * cos1 - n2 * cos2) / (n1 * cos1 + n2 * cos2)
    rp = (n2 * cos1 - n1 * cos2) / (n2 * cos1 + n1 * cos2)
    return (rs * rs + rp * rp) / 2


def brightness(share):
    """How opaque to draw a ray carrying this share of the light, so that on screen (gamma 2.2) it looks that share
    as bright as the incoming light."""
    return max(share, 0) ** (1 / 2.2)


def reach(direction, width, depth):
    """Where a unit direction from the center leaves the media: nothing pokes out, so the object's center stays where
    the light hits the boundary."""
    limits = [edge / abs(d) for d, edge in zip(direction, (width / 2, depth)) if abs(d) > 1e-9]
    return min(limits) * np.array([direction[0], direction[1], 0])


def index_text(n):
    """A refractive index to 3 decimals, but at least 2: 1.00, 1.33, 1.333."""
    k = math.floor(n * 1000 + 0.5)
    digits = f"{k % 1000:03d}"
    return f"{k // 1000}.{digits[:2] if digits.endswith('0') else digits}"


def clip01(x):
    return min(max(x, 0), 1)


class Refraction(VGroup):
    """Light hitting the boundary between two media at the center. It bends by Snell's law,
    n1 sin(theta1) = n2 sin(theta2), and part of it is reflected (all of it past the critical angle), each ray as
    bright as the share of the light it carries (the Fresnel equations). Its parts, in order: top medium, bottom
    medium, normal line, incoming ray, bent ray, reflected ray, the two angle arcs and the two angle labels (top, then
    bottom), and the two index labels. A part that is switched off or can't be there is an empty group, so the order
    never changes."""

    def __init__(self, theta=40 * DEGREES, source="top", n1=1.0, n2=1.33, reflection=True, width=14.25, depth=4.0,
                 ray_color="#FFFF00", ray_width=4.0, bottom_color="#1B3540", top_color="#000000", top_opacity=0.0,
                 normal=True, normal_length=2.0, line_color="#BBBBBB", arcs=True, arc_radius=0.8, labels=True,
                 label1=r"\theta_1", label2=r"\theta_2", **kwargs):
        super().__init__(**kwargs)
        # what it was made with, so its animations can make it again with another angle
        self.settings = dict(theta=theta, source=source, n1=n1, n2=n2, reflection=reflection, width=width,
                             depth=depth, ray_color=ray_color, ray_width=ray_width, bottom_color=bottom_color,
                             top_color=top_color, top_opacity=top_opacity, normal=normal,
                             normal_length=normal_length, line_color=line_color, arcs=arcs, arc_radius=arc_radius,
                             labels=labels, label1=label1, label2=label2)
        limit = 89 * DEGREES
        theta1 = max(-limit, min(limit, theta))
        up = -1 if source == "bottom" else 1  # which way the light's own medium is from the boundary
        n_top, n_bottom = max(1, n1), max(1, n2)
        n_in, n_out = (n_top, n_bottom) if up > 0 else (n_bottom, n_top)
        theta2 = bent_angle(theta1, n_in, n_out)
        self.reflected = theta2 is None  # all of it
        share = 1 if self.reflected else reflectance(n_in, n_out, math.cos(theta1), math.cos(theta2))
        self.top_medium = Rectangle(width=width, height=depth, stroke_width=0, fill_color=top_color,
                                    fill_opacity=top_opacity).move_to(UP * depth / 2)
        self.bottom_medium = Rectangle(width=width, height=depth, stroke_width=0, fill_color=bottom_color,
                                       fill_opacity=1).move_to(DOWN * depth / 2)
        n = min(normal_length, depth)
        self.normal_line = Line(UP * n, DOWN * n, stroke_color=line_color,
                                stroke_width=2) if normal else VGroup()
        start = reach((-math.sin(theta1), up * math.cos(theta1)), width, depth)
        self.ray_in = Line(start, ORIGIN, stroke_color=ray_color, stroke_width=ray_width)
        self.ray_bent = VGroup() if self.reflected else Line(
            ORIGIN, reach((math.sin(theta2), -up * math.cos(theta2)), width, depth), stroke_color=ray_color,
            stroke_width=ray_width, stroke_opacity=brightness(1 - share))
        self.ray_reflected = Line(
            ORIGIN, reach((math.sin(theta1), up * math.cos(theta1)), width, depth), stroke_color=ray_color,
            stroke_width=ray_width, stroke_opacity=brightness(share)) if reflection or self.reflected else VGroup()
        # (where the normal points into the medium, angle from it to the ray) in the top medium, then the bottom
        light = (up * PI / 2, up * theta1)
        bent = None if self.reflected else (-up * PI / 2, up * theta2)
        corners = [light, bent] if up > 0 else [bent, light]
        self.angle_arcs = [VGroup(), VGroup()]
        self.angle_labels = [VGroup(), VGroup()]
        for i, (corner, text) in enumerate(zip(corners, (label1, label2))):
            if corner is None or abs(corner[1]) < 1e-3:
                continue
            side, angle = corner
            if arcs:
                self.angle_arcs[i] = Arc(radius=arc_radius, start_angle=side, angle=angle,
                                         stroke_color=line_color, stroke_width=2)
            if labels and text.strip():
                middle = side + angle / 2
                self.angle_labels[i] = MathTex(text, font_size=40).move_to(
                    (arc_radius + 0.35) * np.array([math.cos(middle), math.sin(middle), 0]))
        # each medium's index in its outer left corner, if it fits there
        self.index_labels = [VGroup(), VGroup()]
        for i, (index, y) in enumerate(((n_top, 1), (n_bottom, -1))):
            label = MathTex(f"n_{i + 1} = {index_text(index)}", font_size=36) if labels else None
            if label is not None and label.width + 0.6 <= width / 2 and label.height + 0.6 <= depth:
                self.index_labels[i] = label.move_to(np.array(
                    [-width / 2 + 0.3 + label.width / 2, y * (depth - 0.3 - label.height / 2), 0]))
        self.add(self.top_medium, self.bottom_medium, self.normal_line, self.ray_in, self.ray_bent,
                 self.ray_reflected, *self.angle_arcs, *self.angle_labels, *self.index_labels)


def shine_times(from_bottom):
    """When each part of a Refraction comes in during Shine, as (from, to, drawn) over the animation (after its rate
    function): the media, the normal and the index labels fade in, the light draws in to the boundary and on (bent
    and reflected at once), and each angle's arc and label fade in as the light reaches it. Drawn parts grow from
    their start; the others fade in."""
    first, then = (0.45, 0.65, False), (0.8, 1, False)
    top, bottom = (then, first) if from_bottom else (first, then)
    return [(0, 0.3, False), (0, 0.3, False), (0.1, 0.35, False), (0.25, 0.6, True), (0.6, 0.95, True),
            (0.6, 0.95, True), top, bottom, top, bottom, (0.1, 0.35, False), (0.1, 0.35, False)]


class Shine(Animation):
    """Brings the refraction in, the light travelling through it."""

    def __init__(self, mobject, **kwargs):
        super().__init__(mobject, introducer=True, **kwargs)

    def interpolate_mobject(self, alpha):
        t = self.rate_func(alpha)
        times = shine_times((getattr(self.mobject, "settings", None) or {}).get("source") == "bottom")
        parts, start = self.mobject.submobjects, self.starting_mobject.submobjects
        if len(parts) != len(times) or len(start) != len(times):  # not shaped like a Refraction
            self.mobject.become(self.starting_mobject).fade(1 - t)
            return
        for part, original, (a, b, drawn) in zip(parts, start, times):
            s = clip01((t - a) / (b - a))
            if drawn:
                part.pointwise_become_partial(original, 0, s)
            else:
                part.become(original).fade(1 - s)


class SweepAngle(Animation):
    """The incoming light turns to another angle, and the bent and reflected rays, the arcs and the labels follow it.
    It starts from the refraction's angle as it is and leaves it at `to`, wherever it was moved, turned or scaled
    to."""

    def __init__(self, mobject, to=70 * DEGREES, **kwargs):
        self.to = to
        self.settings = None
        super().__init__(mobject, **kwargs)

    def begin(self):
        self.settings = dict(getattr(self.mobject, "settings", None) or {}) or None
        if self.settings:
            # the media say where the boundary is now (its center), how big and which way up
            top, bottom = self.mobject.submobjects[:2]
            up = top.get_center() - bottom.get_center()
            self.hit = midpoint(top.get_center(), bottom.get_center())
            self.size = np.linalg.norm(up) / self.settings["depth"]
            self.turn = angle_of_vector(up) - PI / 2
            self.start_theta = self.settings["theta"]
        super().begin()

    def interpolate_mobject(self, alpha):
        if not self.settings:
            return
        theta = self.start_theta + (self.to - self.start_theta) * self.rate_func(alpha)
        fresh = Refraction(**{**self.settings, "theta": theta})
        fresh.scale(self.size, about_point=ORIGIN).rotate(self.turn, OUT, about_point=ORIGIN).shift(self.hit)
        self.mobject.become(fresh)

    def finish(self):
        super().finish()
        if self.settings:
            self.mobject.settings = {**self.settings, "theta": self.to}
