// SVG files as mobjects: a port of manim/mobject/svg/svg_mobject.py and of the parts of svgelements 1.9.6 it relies
// on (SVG.parse with reify=True, Path.approximate_arcs_with_quads, Color, Length).
//
// Manim rewrites the file first: the root <svg> keeps only its style attributes (its viewBox, size and transform
// are dropped), wrapped in a group carrying svg_default's style. svgelements then bakes each shape's transform
// into its points (scaling the stroke width by sqrt|det|) where it can; rectangles and ellipses that are rotated,
// skewed or flipped keep the transform, which Manim applies to the finished mobject.

import { ManimColor } from "../core/color.js";
import { BLACK, VGroup, VMobject } from "./vmobject.js";
import { Circle, Line, Polygon, Rectangle, RoundedRectangle } from "./geometry.js";
import { RIGHT } from "./frozen.js";
import { resources } from "./resources.js";

const TAU = 2 * Math.PI;
const XLINK = "http://www.w3.org/1999/xlink";
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_PPI = 96.0;

/** Python's round(): halves go to the even neighbour. */
function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

// ------------------------------------------------------------------------------------------------ XML

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeEntities(text, custom) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[\w.-]+);/gi, (m, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name] ?? custom[name] ?? m;
  });
}

/** A small XML reader: elements {tag, attrs, children, text}, with namespaces resolved the way ElementTree does
 *  ("{uri}local"; SVG elements by their local name) and internal DTD entities expanded. */
export function parseXml(source) {
  const custom = {};
  let text = source.replace(/^﻿/, "");
  const doctype = /<!DOCTYPE[^[>]*(\[([\s\S]*?)\])?\s*>/i.exec(text);
  if (doctype) {
    for (const m of (doctype[2] ?? "").matchAll(/<!ENTITY\s+([\w.-]+)\s+(["'])([\s\S]*?)\2\s*>/g)) {
      custom[m[1]] = m[3];
    }
    text = text.slice(0, doctype.index) + text.slice(doctype.index + doctype[0].length);
  }
  const root = { tag: "#document", attrs: {}, children: [], text: "" };
  const stack = [{ node: root, ns: { xml: "http://www.w3.org/XML/1998/namespace" } }];
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = token.exec(text)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.node.text += m[1];
    else if (m[6] !== undefined) top.node.text += decodeEntities(m[6], custom);
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const raw = {};
      for (const a of m[4].matchAll(attrRe)) raw[a[1]] = decodeEntities(a[2] ?? a[3], custom);
      const ns = { ...top.ns };
      for (const [k, v] of Object.entries(raw)) {
        if (k === "xmlns") ns[""] = v;
        else if (k.startsWith("xmlns:")) ns[k.slice(6)] = v;
      }
      const qualify = (name, isAttr) => {
        const i = name.indexOf(":");
        if (i < 0) return isAttr || !ns[""] ? name : ns[""] === SVG_NS ? name : `{${ns[""]}}${name}`;
        const uri = ns[name.slice(0, i)];
        if (!uri) return name;
        const local = name.slice(i + 1);
        if (uri === SVG_NS && !isAttr) return local;
        if (uri === XLINK) return `xlink:${local}`;
        return `{${uri}}${local}`;
      };
      const attrs = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k !== "xmlns" && !k.startsWith("xmlns:")) attrs[qualify(k, true)] = v;
      }
      const node = { tag: qualify(m[3], false), attrs, children: [], text: "" };
      top.node.children.push(node);
      if (!m[5]) stack.push({ node, ns });
    }
  }
  const el = root.children.find((c) => c.tag !== "#text");
  if (!el) throw new Error("not an SVG file");
  return el;
}

// ------------------------------------------------------------------------------------------------ svgelements

/** Affine matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mat = {
  mul(m1, m2) { // m1 after m2
    return [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];
  },
  apply(m, [x, y]) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  },
  det: (m) => m[0] * m[3] - m[1] * m[2],
  isIdentity: (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0,
};

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const numbers = (s) => (String(s ?? "").match(NUMBER) ?? []).map(Number);

function parseTransform(text) {
  let m = IDENTITY;
  for (const [, name, args] of String(text ?? "").matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi)) {
    const v = numbers(args);
    let t = IDENTITY;
    switch (name.toLowerCase()) {
      case "matrix":
        if (v.length >= 6) t = v.slice(0, 6);
        break;
      case "translate":
        t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
        t = mat.mul(mat.mul([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewx":
        t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewy":
        t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
    }
    m = mat.mul(m, t);
  }
  return m;
}

/** svgelements Length.value() with the document's ppi; null when absent; percentages of `relative`. */
function length(value, fallback = null, relative = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") return value;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(value));
  if (!m) return fallback;
  const amount = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "": case "px": return amount;
    case "pt": return (amount * 4.0) / 3.0;
    case "pc": return amount * 16.0;
    case "mm": return amount * DEFAULT_PPI * 0.0393701;
    case "cm": return amount * DEFAULT_PPI * 0.393701;
    case "in": return amount * DEFAULT_PPI;
    case "%": return relative === null ? fallback : (amount / 100.0) * relative;
    default: return amount;
  }
}

