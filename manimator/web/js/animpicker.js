// The animation window, for an object (every animation, grouped by what it does, plus the `.animate` methods) or
// for the scene itself (camera moves, grid transformations... depending on its type). It opens in the middle of the
// screen like the object window; clicking a tile picks it.

import { html, useRef, useState } from "./lib.js";
import { emit, scene, store } from "./store.js";
import { Icon } from "./ui.js";
import { CATEGORY_COLORS, CATEGORY_ICONS, playsOn, sceneActions } from "./util.js";

export const SCENE_TARGET = "scene"; // the window animates the scene itself
const METHODS = "Animate a method";
const HEAD = 64; // a section scrolled to sits this far below the top, clear of the search bar

/** Open the window. `target` is an object id or SCENE_TARGET.
 *  `onPick(animKey, methodKey | null, target)` runs with the choice. `oneStep`: the pick plays with other animations
 *  in a step, so scene animations that need a step to themselves are left out. */
export function openAnimPicker({ target, sub, onPick, oneStep = false }) {
  store.animPick = { target, sub, onPick, oneStep, id: (store.animPick?.id ?? 0) + 1 };
  emit();
}

export function closeAnimPicker() {
  if (store.animPick) {
    store.animPick = null;
    emit();
  }
}

export function Tile({ name, desc, color, blocked, onClick }) {
  return html`<button class=${`an-tile ${blocked ? "blocked" : ""}`} style=${`--c:${color}`} disabled=${!!blocked}
      title=${blocked ? `${desc}\n${blocked}` : desc} onClick=${onClick}>
    <span class="nm">${name}</span>
    <span class="ds">${blocked || desc}</span>
  </button>`;
}

