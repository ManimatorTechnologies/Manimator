// Fonts the way Manim's text reaches the screen: Pango + HarfBuzz lay glyphs out, cairo writes their outlines into
// an SVG file, and SVGMobject reads it back.
//
// What this reproduces:
// - fontconfig-style matching of a family/weight/slant request onto the bundled files (manimator/web/fonts/). A
//   family without italic faces (DejaVu) gets fontconfig's synthetic oblique: a 0.2 shear,
// - Pango's font fallback: characters the chosen face lacks (Greek letters in Crimson Pro, say) come from the
//   family's fallback (a DejaVu face, which covers nearly everything),
// - HarfBuzz shaping for the Latin script: GSUB ligatures (single, multiple and ligature substitutions of the
//   default features) and GPOS pair kerning, every value scaled with HarfBuzz's fixed-point rounding into Pango
//   units (1/1024 px),
// - cairo's glyph outlines: FreeType's contour walk, quadratics as cubics, points on cairo's 1/256 px grid,
//   written with cairo's number printing (6 decimals; more below 0.1).
//
// Manimator draws text with Crimson Pro unless an object names another family (the exported Python asks for it
// with Text.set_default). The tests that compare with Manim's own output set DejaVu Sans back.

const PANGO_SCALE = 1024;

const faceSet = (dir, prefix, fallback) => ({ dir, fallback, regular: `${prefix}-Regular.ttf`, bold: `${prefix}-Bold.ttf`,
  italic: `${prefix}-Italic.ttf`, boldItalic: `${prefix}-BoldItalic.ttf` });

/** Every family there is, by name: the folder under the fonts URL, the face files (no italic ones: synthetic
 *  oblique) and the family that draws the characters it lacks. */
export const FONT_FILES = {
  "Crimson Pro": faceSet("crimson-pro", "CrimsonPro", "DejaVu Serif"),
  "STIX Two Text": faceSet("stix-two-text", "STIXTwoText", "DejaVu Serif"),
  Tinos: faceSet("tinos", "Tinos", "DejaVu Serif"),
  "CMU Serif": faceSet("cmu-serif", "CMUSerif", "DejaVu Serif"),
  "Source Serif 4": faceSet("source-serif-4", "SourceSerif4", "DejaVu Serif"),
  Inter: faceSet("inter", "Inter", "DejaVu Sans"),
  Geist: faceSet("geist", "Geist", "DejaVu Sans"),
  "Source Sans 3": faceSet("source-sans-3", "SourceSans3", "DejaVu Sans"),
  "IBM Plex Sans": faceSet("ibm-plex-sans", "IBMPlexSans", "DejaVu Sans"),
  Lato: faceSet("lato", "Lato", "DejaVu Sans"),
  "DejaVu Sans": { dir: "dejavu", fallback: null, regular: "DejaVuSans.ttf", bold: "DejaVuSans-Bold.ttf" },
  "DejaVu Sans Mono": { dir: "dejavu", fallback: "DejaVu Sans", regular: "DejaVuSansMono.ttf",
    bold: "DejaVuSansMono-Bold.ttf" },
  "DejaVu Serif": { dir: "dejavu", fallback: "DejaVu Sans", regular: "DejaVuSerif.ttf", bold: "DejaVuSerif-Bold.ttf" },
};

/** Pango's generic names, as fontconfig answers them where only DejaVu is installed. */
const GENERIC = { sans: "DejaVu Sans", "sans-serif": "DejaVu Sans", serif: "DejaVu Serif", monospace: "DejaVu Sans Mono",
  mono: "DejaVu Sans Mono" };

let defaultFamily = "Crimson Pro";

/** The family text gets when it names none ("" in Manim). */
export const getDefaultFamily = () => defaultFamily;
export function setDefaultFamily(name) {
  if (!FONT_FILES[name]) throw new Error(`unknown font family ${name}`);
  defaultFamily = name;
}