const CSS_COLORS = "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque "
  + "ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue "
  + "5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan "
  + "00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 "
  + "darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 "
  + "darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise "
  + "00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff "
  + "firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold "
  + "ffd700 goldenrod daa520 gray 808080 grey 808080 green 008000 greenyellow adff2f honeydew f0fff0 hotpink ff69b4 "
  + "indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 "
  + "lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray "
  + "d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue "
  + "87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen "
  + "32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 "
  + "mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc "
  + "mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead "
  + "navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 "
  + "palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff "
  + "ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 "
  + "rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell "
  + "fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa "
  + "springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet "
  + "ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32";
const NAMED = (() => {
  const words = CSS_COLORS.split(" ");
  const out = { transparent: [0, 0, 0, 0] };
  for (let i = 0; i < words.length; i += 2) {
    const h = words[i + 1];
    out[words[i]] = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
  }
  return out;
})();

/** svgelements Color: [r, g, b, a] bytes, or null for "none". */
function parseColor(text) {
  if (text === undefined || text === null) return null;
  const s = String(text).trim().toLowerCase();
  if (s === "none" || s === "") return null;
  if (s[0] === "#") {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    if (h.length !== 8 || !/^[0-9a-f]+$/.test(h)) return null;
    return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const crimp = (v) => (v > 255 ? 255 : v < 0 ? 0 : Math.trunc(v));
  const alpha = (o) => {
    let op = o === undefined ? 1 : Number(o);
    if (op > 1) op = 1;
    if (op < 0) op = 0;
    return crimp(pyRound(op * 255.0));
  };
  const F = String.raw`([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)`;
  const re = (body) => new RegExp(String.raw`^${body}$`.replaceAll("F", F));
  let m = re(String.raw`rgba?\(\s*F%\s*,\s*F%\s*,\s*F%\s*(?:,\s*F\s*)?\)`).exec(s);
  if (m) return [1, 2, 3].map((i) => crimp(pyRound(Number(m[i]) * (255.0 / 100.0)))).concat(alpha(m[4]));
  m = re(String.raw`rgba?\(\s*F\s*,\s*F\s*,\s*F\s*(?:,\s*F\s*)?\)`).exec(s);
  if (m) return [1, 2, 3].map((i) => crimp(Math.trunc(Number(m[i])))).concat(alpha(m[4]));
  m = re(String.raw`hsla?\(\s*F\s*,\s*F%\s*,\s*F%\s*(?:,\s*F\s*)?\)`).exec(s);
  if (m) {
    const h = (((Number(m[1]) * Math.PI) / 180) / TAU);
    const sat = Math.min(1, Math.max(0, Number(m[2]) / 100.0));
    const l = Math.min(1, Math.max(0, Number(m[3]) / 100.0));
    const hue = (v1, v2, vh0) => {
      let vh = vh0;
      if (vh < 0) vh += 1;
      if (vh > 1) vh -= 1;
      if (6.0 * vh < 1.0) return v1 + (v2 - v1) * 6.0 * vh;
      if (2.0 * vh < 1) return v2;
      if (3 * vh < 2.0) return v1 + (v2 - v1) * ((2.0 / 3.0) - vh) * 6.0;
      return v1;
    };
    let rgb;
    if (sat === 0.0) rgb = [255.0 * l, 255.0 * l, 255.0 * l];
    else {
      const v2 = l < 0.5 ? l * (1.0 + sat) : (l + sat) - (sat * l);
      const v1 = 2 * l - v2;
      rgb = [255.0 * hue(v1, v2, h + 1.0 / 3.0), 255.0 * hue(v1, v2, h), 255.0 * hue(v1, v2, h - 1.0 / 3.0)];
    }
    return rgb.map(crimp).concat(alpha(m[4]));
  }
  return NAMED[s] ? [...NAMED[s]] : null;
}

const hexrgb = (c) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// ---- path data

/** Path segments: {type: "move"|"line"|"quad"|"cubic"|"arc"|"close", start, end, control(s), ...arc}. */
export function parsePathData(d) {
  const tokens = [];
  const re = /([MmZzLlHhVvCcSsQqTtAa])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d ?? "")) !== null) tokens.push(m[1] ?? { raw: m[2] });
  const segs = [];
  let i = 0;
  let cmd = null;
  let current = [0, 0];
  let subStart = [0, 0];
  const num = () => {
    const v = tokens[i];
    if (typeof v !== "object") throw new Error("bad path data");
    i += 1;
    return Number(v.raw);
  };
  // Arc flags may be written without separators ("a1 1 0 01.5.5"): split numbers like "01.5" into digits.
  const flag = () => {
    const v = tokens[i];
    if (typeof v !== "object") throw new Error("bad path data");
    if (v.raw.length > 1 && (v.raw[0] === "0" || v.raw[0] === "1")) {
      tokens[i] = { raw: v.raw.slice(1) };
      return Number(v.raw[0]);
    }
    i += 1;
    return Number(v.raw) ? 1 : 0;
  };
  const point = (rel) => {
    const x = num();
    const y = num();
    return rel ? [current[0] + x, current[1] + y] : [x, y];
  };
  const last = () => segs[segs.length - 1];
  while (i < tokens.length) {
    if (typeof tokens[i] === "string") {
      cmd = tokens[i];
      i += 1;
      if (cmd === "Z" || cmd === "z") {
        segs.push({ type: "close", start: current, end: subStart });
        current = subStart;
        continue;
      }
    } else if (cmd === null) {
      throw new Error("path data must start with a command");
    }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": {
        const p = point(rel);
        segs.push({ type: "move", start: current, end: p });
        current = p;
        subStart = p;
        cmd = rel ? "l" : "L";
        break;
      }
      case "L": {
        const p = point(rel);
        segs.push({ type: "line", start: current, end: p });
        current = p;
        break;
      }
      case "H": {
        const x = num();
        const p = [rel ? current[0] + x : x, current[1]];
        segs.push({ type: "line", start: current, end: p });
        current = p;
        break;
      }
      case "V": {
        const y = num();
        const p = [current[0], rel ? current[1] + y : y];
        segs.push({ type: "line", start: current, end: p });
        current = p;
        break;
      }
      case "C": {
        const c1 = point(rel);
        const c2 = point(rel);
        const p = point(rel);
        segs.push({ type: "cubic", start: current, control1: c1, control2: c2, end: p });
        current = p;
        break;
      }
      case "S": {
        const prev = last();
        const c1 = prev?.type === "cubic" ? [2 * current[0] - prev.control2[0], 2 * current[1] - prev.control2[1]] : current;
        const c2 = point(rel);
        const p = point(rel);
        segs.push({ type: "cubic", start: current, control1: c1, control2: c2, end: p });
        current = p;
        break;
      }
      case "Q": {
        const c = point(rel);
        const p = point(rel);
        segs.push({ type: "quad", start: current, control: c, end: p });
        current = p;
        break;
      }
      case "T": {
        const prev = last();
        const c = prev?.type === "quad" ? [2 * current[0] - prev.control[0], 2 * current[1] - prev.control[1]] : current;
        const p = point(rel);
        segs.push({ type: "quad", start: current, control: c, end: p });
        current = p;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rotation = num();
        const large = flag();
        const sweep = flag();
        const p = point(rel);
        segs.push(arcFromSvg(current, rx, ry, rotation, large, sweep, p));
        current = p;
        break;
      }
      default:
        throw new Error(`unknown path command ${cmd}`);
    }
  }
  return segs;
}

