// Customizations (server/kits.py): a package's class joins the names scene plans call ({"call": "Battery"}), the way
// Python's `from customizations.battery import Battery` adds it to the generated code. On the site this runs only
// inside the sandboxed frame (web/sandbox/); the chat player (web/mcp/player.html) registers packages itself.

import { Animation } from "./anim/animation.js";
import { ANIMATIONS } from "./anim/index.js";
import { Mobject } from "./manim/mobject.js";
import { CLASSES } from "./plan/names.js";

const registered = new Map(); // class name -> the package version registered under it ("type:sha")

/** Puts a package's class under its name. Returns whether this replaced a different one (built objects cached
 *  under that name are stale then). */
export function registerKitClass(kit, Cls) {
  const isObject = kit.kind === "object";
  const base = isObject ? Mobject : Animation;
  if (typeof Cls !== "function" || !(Cls === base || Cls.prototype instanceof base)) {
    throw new Error(`${kit.class}: kit.js must \`export default\` a class that extends ${isObject
      ? "a Manim object (VGroup, VMobject...)" : "Animation"}`);
  }
  if (!isObject && kit.class in CLASSES) throw new Error(`${kit.class} is already an object's name`);
  const key = `${kit.type}:${kit.js_sha256}`;
  const replaced = registered.has(kit.class) && registered.get(kit.class) !== key;
  (isObject ? CLASSES : ANIMATIONS)[kit.class] = Cls;
  registered.set(kit.class, key);
  return replaced;
}

/** Imports each package of a plan's `kits` ([{type, class, kind, js_sha256}]) whose class isn't registered yet,
 *  from its source text (`sources`: type -> text). Returns whether a class was replaced. */
export async function registerKits(kits = [], sources = {}) {
  let replaced = false;
  for (const kit of kits) {
    if (registered.get(kit.class) === `${kit.type}:${kit.js_sha256}`) continue;
    const text = sources[kit.type];
    if (typeof text !== "string") throw new Error(`${kit.class}: its code didn't arrive`);
    const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    let mod;
    try {
      mod = await import(url);
    } catch (e) {
      throw new Error(`${kit.class}: kit.js failed to load (${e?.message ?? e})`);
    } finally {
      URL.revokeObjectURL(url);
    }
    replaced = registerKitClass(kit, mod.default) || replaced;
  }
  return replaced;
}
