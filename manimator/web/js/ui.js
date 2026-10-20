// Shared UI pieces: icons, menus (with submenus), popovers and modal dialogs.

import { html, useEffect, useLayoutEffect, useRef, useState } from "./lib.js";
import { emit, store, subscribe } from "./store.js";

// ---------------------------------------------------------------- icons (24x24 strokes)
const PATHS = {
  new: "M6 3h8l4 4v14H6z M14 3v4h4",
  save: "M5 3h11l3 3v15H5z M8 3v5h8V3 M8 14h8v7H8z",
  undo: "M9 14L4 9l5-5 M4 9h10a6 6 0 010 12h-3",
  redo: "M15 14l5-5-5-5 M20 9H10a6 6 0 000 12h3",
  grid: "M3 3h18v18H3z M9 3v18 M15 3v18 M3 9h18 M3 15h18",
  magnet: "M6 3v8a6 6 0 0012 0V3 M6 3h4v8a2 2 0 004 0V3h4 M6 7h4 M14 7h4",
  play: "M7 4l13 8-13 8z",
  pause: "M7 5h3v14H7z M14 5h3v14h-3z",
  replay: "M4 12a8 8 0 1 0 2.34-5.66L4 8.5 M4 4v4.5h4.5",
  audio: "M4 9h4l5-4v14l-5-4H4z M16.5 9a4 4 0 010 6 M19 6.5a8 8 0 010 11",
  film: "M3 4h18v16H3z M7 4v16 M17 4v16 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
  layers: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
  code: "M8 7l-5 5 5 5 M16 7l5 5-5 5",
  up: "M12 19V5 M6 11l6-6 6 6",
  down: "M12 5v14 M6 13l6 6 6-6",
  left: "M19 12H5 M11 6l-6 6 6 6",
  dropper: "M15 5l5 5 M13.5 6.5l5 5 M17 9L8 18l-4 1 1-4 9-9",
  maximize: "M9 4H4v5 M15 4h5v5 M20 15v5h-5 M4 15v5h5",
  restore: "M4 9h5V4 M20 9h-5V4 M4 15h5v5 M20 15h-5v5",
  right: "M5 12h14 M13 6l6 6-6 6",
  copy: "M8 8h12v12H8z M4 16V4h12",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  plus: "M12 5v14 M5 12h14",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 110 6 3 3 0 010-6z",
  eyeoff: "M3 3l18 18 M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.1 3.6 M6.6 6.6C3.8 8.4 2 12 2 12s4 6 10 6a9.7 9.7 0 004.4-1.1",
  merge: "M7 4v6a5 5 0 005 5h0a5 5 0 005-5V4 M12 15v5",
  split: "M12 4v5 M12 9L6 15v5 M12 9l6 6v5",
  wait: "M12 7v5l3 2 M12 3a9 9 0 110 18 9 9 0 010-18z",
  folder: "M3 6h6l2 2h10v11H3z",
  export: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
  x: "M6 6l12 12 M18 6L6 18",
  stop: "M6 6h12v12H6z",
  check: "M5 12.25l4.5 4.5L19 7.25",
  chevron: "M6 9l6 6 6-6",
  camera: "M3 8h4l2-3h6l2 3h4v11H3z M12 10.5a3 3 0 110 6 3 3 0 010-6z",
  vector: "M5 19L19 5 M11 5h8v8",
  search: "M10.5 4a6.5 6.5 0 110 13 6.5 6.5 0 010-13z M15.5 15.5L20 20",
  more: "M11 5.5a1 1 0 102 0 1 1 0 10-2 0z M11 12a1 1 0 102 0 1 1 0 10-2 0z M11 18.5a1 1 0 102 0 1 1 0 10-2 0z",
  list: "M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01",
  cards: "M4 4h6.5v6.5H4z M13.5 4H20v6.5h-6.5z M4 13.5h6.5V20H4z M13.5 13.5H20V20h-6.5z",
  sort: "M7 4v16 M3 8l4-4 4 4 M17 20V4 M13 16l4 4 4-4",
  user: "M12 4a4 4 0 110 8 4 4 0 010-8z M4.5 20a7.5 7.5 0 0115 0",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9",
  present: "M3 4h18 M4 4v11h16V4 M12 15v3 M8 21l4-3 4 3",
  spark: "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z M18.5 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z",
  sidebar: "M4 4h16v16H4z M9 4v16",
  grip: "M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01",
};

