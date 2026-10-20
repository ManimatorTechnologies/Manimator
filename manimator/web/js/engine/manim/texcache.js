// TeX renders for the synchronous MathTex constructors. A formula that isn't rendered yet is requested and drawn
// empty; the scene builder then renders every request (asynchronously, with MathJax) and builds the scene again.

import { texToSvg } from "../mw/mathjax.js";

const renders = new Map(); // MathJax input -> {svg} | {error}
const requests = new Set();
const LIMIT = 2000;
let misses = 0;

/** The SVG for `latex`, or null (and a request) when it hasn't been rendered. Throws the TeX error if it failed. */
export function texRender(latex) {
  const r = renders.get(latex);
  if (r === undefined) {
    requests.add(latex);
    misses += 1;
    return null;
  }
  if (r.error) throw new Error(`LaTeX error: ${r.error}`);
  return r.svg;
}

export const hasTexRequests = () => requests.size > 0;

/** How many times a formula was missing so far (an object built while it grew is incomplete). */
export const texMisses = () => misses;

/** Renders everything requested since the last call; returns how many formulas were rendered. */
export async function renderTexRequests() {
  const list = [...requests];
  requests.clear();
  for (const latex of list) {
    try {
      renders.set(latex, { svg: await texToSvg(latex, { display: true }) });
    } catch (e) {
      renders.set(latex, { error: e?.message ?? String(e) });
    }
    if (renders.size > LIMIT) renders.delete(renders.keys().next().value);
  }
  return list.length;
}

export function clearTexRequests() {
  requests.clear();
}
