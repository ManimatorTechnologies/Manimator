// Every animation class a scene plan can name ({"call": "FadeIn"}), by name.

import * as animation from "./animation.js";
import * as composition from "./composition.js";
import * as creation from "./creation.js";
import * as fading from "./fading.js";
import * as indication from "./indication.js";
import * as matching from "./matching.js";
import * as transform from "./transform.js";

const classes = {};
for (const mod of [animation, composition, creation, fading, indication, matching, transform]) {
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function" && (value === animation.Animation || value.prototype instanceof animation.Animation)) {
      classes[name] = value;
    }
  }
}

export const ANIMATIONS = classes;
export { AnimationBuilder, prepareAnimation } from "./animation.js";