/** svgelements Arc._svg_parameterize: the native form (center, prx, pry, sweep). */
function arcFromSvg(start, rx, ry, rotation, largeArc, sweepFlag, end) {
  const arc = { type: "arc", start, end };
  if ((start[0] === end[0] && start[1] === end[1]) || rx === 0 || ry === 0) {
    return Object.assign(arc, { sweep: 0, prx: start, pry: start, center: start });
  }
  const rad = rotation * (Math.PI / 180.0); // math.radians
  const cosr = Math.cos(rad);
  const sinr = Math.sin(rad);
  const dx = (start[0] - end[0]) / 2;
  const dy = (start[1] - end[1]) / 2;
  const x1 = cosr * dx + sinr * dy;
  const x1sq = x1 * x1;
  const y1 = -sinr * dx + cosr * dy;
  const y1sq = y1 * y1;
  let rxs = rx * rx;
  let rys = ry * ry;
  const check = x1sq / rxs + y1sq / rys;
  if (check > 1) {
    rx *= Math.sqrt(check);
    ry *= Math.sqrt(check);
    rxs = rx * rx;
    rys = ry * ry;
  }
  const t1 = rxs * y1sq;
  const t2 = rys * x1sq;
  let c = Math.sqrt(Math.abs((rxs * rys - t1 - t2) / (t1 + t2)));
  if (Boolean(largeArc) === Boolean(sweepFlag)) c = -c;
  const cxp = (c * rx * y1) / ry;
  const cyp = (-c * ry * x1) / rx;
  const center = [cosr * cxp - sinr * cyp + (start[0] + end[0]) / 2, sinr * cxp + cosr * cyp + (start[1] + end[1]) / 2];
  const ux = (x1 - cxp) / rx;
  const uy = (y1 - cyp) / ry;
  const vx = (-x1 - cxp) / rx;
  const vy = (-y1 - cyp) / ry;
  const n = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  let dd = (ux * vx + uy * vy) / n;
  dd = Math.min(1, Math.max(-1, dd));
  let delta = Math.acos(dd) * (180.0 / Math.PI); // math.degrees
  if (ux * vy - uy * vx < 0) delta = -delta;
  delta = ((delta % 360) + 360) % 360;
  if (!sweepFlag) delta -= 360;
  // prx, pry rotated about the centre
  const turn = (TAU * rotation) / 360.0;
  const rot = mat.mul(mat.mul([1, 0, 0, 1, center[0], center[1]], [Math.cos(turn), Math.sin(turn), -Math.sin(turn),
    Math.cos(turn), 0, 0]), [1, 0, 0, 1, -center[0], -center[1]]);
  return Object.assign(arc, {
    center, prx: mat.apply(rot, [center[0] + rx, center[1]]), pry: mat.apply(rot, [center[0], center[1] + ry]),
    sweep: (TAU * delta) / 360.0, // Angle.degrees(delta).as_radians
  });
}