const inkBoxes = {};
/** The drawn part of an icon (stroke included), in its 24x24 units; measured once per icon. */
function inkBox(name) {
  if (!inkBoxes[name]) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:absolute; width:0; height:0; visibility:hidden";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", PATHS[name]);
    svg.appendChild(path);
    document.body.appendChild(svg);
    const b = path.getBBox();
    svg.remove();
    const s = 0.75; // half the stroke width
    inkBoxes[name] = { x: b.x - s, y: b.y - s, w: b.width + 2 * s, h: b.height + 2 * s };
  }
  return inkBoxes[name];
}

/** `tight` crops the icon to its drawn part (same scale, vertically centred in a size-high box), so a button's
 *  padding is the real space around it: icons otherwise carry different amounts of empty margin. */
export function Icon({ name, size = 16, tight = false }) {
  let viewBox = "0 0 24 24", width = size;
  if (tight) {
    const b = inkBox(name);
    viewBox = `${b.x} ${b.y + b.h / 2 - 12} ${b.w} 24`;
    width = (b.w / 24) * size;
  }
  return html`<svg class=${tight ? "tight" : ""} viewBox=${viewBox} width=${width} height=${size} fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d=${PATHS[name]} /></svg>`;
}

const textInks = {};
/** Empty space before the first and after the last letter of `text` (its side bearings), in px. Measured by drawing
 *  it `scale` times larger and scanning the pixels (canvas text metrics are rounded to whole pixels, too coarse for
 *  this); the partly covered edge columns count by how much they are covered. At `scale` = the screen's pixel ratio
 *  it is drawn exactly as the page draws it, fitted to the same pixel grid. */
function textInk(text, font, size, spacing = 0, scale = 10) {
  const key = `${font}|${size}|${spacing}|${scale}|${text}`;
  if (!textInks[key]) {
    const S = scale, fs = size * S;
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d");
    const setFont = () => {
      ctx.font = font.replace(/[\d.]+px/, `${fs}px`);
      ctx.letterSpacing = `${spacing * S}px`; // like CSS, also after the last letter
    };
    setFont();
    const adv = ctx.measureText(text).width;
    cv.width = Math.ceil(adv + fs);
    cv.height = Math.ceil(fs * 2);
    setFont(); // resizing the canvas reset it
    const ox = Math.ceil(fs / 2);
    ctx.fillText(text, ox, Math.ceil(fs * 1.4));
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const cover = (x) => {
      let most = 0;
      for (let y = 0; y < cv.height; y++) most = Math.max(most, d[(y * cv.width + x) * 4 + 3]);
      return most / 255;
    };
    let x0 = 0, x1 = cv.width - 1;
    while (x0 < x1 && cover(x0) < 0.02) x0++;
    while (x1 > x0 && cover(x1) < 0.02) x1--;
    const left = x0 + 1 - cover(x0), right = x1 + cover(x1);
    textInks[key] = { lead: (left - ox) / S, trail: (ox + adv - right) / S };
  }
  return textInks[key];
}

const capHeights = {};
/** How tall the capital letters are drawn on this screen, in px. Measured at the real pixel size, not larger: small
 *  text is fitted to the pixel grid, which can make it a little shorter than the font says. Counts how much of each
 *  pixel row a drawn "H" covers, so the result is finer than whole pixels. */
function capHeight(font, size) {
  const dpr = window.devicePixelRatio || 1, key = `${font}|${size}|${dpr}`;
  if (!capHeights[key]) {
    const fs = size * dpr, base = Math.ceil(fs * 2);
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(fs * 2);
    cv.height = base + Math.ceil(fs);
    const ctx = cv.getContext("2d");
    ctx.font = font.replace(/[\d.]+px/, `${fs}px`);
    ctx.fillText("H", Math.ceil(fs / 2), base);
    const d = ctx.getImageData(0, 0, cv.width, base).data;
    let rows = 0;
    for (let y = 0; y < base; y++) {
      let most = 0;
      for (let x = 0; x < cv.width; x++) most = Math.max(most, d[(y * cv.width + x) * 4 + 3]);
      rows += most / 255;
    }
    capHeights[key] = rows / dpr;
  }
  return capHeights[key];
}

