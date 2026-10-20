// TeX to SVG with the vendored MathJax 4 (manim-web's prebuilt chunk). Works in the browser and in Node (tests).
//
// MathJax keeps rarer glyph ranges (double-struck, calligraphic, fraktur, script, more arrows...) out of its main
// font file and loads them when a formula needs one. Those ranges are vendored as JSON next to the other vendored
// code; MathJax asks for them through mathjax.asyncLoad, which registers the data from this site.

import { loadMathJax } from "./lib.js";

const FONT_RANGES = new URL("../../../vendor/mathjax-newcm/4.1.3/", import.meta.url);
// TeX packages in the bundle. Manim's LaTeX template has amsmath and amssymb (both in "ams").
const PACKAGES = ["base", "ams", "newcommand", "configmacros"];
// LaTeX's own logos (latex.ltx), in roman type; MathJax's are in math italic with other kerns. The A is LaTeX's
// 7 pt size, raised to the top of the T; .5ex is cmr10's (0.2153 em).
const MACROS = {
  TeX: String.raw`\text{T}\kern-.1667em\lower.2153em{\text{E}}\kern-.125em\text{X}`,
  LaTeX: String.raw`\text{L}\kern-.36em\raise.205em{\scriptsize\text{A}}\kern-.15em\TeX`,
};

let fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MathJax font range ${url}: ${res.status}`);
  return res.json();
};

/** For Node: how to read a font range (a URL under the vendor folder) as JSON. */
export function setFontRangeReader(fn) {
  fetchJson = fn;
}

let engine = null;

async function start() {
  const mj = await loadMathJax();
  const adaptor = mj.liteAdaptor();
  mj.RegisterHTMLHandler(adaptor);
  const tex = new mj.TeX({ packages: PACKAGES, macros: MACROS });
  tagParts(tex);
  const svg = new mj.SVG({ fontCache: "none" });
  texFractions(svg);
  texItalicCorrection(svg);
  const doc = mj.mathjax.document("", { InputJax: tex, OutputJax: svg });
  const Font = svg.font.constructor;
  const loaded = new Map();
  mj.mathjax.asyncLoad = (file) => {
    const name = String(file).split("/").pop().replace(/\.js$/, "");
    if (!loaded.has(name)) {
      loaded.set(name, fetchJson(new URL(`${name}.json`, FONT_RANGES).href).then(({ args }) => {
        Font.dynamicSetup(...args);
      }));
    }
    return loaded.get(name);
  };
  return { mj, adaptor, doc };
}

/** MathJax draws a fraction bar 0.1 em wider than its numerator and denominator on each side, and gives the
 *  fraction 0.2 em more room; TeX's bar is exactly as wide as the wider of the two. These are MathJax's own
 *  methods (MathJax 4.1, output/common/Wrappers/mfrac.js and output/svg/Wrappers/mfrac.js) without that extra. */
function texFractions(svg) {
  const Mfrac = svg.factory.nodeMap.get("mfrac");
  Mfrac.prototype.getFractionBBox = function getFractionBBox(bbox, display, thickness) {
    const nbox = this.childNodes[0].getOuterBBox();
    const dbox = this.childNodes[1].getOuterBBox();
    const a = this.font.params.axis_height;
    const { T, u, v } = this.getTUV(display, thickness);
    bbox.combine(nbox, 0, a + T + Math.max(nbox.d * nbox.rscale, u));
    bbox.combine(dbox, 0, a - T - Math.max(dbox.h * dbox.rscale, v));
    bbox.w += 2 * this.pad;
  };
  Mfrac.prototype.makeFraction = function makeFraction(display, t) {
    const svgNodes = this.dom;
    const { numalign, denomalign } = this.node.attributes.getList("numalign", "denomalign");
    const [num, den] = this.childNodes;
    const nbox = num.getOuterBBox();
    const dbox = den.getOuterBBox();
    const a = this.font.params.axis_height;
    const pad = this.node.getProperty("withDelims") ? 0 : this.font.params.nulldelimiterspace;
    const W = Math.max((nbox.L + nbox.w + nbox.R) * nbox.rscale, (dbox.L + dbox.w + dbox.R) * dbox.rscale);
    const nx = this.getAlignX(W, nbox, numalign) + pad;
    const dx = this.getAlignX(W, dbox, denomalign) + pad;
    const { T, u, v } = this.getTUV(display, t);
    num.toSVG(svgNodes);
    num.place(nx, a + T + Math.max(nbox.d * nbox.rscale, u));
    den.toSVG(svgNodes);
    den.place(dx, a - T - Math.max(dbox.h * dbox.rscale, v));
    this.adaptor.append(svgNodes[0], this.svg("rect", {
      width: this.fixed(W), height: this.fixed(t), x: this.fixed(pad), y: this.fixed(a - t / 2),
    }));
  };
}

/** TeX follows a character with its italic correction (a kern) unless a subscript is attached (tex.web 755);
 *  MathJax keeps it only for placing scripts. Characters that are the base of a script are left to MathJax. */
function texItalicCorrection(svg) {
  const SCRIPTED = new Set(["msub", "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts"]);
  for (const kind of ["mi", "mn", "mo"]) {
    const Wrapper = svg.factory.nodeMap.get(kind);
    const computeBBox = Wrapper.prototype.computeBBox;
    Wrapper.prototype.computeBBox = function computeBBoxWithIC(bbox, recompute = false) {
      computeBBox.call(this, bbox, recompute);
      let node = this.node;
      let parent = node.parent;
      while (parent && parent.isInferred) {
        node = parent;
        parent = parent.parent;
      }
      const isBase = parent && SCRIPTED.has(parent.kind) && parent.childNodes[0] === node;
      if (!isBase && bbox.ic && !this.node.isKind?.("mo")) bbox.w += bbox.ic;
    };
  }
}

/** Manim marks the parts of a MathTex with dvisvgm specials (<g id='unique000'>...</g>), which leave the layout
 *  alone. Here \manimpartbegin{id} ... \manimpartend do the same: they produce nothing, and every MathML node made
 *  between them gets a data-manim-part attribute listing the open ids (innermost last), which the SVG output keeps. */
function tagParts(tex) {
  const options = tex.parseOptions;
  const macros = options.handlers.get("macro");
  const CommandMap = macros._configuration.items[0].item.constructor;
  let open = [];
  const map = new CommandMap("manim-parts", { manimpartbegin: "Begin", manimpartend: "End" }, {
    Begin(parser, name) {
      open.push(parser.GetArgument(name));
    },
    End() {
      open.pop();
    },
  });
  macros._configuration.add(map, 0);
  tex.preFilters.add(() => {
    open = [];
  });
  const factory = options.nodeFactory;
  const create = factory.create.bind(factory);
  factory.create = (kind, ...args) => {
    const node = create(kind, ...args);
    if (open.length && node?.attributes?.set) node.attributes.set("data-manim-part", open.join(" "));
    return node;
  };
}

/** The SVG markup MathJax makes for a formula. Throws with MathJax's message when the TeX has an error. */
export async function texToSvg(latex, { display = true } = {}) {
  engine ??= start();
  const { adaptor, doc } = await engine;
  const node = await doc.convertPromise(latex, { display });
  const markup = adaptor.outerHTML(node);
  const error = /data-mjx-error="([^"]*)"/.exec(markup);
  if (error || markup.includes("<mjx-merror") || /data-mml-node="merror"/.test(markup)) {
    throw new Error(error ? decodeEntities(error[1]) : "LaTeX error");
  }
  return markup;
}

function decodeEntities(s) {
  return s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