const dist = (p, q) => Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
const angleTo = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);

function arcPointAtT(arc, t) {
  const rotation = angleTo(arc.center, arc.prx);
  const a = dist(arc.center, arc.prx);
  const b = dist(arc.center, arc.pry);
  const [cx, cy] = arc.center;
  const cr = Math.cos(rotation);
  const sr = Math.sin(rotation);
  const ct = Math.cos(t);
  const st = Math.sin(t);
  return [cx + a * ct * cr - b * st * sr, cy + a * ct * sr + b * st * cr];
}

function arcTAtPoint(arc, p) {
  const angle = angleTo(arc.center, p) - angleTo(arc.center, arc.prx);
  const a = dist(arc.center, arc.prx);
  const b = dist(arc.center, arc.pry);
  let t = Math.atan2(a * Math.tan(angle), b);
  if ((3 * TAU) / 4 >= Math.abs(angle) % TAU && Math.abs(angle) % TAU > TAU / 4) t += TAU / 2;
  return t;
}

function arcPointAtAngle(arc, angle0) {
  const angle = angle0 - angleTo(arc.center, arc.prx);
  const a = dist(arc.center, arc.prx);
  const b = dist(arc.center, arc.pry);
  if (a === b) return arcPointAtT(arc, angle);
  let t = Math.atan2(a * Math.tan(angle), b);
  if ((3 * TAU) / 4 >= Math.abs(angle) % TAU && Math.abs(angle) % TAU > TAU / 4) t += TAU / 2;
  return arcPointAtT(arc, t);
}

/** Arc.as_quad_curves(ceil(|sweep| / (tau * 0.1))): Path.approximate_arcs_with_quads(error=0.1). */
function arcAsQuads(arc) {
  const required = Math.ceil(Math.abs(arc.sweep) / (TAU * 0.1));
  if (required === 0) return [];
  const tSlice = arc.sweep / required;
  let currentT = arcTAtPoint(arc, arcPointAtAngle(arc, angleTo(arc.center, arc.start)));
  let pStart = arc.start;
  const theta = angleTo(arc.center, arc.prx);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const a = dist(arc.center, arc.prx);
  const b = dist(arc.center, arc.pry);
  const [cx, cy] = arc.center;
  const out = [];
  for (let i = 0; i < required; i += 1) {
    const nextT = currentT + tSlice;
    const midT = (nextT + currentT) / 2;
    const pEnd = i === required - 1 ? arc.end : arcPointAtT(arc, nextT);
    const alpha = (4.0 - Math.cos(tSlice)) / 3.0;
    const cm = Math.cos(midT);
    const sm = Math.sin(midT);
    const control = [cx + alpha * (a * cm * cosT - b * sm * sinT), cy + alpha * (a * cm * sinT + b * sm * cosT)];
    out.push({ type: "quad", start: pStart, control, end: pEnd });
    pStart = pEnd;
    currentT = nextT;
  }
  return out;
}