const iconInks = {};
/** Where an icon's strokes visibly reach, in its own units, when drawn at `scale` screen px per unit: measured from
 *  the pixels it covers, the way the eye sees it (a pointed, round-capped tip shows fainter than its outline). */
function iconInk(d, stroke, scale) {
  const key = `${d}|${stroke}|${scale}`;
  if (!iconInks[key]) {
    const pad = 4, k = scale, n = Math.ceil((24 + 2 * pad) * k);
    const cv = document.createElement("canvas");
    cv.width = cv.height = n;
    const ctx = cv.getContext("2d");
    ctx.setTransform(k, 0, 0, k, pad * k, pad * k);
    Object.assign(ctx, { lineWidth: stroke, lineCap: "round", lineJoin: "round", strokeStyle: "#000" });
    ctx.stroke(new Path2D(d));
    const a = ctx.getImageData(0, 0, n, n).data;
    const cols = new Float32Array(n), rows = new Float32Array(n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = a[(y * n + x) * 4 + 3] / 255;
        if (v > cols[x]) cols[x] = v;
        if (v > rows[y]) rows[y] = v;
      }
    }
    const edges = (c) => {
      let i = 0, j = n - 1;
      while (i < j && c[i] < 0.02) i++;
      while (j > i && c[j] < 0.02) j--;
      return [(i + 1 - c[i]) / k - pad, (j + c[j]) / k - pad];
    };
    const [left, right] = edges(cols), [top, bottom] = edges(rows);
    iconInks[key] = { left, right, top, bottom };
  }
  return iconInks[key];
}

/** Puts what a button draws in its optical middle. Its parts (icons, the `.lbl` text, small boxes such as a count
 *  badge) are lined up left to right by what they draw, not by their boxes (icons and letters carry empty space),
 *  keeping the spacing the stylesheet gives between their boxes, and the row is centred in the button. Top to bottom
 *  each part is centred on its own: an icon by its strokes, text by its capital letters from their tops to the
 *  baseline (ascenders and descenders are left out, as the eye does), a box by its box. Text that isn't in a `.lbl`
 *  can't be moved, so such a button is left as it is. */