function AnimPicker({ target, onPick, oneStep }) {
  const { catalog, specs } = store;
  const sc = scene();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const mainRef = useRef();
  const needle = query.trim().toLowerCase();
  const matches = (...texts) => !needle || texts.some((t) => (t || "").toLowerCase().includes(needle));
  const pick = (anim, method = null) => { closeAnimPicker(); onPick(anim, method, target); };
  const typeKey = sc.mobjects.find((m) => m.id === target)?.type;

  // [section, [tiles], color] in display order
  let sections;
  if (target === SCENE_TARGET) {
    const actions = sceneActions(sc).filter((a) => !oneStep || a.fixedTime == null);
    sections = [...new Set(actions.map((a) => a.category))].map((cat) => [cat, actions
      .filter((a) => a.category === cat && matches(a.label, a.description, cat))
      .map((a) => html`<${Tile} name=${a.label} desc=${a.description} color=${CATEGORY_COLORS[cat]}
        onClick=${() => pick(a.key)} />`), CATEGORY_COLORS[cat]]);
  } else {
    sections = catalog.animCategories.map((cat) => [cat, catalog.animations
      .filter((a) => a.category === cat && !a.sceneKinds.length && a.key !== catalog.animate
        && matches(a.key, specs.animations[a.key].description, cat))
      .map((a) => {
        const blocked = a.only.length > 0 && !a.only.includes(typeKey) ? `Only for ${a.only.join(", ")}` : null;
        return html`<${Tile} name=${a.key} desc=${specs.animations[a.key].description} color=${CATEGORY_COLORS[cat]}
          blocked=${blocked} onClick=${() => pick(a.key)} />`;
      }), CATEGORY_COLORS[cat]]);
    // customizations (Customizations page), by their own names: a custom object's animations only for it, and
    // first, as they were made for it
    const custom = ["Custom", store.kits.animations
      .filter((a) => playsOn(a, typeKey) && matches(a.label, a.description, "custom"))
      .map((a) => html`<${Tile} name=${a.label} desc=${a.description} color=${CATEGORY_COLORS.Custom}
        onClick=${() => pick(a.key)} />`), CATEGORY_COLORS.Custom];
    if (store.kits.animations.some((a) => a.only?.includes(typeKey))) sections.unshift(custom);
    else sections.push(custom);
  }
  const moveColor = CATEGORY_COLORS[specs.animations[catalog.animate]?.category] ?? CATEGORY_COLORS.Move;
  const methodGroups = target === SCENE_TARGET ? [] : catalog.methodGroups.map((g) => [g, catalog.methods
    .filter((m) => m.group === g && matches(m.key, m.label, m.description, g, "animate method"))
    .map((m) => html`<${Tile} name=${m.label} desc=${m.description || m.label} color=${moveColor}
      onClick=${() => pick(catalog.animate, m.key)} />`)]).filter(([, t]) => t.length);
  const shown = sections.filter(([, t]) => t.length);
  const nav = [...shown.map(([cat, t, color]) => [cat, t.length, color]),
    ...(methodGroups.length ? [[METHODS, methodGroups.reduce((n, [, t]) => n + t.length, 0), moveColor]] : [])];
  const current = nav.some(([n]) => n === active) ? active : nav[0]?.[0];

  const sectionEls = () => [...mainRef.current.querySelectorAll(".pal-cat")];
  const onScroll = () => {
    const main = mainRef.current;
    if (!main) return; // a scroll that arrives after the window closed
    const top = main.getBoundingClientRect().top + HEAD + 8;
    // At the very bottom the last section can't scroll up to the top, so it counts as the one in view.
    const atEnd = main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
    const hit = (atEnd ? sectionEls().slice(-1) : sectionEls().filter((el) => el.getBoundingClientRect().top <= top)).pop()
      ?? sectionEls()[0];
    if (hit && hit.dataset.cat !== active) setActive(hit.dataset.cat);
  };
  const jump = (name) => {
    const el = sectionEls().find((x) => x.dataset.cat === name);
    if (el) mainRef.current.scrollTo({ top: el.offsetTop - HEAD, behavior: "smooth" });
    setActive(name);
  };

  let empty = null;
  if (!nav.length) {
    empty = needle ? `No animation matches “${query}”.`
      : sceneActions(sc).length ? "The scene's animations need a step of their own."
        : "A plain Scene has no animations of its own. Select an object to animate it, or change the Scene type "
          + "(click empty canvas, then Scene type in the Inspector) to move the camera and more.";
  }
  return html`<div class="pal-body">
    <nav class="pal-nav">
      ${nav.map(([name, n, color]) => html`<button class=${`pal-nav-item ${name === current ? "on" : ""}`} onClick=${() => jump(name)}>
        <span class="an-dot" style=${`background:${color}`} />
        <span class="lbl">${name}</span><span class="n">${n}</span></button>`)}
    </nav>
    <div class="pal-main" ref=${mainRef} onScroll=${onScroll}>
      <div class="pal-search">
        <input class="input" type="search" placeholder="Search animations…" spellcheck="false" value=${query}
          ref=${(el) => { if (el && !el.dataset.f) { el.dataset.f = "1"; setTimeout(() => el.isConnected && el.focus(), 0); } }}
          onInput=${(e) => { setQuery(e.target.value); mainRef.current.scrollTop = 0; }} />
      </div>
      ${empty && html`<div class="empty">${empty}</div>`}
      ${shown.map(([cat, tiles]) => html`<section class="pal-cat" data-cat=${cat}>
        <h4>${CATEGORY_ICONS[cat] ?? ""} ${cat}</h4>
        <div class="an-grid">${tiles}</div>
      </section>`)}
      ${methodGroups.length > 0 && html`<section class="pal-cat" data-cat=${METHODS}>
        <h4>${METHODS} <span class="dim">· changes over time with .animate</span></h4>
        ${methodGroups.map(([g, tiles]) => html`<h5>${g}</h5><div class="an-grid">${tiles}</div>`)}
      </section>`}
    </div>
  </div>`;
}

export function AnimWindow() {
  const a = store.animPick;
  if (!a) return null;
  const sc = scene();
  const name = a.target === SCENE_TARGET ? sc.name : sc.mobjects.find((m) => m.id === a.target)?.name;
  return html`<div class="pal-back an-back" onPointerDown=${(e) => e.target === e.currentTarget && closeAnimPicker()}>
    <div class="pal-win an-win" role="dialog" aria-label="Animate">
      <div class="pal-title">
        <${Icon} name="play" />
        <span class="name">Animate “${name}”</span>
        ${a.sub && html`<span class="path">${a.sub}</span>`}
        <span class="grow" />
        <button class="btn small icon ghost" title="Close (Esc)" onClick=${closeAnimPicker}><${Icon} name="x" /></button>
      </div>
      <${AnimPicker} key=${`${a.id}:${a.target}`} target=${a.target} onPick=${a.onPick} oneStep=${a.oneStep} />
    </div>
  </div>`;
}
