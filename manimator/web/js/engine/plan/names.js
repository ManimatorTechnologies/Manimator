// The Manim names a scene plan can use ({"call": name} and {"name": name}): classes and rate functions.

import { RATE_FUNCTIONS } from "../core/rates.js";
import * as brace from "../manim/brace.js";
import * as code from "../manim/code.js";
import * as coordinates from "../manim/coordinates.js";
import * as geometry from "../manim/geometry.js";
import * as graph from "../manim/graph.js";
import * as image from "../manim/image.js";
import * as markup from "../manim/markup.js";
import * as matrix from "../manim/matrix.js";
import { Group, Mobject } from "../manim/mobject.js";
import * as numbers from "../manim/numbers.js";
import * as svg from "../manim/svg.js";
import * as tex from "../manim/tex.js";
import * as text from "../manim/text.js";
import * as threeD from "../manim/three_d.js";
import * as vectorField from "../manim/vector_field.js";
import * as vmobject from "../manim/vmobject.js";

const classes = {};
for (const mod of [vmobject, geometry, svg, text, markup, tex, numbers, brace, matrix, coordinates, vectorField, graph,
  threeD, image, code]) {
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function" && value.prototype instanceof Mobject) classes[name] = value;
  }
}
classes.Group = Group;
classes.Mobject = Mobject;

/** Mobject classes by name. Animation classes are added by the timeline module. */
export const CLASSES = classes;

/** Rate functions by their Python spelling (smooth, rate_functions.ease_out_bounce...). */
export function rateFunctionNamed(name) {
  const short = name.startsWith("rate_functions.") ? name.slice("rate_functions.".length) : name;
  return RATE_FUNCTIONS[short] ?? null;
}

/** A {"name": ...} value: a class or a rate function. */
export function lookupName(name) {
  if (name in CLASSES) return CLASSES[name];
  const rate = rateFunctionNamed(name);
  if (rate) return rate;
  throw new Error(`name '${name}' is not defined`);
}