export function centerText(btn) {
  if (!btn?.isConnected) return;
  const kids = [...btn.children];
  for (const el of kids) {
    if (el.tagName === "svg") el.querySelector("path")?.removeAttribute("transform");
    else el.style.transform = "";
  }
  if ([...btn.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
  const b = btn.getBoundingClientRect();
  if (!b.width) return;
  const dpr = window.devicePixelRatio || 1, snap = (v) => Math.round(v * dpr) / dpr;
  placedAt.set(btn, `${b.left},${b.top},${dpr}`);
  const midX = b.left + b.width / 2, midY = b.top + b.height / 2;

  const parts = []; // { el, kind, box (layout box), left, right (drawn part), mid (what is centred top to bottom) }
  for (const el of kids) {
    if (!el.getClientRects().length) continue; // hidden (narrow windows hide some labels)
    const box = el.getBoundingClientRect();
    if (el.tagName === "svg") {
      const path = el.querySelector("path");
      if (!path) continue;
      const vb = el.viewBox.baseVal, unit = box.width / vb.width;
      el.style.overflow = "visible"; // its drawing moves inside its box: the box itself would be snapped to whole pixels
      const ink = iconInk(path.getAttribute("d"), parseFloat(el.getAttribute("stroke-width")) || 1.5, unit * dpr);
      // the browser paints an icon at its box snapped to whole CSS px
      const x = (u) => Math.round(box.left) + (u - vb.x) * unit, y = (v) => Math.round(box.top) + (v - vb.y) * unit;
      parts.push({ el, path, unit, kind: "icon", box, left: x(ink.left), right: x(ink.right), mid: (y(ink.top) + y(ink.bottom)) / 2 });
    } else if (el.classList.contains("lbl")) {
      const text = el.textContent.trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, size = parseFloat(cs.fontSize);
      const ink = textInk(text, font, size, parseFloat(cs.letterSpacing) || 0, dpr);
      const probe = document.createElement("span"); // a 0-high box sitting on the baseline: where the page draws it
      probe.style.cssText = "display:inline-block; width:0; height:0; vertical-align:baseline";
      probe.dataset.probe = "1";
      el.appendChild(probe);
      const baseline = probe.getBoundingClientRect().top;
      probe.remove();
      const cut = el.scrollWidth > el.clientWidth + 1; // a cut-off name is placed by its box instead
      parts.push({ el, kind: "text", box, left: box.left + (cut ? 0 : ink.lead), right: box.right - (cut ? 0 : ink.trail),
        mid: baseline - capHeight(font, size) / 2 });
    } else {
      parts.push({ el, kind: "box", box, left: box.left, right: box.right, mid: box.top + box.height / 2 });
    }
  }
  if (!parts.length) return;
  // the spacing between parts is the stylesheet's, between their boxes
  const gaps = parts.slice(1).map((q, i) => Math.max(0, q.box.left - parts[i].box.right));
  const width = parts.reduce((w, q) => w + q.right - q.left, 0) + gaps.reduce((a, g) => a + g, 0);
  let x = midX - width / 2;
  for (const [i, q] of parts.entries()) {
    q.dx = x - q.left;
    x += q.right - q.left + (gaps[i] ?? 0);
  }
  // Text and boxes move by a transform (the browser rounds left/top to whole CSS px). Letters are drawn at any
  // fraction of a pixel across but only on whole device px up and down, so text moves exactly across and in whole
  // device px up and down; boxes in whole device px both ways, to keep their edges sharp. Icons can move by any
  // fraction, so an icon at the far end from the text takes up any rounding of the text, and both margins come out
  // equal.
  const t = parts.findIndex((q) => q.kind === "text");
  let err = 0;
  for (const q of parts) {
    if (q.kind === "icon") continue;
    const dx = q.kind === "text" ? q.dx : snap(q.dx);
    if (q.kind === "text") err = dx - q.dx;
    q.el.style.transform = `translate(${dx.toFixed(3)}px, ${snap(midY - q.mid).toFixed(3)}px)`;
  }
  for (const [i, q] of parts.entries()) {
    if (q.kind !== "icon") continue;
    const far = t >= 0 && (t === 0 ? i === parts.length - 1 : t === parts.length - 1 ? i === 0 : false);
    const dx = q.dx - (far ? err : 0);
    q.path.setAttribute("transform", `translate(${(dx / q.unit).toFixed(3)} ${((midY - q.mid) / q.unit).toFixed(3)})`);
  }
}

/** Every button of these kinds is kept optically centred, wherever and whenever it appears. */
const CENTERED = ".btn, .menubtn, .brand.link, .tab, .co-corner, .modal .close, .home-search .clear, .home-tools .seg button, .sheet-add, .toast-action";
export function centerButtons(root = document.body) {
  root.querySelectorAll(CENTERED).forEach(centered);
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(CENTERED)) centered(n);
        n.querySelectorAll(CENTERED).forEach(centered);
      }
    }
  }).observe(root, { childList: true, subtree: true });
  // windows and toasts slide and scale in: measure again once they have arrived
  root.addEventListener("animationend", (e) => e.target.querySelectorAll?.(".centered").forEach(recenter));
  // Buttons also move without changing size (a splitter dragged, a list growing above them, scrolling), and where a
  // button sits decides how its parts snap to the pixel grid: centre again any that moved.
  subscribe(checkMoved);
  new MutationObserver(checkMoved).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  for (const type of ["transitionend", "scroll", "pointerover"]) root.addEventListener(type, checkMoved, { capture: true, passive: true });
}