function transformSegment(seg, m) {
  const out = { ...seg };
  for (const key of ["start", "end", "control", "control1", "control2", "center", "prx", "pry"]) {
    if (seg[key]) out[key] = mat.apply(m, seg[key]);
  }
  if (seg.type === "arc" && mat.det(m) < 0) out.sweep = -seg.sweep;
  return out;
}

// ---- the document walk (SVG.parse)

const NOT_INHERITED = ["preserveAspectRatio", "viewBox", "id", "class", "clip-path"];
const HIDDEN_CONTAINERS = new Set(["defs", "clipPath", "pattern"]);
const SHAPES = new Set(["path", "circle", "ellipse", "line", "polyline", "polygon", "rect"]);

/** The shapes of an SVG document, in drawing order, after Manim's rewrite of the root. */
export function svgShapes(source, configStyle = {}) {
  const original = typeof source === "string" ? parseXml(source) : source;
  const styleKeys = ["fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "style"];
  const rootStyle = Object.fromEntries(Object.entries(original.attrs).filter(([k]) => styleKeys.includes(k)));
  const tree = { tag: "svg", attrs: {}, children: [{ tag: "g", attrs: configStyle, children: [
    { tag: "g", attrs: rootStyle, children: original.children, text: "" }], text: "" }], text: "" };
  const byId = {};
  (function index(node) {
    if (node.attrs.id !== undefined) byId[node.attrs.id] = node;
    node.children.forEach(index);
  }(tree));

  const shapes = [];
  const styles = {};
  function walk(node, parentValues, hidden, depth, groups) {
    if (depth > 64) return;
    const tag = node.tag;
    if ((parentValues.display ?? "").toLowerCase() === "none") return;
    if (tag === "style") {
      const css = node.text.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, sel, body] of css.trim().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        for (const selector of sel.split(",")) {
          const s = selector.trim();
          if (!(s in styles)) styles[s] = body.trim();
          else styles[s] += (styles[s].endsWith(";") ? "" : ";") + body.trim();
        }
      }
      return;
    }
    const values = { ...parentValues };
    for (const k of NOT_INHERITED) delete values[k];
    const attributes = { ...node.attrs };
    let style = "";
    const addStyle = (s) => {
      if (s === undefined) return;
      style += (style.length && !style.endsWith(";") ? ";" : "") + s;
    };
    addStyle(styles["*"]);
    addStyle(styles[tag]);
    if (attributes.id !== undefined) addStyle(styles[`#${attributes.id}`]);
    if (attributes.class !== undefined) {
      for (const cls of attributes.class.split(" ")) {
        addStyle(styles[`.${cls}`]);
        addStyle(styles[`${tag}.${cls}`]);
      }
    }
    addStyle(attributes.style);
    for (const item of style.split(";")) {
      const kv = item.split(":");
      if (kv.length === 2) attributes[kv[0].trim()] = kv[1].trim();
    }
    for (const key of ["fill", "stroke"]) {
      if (attributes[key] === "currentColor") attributes[key] = attributes.color ?? values.color;
    }
    if (attributes.transform !== undefined && values.transform !== undefined) {
      attributes.transform = `${values.transform} ${attributes.transform}`;
    }
    Object.assign(values, attributes);
    if ((values.display ?? "").toLowerCase() === "none") return;
    let hide = hidden || HIDDEN_CONTAINERS.has(tag);
    // ids of the groups this element is in (Manim's id_to_vgroup_dict). MathTex parts arrive as data-manim-part,
    // which lists every open part where MathJax made the node: the nearest such list is the one that counts.
    const ids = { own: [...groups.own], parts: groups.parts };
    if (node.attrs.id && !ids.own.includes(node.attrs.id)) ids.own.push(node.attrs.id);
    if (node.attrs["data-manim-part"]) ids.parts = node.attrs["data-manim-part"].split(" ").filter(Boolean);
    let childValues = values;
    if (tag === "use") {
      const x = length(values.x, 0);
      const y = length(values.y, 0);
      childValues = { ...values };
      if (x !== 0 || y !== 0) childValues.transform = `${values.transform ?? ""} translate(${x}, ${y})`;
      for (const k of ["x", "y", "width", "height"]) delete childValues[k];
    } else if (SHAPES.has(tag) && !hide) {
      const shape = makeShape(tag, values);
      if (shape) {
        shape.groups = [...groups.own, ...groups.parts.filter((id) => !groups.own.includes(id))];
        shapes.push(shape);
      }
    } else if (tag === "text" || tag === "image") {
      hide = true;
    }
    for (const child of node.children) walk(child, childValues, hide, depth + 1, ids);
    if (tag === "use") {
      const href = node.attrs["xlink:href"] ?? node.attrs.href;
      const target = href?.startsWith("#") ? byId[href.slice(1)] : undefined;
      if (target) walk(target, childValues, hide, depth + 1, ids);
    }
  }
  walk(tree, { color: "black", fill: "black", stroke: "none" }, false, 0, { own: [], parts: [] });
  return shapes;
}

