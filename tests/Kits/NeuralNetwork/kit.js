// Neural network: the browser engine's version (Manimator draws and plays this one). kit.py is the same for Manim.
import {
  Animation, BLUE, Brace, Circle, DOWN, Dot, GREEN, GREY_B, LEFT, Line, MED_SMALL_BUFF, MathTex, RIGHT, UP, VGroup,
  VMobject, YELLOW, mul,
} from "manimator";

const LAYER_LAG = 2 / 3; // Feed forward: a layer's pulses set off as the layer before it finishes filling
const TIME_WIDTH = 2; // a pulse grows along its edge, covers it, then shrinks away toward the far end

/** "8, 6, 6, 4" -> [8, 6, 6, 4]: each run of digits is a layer (1 to 1000 neurons), at most 12 layers. */
function layerSizes(text) {
  const sizes = (String(text).match(/[0-9]+/g) ?? []).slice(0, 12)
    .map((s) => Math.max(1, Math.min(1000, parseInt(s, 10))));
  return sizes.length ? sizes : [1];
}

/** Fill opacities for the lit-up look (Light up, and Feed forward's pattern), from a Park-Miller generator
 *  (kit.py makes the same numbers). */
function activations(count, seed) {
  let state = ((Math.trunc(seed) % 2147483646) + 2147483646) % 2147483646 + 1; // Python's % never goes negative
  const out = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 48271) % 2147483647;
    out.push(state / 2147483647);
  }
  return out;
}

export class NeuralNetwork extends VGroup {
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

const clip01 = (x) => Math.min(Math.max(x, 0), 1);

/** A NeuralNetwork's neurons (per layer) and edges (per pair of layers), found by position, since copies may not keep
 *  attributes: its parts are [edges, layers] (then labels); edges[i] holds the Lines from layer i to layer i + 1, and
 *  each layer's first part is its neurons. null when mob isn't shaped like that. */
function networkParts(mob) {
  if (mob.submobjects.length < 2) return null;
  const [edges, layers] = mob.submobjects;
  const neurons = [];
  for (const layer of layers.submobjects) {
    const cells = layer.submobjects.length ? layer.submobjects[0].submobjects : [];
    if (!cells.length || !cells.every((c) => c instanceof VMobject)) return null;
    neurons.push(cells);
  }
  if (!neurons.length || edges.submobjects.length !== neurons.length - 1) return null;
  const lines = [];
  for (const [i, group] of edges.submobjects.entries()) {
    const row = group.submobjects;
    if (row.length !== neurons[i].length * neurons[i + 1].length
      || !row.every((e) => e instanceof VMobject && e.get_num_curves() > 0)) return null;
    lines.push(row);
  }
  return [neurons, lines];
}

/** Feed forward: the network lights up layer by layer, left to right: each layer's neurons fill to their activation
 *  while a pulse runs along the edges into it. The neurons stay lit; the edges end as they were. */
export class FeedForward extends Animation {
  __init__({ mobject = null, seed = 7, pulse_color = YELLOW, pulse_width = 1.5, ...kw } = {}) {
    this.seed = seed;
    this.pulse_color = pulse_color;
    this.pulse_width = pulse_width;
    this.parts = null;
    this.fills = null;
    this.pulses = null;
    return super.__init__({ ...kw, mobject });
  }

  begin() {
    this.parts = networkParts(this.mobject);
    if (this.parts) {
      const [neurons, lines] = this.parts;
      const targets = activations(neurons.reduce((n, layer) => n + layer.length, 0), this.seed);
      let next = 0;
      this.fills = neurons.map((layer) => layer.map((n) => [n.get_fill_opacity(), targets[next++]]));
      // copies of the edges, drawn over them and under the neurons while this plays
      this.pulses = VGroup.make({ vmobjects: lines.map((row) => VGroup.make({ vmobjects: row.map((e) =>
        this.make_pulse(e)) })) });
      this.mobject.insert(1, this.pulses);
    }
    super.begin();
  }

  make_pulse(edge) {
    return edge.copy().set_stroke(this.pulse_color, this.pulse_width * edge.get_stroke_width(), 1);
  }

  interpolate_mobject(alpha) {
    if (!this.parts) return;
    const [neurons, lines] = this.parts;
    const full = (neurons.length - 1) * LAYER_LAG + 1;
    neurons.forEach((layer, j) => {
      const s = clip01(alpha * full - j * LAYER_LAG); // how far layer j is through its part of the run
      // the first layer just fills; the others fill as their pulses arrive
      const fill = this.rate_func(j === 0 ? clip01(1.5 * s) : clip01(2 * s - 1 / 3));
      layer.forEach((neuron, i) => {
        const [start, target] = this.fills[j][i];
        neuron.set_fill(null, start + (target - start) * fill);
      });
      if (j === 0) return;
      const row = lines[j - 1];
      // each edge's pulse takes half of the layer's part; their starts spread over the other half
      const step = row.length > 1 ? 1 / (row.length - 1) : 0;
      const pulses = this.pulses.submobjects[j - 1].submobjects;
      row.forEach((edge, k) => {
        const upper = (1 + TIME_WIDTH) * this.rate_func(clip01(2 * s - k * step));
        pulses[k].pointwise_become_partial(edge, Math.max(upper - TIME_WIDTH, 0), Math.min(upper, 1));
      });
    });
  }

  finish() {
    super.finish();
    if (this.pulses !== null) this.mobject.remove(this.pulses);
  }
}
