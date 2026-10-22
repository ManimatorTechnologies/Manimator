import re

from manim import *

LAYER_LAG = 2 / 3  # Feed forward: a layer's pulses set off as the layer before it finishes filling
TIME_WIDTH = 2  # a pulse grows along its edge, covers it, then shrinks away toward the far end


def layer_sizes(text):
    """"8, 6, 6, 4" -> [8, 6, 6, 4]: each run of digits is a layer (1 to 1000 neurons), at most 12 layers."""
    sizes = [max(1, min(1000, int(s))) for s in re.findall(r"[0-9]+", str(text))[:12]]
    return sizes or [1]


def activations(count, seed):
    """Fill opacities for the lit-up look (Light up, and Feed forward's pattern), from a Park-Miller generator
    (kit.js makes the same numbers)."""
    state = int(seed) % 2147483646 + 1
    out = []
    for _ in range(count):
        state = state * 48271 % 2147483647
        out.append(state / 2147483647)
    return out


class NeuralNetwork(VGroup):
    """Layers of neurons joined by edges. Layers bigger than max_shown show their top and bottom neurons around
    a vertical ellipsis, with a brace giving the layer's size."""

    def __init__(self, layers="8, 6, 6, 4", neuron_radius=0.15, neuron_spacing=0.25, layer_spacing=1.0,
                 max_shown=16, neuron_color=BLUE, neuron_width=3.0, activation_color=GREEN, edge_color=GREY_B,
                 edge_width=2.0, braces=True, output_labels=False, lit=False, seed=7, **kwargs):
        super().__init__(**kwargs)
        self.sizes = layer_sizes(layers)
        self.layers = VGroup(*(self.make_layer(size, neuron_radius, neuron_spacing, max(2, max_shown), neuron_color,
                                               neuron_width, activation_color, braces) for size in self.sizes))
        self.layers.arrange(RIGHT, buff=layer_spacing)
        self.edges = VGroup()
        for left, right in zip(self.layers[:-1], self.layers[1:]):
            self.edges.add(VGroup(*(
                Line(a.get_center(), b.get_center(), buff=neuron_radius, stroke_color=edge_color,
                     stroke_width=edge_width)
                for a in left.neurons for b in right.neurons)))
        self.add(self.edges, self.layers)
        if output_labels:
            self.labels = VGroup()
            last = self.layers[-1]
            for index, neuron in zip(last.indices, last.neurons):
                label = MathTex(str(index))
                label.scale_to_fit_height(0.75 * neuron.height)
                label.move_to(neuron).shift(neuron.width * RIGHT)
                self.labels.add(label)
            self.add(self.labels)
        if lit:
            neurons = [n for layer in self.layers for n in layer.neurons]
            for neuron, opacity in zip(neurons, activations(len(neurons), seed)):
                neuron.set_fill(activation_color, opacity=opacity)

    @staticmethod
    def make_layer(size, radius, spacing, max_shown, color, width, fill_color, braces):
        shown = min(size, max_shown)
        neurons = VGroup(*(Circle(radius=radius, stroke_color=color, stroke_width=width, fill_color=fill_color,
                                  fill_opacity=0) for _ in range(shown)))
        neurons.arrange(DOWN, buff=spacing)
        layer = VGroup(neurons)
        layer.neurons = neurons
        layer.indices = list(range(shown))
        if size > shown:
            top = shown // 2
            layer.indices = list(range(top)) + list(range(size - (shown - top), size))
            # LaTeX's \vdots, as three dots (MathJax draws it a little shorter)
            dots = VGroup(*(Dot(radius=0.0264) for _ in range(3))).arrange(DOWN, buff=0.14645).move_to(neurons)
            VGroup(*neurons[:top]).next_to(dots, UP, MED_SMALL_BUFF)
            VGroup(*neurons[top:]).next_to(dots, DOWN, MED_SMALL_BUFF)
            layer.add(dots)
            if braces:
                brace = Brace(layer, LEFT)
                layer.add(brace, brace.get_tex(str(size)))
        return layer


def clip01(x):
    return min(max(x, 0), 1)


def network_parts(mob):
    """A NeuralNetwork's neurons (per layer) and edges (per pair of layers), found by position, since copies may not
    keep attributes: its parts are [edges, layers] (then labels); edges[i] holds the Lines from layer i to layer i + 1,
    and each layer's first part is its neurons. None when mob isn't shaped like that."""
    if len(mob.submobjects) < 2:
        return None
    edges, layers = mob.submobjects[:2]
    neurons = []
    for layer in layers.submobjects:
        cells = layer.submobjects[0].submobjects if layer.submobjects else []
        if not cells or not all(isinstance(c, VMobject) for c in cells):
            return None
        neurons.append(cells)
    if not neurons or len(edges.submobjects) != len(neurons) - 1:
        return None
    lines = []
    for i, group in enumerate(edges.submobjects):
        row = group.submobjects
        if len(row) != len(neurons[i]) * len(neurons[i + 1]) \
                or not all(isinstance(e, VMobject) and e.get_num_curves() > 0 for e in row):
            return None
        lines.append(row)
    return neurons, lines


class FeedForward(Animation):
    """The network lighting up layer by layer, left to right: each layer's neurons fill to their activation while a
    pulse runs along the edges into it. The neurons stay lit; the edges end as they were."""

    def __init__(self, mobject, seed=7, pulse_color=YELLOW, pulse_width=1.5, **kwargs):
        self.seed = seed
        self.pulse_color = pulse_color
        self.pulse_width = pulse_width
        self.parts = None
        self.fills = None
        self.pulses = None
        super().__init__(mobject, **kwargs)

    def begin(self):
        self.parts = network_parts(self.mobject)
        if self.parts:
            neurons, lines = self.parts
            targets = iter(activations(sum(len(layer) for layer in neurons), self.seed))
            self.fills = [[(n.get_fill_opacity(), next(targets)) for n in layer] for layer in neurons]
            # copies of the edges, drawn over them and under the neurons while this plays
            self.pulses = VGroup(*(VGroup(*(self.make_pulse(e) for e in row)) for row in lines))
            self.mobject.insert(1, self.pulses)
        super().begin()

    def make_pulse(self, edge):
        return edge.copy().set_stroke(self.pulse_color, self.pulse_width * edge.get_stroke_width(), 1)

    def interpolate_mobject(self, alpha):
        if not self.parts:
            return
        neurons, lines = self.parts
        full = (len(neurons) - 1) * LAYER_LAG + 1
        for j, layer in enumerate(neurons):
            s = clip01(alpha * full - j * LAYER_LAG)  # how far layer j is through its part of the run
            # the first layer just fills; the others fill as their pulses arrive
            fill = self.rate_func(clip01(1.5 * s) if j == 0 else clip01(2 * s - 1 / 3))
            for neuron, (start, target) in zip(layer, self.fills[j]):
                neuron.set_fill(opacity=start + (target - start) * fill)
            if j == 0:
                continue
            row = lines[j - 1]
            # each edge's pulse takes half of the layer's part; their starts spread over the other half
            step = 1 / (len(row) - 1) if len(row) > 1 else 0
            for k, (edge, pulse) in enumerate(zip(row, self.pulses.submobjects[j - 1].submobjects)):
                upper = (1 + TIME_WIDTH) * self.rate_func(clip01(2 * s - k * step))
                pulse.pointwise_become_partial(edge, max(upper - TIME_WIDTH, 0), min(upper, 1))

    def finish(self):
        super().finish()
        if self.pulses is not None:
            self.mobject.remove(self.pulses)
