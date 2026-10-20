from manim import *


class PopIn(Animation):
    """Grow from nothing, a little past full size, and settle."""

    def __init__(self, mobject, bounce=1.7, **kwargs):
        self.bounce = bounce
        super().__init__(mobject, introducer=True, **kwargs)

    def interpolate_mobject(self, alpha):
        t = self.rate_func(alpha) - 1  # "ease out back": 0 at the start, past 1 on the way, 1 at the end
        size = 1 + (self.bounce + 1) * t**3 + self.bounce * t**2
        self.mobject.become(self.starting_mobject)
        self.mobject.scale(max(size, 0.001))
