// The method window: "Add Method" in the Inspector opens it in the middle of the screen, like the object and
// animation windows. Clicking a tile adds that method to the object (methods run once, top to bottom, after it is
// created: placing it next to others, rotating, scaling, recolouring...).

import { html, useRef, useState } from "./lib.js";
import { emit, scene, sop, store } from "./store.js";
import { Icon } from "./ui.js";
import { Tile } from "./animpicker.js";
import { CATEGORY_COLORS } from "./util.js";

const GROUP_COLORS = { Position: CATEGORY_COLORS.Move, Transform: CATEGORY_COLORS.Transform, Style: CATEGORY_COLORS.Emphasize };
const HEAD = 64; // a section scrolled to sits this far below the top, clear of the search bar

/** Open the window for the object `mobId`. */
export function openMethodPicker(mobId) {
  store.methodPick = { mobId };
  emit();
}

export function closeMethodPicker() {
  if (store.methodPick) {
    store.methodPick = null;
    emit();
  }
}

function MethodPicker({ mobId }) {
  const { catalog } = store;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const mainRef = useRef();
  const needle = query.trim().toLowerCase();
  const matches = (...texts) => !needle || texts.some((t) => (t || "").toLowerCase().includes(needle));
  const pick = (key) => {
    closeMethodPicker();
    sop("add_method", { mob_id: mobId, method: key });
  };
  const groups = catalog.methodGroups.map((g) => [g, catalog.methods
    .filter((m) => m.group === g && matches(m.key, m.label, m.description, g))
    .map((m) => html`<${Tile} name=${m.label} desc=${m.description} color=${GROUP_COLORS[g] ?? "#888"}
      onClick=${() => pick(m.key)} />`)]).filter(([, tiles]) => tiles.length);
  const current = groups.some(([g]) => g === active) ? active : groups[0]?.[0];

  const sectionEls = () => [...mainRef.current.querySelectorAll(".pal-cat")];
  const onScroll = () => {
    const main = mainRef.current;
    if (!main) return;
    const top = main.getBoundingClientRect().top + HEAD + 8;
    // At the very bottom the last section can't scroll up to the top, so it counts as the one in view.
    const atEnd = main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
    const hit = (atEnd ? sectionEls().slice(-1) : sectionEls().filter((el) => el.getBoundingClientRect().top <= top)).pop()
      ?? sectionEls()[0];
    if (hit && hit.dataset.cat !== active) setActive(hit.dataset.cat);
  };
  const jump = (g) => {
    const el = sectionEls().find((x) => x.dataset.cat === g);
    if (el) mainRef.current.scrollTo({ top: el.offsetTop - HEAD, behavior: "smooth" });
    setActive(g);
  };

  return html`<div class="pal-body">
    <nav class="pal-nav">
      ${groups.map(([g, tiles]) => html`<button class=${`pal-nav-item ${g === current ? "on" : ""}`} onClick=${() => jump(g)}>
        <span class="an-dot" style=${`background:${GROUP_COLORS[g] ?? "#888"}`} />
        <span class="lbl">${g}</span><span class="n">${tiles.length}</span></button>`)}
    </nav>
    <div class="pal-main" ref=${mainRef} onScroll=${onScroll}>
      <div class="pal-search">
        <input class="input" type="search" placeholder="Search methods…" spellcheck=${false} value=${query}
          ref=${(el) => { if (el && !el.dataset.f) { el.dataset.f = "1"; setTimeout(() => el.isConnected && el.focus(), 0); } }}
          onInput=${(e) => { setQuery(e.target.value); mainRef.current.scrollTop = 0; }} />
      </div>
      ${groups.length === 0 && html`<div class="empty">No method matches “${query}”.</div>`}
      ${groups.map(([g, tiles]) => html`<section class="pal-cat" data-cat=${g}>
        <h4>${g}</h4>
        <div class="an-grid">${tiles}</div>
      </section>`)}
    </div>
  </div>`;
}

export function MethodWindow() {
  const pickFor = store.methodPick;
  if (!pickFor) return null;
  const name = scene().mobjects.find((m) => m.id === pickFor.mobId)?.name;
  return html`<div class="pal-back" onPointerDown=${(e) => e.target === e.currentTarget && closeMethodPicker()}>
    <div class="pal-win mt-win" role="dialog" aria-label="Add a method">
      <div class="pal-title">
        <${Icon} name="plus" />
        <span class="name">Add Method</span>
        <span class="path">to “${name}”</span>
        <span class="grow" />
        <button class="btn small icon ghost" title="Close (Esc)" onClick=${closeMethodPicker}><${Icon} name="x" /></button>
      </div>
      <${MethodPicker} key=${pickFor.mobId} mobId=${pickFor.mobId} />
    </div>
  </div>`;
}
