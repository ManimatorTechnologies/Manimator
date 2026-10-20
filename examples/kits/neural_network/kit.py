import re

from manim import *


def layer_sizes(text):
    """"8, 6, 6, 4" -> [8, 6, 6, 4]: each run of digits is a layer (1 to 1000 neurons), at most 12 layers."""
    sizes = [max(1, min(1000, int(s))) for s in re.findall(r"[0-9]+", str(text))[:12]]
    return sizes or [1]


def activations(count, seed):
    """Fill opacities for the lit-up look, from a Park-Miller generator (kit.js makes the same numbers)."""
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