/** One shape as svgelements leaves it after reify(): geometry, residual matrix and style. */
function makeShape(tag, values) {
  const m = parseTransform(values.transform);
  let strokeWidth = length(values.stroke_width, 1.0);
  strokeWidth = length(values["stroke-width"], strokeWidth);
  const color = (key) => {
    const c = parseColor(values[key]);
    const opacity = values[`${key}-opacity`] ?? values[`${key}_opacity`];
    if (c && opacity !== undefined && Number.isFinite(Number(opacity))) {
      c[3] = Math.max(0, Math.min(255, pyRound(Number(opacity) * 255.0)));
    }
    return c;
  };
  const shape = { tag, id: values.id, fill: color("fill"), stroke: color("stroke"), matrix: IDENTITY };
  const scaleStroke = () => strokeWidth * Math.sqrt(Math.abs(mat.det(m)));
  switch (tag) {
    case "path": {
      let segs;
      try {
        segs = parsePathData(values.d);
      } catch {
        return null;
      }
      if (segs.length === 0) return null;
      segs = segs.map((s) => transformSegment(s, m)).flatMap((s) => (s.type === "arc" ? arcAsQuads(s) : [s]));
      return Object.assign(shape, { segments: segs, stroke_width: scaleStroke() });
    }
    case "line": {
      const p1 = mat.apply(m, [length(values.x1, 0), length(values.y1, 0)]);
      const p2 = mat.apply(m, [length(values.x2, 0), length(values.y2, 0)]);
      return Object.assign(shape, { p1, p2, stroke_width: scaleStroke() });
    }
    case "polyline":
    case "polygon": {
      const nums = numbers(values.points);
      const pts = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(mat.apply(m, [nums[i], nums[i + 1]]));
      if (pts.length === 0) return null;
      return Object.assign(shape, { points: pts, stroke_width: scaleStroke() });
    }
    case "rect": {
      const width = length(values.width, 1);
      const height = length(values.height, 1);
      let rx = values.rx === undefined ? null : length(values.rx, null, width);
      let ry = values.ry === undefined ? null : length(values.ry, null, height);
      if (rx === null && ry === null) rx = ry = 0;
      else if (ry === null) ry = rx;
      else if (rx === null) rx = ry;
      if (rx === 0 || ry === 0) rx = ry = 0;
      else {
        rx = Math.min(rx, width / 2.0);
        ry = Math.min(ry, height / 2.0);
      }
      Object.assign(shape, { x: length(values.x, 0), y: length(values.y, 0), width, height, rx, ry });
      return reifyBox(shape, m, strokeWidth, ["x", "y"], (s) => s.width === 0 || s.height === 0);
    }
    case "circle":
    case "ellipse": {
      let rx = length(values.rx);
      let ry = length(values.ry);
      const r = length(values.r);
      if (r !== null) rx = ry = r;
      else {
        rx ??= 1;
        ry ??= 1;
      }
      Object.assign(shape, { cx: length(values.cx, 0), cy: length(values.cy, 0), rx, ry, tag: "ellipse" });
      return reifyBox(shape, m, strokeWidth, ["cx", "cy"], (s) => {
        const sx = Math.sqrt(s.matrix[0] ** 2 + s.matrix[1] ** 2);
        const sy = Math.sqrt(s.matrix[2] ** 2 + s.matrix[3] ** 2);
        return s.rx * sx === 0 || s.ry * sy === 0;
      });
    }
    default:
      return null;
  }
}

/** Rect.reify / _RoundShape.reify: scale and translation go into the geometry; rotation, skew or a flip stay. */
function reifyBox(shape, m, strokeWidth, [kx, ky], degenerate) {
  const [sx, , , sy, tx, ty] = [m[0], m[1], m[2], m[3], m[4], m[5]];
  shape.stroke_width = strokeWidth;
  shape.matrix = m;
  if (!(sx * sy < 0) && m[1] === 0 && m[2] === 0 && sx !== 0 && sy !== 0) {
    shape.stroke_width = strokeWidth * Math.sqrt(Math.abs(mat.det(m)));
    shape[kx] = shape[kx] * sx + tx;
    shape[ky] = shape[ky] * sy + ty;
    shape.rx *= sx;
    shape.ry *= sy;
    if (shape.width !== undefined) {
      shape.width *= sx;
      shape.height *= sy;
    }
    shape.matrix = IDENTITY;
  }
  return degenerate(shape) ? null : shape;
}