/** Where each button was when it was last centred (left, top and the pixel ratio). */
const placedAt = new WeakMap();
let movedQueued = false;
function checkMoved() {
  if (movedQueued) return;
  movedQueued = true;
  requestAnimationFrame(() => { // after the page has drawn what changed
    movedQueued = false;
    const dpr = window.devicePixelRatio || 1;
    for (const el of centeredEls) {
      if (!el.isConnected) { centeredEls.delete(el); continue; }
      const b = el.getBoundingClientRect();
      if (b.width && placedAt.get(el) !== `${b.left},${b.top},${dpr}`) centerText(el);
    }
  });
}

// Buttons kept optically centred: again when their text or size changes, once the web font is in, and when the
// window changes (zooming changes the screen's pixel ratio, and so the pixel grid everything is fitted to).
const centeredEls = new Set();
let centeredSizes = null, centeredTexts = null;
const recenter = (el) => { if (el.isConnected) centerText(el); else centeredEls.delete(el); };
const recenterAll = () => centeredEls.forEach(recenter);

/** Keeps a button's icon and/or `.lbl` in its optical middle (see centerText). */
function centered(el) {
  if (!el || centeredEls.has(el)) return;
  if (!centeredSizes) {
    centeredSizes = new ResizeObserver((entries) => entries.forEach((e) => recenter(e.target)));
    centeredTexts = new MutationObserver((records) => {
      const changed = new Set();
      for (const r of records) {
        const own = [...r.addedNodes, ...r.removedNodes].every((n) => n.dataset?.probe); // centerText's own probe
        if (r.type === "characterData" || !own) changed.add(r.target.closest?.(".centered") || r.target.parentElement?.closest(".centered"));
      }
      changed.forEach((b) => b && centeredEls.has(b) && recenter(b));
    });
    window.addEventListener("resize", recenterAll);
    document.fonts?.ready.then(recenterAll);
  }
  centeredEls.add(el);
  el.classList.add("centered");
  centeredSizes.observe(el);
  centeredTexts.observe(el, { subtree: true, childList: true, characterData: true });
}

// ---------------------------------------------------------------- menus
// Item: { label, onClick, disabled, key, icon, children: [...] } | { section } | { separator: true }

export function openMenu(items, x, y, extra = {}) {
  store.menu = { items, x, y, ...extra };
  emit();
}

export function openMenuAt(event, items, below = true) {
  const r = event.currentTarget.getBoundingClientRect();
  openMenu(items, r.left, below ? r.bottom + 4 : r.top);
}

export function closeMenu() {
  if (store.menu) {
    store.menu = null;
    emit();
  }
}

function MenuList({ items, sub = false, kind = "", minWidth = 0 }) {
  const ref = useRef();
  const [open, setOpen] = useState(-1);
  const [fit, setFit] = useState({ flip: false, dy: 0 });
  useLayoutEffect(() => {
    if (sub && ref.current) {
      // Keep submenus on screen: open to the left near the right edge, shift up near the bottom.
      const r = ref.current.getBoundingClientRect();
      const overflow = r.bottom - (window.innerHeight - 6);
      setFit({ flip: r.right > window.innerWidth - 4, dy: overflow > 0 ? Math.min(overflow, r.top - 6) : 0 });
    }
  }, []);
  return html`<div ref=${ref} class=${`menu ${kind} ${sub ? "sub" : ""} ${fit.flip ? "flip" : ""}`}
      style=${sub ? `top:${-5 - fit.dy}px` : minWidth ? `min-width:${minWidth}px` : ""}
      onMouseDown=${(e) => e.stopPropagation()}>
    ${items.map((it, i) => {
      if (it.separator) return html`<div class="msep" />`;
      if (it.section) return html`<div class="msec">${it.section}</div>`;
      const disabled = it.disabled || (!it.onClick && !it.children);
      return html`<div class=${`mi ${disabled ? "disabled" : ""} ${open === i ? "open" : ""}`} title=${it.title || ""}
          onMouseEnter=${() => setOpen(it.children && !it.disabled ? i : -1)}
          onClick=${(e) => {
            if (disabled) return;
            if (it.children) {
              if (e.target.closest(".menu") === ref.current) setOpen(i); // clicks also open submenus
              return;
            }
            closeMenu();
            it.onClick();
          }}>
        ${it.icon !== undefined && html`<span class="ic">${it.icon}</span>`}
        <span class="lbl">${it.label}</span>
        ${it.key && html`<span class="key">${it.key}</span>`}
        ${it.children && html`<span class="arrow">▶</span>`}
        ${it.children && open === i && html`<${MenuList} items=${it.children} sub=${true} />`}
      </div>`;
    })}
  </div>`;
}

