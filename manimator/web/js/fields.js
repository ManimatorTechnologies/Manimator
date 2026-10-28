// One editor per parameter kind (see manimator/registry/params.py).
// Every editor calls onChange(value, gesture?) — `gesture` is set for continuous
// drags (sliders, label scrubbing) so the whole drag becomes one undo step.

import { html, useEffect, useRef, useState } from "./lib.js";
import { chooseLocalFile, get, uploadAsset } from "./api.js";
import { emit, status, store } from "./store.js";
import { Dropdown, Icon } from "./ui.js";
import { clamp, fmt, newGesture, round } from "./util.js";

const ARROWS = { UL: "↖", UP: "↑", UR: "↗", LEFT: "←", ORIGIN: "•", RIGHT: "→", DL: "↙", DOWN: "↓", DR: "↘" };
const NUMERIC = new Set(["float", "int", "angle"]);
const TALL = new Set(["text", "points", "grid", "numbers", "mobrefs", "direction"]); // labels line up with the top
const WIDE = new Set(["range", "point3"]); // three fields need the whole row: the label goes above them

function limits(p) {
  if (p.kind === "angle") return { min: -36000, max: 36000, step: 15, decimals: 1, suffix: "°" };
  if (p.kind === "int") return { min: p.min, max: p.max, step: Math.max(1, p.step), decimals: 0, integer: true };
  return { min: p.min, max: p.max, step: p.step, decimals: p.decimals };
}

// ---------------------------------------------------------------- numbers
/** `prefix` (x, y, from…) and `suffix` (°, s) sit inside the field's own border. */
export function NumberInput({ value, min = -1e9, max = 1e9, step = 0.1, decimals = 2, prefix = "", suffix = "", integer,
  onChange, short, title }) {
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  const update = (d) => { draftRef.current = d; setDraft(d); };
  const norm = (v) => (integer ? Math.round(v) : round(v, 6));
  const commit = () => {
    const text = draftRef.current;
    update(null);
    if (text === null) return;
    const v = Number(String(text).trim().replace(",", "."));
    if (String(text).trim() === "" || !Number.isFinite(v)) return;
    const c = norm(clamp(v, min, max));
    if (c !== value) onChange(c);
  };
  const bump = (dir, e) => {
    const mult = e?.shiftKey ? 10 : e?.altKey ? 0.1 : 1;
    update(null);
    onChange(norm(clamp(Number(value) + dir * step * mult, min, max)));
  };
  return html`<div class=${`num ${short ? "short" : ""}`} title=${title || ""}>
    ${prefix && html`<span class="prefix">${prefix}</span>`}
    <input value=${draft ?? fmt(value, decimals)} spellcheck=${false}
      onFocus=${(e) => e.target.select()}
      onInput=${(e) => update(e.target.value)}
      onBlur=${commit}
      onKeyDown=${(e) => {
        if (e.key === "Enter") { commit(); e.target.blur(); }
        else if (e.key === "Escape") { update(null); e.target.blur(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); bump(1, e); }
        else if (e.key === "ArrowDown") { e.preventDefault(); bump(-1, e); }
      }} />
    ${suffix && html`<span class="suffix">${suffix}</span>`}
    <div class="spin">
      <button class="up" tabindex="-1" onMouseDown=${(e) => e.preventDefault()} onClick=${(e) => bump(1, e)}><${Icon} name="chevron" /></button>
      <button tabindex="-1" onMouseDown=${(e) => e.preventDefault()} onClick=${(e) => bump(-1, e)}><${Icon} name="chevron" /></button>
    </div>
  </div>`;
}

/** A label you can drag sideways to change a number (Shift = 10x). */
function ScrubLabel({ p, value, onChange }) {
  const start = useRef(null);
  const lim = limits(p);
  return html`<label class="scrub" title=${p.tooltip || "Drag left or right to change"}
    onPointerDown=${(e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, v: Number(value) || 0, g: newGesture(), last: value };
    }}
    onPointerMove=${(e) => {
      const s = start.current;
      if (!s) return;
      const steps = Math.round((e.clientX - s.x) / 4);
      let v = clamp(s.v + steps * lim.step * (e.shiftKey ? 10 : 1), lim.min, lim.max);
      v = lim.integer ? Math.round(v) : round(v, 6);
      if (v !== s.last) {
        s.last = v;
        onChange(v, s.g);
      }
    }}
    onPointerUp=${() => { start.current = null; }} onPointerCancel=${() => { start.current = null; }}>${p.label}</label>`;
}