// ------------------------------------------------------------------------------------------------ mobjects

const p3 = (p) => [p[0], p[1], 0.0];

/** VMobjectFromSVGPath: lines and quadratics become cubics; a close adds the line back to the last move. */
export class VMobjectFromSVGPath extends VMobject {
  static SIG = ["path_obj", "long_lines", "should_subdivide_sharp_curves", "should_remove_null_curves"];

  __init__({ path_obj, long_lines = false, should_subdivide_sharp_curves = false, should_remove_null_curves = false,
    ...kw } = {}) {
    this.path_obj = path_obj;
    this.long_lines = long_lines;
    this.should_subdivide_sharp_curves = should_subdivide_sharp_curves;
    this.should_remove_null_curves = should_remove_null_curves;
    return super.__init__(kw);
  }

  generate_points() {
    return this.handle_commands();
  }

  handle_commands() {
    const all = [];
    let lastMove = null;
    let lastTrueMove = null;
    const movePen = (pt, trueMove = false) => {
      lastMove = pt;
      if (trueMove) lastTrueMove = lastMove;
    };
    const addCubic = (start, cp1, cp2, end) => {
      all.push(start, cp1, cp2, end);
      movePen(end);
    };
    const third = (a, b, c) => [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const addQuad = (start, cp, end) => addCubic(start, third(start, cp, cp), third(cp, cp, end), end);
    const addLine = (start, end) => addCubic(start, third(start, start, end), third(start, end, end), end);
    for (const seg of this.path_obj) {
      if (seg.type === "move") movePen(p3(seg.end), true);
      else if (seg.type === "line") addLine(lastMove, p3(seg.end));
      else if (seg.type === "quad") addQuad(lastMove, p3(seg.control), p3(seg.end));
      else if (seg.type === "cubic") addCubic(lastMove, p3(seg.control1), p3(seg.control2), p3(seg.end));
      else if (seg.type === "close") {
        const d = Math.sqrt((lastMove[0] - lastTrueMove[0]) ** 2 + (lastMove[1] - lastTrueMove[1]) ** 2
          + (lastMove[2] - lastTrueMove[2]) ** 2);
        if (Math.abs(d) > 0.0001) addLine(lastMove, lastTrueMove);
      }
    }
    this.points = all.map((p) => [p[0], p[1], p[2]]);
    return this;
  }
}

/** SVGMobject.get_mob_from_shape_element, then apply_style_to_mobject and handle_transform. */
function shapeToMobject(shape, pathConfig) {
  let mob;
  switch (shape.tag) {
    case "path":
      mob = VMobjectFromSVGPath.make({ ...pathConfig, path_obj: shape.segments });
      break;
    case "line":
      mob = Line.make({ start: p3(shape.p1), end: p3(shape.p2) });
      break;
    case "rect":
      if (shape.rx === 0 || shape.ry === 0) mob = Rectangle.make({ width: shape.width, height: shape.height });
      else {
        mob = RoundedRectangle.make({ width: shape.width, height: (shape.height * shape.rx) / shape.ry,
          corner_radius: shape.rx });
        mob.stretch_to_fit_height(shape.height);
      }
      mob.shift([shape.x + shape.width / 2, shape.y + shape.height / 2, 0.0]);
      break;
    case "ellipse":
      mob = Circle.make({ radius: shape.rx });
      if (shape.rx !== shape.ry) mob.stretch_to_fit_height(2 * shape.ry);
      mob.shift([shape.cx, shape.cy, 0.0]);
      break;
    case "polygon":
      mob = Polygon.make({ vertices: shape.points.map(p3) });
      break;
    case "polyline":
      mob = VMobject.make().set_points_as_corners(shape.points.map(p3));
      break;
    default:
      return null;
  }
  if (!mob.has_points()) return null;
  mob.set_style({
    stroke_width: shape.stroke_width,
    stroke_color: shape.stroke ? hexrgb(shape.stroke) : null,
    stroke_opacity: shape.stroke ? shape.stroke[3] / 255.0 : null,
    fill_color: shape.fill ? hexrgb(shape.fill) : null,
    fill_opacity: shape.fill ? shape.fill[3] / 255.0 : null,
  });
  if (shape.matrix && !mat.isIdentity(shape.matrix)) {
    const [a, b, c, d, e, f] = shape.matrix;
    mob.apply_matrix([[a, c], [b, d]]);
    mob.shift([e, f, 0.0]);
  }
  return mob;
}

const SVG_CACHE = new Map();
const SVG_CACHE_LIMIT = 400;

export function clearSvgCache() {
  SVG_CACHE.clear();
}

const SVG_DEFAULT = { color: null, opacity: null, fill_color: null, fill_opacity: null, stroke_width: 0,
  stroke_color: null, stroke_opacity: null };

export class SVGMobject extends VMobject {
  static SIG = ["file_name", "should_center", "height", "width", "color", "opacity", "fill_color", "fill_opacity",
    "stroke_color", "stroke_opacity", "stroke_width", "svg_default", "path_string_config", "use_svg_cache"];