export function MenuLayer() {
  const ref = useRef();
  const m = store.menu;
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const menu = ref.current.firstElementChild;
    const r = menu.getBoundingClientRect();
    const x = Math.min(m.x, window.innerWidth - r.width - 6);
    let y = m.y;
    if (m.above === undefined) {
      // Menus shift up to fit.
      if (y + r.height > window.innerHeight - 6) y = Math.max(6, window.innerHeight - r.height - 6);
    } else {
      // Dropdowns stay attached to their button: below it, or above when that leaves more room, scrolling if needed.
      const below = window.innerHeight - 6 - m.y;
      const above = m.above - 6;
      const room = r.height > below && above > below ? above : below;
      if (room === above) y = m.above - Math.min(r.height, room);
      menu.style.maxHeight = `${room}px`;
      menu.querySelector(".mi .ic svg")?.closest(".mi").scrollIntoView({ block: "center" }); // the current choice
    }
    setPos({ x: Math.max(6, x), y });
  }, [m]);
  if (!m) return null;
  const style = pos ? `left:${pos.x}px; top:${pos.y}px` : `left:${m.x}px; top:${m.y}px; visibility:hidden`;
  return html`<div class="layer" onMouseDown=${closeMenu} onContextMenu=${(e) => { e.preventDefault(); closeMenu(); }}>
    <div ref=${ref} style=${`position:fixed; ${style}`} class="menu-host"><${MenuList} items=${m.items} kind=${m.kind} minWidth=${m.minWidth} /></div>
  </div>`;
}

// ---------------------------------------------------------------- dropdowns
/** A select replacement that opens the app's own floating menu.
 *  options: [[value, label], ...], with { section: "Heading" } entries allowed in between.
 *  `label` gives the button fixed text; otherwise it shows the current choice. */
export function Dropdown({ value, options, onChange, label, placeholder = "Choose…", title = "", class: cls = "" }) {
  const ref = useRef();
  const same = (v) => v !== null && v !== undefined && String(v) === String(value);
  const choices = options.filter(Array.isArray);
  const current = choices.find(([v]) => same(v));
  const isOpen = !!ref.current && store.menu?.anchor === ref.current;
  const open = () => {
    const r = ref.current.getBoundingClientRect();
    const items = options.map((o) => (Array.isArray(o) ? {
      label: o[1],
      icon: same(o[0]) ? html`<${Icon} name="check" size=${15} />` : "",
      onClick: () => !same(o[0]) && onChange(o[0]),
    } : o));
    if (!choices.length) items.push({ label: placeholder, disabled: true });
    openMenu(items, r.left, r.bottom + 6, { kind: "dd", minWidth: r.width, anchor: ref.current, above: r.top - 6 });
  };
  const onKeyDown = (e) => {
    if (["ArrowDown", "ArrowUp"].includes(e.key) && choices.length) {
      // Like a native select: arrows step through the choices without opening the menu.
      e.preventDefault();
      const i = choices.findIndex(([v]) => same(v));
      const next = choices[Math.max(0, Math.min(choices.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next && !same(next[0])) onChange(next[0]);
    }
  };
  return html`<button ref=${ref} type="button" class=${`dropdown ${isOpen ? "open" : ""} ${cls}`} title=${title}
      aria-haspopup="listbox" aria-expanded=${isOpen} onClick=${open} onKeyDown=${onKeyDown}>
    <span class=${`val ${current || label ? "" : "ph"}`}>${label ?? (current ? current[1] : placeholder)}</span>
    <svg class="chev" viewBox="0 0 10 5.75" width="10" height="5.75" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round"><path d="M.75 .75 5 5l4.25-4.25" /></svg>
  </button>`;
}

// ---------------------------------------------------------------- popovers (color picker etc.)
export function openPopover(anchor, render) {
  const r = anchor.getBoundingClientRect();
  store.popover = { x: r.left, y: r.bottom + 4, top: r.top, render };
  emit();
}

export function closePopover() {
  if (store.popover) {
    store.popover = null;
    emit();
  }
}

export function PopoverLayer() {
  const ref = useRef();
  const p = store.popover;
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!p || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.max(6, Math.min(p.x, window.innerWidth - r.width - 8));
    const y = p.y + r.height > window.innerHeight - 6 ? Math.max(6, p.top - r.height - 4) : p.y;
    setPos({ x, y });
  }, [p]);
  if (!p) return null;
  const style = pos ? `left:${pos.x}px; top:${pos.y}px` : `left:${p.x}px; top:${p.y}px; visibility:hidden`;
  return html`<div class="layer" onMouseDown=${closePopover}>
    <div ref=${ref} class="popover" style=${style} onMouseDown=${(e) => e.stopPropagation()}>${p.render()}</div>
  </div>`;
}