/** Pango weight names (Manim's NORMAL, BOLD...) as numbers. */
export const WEIGHTS = { THIN: 100, ULTRALIGHT: 200, LIGHT: 300, SEMILIGHT: 350, BOOK: 380, NORMAL: 400, MEDIUM: 500,
  SEMIBOLD: 600, BOLD: 700, ULTRABOLD: 800, HEAVY: 900, ULTRAHEAVY: 1000 };

const faces = new Map(); // "dir/file" -> Face

/** The files of a family, as paths under the fonts URL. */
export function familyPaths(family) {
  const f = FONT_FILES[family];
  return ["regular", "bold", "italic", "boldItalic"].filter((k) => f[k]).map((k) => `${f.dir}/${f[k]}`);
}

/** Makes a parsed font (opentype.js) available under its path ("crimson-pro/CrimsonPro-Regular.ttf"). */
export function registerFont(path, otFont) {
  faces.set(path, new Face(path, otFont));
}

export const fontsLoaded = () => faces.size > 0;
const familyLoaded = (family) => familyPaths(family).every((p) => faces.has(p));

/** The family a Pango font description names: a bundled one, a generic name, or fontconfig's default. */
export function familyOf(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return defaultFamily;
  if (GENERIC[n]) return GENERIC[n];
  for (const key of Object.keys(FONT_FILES)) if (key.toLowerCase() === n) return key;
  return "DejaVu Sans";
}

let source = null; // { baseUrl, opentype }: where families not loaded yet come from
const loading = new Map(); // family -> Promise

function loadFamily(family) {
  if (familyLoaded(family)) return Promise.resolve();
  if (!loading.has(family)) {
    const { baseUrl, opentype } = source;
    loading.set(family, Promise.all(familyPaths(family).filter((p) => !faces.has(p)).map(async (path) => {
      const response = await fetch(`${baseUrl}/${path}`);
      if (!response.ok) throw new Error(`font ${path}: ${response.status}`);
      registerFont(path, opentype.parse(await response.arrayBuffer()));
    })).finally(() => loading.delete(family)));
  }
  return loading.get(family);
}

/** Remembers where the fonts are and loads the default family with its fallback (the rest come with ensureFonts). */
export async function loadFonts(baseUrl, opentype) {
  source = { baseUrl: baseUrl.replace(/\/+$/, ""), opentype };
  const fallback = FONT_FILES[defaultFamily].fallback;
  await Promise.all([defaultFamily, ...(fallback ? [fallback] : [])].map(loadFamily));
}