function Slider({ value, min, max, step, onChange }) {
  const g = useRef(null);
  const fraction = max > min ? clamp((value - min) / (max - min), 0, 1) : 0; // how much of the track to fill
  return html`<input type="range" class="slider" style=${`--p:${fraction}`} min=${min} max=${max} step=${step / 5} value=${value}
    onPointerDown=${() => { g.current = newGesture(); }}
    onInput=${(e) => onChange(Number(e.target.value), g.current || newGesture())} />`;
}

// ---------------------------------------------------------------- text
export function TextInput({ value, onChange, list, placeholder, title }) {
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  const update = (d) => { draftRef.current = d; setDraft(d); };
  const commit = () => {
    const d = draftRef.current;
    update(null);
    if (d !== null && d !== value) onChange(d);
  };
  return html`<input class="input" list=${list} placeholder=${placeholder || ""} title=${title || ""}
    value=${draft ?? value ?? ""} spellcheck=${false}
    onInput=${(e) => update(e.target.value)} onBlur=${commit}
    onKeyDown=${(e) => {
      if (e.key === "Enter") e.target.blur();
      if (e.key === "Escape") { update(null); e.target.blur(); }
    }} />`;
}

function TextArea({ value, onChange, rows = 2, hint }) {
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  const update = (d) => { draftRef.current = d; setDraft(d); };
  const commit = () => {
    const d = draftRef.current;
    update(null);
    if (d !== null && d !== value) onChange(d);
  };
  return html`<div class="textfield">
    <textarea class="input" rows=${rows} spellcheck=${false} value=${draft ?? value ?? ""}
      onInput=${(e) => update(e.target.value)} onBlur=${commit}
      onKeyDown=${(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commit(); } }} />
    <div class="bar"><span>${draft !== null && draft !== value ? "Ctrl+Enter or click away to apply" : hint || ""}</span>
      ${draft !== null && draft !== value && html`<button class="btn small primary"
        onMouseDown=${(e) => e.preventDefault()} onClick=${commit}><span class="lbl">Apply</span></button>`}</div>
  </div>`;
}

export function Toggle({ value, onChange, label, title }) {
  return html`<div class="ctl"><label class="switch" title=${title || ""}>
    <span class="toggle"><input type="checkbox" checked=${!!value} onChange=${(e) => onChange(e.target.checked)} /><span /></span>
    ${label && html`<span>${label}</span>`}
  </label></div>`;
}

