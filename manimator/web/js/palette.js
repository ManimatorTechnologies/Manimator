// The "+" in the Objects panel opens this window: click an object, then click the canvas.
// Or drag it from here onto the canvas (the window steps aside while you drag).

import { html, useRef, useState } from "./lib.js";
import { emit, store } from "./store.js";
import { Icon } from "./ui.js";
import { addObject } from "./actions.js";
import { SHORT_LABELS, typeLabel } from "./util.js";

export const DRAG_TYPE = "application/x-manimator-mobject";

/** An object's icon (drawn once by tools/make_icons.py); objects without one (customizations too) show their symbol. */
export function iconImg(key, cls = "") {
  if (String(key).startsWith("kit:")) return null;
  return html`<img class=${cls} src=${`/static/icons/${key}.png`} alt="" draggable="false"
    onLoad=${(e) => e.target.classList.add("ok")} onError=${(e) => e.target.remove()} />`;
}

// Objects without a spot of their own (graphs, groups, helpers) are added right away.
const placeable = (spec) => spec.positioned || spec.pointParams.length > 0;

function PaletteButton({ spec }) {
  const armed = store.armed === spec.key;
  const label = SHORT_LABELS[spec.key] ?? typeLabel(spec.key);
  const tip = `${spec.kit ? `${label} (a customization)` : spec.key}${spec.description ? ` — ${spec.description}` : ""}\n`
    + (spec.needsTarget ? "Select the object it attaches to first, then click here."
      : !placeable(spec) ? "Click to add it."
      : "Click, then click the canvas. You can also drag it onto the canvas.");
  return html`<button class=${`pal-btn ${armed ? "armed" : ""}`} title=${tip} draggable="true"
    onClick=${() => {
      closePalette();
      if (spec.needsTarget || !placeable(spec)) {
        addObject(spec.key, 0, 0);
        return;
      }
      store.armed = armed ? null : spec.key;
      emit();
    }}
    onDragStart=${(e) => {
      e.dataTransfer.setData(DRAG_TYPE, spec.key);
      e.dataTransfer.effectAllowed = "copy";
      // Get out of the way so the canvas can take the drop; wait a tick so the drag image is captured first.
      setTimeout(() => { store.paletteDragging = true; emit(); }, 0);
    }}
    onDragEnd=${closePalette}>
    ${iconImg(spec.key)}
    <span class="glyph">${spec.icon}</span>
    <span class="name">${label}</span>
  </button>`;
}

export function Palette() {
  const { catalog, specs } = store;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const mainRef = useRef();
  const needle = query.trim().toLowerCase();
  const matches = (m) => !needle
    || [m.key, SHORT_LABELS[m.key] ?? "", m.label ?? "", m.description, m.category]
      .some((t) => t.toLowerCase().includes(needle));
  const groups = catalog.mobCategories
    .map((cat) => [cat, catalog.mobjects.filter((m) => m.category === cat && matches(m))])
    .concat([["Custom", store.kits.mobjects.filter(matches)]]) // customizations (Customizations page)
    .filter(([, list]) => list.length);
  const current = groups.some(([cat]) => cat === active) ? active : groups[0]?.[0];
  const sections = () => [...mainRef.current.querySelectorAll(".pal-cat")];
  const HEAD = 64; // a section scrolled to sits this far below the top, clear of the search bar
  const onScroll = () => {
    // The category list follows the scroll: the last section whose heading has reached the top.
    const main = mainRef.current;
    if (!main) return; // a scroll that arrives after the palette closed
    const top = main.getBoundingClientRect().top + HEAD + 8;
    const hit = sections().filter((el) => el.getBoundingClientRect().top <= top).pop() ?? sections()[0];
    if (hit && hit.dataset.cat !== active) setActive(hit.dataset.cat);
  };
  const jump = (cat) => {
    const el = sections().find((x) => x.dataset.cat === cat);
    if (el) mainRef.current.scrollTo({ top: el.offsetTop - HEAD, behavior: "smooth" });
    setActive(cat);
  };
  return html`<div class="pal-body">
    <nav class="pal-nav">
      ${groups.map(([cat, list]) => html`<button class=${`pal-nav-item ${cat === current ? "on" : ""}`} onClick=${() => jump(cat)}>
        <span class="lbl">${cat}</span><span class="n">${list.length}</span></button>`)}
    </nav>
    <div class="pal-main" ref=${mainRef} onScroll=${onScroll}>
      <div class="pal-search">
        <input class="input" type="search" placeholder="Search objects…" spellcheck="false" value=${query}
          ref=${(el) => { if (el && !el.dataset.f) { el.dataset.f = "1"; setTimeout(() => el.isConnected && el.focus(), 0); } }}
          onInput=${(e) => { setQuery(e.target.value); mainRef.current.scrollTop = 0; }} />
      </div>
      ${groups.length === 0 && html`<div class="empty">No object matches “${query}”.</div>`}
      ${groups.map(([cat, list]) => html`<section class="pal-cat" data-cat=${cat}>
        <h4>${cat}</h4>
        <div class="pal-grid">
          ${list.map((m) => html`<${PaletteButton} spec=${specs.mobjects[m.key]} />`)}
        </div>
      </section>`)}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- the "+" window
export function closePalette() {
  if (store.paletteOpen) {
    Object.assign(store, { paletteOpen: false, paletteDragging: false });
    emit();
  }
}

/** Open (or close) the object window. */
export function togglePalette() {
  Object.assign(store, { paletteOpen: !store.paletteOpen, paletteDragging: false });
  emit();
}

export function PalettePopover() {
  if (!store.paletteOpen) return null;
  const max = !!store.paletteMax;
  const toggleMax = () => { store.paletteMax = !max; emit(); };
  return html`<div class=${`pal-back ${store.paletteDragging ? "dragging" : ""}`}
      onPointerDown=${(e) => e.target === e.currentTarget && closePalette()}>
    <div class=${`pal-win ${max ? "max" : ""}`} role="dialog" aria-label="Add an object">
      <div class="pal-title" onDblClick=${(e) => !e.target.closest("button") && toggleMax()}>
        <${Icon} name="plus" />
        <span class="name">Add object</span>
        <span class="path">Click one, then click the canvas · or drag it onto the canvas</span>
        <span class="grow" />
        <button class="btn small icon ghost" title=${max ? "Restore" : "Maximize"} onClick=${toggleMax}>
          <${Icon} name=${max ? "restore" : "maximize"} /></button>
        <button class="btn small icon ghost" title="Close (Esc)" onClick=${closePalette}><${Icon} name="x" /></button>
      </div>
      <${Palette} />
    </div>
  </div>`;
}