/** Font names in a scene plan: font= arguments, t2f values and markup's font / face / font_family attributes. */
function namedFamilies(plan) {
  const names = new Set();
  const visit = (v, key) => {
    if (typeof v === "string") {
      if (key === "font") names.add(v);
      for (const m of v.matchAll(/\b(?:font|face|font_family|font_desc)\s*=\s*(["'])(.*?)\1/g)) names.add(m[2]);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, null));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "t2f" && x && typeof x === "object" && !Array.isArray(x)) Object.values(x).forEach((f) => names.add(f));
        visit(x, k);
      }
    }
  };
  visit(plan, null);
  return names;
}

/** Loads the families a scene plan uses (and their fallbacks) that aren't loaded yet. A family that fails to load
 *  is drawn with the default one. */
export async function ensureFonts(plan) {
  if (!source) return;
  const want = new Set([defaultFamily]);
  for (const name of namedFamilies(plan)) want.add(familyOf(String(name).split(",")[0]));
  if (JSON.stringify(plan).includes('"Code"')) want.add("DejaVu Sans Mono"); // Code draws with Monospace
  for (const fam of [...want]) if (FONT_FILES[fam].fallback) want.add(FONT_FILES[fam].fallback);
  await Promise.all([...want].map((fam) => loadFamily(fam).catch((e) => console.warn(`${fam}: ${e.message}`))));
}

/** fontconfig's choice for a Pango font description: the face, whether it is slanted synthetically, and the face
 *  (and slant) for the characters it lacks. */
export function resolveFont(family = "", slant = "NORMAL", weight = "NORMAL") {
  let fam = familyOf(family);
  if (!familyLoaded(fam)) fam = defaultFamily; // not fetched (or failed): drawn with the default family
  const files = FONT_FILES[fam];
  const w = typeof weight === "number" ? weight : WEIGHTS[String(weight).toUpperCase()] ?? 400;
  const bold = Math.abs(w - 700) < Math.abs(w - 400);
  const italic = String(slant).toUpperCase() !== "NORMAL";
  const pick = (f) => (italic && f.italic ? (bold ? f.boldItalic : f.italic) : bold ? f.bold : f.regular);
  const face = faces.get(`${files.dir}/${pick(files)}`);
  if (!face) throw new Error(`font ${pick(files)} isn't loaded`);
  const fb = files.fallback && FONT_FILES[files.fallback];
  const fallback = (fb && faces.get(`${fb.dir}/${pick(fb)}`)) || null;
  return { face, oblique: italic && !files.italic, fallback, fallbackOblique: italic && !fb?.italic };
}

/** Pango's itemizing by font: runs of characters for the face, or for the fallback face where it lacks them. */
export function fontRuns(text, face, fallback) {
  const runs = [];
  for (const ch of text) {
    const useFallback = fallback !== null && !face.has(ch) && fallback.has(ch);
    const last = runs[runs.length - 1];
    if (last && last.fallback === useFallback) last.text += ch;
    else runs.push({ text: ch, fallback: useFallback });
  }
  return runs;
}

// ------------------------------------------------------------------------------------------------ sizes

/** A Pango font size in points (font_desc size) as the numbers Pango and HarfBuzz use at 96 dpi. */
export function pangoSize(points) {
  const units = Math.floor(points * PANGO_SCALE + 0.5); // pango_units_from_double
  const pixels = ((units / PANGO_SCALE) * 96) / 72;
  return { pixels, scale: Math.trunc(pixels * PANGO_SCALE) };
}

/** HarfBuzz's em_scale: font units to Pango units for a face with `upem`, at hb scale `scale`. */
export function emScaler(scale, upem) {
  const mult = Math.floor((scale * 65536) / upem);
  return (v) => Math.floor((v * mult + 32768) / 65536);
}

// ------------------------------------------------------------------------------------------------ shaping

const DEFAULT_FEATURES = ["ccmp", "locl", "rlig", "liga", "clig", "calt"];
const NO_LIGATURES = new Set(["liga", "dlig", "clig", "hlig"]);

function coverageIndex(cov, gid) {
  if (!cov) return -1;
  if (cov.format === 1) return cov.glyphs.indexOf(gid);
  for (const r of cov.ranges) if (gid >= r.start && gid <= r.end) return r.index + gid - r.start;
  return -1;
}

function classOf(def, gid) {
  if (!def) return 0;
  if (def.format === 1) {
    const i = gid - def.startGlyph;
    return i >= 0 && i < def.classes.length ? def.classes[i] : 0;
  }
  for (const r of def.ranges) if (gid >= r.start && gid <= r.end) return r.classId;
  return 0;
}

class Face {
  constructor(file, font) {
    this.file = file;
    this.font = font;
    this.upem = font.unitsPerEm;
    this.ascender = font.tables.hhea.ascender;
    this.descender = font.tables.hhea.descender;
    this.lineGap = font.tables.hhea.lineGap ?? 0;
    this.gsubLookups = this.lookupsFor(font.tables.gsub, DEFAULT_FEATURES);
    this.gsubLookupsNoLiga = this.lookupsFor(font.tables.gsub, DEFAULT_FEATURES.filter((f) => !NO_LIGATURES.has(f)));
    this.kernLookups = this.lookupsFor(font.tables.gpos, ["kern"]);
    this.outlines = new Map();
  }

  /** Lookup indexes (in LookupList order, as HarfBuzz applies them) of `features` for the Latin script. */
  lookupsFor(table, features) {
    if (!table) return [];
    const script = table.scripts.find((s) => s.tag === "latn") ?? table.scripts.find((s) => s.tag === "DFLT");
    if (!script) return [];
    const out = new Set();
    for (const fi of script.script.defaultLangSys.featureIndexes) {
      const f = table.features[fi];
      if (features.includes(f.tag)) f.feature.lookupListIndexes.forEach((i) => out.add(i));
    }
    return [...out].sort((a, b) => a - b);
  }

  glyphIndex(char) {
    return this.font.charToGlyphIndex(char);
  }

  /** Whether the face draws `char` (white space and controls count as drawn: they never fall back). */
  has(char) {
    return /[\s\p{Cc}]/u.test(char) || this.glyphIndex(char) > 0;
  }

  advance(gid) {
    return this.font.glyphs.get(gid).advanceWidth ?? 0;
  }

  /** The glyphs for `text`: [{gid, cluster}] after GSUB, and each glyph's extra advance from GPOS kerning. */
  shape(text, { ligatures = true } = {}) {
    const chars = [...text];
    let glyphs = chars.map((ch, i) => ({ gid: this.glyphIndex(ch), cluster: i }));
    const gsub = this.font.tables.gsub;
    for (const li of ligatures ? this.gsubLookups : this.gsubLookupsNoLiga) {
      glyphs = this.applySubstitution(gsub.lookups[li], glyphs);
    }
    const kern = glyphs.map(() => 0);
    const gpos = this.font.tables.gpos;
    for (const li of this.kernLookups) this.applyPairs(gpos.lookups[li], glyphs, kern);
    return { glyphs, kern };
  }

  applySubstitution(lookup, glyphs) {
    const out = [];
    let i = 0;
    while (i < glyphs.length) {
      let done = false;
      for (const st of lookup.subtables) {
        const g = glyphs[i];
        const ci = coverageIndex(st.coverage, g.gid);
        if (ci < 0) continue;
        if (lookup.lookupType === 1) {
          const gid = st.substFormat === 1 ? (g.gid + st.deltaGlyphId) & 0xffff : st.substitute[ci];
          out.push({ ...g, gid });
          i += 1;
          done = true;
        } else if (lookup.lookupType === 2) {
          for (const gid of st.sequences[ci]) out.push({ ...g, gid });
          i += 1;
          done = true;
        } else if (lookup.lookupType === 4) {
          for (const lig of st.ligatureSets[ci]) {
            const comps = lig.components;
            if (comps.every((c, k) => glyphs[i + 1 + k]?.gid === c)) {
              out.push({ gid: lig.ligGlyph, cluster: g.cluster });
              i += 1 + comps.length;
              done = true;
              break;
            }
          }
        }
        if (done) break;
      }
      if (!done) {
        out.push(glyphs[i]);
        i += 1;
      }
    }
    return out;
  }

  applyPairs(lookup, glyphs, kern) {
    if (lookup.lookupType !== 2) return;
    let i = 0;
    while (i < glyphs.length - 1) {
      const a = glyphs[i].gid;
      const b = glyphs[i + 1].gid;
      let step = 1;
      for (const st of lookup.subtables) {
        const ci = coverageIndex(st.coverage, a);
        if (ci < 0) continue;
        let v1 = null;
        let v2 = null;
        let matched = false;
        if (st.posFormat === 1) {
          const pair = st.pairSets[ci]?.find((p) => p.secondGlyph === b);
          if (pair) {
            v1 = pair.value1;
            v2 = pair.value2;
            matched = true;
          }
        } else {
          const rec = st.classRecords[classOf(st.classDef1, a)]?.[classOf(st.classDef2, b)];
          if (rec) {
            v1 = rec.value1;
            v2 = rec.value2;
          }
          matched = true;
        }
        if (!matched) continue;
        if (v1?.xAdvance) kern[i] += v1.xAdvance;
        if (v2?.xAdvance) kern[i + 1] += v2.xAdvance;
        if (st.valueFormat2) step = 2;
        break;
      }
      i += step;
    }
  }

  /** FreeType's walk over a TrueType glyph: per contour a start and [line|conic] segments, in font units. */
  contours(gid) {
    if (this.outlines.has(gid)) return this.outlines.get(gid);
    const glyph = this.font.glyphs.get(gid);
    if (glyph.points === undefined && glyph.getPath) glyph.getPath();
    const pts = glyph.points ?? [];
    const out = [];
    let first = 0;
    for (let k = 0; k < pts.length; k += 1) {
      if (!pts[k].lastPointOfContour) continue;
      out.push(walkContour(pts.slice(first, k + 1)));
      first = k + 1;
    }
    this.outlines.set(gid, out);
    return out;
  }
}

/** FT_Outline_Decompose for one contour (points {x, y, onCurve}); midpoints stay exact. */
function walkContour(points) {
  const P = (p) => [p.x, p.y];
  const n = points.length;
  let start = P(points[0]);
  const last = P(points[n - 1]);
  let index = 0;
  let limit = n - 1;
  if (!points[0].onCurve) {
    if (points[n - 1].onCurve) {
      start = last;
      limit -= 1;
    } else {
      start = [(start[0] + last[0]) / 2, (start[1] + last[1]) / 2];
    }
    index = -1;
  }
  const segs = [];
  let closed = false;
  while (index < limit) {
    index += 1;
    const p = points[index];
    if (p.onCurve) {
      segs.push({ type: "line", to: P(p) });
      continue;
    }
    let control = P(p);
    for (;;) {
      if (index < limit) {
        index += 1;
        const q = points[index];
        if (q.onCurve) {
          segs.push({ type: "conic", control, to: P(q) });
          break;
        }
        const middle = [(control[0] + q.x) / 2, (control[1] + q.y) / 2];
        segs.push({ type: "conic", control, to: middle });
        control = P(q);
        continue;
      }
      segs.push({ type: "conic", control, to: start });
      closed = true;
      break;
    }
    if (closed) break;
  }
  if (!closed) segs.push({ type: "line", to: start });
  return { start, segs };
}

// ------------------------------------------------------------------------------------------------ cairo numbers

function roundHalfEvenDigits(abs, digits) {
  const s = abs.toFixed(Math.min(100, digits + 20));
  const dot = s.indexOf(".");
  const intPart = s.slice(0, dot);
  const frac = s.slice(dot + 1);
  const keep = frac.slice(0, digits);
  const rest = frac.slice(digits);
  const half = `5${"0".repeat(rest.length - 1)}`;
  let up = rest > half;
  if (rest === half) up = Number(keep.length ? keep[keep.length - 1] : intPart[intPart.length - 1]) % 2 === 1;
  if (!up) return `${intPart}.${keep}`;
  // add one unit in the last kept place
  const digitsAll = (intPart + keep).split("").map(Number);
  let i = digitsAll.length - 1;
  while (i >= 0) {
    if (digitsAll[i] === 9) {
      digitsAll[i] = 0;
      i -= 1;
    } else {
      digitsAll[i] += 1;
      break;
    }
  }
  if (i < 0) digitsAll.unshift(1);
  const joined = digitsAll.join("");
  const cut = joined.length - keep.length;
  return `${joined.slice(0, cut)}.${joined.slice(cut)}`;
}

/** A coordinate as cairo writes it into SVG (_cairo_dtostr) and svgelements reads it back. */
export function cairoNumber(d) {
  if (d === 0 || !Number.isFinite(d)) return 0;
  const abs = Math.abs(d);
  let digits = 6;
  if (abs < 0.1) {
    const s = abs.toFixed(18);
    let zeros = 0;
    for (let i = 2; i < s.length && s[i] === "0"; i += 1) zeros += 1;
    digits = zeros + 6;
    if (digits >= 18) digits = 18;
  }
  const v = Number(roundHalfEvenDigits(abs, digits));
  return d < 0 ? -v : v;
}

/** cairo's fixed point (24.8): the nearest 1/256 as an integer, ties to even. */
export function cairoFixedInt(v) {
  const x = v * 256;
  let r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2);
  return r;
}

export const cairoFixed = (v) => cairoFixedInt(v) / 256;

/** cairo_path_fixed: the ops a glyph outline becomes, with cairo's rules for degenerate and collinear lines. */
class CairoPath {
  constructor() {
    this.ops = []; // {op: "M"|"L"|"C"|"Z", pts}
    this.current = null;
    this.lastMove = null;
    this.needsMove = false;
  }

  lastOp() {
    return this.ops.length ? this.ops[this.ops.length - 1].op : null;
  }

  moveTo(p) {
    this.needsMove = true;
    this.current = p;
    this.lastMove = p;
  }

  applyMove() {
    if (!this.needsMove) return;
    this.needsMove = false;
    this.ops.push({ op: "M", pts: [this.current] });
  }

  penultimate() {
    const prev = this.ops[this.ops.length - 2];
    return prev.pts[prev.pts.length - 1];
  }

  dropLine() {
    this.ops.pop();
    const last = this.ops[this.ops.length - 1];
    this.current = last.pts[last.pts.length - 1];
  }

  lineTo(p) {
    if (this.current === null) return this.moveTo(p);
    this.applyMove();
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    if (this.lastOp() !== "M" && same(p, this.current)) return undefined;
    if (this.lastOp() === "L") {
      const q = this.penultimate();
      if (same(q, this.current)) this.dropLine();
      else {
        const prev = [this.current[0] - q[0], this.current[1] - q[1]];
        const self = [p[0] - this.current[0], p[1] - this.current[1]];
        const equal = prev[1] * self[0] === self[1] * prev[0];
        const backwards = prev[0] * self[0] < 0 || prev[1] * self[1] < 0;
        if (equal && !backwards) this.dropLine();
      }
    }
    this.ops.push({ op: "L", pts: [p] });
    this.current = p;
    return undefined;
  }

  curveTo(c1, c2, p) {
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    if (this.current && same(this.current, p) && same(c1, p) && same(c2, p)) return this.lineTo(p);
    this.applyMove();
    if (this.lastOp() === "L" && same(this.penultimate(), this.current)) this.dropLine();
    this.ops.push({ op: "C", pts: [c1, c2, p] });
    this.current = p;
    return undefined;
  }

  close() {
    if (this.current === null) return;
    this.lineTo(this.lastMove);
    if (this.lastOp() === "L") this.dropLine();
    this.needsMove = true;
    this.ops.push({ op: "Z", pts: [] });
    this.current = this.lastMove;
  }
}

/** A glyph's outline in px (y down) at `pixels` per em, as path segments for VMobjectFromSVGPath (before the
 *  glyph's position is added). `shear` is a synthetic oblique (x += shear * y, font units up). */
export function glyphSegments(face, gid, pixels, shear = 0) {
  const k = pixels / face.upem;
  const map = ([x, y]) => [(x + shear * y) * k, -y * k];
  const fixed = ([x, y]) => [cairoFixedInt(x), cairoFixedInt(y)];
  const path = new CairoPath();
  for (const contour of face.contours(gid)) {
    path.close(); // cairo-ft's move_to callback closes the previous contour first
    let cur = map(contour.start);
    path.moveTo(fixed(cur));
    for (const s of contour.segs) {
      const to = map(s.to);
      if (s.type === "line") path.lineTo(fixed(to));
      else {
        const c = map(s.control);
        const c1 = [cur[0] + (2.0 / 3.0) * (c[0] - cur[0]), cur[1] + (2.0 / 3.0) * (c[1] - cur[1])];
        const c2 = [to[0] + (2.0 / 3.0) * (c[0] - to[0]), to[1] + (2.0 / 3.0) * (c[1] - to[1])];
        path.curveTo(fixed(c1), fixed(c2), fixed(to));
      }
      cur = to;
    }
  }
  path.close();
  const num = ([x, y]) => [cairoNumber(x / 256), cairoNumber(y / 256)];
  return path.ops.map(({ op, pts }) => {
    if (op === "M") return { type: "move", end: num(pts[0]) };
    if (op === "L") return { type: "line", end: num(pts[0]) };
    if (op === "C") return { type: "cubic", control1: num(pts[0]), control2: num(pts[1]), end: num(pts[2]) };
    return { type: "close" };
  });
}

export { PANGO_SCALE };