  __init__({ file_name = null, should_center = true, height = 2, width = null, color = null, opacity = null,
    fill_color = null, fill_opacity = null, stroke_color = null, stroke_opacity = null, stroke_width = null,
    svg_default = null, path_string_config = null, use_svg_cache = true, svg_text = null, ...kw } = {}) {
    super.__init__({ ...kw, color: null, stroke_color: null, fill_color: null });
    this.file_name = file_name;
    this.svg_text = svg_text;
    this.should_center = should_center;
    this.svg_height = height;
    this.svg_width = width;
    this.color = new ManimColor(color);
    this.opacity = opacity;
    this.fill_color = fill_color;
    this.fill_opacity = fill_opacity;
    this.stroke_color = stroke_color;
    this.stroke_opacity = stroke_opacity;
    this.stroke_width = stroke_width ?? 0;
    this.svg_default = svg_default ?? { ...SVG_DEFAULT };
    this.path_string_config = path_string_config ?? {};
    this.id_to_vgroup_dict = {};
    this.init_svg_mobject(use_svg_cache);
    this.set_style({ fill_color, fill_opacity, stroke_color, stroke_opacity, stroke_width });
    this.move_into_position();
    return this;
  }

  /** Manim keeps every parsed file (SVG_HASH_TO_MOB_MAP): a repeat copies the parts and skips the flip. */
  init_svg_mobject(use_svg_cache) {
    const key = use_svg_cache ? this.hash_seed() : null;
    if (key !== null && SVG_CACHE.has(key)) {
      const mob = SVG_CACHE.get(key).copy();
      this.add(...mob.iter());
      this.id_to_vgroup_dict = mob.id_to_vgroup_dict;
      return this;
    }
    this.generate_mobject();
    if (key !== null && !this.svg_incomplete) {
      if (SVG_CACHE.size >= SVG_CACHE_LIMIT) SVG_CACHE.delete(SVG_CACHE.keys().next().value);
      SVG_CACHE.set(key, this.copy());
    }
    return this;
  }

  hash_seed() {
    return JSON.stringify([this.constructor.name, this.svg_default, this.path_string_config, this.file_name,
      this.file_name === null ? this.svg_text : null]);
  }

  get_svg_text() {
    if (this.svg_text !== null) return this.svg_text;
    if (this.file_name === null) throw new Error("Must specify file for SVGMobject");
    return resources.text(this.file_name);
  }

  /** Group ids that exist even when empty (dvisvgm writes a <g id> for every MathTex part). */
  expected_group_ids() {
    return [];
  }

  /** The file's shapes, as svgelements leaves them. Text makes its own without a file. */
  svg_shapes() {
    return svgShapes(this.get_svg_text(), this.generate_config_style_dict());
  }

  generate_mobject() {
    const groups = { root: VGroup.make() };
    for (const id of this.expected_group_ids()) groups[id] = VGroup.make();
    const mobs = [];
    for (const shape of this.svg_shapes()) {
      const mob = shapeToMobject(shape, this.path_string_config);
      if (!mob) continue;
      mobs.push(mob);
      groups.root.add(mob);
      for (const id of shape.groups ?? []) (groups[id] ??= VGroup.make()).add(mob);
    }
    this.add(...mobs);
    this.id_to_vgroup_dict = groups;
    this.flip(RIGHT);
    return this;
  }

  generate_config_style_dict() {
    const keys = { fill: ["color", "fill_color"], "fill-opacity": ["opacity", "fill_opacity"],
      stroke: ["color", "stroke_color"], "stroke-opacity": ["opacity", "stroke_opacity"],
      "stroke-width": ["stroke_width"] };
    const result = {};
    for (const [svgKey, styleKeys] of Object.entries(keys)) {
      for (const k of styleKeys) {
        const v = this.svg_default[k];
        if (v === null || v === undefined) continue;
        result[svgKey] = v instanceof ManimColor ? v.to_hex() : String(v);
      }
    }
    return result;
  }

  move_into_position() {
    if (this.should_center) this.center();
    if (this.svg_height !== null && this.svg_height !== undefined) this.set({ height: this.svg_height });
    if (this.svg_width !== null && this.svg_width !== undefined) this.set({ width: this.svg_width });
    return this;
  }
}

export { BLACK, VGroup };
