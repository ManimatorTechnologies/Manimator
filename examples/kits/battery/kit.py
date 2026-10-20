from manim import *


class Battery(VGroup):
    """A battery whose fill shows its charge: green, then yellow, then red as it runs down."""

    def __init__(self, charge=0.7, **kwargs):
        super().__init__(**kwargs)
        c = max(0.0, min(1.0, charge))
        body = RoundedRectangle(width=2, height=1, corner_radius=0.12, color=WHITE)
        tip = Rectangle(width=0.12, height=0.4, color=WHITE, fill_opacity=1).next_to(body, RIGHT, buff=0)
        level = GREEN if c >= 0.5 else YELLOW if c >= 0.2 else RED
        fill = Rectangle(width=max(0.01, 1.8 * c), height=0.8, stroke_width=0, fill_color=level, fill_opacity=1)
        fill.align_to(body, LEFT).shift(RIGHT * 0.1)
        self.add(body, tip, fill)
