// Graph and DiGraph layouts against Manim + networkx (tools/MakeJsFixtures.py: graphs). Spring and random layouts
// come from numpy's MT19937 and match exactly; circular and shell round through float32 as networkx does.
// Kamada-Kawai stops where an L-BFGS stops, near scipy's L-BFGS-B result but not on it: 1e-4.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { close, fixture } from "./helpers.mjs";

const mj = await import("../../manimator/web/js/engine/mw/mathjax.js");
mj.setFontRangeReader(async (url) => JSON.parse(readFileSync(new URL(url), "utf8")));
const { Graph, DiGraph } = await import("../../manimator/web/js/engine/manim/graph.js");
const { renderTexRequests } = await import("../../manimator/web/js/engine/manim/texcache.js");

const EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 2]];
const cases = fixture("graphs");

function build([cls, layout, labels, seed]) {
  const kw = { vertices: [0, 1, 2, 3, 4], edges: EDGES, layout, layout_scale: 2, labels };
  if (layout === "spring" || layout === "random") kw.layout_config = { seed };
  return (cls === "Graph" ? Graph : DiGraph).make(kw);
}

for (const c of cases) {
  try {
    build(c.case);
  } catch {
    // labels not rendered yet
  }
}
await renderTexRequests();

for (const { case: spec, vertices, edges, width, height } of cases) {
  test(spec.join(" "), () => {
    const g = build(spec);
    const tol = spec[1] === "kamada_kawai" ? 1e-4 : 1e-6;
    close([0, 1, 2, 3, 4].map((v) => g.item(v).get_center()), vertices, tol, "vertices");
    close(EDGES.map((e) => [...g.item(e).get_start(), ...g.item(e).get_end()]), edges, tol, "edges");
    // label sizes come from MathJax, so the overall box only roughly
    close([g.width, g.height], [width, height], spec[2] ? 0.05 : tol, "size");
  });
}
