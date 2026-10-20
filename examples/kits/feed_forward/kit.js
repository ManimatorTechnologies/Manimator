// Feed forward: the browser engine's version (Manimator plays this one). kit.py is the same animation for Manim.
import { Animation, VGroup, VMobject, YELLOW } from "manimator";

const LAYER_LAG = 2 / 3; // a layer's pulses set off as the layer before it finishes filling
const TIME_WIDTH = 2; // a pulse grows along its edge, covers it, then shrinks away toward the far end

/** Fill opacities from a Park-Miller generator: the Neural network customization's Light up uses the same numbers,
 *  so a pattern lights up the same neurons either way (kit.py makes them too). */
function activations(count, seed) {
  let state = ((Math.trunc(seed) % 2147483646) + 2147483646) % 2147483646 + 1; // Python's % never goes negative
  const out = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 48271) % 2147483647;
    out.push(state / 2147483647);
  }
  return out;
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

export default class FeedForward extends Animation {
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