// ---------------------------------------------------------------- color
/** Manim's colour names for people: DARK_GRAY -> "Dark gray", GRAY_A -> "Gray A" (shade letters stay capitals). */
const colorLabel = (name) => name.split("_")
  .map((w, i) => (w.length === 1 ? w : i === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ");
const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

function parseHex(text) {
  let t = String(text || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(t) ? `#${t.toUpperCase()}` : null;
}

function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }) {
  const f = (k) => { const x = (k + h / 60) % 6; return v - v * s * Math.max(0, Math.min(x, 4 - x, 1)); };
  return toHex(f(5) * 255, f(3) * 255, f(1) * 255);
}

/** Drag inside `el`, reporting the pointer as 0..1 fractions of its box. */
function dragIn(e, onMove) {
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const report = (ev) => {
    const r = el.getBoundingClientRect();
    onMove(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
  };
  report(e);
  el.onpointermove = report;
  el.onpointerup = el.onpointercancel = () => { el.onpointermove = el.onpointerup = el.onpointercancel = null; };
}

/** Palette swatches on the left; on the right a picker for any colour: saturation/brightness square, hue bar,
 *  eyedropper and hex. Swatches apply at once; the picker applies with Apply or Enter. */
function ColorPicker({ value, optional, onPick }) {
  const { rows, hex } = store.catalog.palette;
  const [hsv, setHsv] = useState(() => hexToHsv(value || "#FFFFFF"));
  const [text, setText] = useState(null); // the hex box while it is being typed in
  const draft = hsvToHex(hsv);
  const setFromHex = (h) => {
    const parsed = parseHex(h);
    if (parsed) setHsv((old) => { const n = hexToHsv(parsed); return n.s === 0 || n.v === 0 ? { ...n, h: old.h } : n; });
    return parsed;
  };
  const eyedrop = async () => {
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      setFromHex(sRGBHex);
    } catch { /* cancelled */ }
  };
  return html`<div class="cpick">
    <div class="cp-body">
      <div class="cp-col">
        <h4>Palette</h4>
        <div class="palette-grid">
          ${rows.flat().map((name) => html`<button class=${hex[name] === value ? "on" : ""} title=${colorLabel(name)}
            style=${`background:${hex[name]}`} onClick=${() => onPick(hex[name])} />`)}
        </div>
      </div>
      <div class="cp-col">
        <h4>Custom</h4>
        <div class="cp-sv" style=${`background-color:hsl(${hsv.h} 100% 50%)`}
          onPointerDown=${(e) => dragIn(e, (x, y) => { setText(null); setHsv((o) => ({ ...o, s: x, v: 1 - y })); })}>
          <i style=${`left:${hsv.s * 100}%; top:${(1 - hsv.v) * 100}%; background:${draft}`} />
        </div>
        <div class="cp-hue" onPointerDown=${(e) => dragIn(e, (x) => { setText(null); setHsv((o) => ({ ...o, h: x * 360 })); })}>
          <i style=${`left:${(hsv.h / 360) * 100}%; background:hsl(${hsv.h} 100% 50%)`} />
        </div>
        <div class="cp-row">
          ${"EyeDropper" in window && html`<button class="btn small icon" title="Pick a colour from the screen" onClick=${eyedrop}>
            <${Icon} name="dropper" /></button>`}
          <input class="input cp-hex" value=${text ?? draft} spellcheck=${false} maxlength="7" title="Hex colour"
            onInput=${(e) => { setText(e.target.value); setFromHex(e.target.value); }}
            onBlur=${() => setText(null)}
            onKeyDown=${(e) => { if (e.key === "Enter") { const h = setFromHex(e.target.value) ?? draft; setText(null); onPick(h); } }} />
        </div>
      </div>
    </div>
    <div class="cp-foot">
      <span class="grow" />
      ${optional && html`<button class="btn small" title="Let the object use its default colour" onClick=${() => onPick(null)}><span class="lbl">Auto</span></button>`}
      <button class="btn small" onClick=${closeColorPicker}><span class="lbl">Cancel</span></button>
      <button class="btn small primary" disabled=${draft === value} onClick=${() => onPick(draft)}><span class="lbl">Apply</span></button>
    </div>
  </div>`;
}

let colorPickCount = 0;

export function closeColorPicker() {
  if (store.colorPick) {
    store.colorPick = null;
    emit();
  }
}

/** The colour picker, as a window in the middle of the screen (like the object window). */
export function ColorWindow() {
  const c = store.colorPick;
  if (!c) return null;
  return html`<div class="pal-back cp-back" onPointerDown=${(e) => e.target === e.currentTarget && closeColorPicker()}>
    <div class="cp-win" role="dialog" aria-label="Pick a colour">
      <div class="pal-title">
        <span class="chip" style=${c.value ? `background:${c.value}` : ""} />
        <span class="name">Colour</span>
        <span class="path">Pick a swatch, or mix any colour on the right</span>
        <span class="grow" />
        <button class="btn small icon ghost" title="Close (Esc)" onClick=${closeColorPicker}><${Icon} name="x" /></button>
      </div>
      <${ColorPicker} key=${c.id} value=${c.value} optional=${c.optional} onPick=${c.onPick} />
    </div>
  </div>`;
}

export function ColorButton({ value, optional, onChange }) {
  const named = value && store.catalog.palette.names[value];
  const name = named ? colorLabel(named) : value ?? "Auto";
  const open = () => {
    store.colorPick = { id: ++colorPickCount, value, optional, onPick: (v) => { closeColorPicker(); if (v !== value) onChange(v); } };
    emit();
  };
  return html`<button class="swatch-btn" onClick=${open}>
    <span class=${`chip ${value ? "" : "auto"}`} style=${value ? `background:${value}` : ""} />
    <span>${name}</span>
  </button>`;
}

// ---------------------------------------------------------------- choices
function DirPad({ value, choices, optional, onChange }) {
  const allowed = new Set(choices?.length ? choices : Object.keys(ARROWS));
  return html`<div class="dirpad">
    ${store.catalog.directionGrid.flat().map((d) => html`<button title=${d} disabled=${!allowed.has(d)}
      class=${d === value ? "on" : ""}
      onClick=${() => onChange(d === value && optional ? null : d)}>${ARROWS[d]}</button>`)}
  </div>`;
}

function Select({ value, options, onChange, placeholder }) {
  return html`<${Dropdown} value=${value} options=${options} placeholder=${placeholder} onChange=${onChange} />`;
}

// ---------------------------------------------------------------- structured values
// These are edited as plain text; the server parses the text and sends back the clean value.
const cells = (row) => (row.some((c) => String(c).includes(",")) ? " | " : ", ");
const TO_TEXT = {
  points: (v) => (v || []).map(([x, y]) => `${round(x, 4)}, ${round(y, 4)}`).join("\n"),
  numbers: (v) => (v || []).map((n) => round(n, 4)).join(", "),
  grid: (v) => (v || []).map((row) => row.join(cells(row))).join("\n"),
};
const HINTS = {
  points: "One point per line: x, y",
  numbers: "Separate with commas",
  grid: "One row per line. Separate cells with commas or |",
};

function CheckList({ value, options, onChange }) {
  const chosen = new Set(value || []);
  if (!options.length) return html`<span class="tag">No other objects yet.</span>`;
  const toggle = (id) => onChange(options.map(([i]) => i).filter((i) => (i === id ? !chosen.has(i) : chosen.has(i))));
  return html`<div class="checklist">
    ${options.map(([id, name]) => html`<label class="chk"><input type="checkbox" checked=${chosen.has(id)}
      onChange=${() => toggle(id)} /><span>${name}</span></label>`)}
  </div>`;
}

// Hosted version: choose among the files this visitor uploaded, or upload another.
function UploadField({ p, value, onChange }) {
  const [files, setFiles] = useState([]);
  useEffect(() => { get("/api/assets").then((r) => setFiles(r.files)).catch(() => {}); }, [value]);
  const svg = p.accept === "svg";
  const upload = async () => {
    const file = await chooseLocalFile(svg ? ".svg,image/svg+xml" : "image/*");
    if (!file) return;
    try {
      const res = await uploadAsset(file);
      setFiles(res.files);
      onChange(res.name);
    } catch (err) {
      status(err.message, "error");
    }
  };
  const mine = files.filter((n) => (svg ? /\.svg$/i : /\.(png|jpe?g|gif|bmp|webp)$/i).test(n)); // not videos
  const label = (n) => n.replace(/-[0-9a-f]{8}(\.\w+)$/, "$1"); // hide the tag that keeps names unique
  return html`<div class="ctl">
    <${Select} value=${value || null} options=${mine.map((n) => [n, label(n)])}
      placeholder=${mine.length ? "Choose an upload…" : "Nothing uploaded yet"} onChange=${onChange} />
    <button class="btn" onClick=${upload}><span class="lbl">Upload…</span></button>
  </div>`;
}

function FileField({ p, value, onChange }) {
  return html`<${UploadField} p=${p} value=${value} onChange=${onChange} />`;
}

// ---------------------------------------------------------------- dispatcher
export function Field({ p, value, onChange, refs }) {
  const lim = limits(p);
  switch (p.kind) {
    case "float":
    case "int":
    case "angle":
      return html`<div class="ctl">
        ${p.slider && html`<${Slider} value=${value} min=${p.min} max=${p.max} step=${p.step} onChange=${onChange} />`}
        <${NumberInput} value=${value} ...${lim} short=${p.slider} onChange=${onChange} />
      </div>`;
    case "str":
      return html`<div class="ctl"><${TextInput} value=${value} onChange=${onChange} /></div>`;
    case "font": {
      // "" is Manimator's default (the first font); a name typed into an older project stays choosable
      const fonts = store.catalog.fonts;
      const options = [["", `${fonts[0]} (default)`], ...fonts.slice(1).map((f) => [f, f]),
        ...(value && !fonts.includes(value) ? [[value, value]] : [])];
      return html`<div class="ctl"><${Select} value=${value === fonts[0] ? "" : value || ""} options=${options}
        onChange=${onChange} /></div>`;
    }
    case "text":
      return html`<div class="ctl"><${TextArea} value=${value} onChange=${onChange} /></div>`;
    case "bool":
      return html`<${Toggle} value=${value} onChange=${onChange} />`;
    case "color":
      return html`<div class="ctl"><${ColorButton} value=${value} optional=${p.optional} onChange=${onChange} /></div>`;
    case "point":
    case "vector": {
      const v = value || [0, 0];
      return html`<div class="ctl multi c2">
        <${NumberInput} prefix="x" value=${v[0]} step=${0.25} min=${-100} max=${100}
          onChange=${(x) => onChange([x, v[1]])} />
        <${NumberInput} prefix="y" value=${v[1]} step=${0.25} min=${-100} max=${100}
          onChange=${(y) => onChange([v[0], y])} />
      </div>`;
    }
    case "range": {
      const v = value || [0, 1, 1];
      const part = (i, x) => onChange(v.map((old, j) => (i === j ? x : old)));
      return html`<div class="ctl multi c3 wide">
        <${NumberInput} prefix="from" value=${v[0]} step=${1} onChange=${(x) => part(0, x)} />
        <${NumberInput} prefix="to" value=${v[1]} step=${1} onChange=${(x) => part(1, x)} />
        <${NumberInput} prefix="step" value=${v[2]} step=${0.5} min=${0.01} onChange=${(x) => part(2, x)} />
      </div>`;
    }
    case "direction":
      return html`<${DirPad} value=${value} choices=${p.choices} optional=${p.optional} onChange=${onChange} />`;
    case "enum":
      return html`<div class="ctl"><${Select} value=${value} options=${p.choices} onChange=${onChange} /></div>`;
    case "mobref":
      return html`<div class="ctl"><${Select} value=${value} options=${refs || []}
        placeholder=${refs?.length ? "Choose an object…" : "No other objects"} onChange=${onChange} /></div>`;
    case "mobrefs":
      return html`<div class="ctl"><${CheckList} value=${value} options=${refs || []} onChange=${onChange} /></div>`;
    case "expr":
      return html`<div class="ctl"><${TextInput} value=${value} title=${p.tooltip} onChange=${onChange} /></div>`;
    case "points":
    case "numbers":
    case "grid":
      return html`<div class="ctl"><${TextArea} value=${TO_TEXT[p.kind](value)} rows=${p.kind === "numbers" ? 2 : 5}
        hint=${HINTS[p.kind]} onChange=${onChange} /></div>`;
    case "file":
      return html`<${FileField} p=${p} value=${value} onChange=${onChange} />`;
    case "point3": {
      const v = value || [0, 0, 0];
      const part = (i) => (x) => onChange(v.map((old, j) => (i === j ? x : old)));
      return html`<div class="ctl multi c3 wide">
        ${["x", "y", "z"].map((axis, i) => html`<${NumberInput} prefix=${axis} value=${v[i]} step=${0.25} min=${-100} max=${100}
          onChange=${part(i)} />`)}
      </div>`;
    }
    default:
      return html`<span>?</span>`;
  }
}

/** A labelled form for a list of params. onChange(name, value, gesture). refs() → [[id, name]]. */
export function ParamForm({ params, values, onChange, refs }) {
  return html`<div class="form">
    ${params.map((p) => {
      const value = values?.[p.name] ?? (values && p.name in values ? values[p.name] : p.default);
      const change = (v, g) => onChange(p.name, v, g);
      return html`
        ${NUMERIC.has(p.kind) ? html`<${ScrubLabel} p=${p} value=${value} onChange=${change} />`
          : html`<label class=${WIDE.has(p.kind) ? "wide" : TALL.has(p.kind) ? "top" : ""} title=${p.tooltip || p.label}>${p.label}</label>`}
        <${Field} p=${p} value=${value} onChange=${change}
          refs=${(p.kind === "mobref" || p.kind === "mobrefs") && refs ? refs() : null} />`;
    })}
  </div>`;
}
