// Evaluating scene-plan nodes (manimator/calltree.py lists the forms) against the port of Manim.
//
// ctx: { ref(id) -> mobject, attr(path) -> value (self.camera.frame...), call(name, args, kwargs) -> value for names
// that aren't classes (self.add, animations...), animate(target, calls) -> value }.

import { config } from "../manim/config.js";
import { callMethod } from "../manim/pymethods.js";
import { pyCall } from "../manim/pycall.js";
import { pymod } from "../core/math.js";
import { CLASSES, lookupName } from "./names.js";

const npSign = (v) => (v > 0 ? 1 : v < 0 ? -1 : v === 0 ? 0 : NaN);

/** numpy functions a formula may use (registry/exprs.py FUNCTIONS). */
const NP = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  arctan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, log: Math.log,
  log10: Math.log10, log2: Math.log2, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: npSign,
  floor: Math.floor, ceil: Math.ceil, minimum: (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b)),
  maximum: (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.max(a, b)),
};

const OPS = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "**": (a, b) => a ** b,
  "%": (a, b) => (b === 0 ? NaN : pymod(a, b)),
  "//": (a, b) => Math.floor(a / b),
};

/** A formula tree ({"v"}, {"op", "a", "b"}, {"op": "neg"}, {"f", "args"}, numbers) with numpy float semantics. */
export function evalExpr(tree, scope) {
  if (typeof tree === "number") return tree;
  if ("v" in tree) {
    if (!(tree.v in scope)) throw new Error(`name '${tree.v}' is not defined`);
    return Number(scope[tree.v]);
  }
  if (tree.op === "neg") return -evalExpr(tree.a, scope);
  if (tree.op) return OPS[tree.op](evalExpr(tree.a, scope), evalExpr(tree.b, scope));
  if (tree.f) {
    const fn = NP[tree.f];
    if (!fn) throw new Error(`unknown function ${tree.f}`);
    return fn(...tree.args.map((a) => evalExpr(a, scope)));
  }
  throw new Error("bad formula");
}

/** Values of a plan node. `scope` holds lambda parameters. */
export function evalNode(node, ctx, scope = {}) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => evalNode(n, ctx, scope));
  if ("__value" in node) return node.__value; // a value the builder adds (Code's highlight)
  if ("ref" in node) return ctx.ref(node.ref);
  if ("name" in node) return lookupName(node.name);
  if ("asset" in node) return node.asset;
  if ("frame_width" in node) return config.frame_width / node.frame_width;
  if ("dict" in node) return Object.fromEntries(Object.entries(node.dict).map(([k, v]) => [k, evalNode(v, ctx, scope)]));
  if ("attr" in node) return ctx.attr(node.attr);
  if ("expr" in node) return evalExpr(node.expr, scope);
  if ("lambda" in node) return makeLambda(node, ctx, scope);
  if ("animate" in node) return ctx.animate(evalNode(node.animate, ctx, scope), node.calls, scope);
  if ("call" in node) return evalCall(node, ctx, scope);
  throw new Error(`unknown plan node ${JSON.stringify(node).slice(0, 80)}`);
}

function makeLambda(node, ctx, outer) {
  const fn = (...args) => {
    const scope = { ...outer };
    node.lambda.forEach((p, i) => { scope[p] = args[i]; });
    for (const [name, [param, index]] of Object.entries(node.bind ?? {})) scope[name] = scope[param][index];
    return evalNode(node.body, ctx, scope);
  };
  Object.defineProperty(fn, "length", { value: node.lambda.length });
  return fn;
}

export function evalCall(node, ctx, scope = {}) {
  const args = (node.args ?? []).map((a) => evalNode(a, ctx, scope));
  const kwargs = Object.fromEntries(Object.entries(node.kwargs ?? {}).map(([k, v]) => [k, evalNode(v, ctx, scope)]));
  let value;
  if (node.on !== undefined) {
    const target = evalNode(node.on, ctx, scope);
    value = ctx.method ? ctx.method(target, node.call, args, kwargs) : callMethod(target, node.call, args, kwargs);
  } else {
    value = callName(node.call, args, kwargs, ctx);
  }
  for (const chained of node.then ?? []) {
    const cargs = (chained.args ?? []).map((a) => evalNode(a, ctx, scope));
    const ckw = Object.fromEntries(Object.entries(chained.kwargs ?? {}).map(([k, v]) => [k, evalNode(v, ctx, scope)]));
    const result = callMethod(value, chained.call, cargs, ckw);
    value = result === undefined ? value : result;
  }
  return value;
}

function callName(name, args, kwargs, ctx) {
  if (name === "np.array") return args[0].map((v) => (Array.isArray(v) ? v.map(Number) : Number(v)));
  if (name in CLASSES) return pyCall(CLASSES[name], args, kwargs);
  if (ctx.call) return ctx.call(name, args, kwargs);
  throw new Error(`name '${name}' is not defined`);
}
