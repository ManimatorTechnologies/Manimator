// Small helpers shared by the components.

import { store } from "./store.js";

// Manim's default 16:9 frame is 14.22 x 8 units; previews are rendered at 1280 x 720.
export const FW = 128 / 9;
export const FH = 8;
export const PW = 1280;
export const PH = 720;

export const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export const snap = (v, step = 0.25) => round(Math.round(v / step) * step, 4);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmt(v, decimals = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  return String(round(Number(v), decimals));
}

let gestureCounter = 0;
export const newGesture = () => `g${Date.now().toString(36)}${(gestureCounter++).toString(36)}`;

export const CATEGORY_COLORS = {
  Appear: "#83C167",
  Disappear: "#FC6255",
  Emphasize: "#F7D96F",
  Transform: "#B189C6",
  Move: "#58C4DD",
  Camera: "#5CD0B3",
  Zoom: "#F0AC5F",
  Grid: "#C55F73",
  Vectors: "#FF862F",
  Custom: "#E07BB5", // customizations (Customizations page)
};
export const CATEGORY_ICONS = {
  Appear: "✦", Disappear: "✧", Emphasize: "✺", Transform: "⇄", Move: "➜", Camera: "◉", Zoom: "⊕", Grid: "⊞", Vectors: "↗",
  Custom: "✦",
};

export const SHORT_LABELS = {
  RoundedRectangle: "Rounded",
  RegularPolygon: "Regular",
  DoubleArrow: "Double Arrow",
  DashedLine: "Dashed",
  MarkupText: "Markup",
  DecimalNumber: "Number",
  NumberLine: "Number Line",
  NumberPlane: "Plane",
  SurroundingRectangle: "Surround",
  RegularPolygram: "Polygram",
  AnnotationDot: "Marker",
  LabeledDot: "Label Dot",
  AnnularSector: "Ring Slice",
  ArcPolygon: "Arc Polygon",
  ArcBetweenPoints: "Arc (points)",
  CurvedArrow: "Curved Arrow",
  CurvedDoubleArrow: "Curved Both",
  RightAngle: "Right Angle",
  LabeledLine: "Label Line",
  LabeledArrow: "Label Arrow",
  BulletedList: "Bullets",
  IntegerMatrix: "Int Matrix",
  DecimalMatrix: "Dec Matrix",
  IntegerTable: "Int Table",
  DecimalTable: "Dec Table",
  ComplexPlane: "Complex",
  PolarPlane: "Polar",
  FunctionGraph: "Function",
  ParametricFunction: "Parametric",
  ImplicitFunction: "Implicit",
  BarChart: "Bar Chart",
  ArrowVectorField: "Vector Field",
  DiGraph: "Digraph",
  ImageMobject: "Image",
  SVGMobject: "SVG",
  BraceLabel: "Brace+Label",
  BraceBetweenPoints: "Brace (pts)",
  BackgroundRectangle: "Backdrop",
  DashedVMobject: "Dashed Copy",
  TangentLine: "Tangent",
  Line3D: "Line 3D",
  Arrow3D: "Arrow 3D",
  Dot3D: "Dot 3D",
  ThreeDAxes: "3D Axes",
  Tetrahedron: "Tetra",
  Octahedron: "Octa",
  Icosahedron: "Icosa",
  Dodecahedron: "Dodeca",
};

export function animCategory(a) {
  if (a.anim === store.catalog.animate) return "Move";
  return store.specs.animations[a.anim]?.category ?? "Move";
}

export function animParams(a) {
  if (a.anim === store.catalog.animate) return store.specs.methods[a.method]?.params ?? [];
  return store.specs.animations[a.anim]?.params ?? [];
}

/** A scene action (camera move, grid transformation...): it belongs to the scene and has no target object. */
export const isAction = (a) => (store.specs.animations[a.anim]?.sceneKinds.length ?? 0) > 0;

/** An object type's name as the editor shows it: a customization's own name ("Battery"), else the key. */
export const typeLabel = (key) => store.specs.mobjects[key]?.label ?? key;

/** A method's name as people read it ("To corner"), not as Python writes it. */
export const methodLabel = (key) => store.specs.methods[key]?.label ?? key;

