// Customizations (server/kits.py): a package's classes join the names scene plans call ({"call": "Battery"}), the way
// Python's `from customizations.battery import Battery` adds them to the generated code. On the site this runs only
// inside the sandboxed frame (web/sandbox/); the chat player (web/mcp/player.html) registers packages itself.

import { Animation } from "./anim/animation.js";
import { ANIMATIONS } from "./anim/index.js";
import { Mobject } from "./manim/mobject.js";
import { CLASSES } from "./plan/names.js";

const registered = new Map(); // class name -> the package version registered under it ("type:sha")
const modules = new Map(); // kit.js sha256 -> its module (a promise): a package's classes come from one import

/** Puts a package's class under its name. Returns whether this replaced a different one (built objects cached
 *  under that name are stale then). */
export function registerKitClass(kit, Cls) {
  const isObject = kit.kind === "object";
  const base = isObject ? Mobject : Animation;
  if (typeof Cls !== "function" || !(Cls === base || Cls.prototype instanceof base)) {
    const how = (kit.export ?? "default") === "default" ? "`export default` a class" : `export class ${kit.class}`;
    throw new Error(`${kit.class}: kit.js must ${how} that extends ${isObject
      ? "a Manim object (VGroup, VMobject...)" : "Animation"}`);
  }
  if (!isObject && kit.class in CLASSES) throw new Error(`${kit.class} is already an object's name`);
  const key = `${kit.type}:${kit.js_sha256}`;
  const replaced = registered.has(kit.class) && registered.get(kit.class) !== key;
  (isObject ? CLASSES : ANIMATIONS)[kit.class] = Cls;
  registered.set(kit.class, key);
  return replaced;
}

/** A module from source text, through a blob: address. */
async function importText(text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Imports each package of a plan's `kits` ([{type, class, kind, js_sha256, export?}]) whose class isn't registered
 *  yet, from its source text (`sources`: type -> text; an object's animations share their object's text, so any
 *  type with the same js_sha256 will do), with `load(text, sha)` (default: a blob: module). Each kit.js is imported
 *  once: an animation and its object come from the same module. Returns whether a class was replaced. */
export async function registerKits(kits = [], sources = {}, load = importText) {
  let replaced = false;
  for (const kit of kits) {
    if (registered.get(kit.class) === `${kit.type}:${kit.js_sha256}`) continue;
    const text = sources[kit.type]
      ?? sources[kits.find((k) => k.js_sha256 === kit.js_sha256 && typeof sources[k.type] === "string")?.type];
    if (typeof text !== "string") throw new Error(`${kit.class}: its code didn't arrive`);
    const cacheKey = kit.js_sha256 || text;
    if (!modules.has(cacheKey)) {
      const loading = load(text, kit.js_sha256);
      loading.catch(() => modules.delete(cacheKey));
      modules.set(cacheKey, loading);
    }
    let mod;
    try {
      mod = await modules.get(cacheKey);
    } catch (e) {
      throw new Error(`${kit.class}: kit.js failed to load (${e?.message ?? e})`);
    }
    replaced = registerKitClass(kit, mod[kit.export ?? "default"]) || replaced;
  }
  return replaced;
}
