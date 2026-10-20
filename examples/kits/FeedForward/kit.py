from manim import *

LAYER_LAG = 2 / 3  # a layer's pulses set off as the layer before it finishes filling
TIME_WIDTH = 2  # a pulse grows along its edge, covers it, then shrinks away toward the far end


def activations(count, seed):
    """Fill opacities from a Park-Miller generator: the Neural network customization's Light up uses the same
    numbers, so a pattern lights up the same neurons either way (kit.js makes them too)."""
    state = int(seed) % 2147483646 + 1
    out = []
    for _ in range(count):
        state = state * 48271 % 2147483647
        out.append(state / 2147483647)
    return out


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
    """A NeuralNetwork lighting up layer by layer, left to right: each layer's neurons fill to their activation while
    a pulse runs along the edges into it. The neurons stay lit; the edges end as they were. Anything not shaped
    like a NeuralNetwork is left as it is."""

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