// ---------------------------------------------------------------- modal dialogs
function showModal(config) {
  return new Promise((resolve) => {
    store.modal = { ...config, resolve };
    emit();
  });
}

function closeModal(value) {
  const m = store.modal;
  store.modal = null;
  emit();
  m?.resolve(value);
}

export const confirmDialog = ({ title, message, ok = "OK", cancel = "Cancel", danger = false }) =>
  showModal({ kind: "confirm", title, message, ok, cancel, danger });

export const alertDialog = ({ title, message }) => showModal({ kind: "alert", title, message, ok: "OK" });

export const promptDialog = ({ title, message, value = "", placeholder = "", ok = "OK", suggestions = [] }) =>
  showModal({ kind: "prompt", title, message, value, placeholder, ok, cancel: "Cancel", suggestions });

export function ModalLayer() {
  const m = store.modal;
  const inputRef = useRef();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (m?.kind === "prompt") {
      setValue(m.value || "");
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [m]);
  if (!m) return null;
  const okValue = () => (m.kind === "prompt" ? value.trim() || null : true);
  const onKey = (e) => {
    if (e.key === "Escape") closeModal(m.kind === "prompt" ? null : false);
    if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") closeModal(okValue());
  };
  return html`<div class="modal-back" onKeyDown=${onKey}>
    <div class="modal" role="dialog">
      <h2>${m.title}</h2>
      ${m.message && html`<p>${m.message}</p>`}
      ${m.kind === "prompt" && html`
        <input ref=${inputRef} class="input" value=${value} placeholder=${m.placeholder}
          onInput=${(e) => setValue(e.target.value)} />
        ${m.suggestions?.length > 0 && html`<ul class="recent-list">
          ${m.suggestions.map((s) => html`<li title=${s} onClick=${() => closeModal(s)}>${s}</li>`)}
        </ul>`}`}
      <div class="actions">
        ${m.kind !== "alert" && html`<button class="btn" onClick=${() => closeModal(m.kind === "prompt" ? null : false)}>
          <span class="lbl">${m.cancel}</span></button>`}
        <button class=${`btn ${m.danger ? "danger" : "primary"}`} autofocus=${m.kind !== "prompt"}
          onClick=${() => closeModal(okValue())}><span class="lbl">${m.ok}</span></button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- messages
/** The latest message ("Deleted circle. Ctrl+Z brings it back.", errors...) as a pop-up that goes away by itself. */
export function Toast() {
  const st = store.status;
  const [dismissed, setDismissed] = useState(0);
  useEffect(() => {
    if (!st.id) return undefined;
    const timer = setTimeout(() => setDismissed(st.id), st.kind === "error" ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [st.id]);
  if (!st.id || !st.text || dismissed === st.id) return null;
  const act = st.action && store.actions?.[st.action.name];
  return html`<div class=${`toast ${st.kind}`} role="status" title="Click to dismiss" onClick=${() => setDismissed(st.id)}>
    ${st.text}${act && html`<button class="toast-action" onClick=${(e) => { e.stopPropagation(); setDismissed(st.id); act(); }}>
      <span class="lbl">${st.action.label}</span></button>`}</div>`;
}
