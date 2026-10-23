// Building a scene plan's objects (manimator/plan.py) with the port of Manim, the way the generated Python does:
// each object's call, then its post calls, in the plan's order (dependencies first).
//
// Building is synchronous, like Python. Files (uploads, fonts) are loaded before; a formula MathJax hasn't rendered
// yet comes out empty and is requested, then the whole build runs again once the requests are rendered.

import { ensureFonts } from "../manim/fonts.js";
import { resources } from "../manim/resources.js";
import { clearSvgCache } from "../manim/svg.js";
import { clearTexRequests, hasTexRequests, renderTexRequests, texMisses } from "../manim/texcache.js";
import { evalCall, evalNode } from "./values.js";

/** Every {"asset": name} in the plan, with how it is used (an image or an SVG file). */
export function planAssets(plan) {
  const out = new Map();
  const walk = (node, owner) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, owner));
      return;
    }
    if ("asset" in node) out.set(node.asset, owner === "ImageMobject" ? "image" : "text");
    for (const [k, v] of Object.entries(node)) walk(v, k === "args" || k === "kwargs" ? node.call ?? owner : owner);
  };
  for (const obj of plan.objects ?? []) walk(obj.call, obj.call?.call);
  walk(plan.steps, null);
  return out;
}

/** Decodes a picture into {width, height, data} (RGBA). */
export async function decodeImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return { width: canvas.width, height: canvas.height, data };
}

/** Loads the fonts the plan uses and its files into resources. `fetchAsset(name)` returns a Response (the site:
 *  GET /api/assets/name); without it, only the fonts. */
export async function loadPlanAssets(plan, fetchAsset) {
  await ensureFonts(plan);
  if (!fetchAsset) return;
  await Promise.all([...planAssets(plan)].map(async ([name, kind]) => {
    if (resources.has(kind, name)) return;
    const response = await fetchAsset(name);
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    if (kind === "image") resources.put("image", name, await decodeImage(await response.blob()));
    else resources.put("text", name, await response.text());
  }));
}

/** The object context: refs resolve to built objects; a failed dependency fails the object that uses it. */
export function objectContext(built, extra = {}) {
  return {
    ref(id) {
      const entry = built.get(id);
      if (!entry) throw new Error(`object ${id} isn't built`);
      if (entry.error) throw new Error(`it uses an object that failed (${entry.error})`);
      return entry.mobject;
    },
    attr(path) {
      throw new Error(`${path} isn't available here`);
    },
    animate() {
      throw new Error("animations aren't available here");
    },
    ...extra,
  };
}

/** A cache of constructor results for objects that don't use other objects (as the server preview had), so moving
 *  a formula or a graph doesn't make it again: the object's type and call (as JSON) -> the object, copied on each
 *  use. The type tells customizations apart (server/kits.py "kit:<id>:<version>"): two packages, or two versions of
 *  one, may call the same class name with the same settings and draw different things. */
export class BuildCache {
  constructor(limit = 300) {
    this.limit = limit;
    this.map = new Map();
  }

  make(obj, call, ctx) {
    if (obj.deps?.length) return evalCall(call, ctx);
    const key = JSON.stringify([obj.type ?? null, call]);
    let cached = this.map.get(key);
    if (cached === undefined) {
      const misses = texMisses();
      cached = evalCall(call, ctx);
      if (texMisses() !== misses) return cached; // made before its formula was rendered: don't keep it
      this.map.set(key, cached);
      if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    } else {
      this.map.delete(key); // most recently used last
      this.map.set(key, cached);
    }
    return cached.copy();
  }
}

/** One pass over the plan's objects: Map id -> {mobject, error}.
 *
 *  Manim keeps the SVGs it made (text too) for the rest of the process, and a repeated one isn't flipped as a
 *  whole, only its parts (so the group's own sheen direction differs). A video's first scene starts with none
 *  kept, so each pass starts with none either. */
export function buildObjectsOnce(plan, { extra = {}, cache = null, onBuilt = null } = {}) {
  clearSvgCache();
  const built = new Map();
  const ctx = objectContext(built, extra);
  for (const obj of plan.objects ?? []) {
    if (obj.error) {
      built.set(obj.id, { mobject: null, error: obj.error });
      continue;
    }
    try {
      const call = obj.type === "Code" && obj.code ? withKwarg(obj.call, "highlight", obj.code) : obj.call;
      const mobject = cache ? cache.make(obj, call, ctx) : evalCall(call, ctx);
      built.set(obj.id, { mobject, error: null }); // its post calls refer to it
      for (const post of obj.post ?? []) evalNode(post, ctx, {});
      onBuilt?.(obj.id, mobject);
    } catch (e) {
      built.set(obj.id, { mobject: null, error: e?.message ?? String(e) });
    }
  }
  return built;
}

function withKwarg(call, key, value) {
  return { ...call, kwargs: { ...(call.kwargs ?? {}), [key]: { __value: value } } };
}

/** Builds until every formula is rendered (at most `passes` times). */
export async function buildObjects(plan, { passes = 4, extra = {}, cache = null, onBuilt = null } = {}) {
  clearTexRequests();
  let built = null;
  for (let i = 0; i < passes; i += 1) {
    built = buildObjectsOnce(plan, { extra, cache, onBuilt });
    if (!hasTexRequests()) return built;
    await renderTexRequests();
  }
  return built;
}