/** Short name of an animation, as on its timeline block. */
export const animName = (a) => (a.anim === store.catalog.animate ? methodLabel(a.method) : store.specs.animations[a.anim]?.label ?? a.anim);

export function animSummary(a, names) {
  if (isAction(a)) {
    const spec = store.specs.animations[a.anim];
    const objs = spec.params.flatMap((p) => (p.kind === "mobref" ? [a.params[p.name]] : p.kind === "mobrefs" ? a.params[p.name] ?? [] : []));
    return objs.length ? `${spec.label} (${objs.map((i) => names[i] ?? "?").join(", ")})` : spec.label;
  }
  const target = names[a.target] ?? "?";
  if (a.anim === store.catalog.animate) return `${methodLabel(a.method)} (${target})`;
  const spec = store.specs.animations[a.anim];
  const other = spec?.params.find((p) => p.kind === "mobref");
  const name = spec?.kit ? spec.label : a.anim; // a customization by its own name
  if (other) return `${name}(${target} → ${names[a.params[other.name]] ?? "?"})`;
  return `${name}(${target})`;
}

// ---- scene kinds (mirrors registry/scenes.py and model/ops.py) ----
export const kindOf = (sc) => store.specs.kinds[sc.kind] ?? store.specs.kinds.Scene;

/** Whether the scene class draws something itself (a grid, basis vectors), so a scene with no objects is not blank. */
export function drawsOwnContent(sc) {
  const options = kindOf(sc).options;
  const on = (name) => !!(sc.options[name] ?? options.find((o) => o.name === name)?.default);
  if (sc.kind === "LinearTransformationScene") return ["include_background_plane", "include_foreground_plane", "show_basis_vectors"].some(on);
  if (sc.kind === "VectorScene") return (sc.options.background ?? "plane") !== "none" || on("basis_vectors");
  return false;
}

/** The scene actions this kind of scene can do. */
export const sceneActions = (sc) => store.catalog.animations.filter((a) => a.sceneKinds.includes(sc.kind));

/** Ids of the objects held by a group: they come, go and move with it. */
export function groupMembers(sc) {
  const owned = new Set();
  for (const m of sc.mobjects) if (store.specs.mobjects[m.type].params.some((p) => p.name === "members" && p.kind === "mobrefs")) {
    for (const id of m.params.members ?? []) owned.add(id);
  }
  return owned;
}

/** How an object takes part in a LinearTransformationScene: its own choice, or the automatic one. */
export function transformRole(m) {
  const role = m.transform_role === "vector" && !store.catalog.vectorTypes.includes(m.type) ? "" : m.transform_role;
  return role || store.specs.mobjects[m.type].transformRole;
}

// ---- references between objects (mirrors model/ops.py) ----
export function mobjectRefs(m) {
  const refs = new Set();
  for (const p of store.specs.mobjects[m.type].params) if (p.kind === "mobref" && m.params[p.name]) refs.add(m.params[p.name]);
  for (const c of m.methods) {
    for (const p of store.specs.methods[c.method]?.params ?? []) {
      if (p.kind === "mobref" && c.args[p.name]) refs.add(c.args[p.name]);
    }
  }
  return refs;
}

/** The object plus everything that (indirectly) needs it to be built first. */
export function dependents(scene, id) {
  const result = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of scene.mobjects) {
      if (result.has(m.id)) continue;
      for (const r of mobjectRefs(m)) {
        if (result.has(r)) {
          result.add(m.id);
          changed = true;
          break;
        }
      }
    }
  }
  return result;
}

/** [[id, name]] an object reference may point at. Setup refs exclude anything that would make a loop. */
export function refChoices(scene, ownerId, setup) {
  const excluded = setup && ownerId ? dependents(scene, ownerId) : new Set([ownerId]);
  return scene.mobjects.filter((m) => !excluded.has(m.id)).map((m) => [m.id, m.name]);
}

export function sceneSeconds(scene) {
  return scene.steps.reduce((t, s) => t + (s.kind === "wait" ? s.duration : s.run_time), 0);
}
