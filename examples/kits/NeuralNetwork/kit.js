// Neural network: the browser engine's version (Manimator draws this one). kit.py is the same object for Manim.
import {
  BLUE, Brace, Circle, DOWN, Dot, GREEN, GREY_B, LEFT, Line, MED_SMALL_BUFF, MathTex, RIGHT, UP, VGroup, mul,
} from "manimator";

/** "8, 6, 6, 4" -> [8, 6, 6, 4]: each run of digits is a layer (1 to 1000 neurons), at most 12 layers. */
function layerSizes(text) {
  const sizes = (String(text).match(/[0-9]+/g) ?? []).slice(0, 12)
    .map((s) => Math.max(1, Math.min(1000, parseInt(s, 10))));
  return sizes.length ? sizes : [1];
}

/** Fill opacities for the lit-up look, from a Park-Miller generator (kit.py makes the same numbers). */
function activations(count, seed) {
  let state = ((Math.trunc(seed) % 2147483646) + 2147483646) % 2147483646 + 1; // Python's % never goes negative
  const out = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 48271) % 2147483647;
    out.push(state / 2147483647);
  }
  return out;
}

export default class NeuralNetwork extends VGroup {
  static SIG = ["layers"]; // NeuralNetwork("4, 3, 2") means layers="4, 3, 2", as in Python

  __init__({ layers = "8, 6, 6, 4", neuron_radius = 0.15, neuron_spacing = 0.25, layer_spacing = 1.0, max_shown = 16,
    neuron_color = BLUE, neuron_width = 3.0, activation_color = GREEN, edge_color = GREY_B, edge_width = 2.0,
    braces = true, output_labels = false, lit = false, seed = 7, ...kw } = {}) {
    super.__init__(kw);
    this.sizes = layerSizes(layers);
    this.layers = VGroup.make({ vmobjects: this.sizes.map((size) => NeuralNetwork.make_layer(size, neuron_radius,
      neuron_spacing, Math.max(2, max_shown), neuron_color, neuron_width, activation_color, braces)) });
    this.layers.arrange(RIGHT, layer_spacing);
    this.edges = VGroup.make();
    const all = this.layers.submobjects;
    for (let i = 0; i + 1 < all.length; i += 1) {
      const lines = [];
      for (const a of all[i].neurons.submobjects) {
        for (const b of all[i + 1].neurons.submobjects) {
          lines.push(Line.make({ start: a.get_center(), end: b.get_center(), buff: neuron_radius,
            stroke_color: edge_color, stroke_width: edge_width }));
        }
      }
      this.edges.add(VGroup.make({ vmobjects: lines }));
    }
    this.add(this.edges, this.layers);
    if (output_labels) {
      this.labels = VGroup.make();
      const last = all[all.length - 1];
      last.neurons.submobjects.forEach((neuron, i) => {
        const label = MathTex.make({ tex_strings: [String(last.indices[i])] });
        label.scale_to_fit_height(0.75 * neuron.height);
        label.move_to(neuron).shift(mul(RIGHT, neuron.width));
        this.labels.add(label);
      });
      this.add(this.labels);
    }
    if (lit) {
      const neurons = all.flatMap((layer) => layer.neurons.submobjects);
      const opacities = activations(neurons.length, seed);
      neurons.forEach((neuron, i) => neuron.set_fill(activation_color, opacities[i]));
    }
    return this;
  }

  static make_layer(size, radius, spacing, maxShown, color, width, fillColor, braces) {
    const shown = Math.min(size, maxShown);
    const neurons = VGroup.make({ vmobjects: Array.from({ length: shown }, () => Circle.make({ radius,
      stroke_color: color, stroke_width: width, fill_color: fillColor, fill_opacity: 0 })) });
    neurons.arrange(DOWN, spacing);
    const layer = VGroup.make({ vmobjects: [neurons] });
    layer.neurons = neurons;
    layer.indices = Array.from({ length: shown }, (_, i) => i);
    if (size > shown) {
      const top = Math.floor(shown / 2);
      layer.indices = layer.indices.map((i) => (i < top ? i : size - shown + i));
      // LaTeX's \vdots, as three dots (MathJax draws it a little shorter)
      const dots = VGroup.make({ vmobjects: Array.from({ length: 3 }, () => Dot.make({ radius: 0.0264 })) })
        .arrange(DOWN, 0.14645).move_to(neurons);
      VGroup.make({ vmobjects: neurons.submobjects.slice(0, top) }).next_to(dots, UP, MED_SMALL_BUFF);
      VGroup.make({ vmobjects: neurons.submobjects.slice(top) }).next_to(dots, DOWN, MED_SMALL_BUFF);
      layer.add(dots);
      if (braces) {
        const brace = Brace.make({ mobject: layer, direction: LEFT });
        layer.add(brace, brace.get_tex(String(size)));
      }
    }
    return layer;
  }
}
