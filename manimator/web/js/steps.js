// Animation panel: a timeline of steps. Click a step to select it; click it again to open its settings in a window
// in the middle of the screen.

import { html, useEffect, useLayoutEffect, useRef, useState } from "./lib.js";
import { addWait, animateTarget, openAnimateWindow } from "./actions.js";
import { NumberInput, ParamForm } from "./fields.js";
import { openAnimPicker, SCENE_TARGET } from "./animpicker.js";
import { emit, mk, names, scene, selectStep, sop, status, store } from "./store.js";
import { Dropdown, Icon } from "./ui.js";
import {
  CATEGORY_COLORS, CATEGORY_ICONS, animCategory, animName, animParams, animSummary, clamp, isAction, newGesture, playsOn,
  refChoices, round, sceneActions,
} from "./util.js";

const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const MIN_TICK_PX = 56;
const stepLength = (s) => (s.kind === "wait" ? s.duration : s.run_time);
/** Seconds a step must last when it plays a fixed sequence of its own (null for the rest). */
const fixedTime = (s) => s.animations.map((a) => store.specs.animations[a.anim]?.fixedTime).find((t) => t != null) ?? null;
const fmtSec = (t) => `${round(t, 2)}s`;

/** Seconds per (invisible) tick: the view ends on one, so the scale changes in tidy steps. */
function tickStep(width, length) {
  return TICK_STEPS.find((t) => (t / length) * width >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

/** How many seconds the timeline shows: the scene plus room to drag into, ending on a tick. */
function viewLength(width, total) {
  const want = Math.max(total * 1.15, 1);
  const t = tickStep(width, want);
  return Math.ceil(want / t) * t;
}

const PAD = 4; // room inside the scrolling area for the selected block's outline (2px, 2px away)
const MIN_VIEW_SECONDS = 0.5; // the furthest Alt+wheel zooms in: half a second across the timeline
let altZoomed = false; // Alt was used to zoom: its release must not also open the browser's menu

/** Steps sized by how long they last, with an audio track on the same time scale under them.
 *  Click a block to edit it; drag its right end to change its length. Alt+wheel zooms in and out around the pointer
 *  (out as far as the whole scene); zoomed in, the tracks scroll sideways together. */
function Timeline({ sc }) {
  const ref = useRef(); // the scrolling area
  const [width, setWidth] = useState(0); // of the visible part of the tracks
  const [bar, setBar] = useState(0); // height of the scrollbar kept under the tracks (0 where scrollbars float)
  const [drag, setDrag] = useState(null); // { i, x0, len0, len, pps } while resizing a block
  const [zoomPps, setZoomPps] = useState(null); // pixels per second chosen with Alt+wheel; null fits the scene
  const [zooming, setZooming] = useState(false); // blocks don't glide while the wheel turns, so they stay under it
  const anchor = useRef(null); // after a zoom: { t, x }, the time to keep at x pixels from the left of the view
  const zoomEnd = useRef();
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      setWidth(Math.max(0, (el?.clientWidth ?? 0) - 2 * PAD));
      setBar(el ? el.offsetHeight - el.clientHeight : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const keys = (e) => {
      if (e.key !== "Alt") return;
      if (e.type === "keydown") altZoomed = false;
      else if (altZoomed) { e.preventDefault(); altZoomed = false; }
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keys);
      clearTimeout(zoomEnd.current);
    };
  }, []);
  const nm = names();
  const lengths = sc.steps.map((s, i) => (drag?.i === i ? drag.len : stepLength(s)));
  const total = lengths.reduce((a, b) => a + b, 0);
  const fitPps = width > 0 ? width / viewLength(width, total) : 0;
  // The scale stays put while dragging, so the end follows the pointer.
  const pps = drag?.pps ?? (zoomPps != null ? Math.max(zoomPps, fitPps) : fitPps);
  // As wide as the view, or the scene plus room to drag into when zoomed in (or dragged past the end).
  const contentWidth = Math.max(width, Math.ceil(total * 1.15 * pps));
  useLayoutEffect(() => {
    if (!anchor.current || !ref.current) return;
    ref.current.scrollLeft = anchor.current.t * pps - anchor.current.x;
    anchor.current = null;
  });

  const zoom = (e) => {
    if (!e.altKey || !pps) return;
    e.preventDefault();
    altZoomed = true;
    const el = ref.current;
    const x = clamp(e.clientX - el.getBoundingClientRect().left - PAD, 0, width); // the pointer, in the view
    const delta = e.deltaY || e.deltaX; // a line is about 40 pixels
    const next = clamp(pps * Math.exp(-delta * (e.deltaMode === 1 ? 0.06 : 0.0015)), fitPps,
      Math.max(fitPps, width / MIN_VIEW_SECONDS));
    anchor.current = { t: (el.scrollLeft + x) / pps, x };
    setZoomPps(next <= fitPps * 1.001 ? null : next);
    setZooming(true);
    clearTimeout(zoomEnd.current);
    zoomEnd.current = setTimeout(() => setZooming(false), 250);
  };

  const startDrag = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ i, x0: e.clientX, len0: lengths[i], len: lengths[i], pps });
  };
  const moveDrag = (e) => {
    if (!drag) return;
    const s = sc.steps[drag.i];
    // The end follows the pointer exactly (rounded to 0.01s only when saved); Shift snaps to half seconds.
    const raw = drag.len0 + (e.clientX - drag.x0) / pps;
    const len = clamp(e.shiftKey ? Math.round(raw * 2) / 2 : raw, 0.05, s.kind === "wait" ? 3600 : 600);
    if (len !== drag.len) setDrag({ ...drag, len });
  };
  const endDrag = () => {
    if (!drag) return;
    const s = sc.steps[drag.i];
    const value = round(drag.len, 2);
    if (s && value !== drag.len0) sop("set_step", { step: drag.i, name: s.kind === "wait" ? "duration" : "run_time", value });
    setDrag(null);
  };

  let at = 0;
  return html`<div class=${`tl ${drag ? "dragging" : ""} ${zooming ? "zooming" : ""}`} style=${`--bar:${bar}px`}>
    <div class="tl-icons">
      <span class="tl-ic" title="Visual: the animation steps"><${Icon} name="film" /></span>
      <span class="tl-ic" title="Audio"><${Icon} name="audio" /></span>
    </div>
    <div class="tl-scroll" ref=${ref} onWheel=${zoom}>
      <div class="tl-tracks" style=${`width:${contentWidth}px`}>
        <div class="tl-track">
          ${sc.steps.length === 0 && html`<div class="tl-empty">Empty timeline</div>`}
          ${pps > 0 && sc.steps.map((s, i) => {
            const start = at;
            const len = lengths[i];
            at += len;
            const color = s.kind === "wait" ? null : CATEGORY_COLORS[animCategory(s.animations[0])];
            const label = s.kind === "wait" ? "wait" : s.animations.map(animName).join(" + ");
            const what = s.kind === "wait" ? `wait ${fmtSec(len)}` : s.animations.map((a) => animSummary(a, nm)).join(" + ");
            // The name comes first; the length joins it when both fit, and takes over a narrow block while resizing.
            const roomy = len * pps >= 96, resizing = drag?.i === i;
            // Edges on whole pixels, so the selection outline is equally crisp on every side; 2px between blocks.
            const x0 = Math.round(start * pps), x1 = Math.round((start + len) * pps);
            return html`<div class=${`blk ${s.kind === "wait" ? "wait" : ""} ${store.selectedStep === i ? "sel" : ""} ${drag?.i === i ? "resizing" : ""}`}
                style=${`left:${x0}px; width:${Math.max(x1 - x0 - 2, 6)}px; ${color ? `background:${color}` : ""}`}
                title=${`${i + 1}. ${what} · ${fmtSec(start)} → ${fmtSec(start + len)}${store.selectedStep === i ? " · click again to edit" : ""}`}
                onClick=${() => clickStep(i)}>
              ${(roomy || !resizing) && html`<span class="lbl">${label}</span>`}
              ${(roomy || resizing) && html`<span class="dur">${fmtSec(len)}</span>`}
              ${(s.kind === "wait" || fixedTime(s) == null) && html`<div class="grip" title="Drag to change how long this step lasts (Shift: half seconds)"
                onPointerDown=${(e) => startDrag(e, i)} onPointerMove=${moveDrag} onPointerUp=${endDrag} onPointerCancel=${endDrag}
                onClick=${(e) => e.stopPropagation()} />`}
            </div>`;
          })}
        </div>
        <div class="tl-track audio"><div class="tl-empty">No audio yet</div></div>
      </div>
    </div>
  </div>`;
}

/** Dropdown choices for a scene action: the actions this kind of scene can do, by category. */
function actionOptions(sc) {
  const actions = sceneActions(sc);
  const cats = [...new Set(actions.map((x) => x.category))];
  return cats.flatMap((cat) => [{ section: `${CATEGORY_ICONS[cat]} ${cat}` },
    ...actions.filter((x) => x.category === cat).map((x) => [x.key, x.label])]);
}

function ActionCard({ sc, si, ai, a }) {
  const spec = store.specs.animations[a.anim];
  return html`<div class="card">
    <div class="ch" style="gap:8px">
      <div class="ctl" style="flex:1">
        <${Dropdown} value=${a.anim} title="Scene action" options=${actionOptions(sc)}
          onChange=${(anim) => sop("change_animation", { step: si, index: ai, anim })} />
      </div>
      <button class="btn small icon ghost danger" title="Remove this action"
        onClick=${async () => {
          const removedStep = await sop("remove_animation", { step: si, index: ai });
          if (removedStep) selectStep(null);
        }}><${Icon} name="x" /></button>
    </div>
    <div class="cb">
      ${spec.description && html`<div class="desc">${spec.description}</div>`}
      ${spec.params.length > 0 && html`<${ParamForm} params=${spec.params} values=${a.params}
        refs=${() => sc.mobjects.map((m) => [m.id, m.name])}
        onChange=${(name, value, g) => sop("set_animation_param", { step: si, index: ai, name, value }, mk(`st${si}.${ai}:${name}`, g))} />`}
    </div>
  </div>`;
}

/** The Custom section of the animation dropdown: the visitor's customizations that play on the target (a custom
 *  object's animations play only on it), and the step's own if it is one they can't add any more (so it still shows
 *  its name). */
function customAnimOptions(current, targetType) {
  const list = store.kits.animations.filter((x) => playsOn(x, targetType));
  const own = store.specs.animations[current];
  if ((own?.kit || own?.blocked) && !list.some((x) => x.key === current)) list.push(own);
  return list.length ? [{ section: `${CATEGORY_ICONS.Custom} Custom` }, ...list.map((x) => [x.key, x.label])] : [];
}

function AnimCard({ sc, si, ai, a }) {
  const { catalog, specs } = store;
  if (isAction(a)) return html`<${ActionCard} sc=${sc} si=${si} ai=${ai} a=${a} />`;
  const params = animParams(a);
  const isAnimate = a.anim === catalog.animate;
  const desc = isAnimate ? specs.methods[a.method]?.description : specs.animations[a.anim]?.description;
  const own = specs.animations[a.anim];
  const targets = sc.mobjects.filter((m) => m.id === a.target || !own?.kit || playsOn(own, m.type));
  return html`<div class="card">
    <div class="ch" style="gap:8px">
      <div class="ctl" style="flex:1">
        <${Dropdown} value=${a.anim} title="Animation"
          options=${[...catalog.animCategories.flatMap((cat) => {
            const anims = catalog.animations.filter((x) => x.category === cat && !x.sceneKinds.length);
            return anims.length ? [{ section: `${CATEGORY_ICONS[cat]} ${cat}` },
              ...anims.map((x) => [x.key, x.key === catalog.animate ? "Animate a method" : x.key])] : [];
          }), ...customAnimOptions(a.anim, sc.mobjects.find((m) => m.id === a.target)?.type)]}
          onChange=${(anim) => sop("change_animation", { step: si, index: ai, anim,
            // .animate needs a method; start from the current one (or the first) and let the Method field change it
            method: anim === catalog.animate ? a.method ?? catalog.methods[0]?.key : undefined })} />
        <span class="tag">on</span>
        <${Dropdown} value=${a.target} title="Which object" options=${targets.map((m) => [m.id, m.name])}
          onChange=${(target_id) => sop("set_animation_target", { step: si, index: ai, target_id })} />
      </div>
      <button class="btn small icon ghost danger" title="Remove this animation"
        onClick=${async () => {
          const removedStep = await sop("remove_animation", { step: si, index: ai });
          if (removedStep) selectStep(null);
        }}><${Icon} name="x" /></button>
    </div>
    <div class="cb">
      ${isAnimate && html`<div class="form" style="margin-bottom:8px">
        <label>Method</label>
        <div class="ctl">
          <${Dropdown} value=${a.method}
            options=${catalog.methodGroups.flatMap((g) => [{ section: g },
              ...catalog.methods.filter((m) => m.group === g).map((m) => [m.key, m.label])])}
            onChange=${(method) => sop("change_animation", { step: si, index: ai, anim: a.anim, method })} />
        </div>
      </div>`}
      ${desc && html`<div class="desc">${desc}</div>`}
      ${params.length > 0 && html`<${ParamForm} params=${params} values=${a.params}
        refs=${() => refChoices(sc, a.target, false)}
        onChange=${(name, value, g) => sop("set_animation_param", { step: si, index: ai, name, value }, mk(`st${si}.${ai}:${name}`, g))} />`}
    </div>
  </div>`;
}

/** The first click on a block selects that step; clicking the already selected block opens its settings. */
function clickStep(i) {
  Object.assign(store, store.selectedStep === i ? { stepOpen: true } : { selectedStep: i, stepOpen: false });
  emit();
}

export function closeStepEditor() {
  if (store.stepOpen) {
    store.stepOpen = false;
    emit();
  }
}

let lagGesture = null; // the Stagger slider's drag: one undo step per drag, not one per step forever

/** Short name for a step, as on its timeline block. */
const stepLabel =(s) => (s.kind === "wait" ? "Wait" : s.animations.map(animName).join(" + "));

function StepEditor({ sc }) {
  const i = store.selectedStep;
  const s = sc.steps[i];
  const set = (name, value, g) => sop("set_step", { step: i, name, value }, mk(`step${i}:${name}`, g));
  if (s.kind === "wait") {
    return html`<div class="section"><div class="sh">Timing</div><div class="sb"><div class="form">
      <label>Duration</label><div class="ctl"><${NumberInput} value=${s.duration} min=${0.05} max=${3600} step=${0.25} suffix="s"
        onChange=${(v) => set("duration", v)} /></div>
    </div></div></div>`;
  }
  // the selected object; with none, the scene (or else the step's own object)
  const target = animateTarget(store.selectedId, { oneStep: true, fallback: s.animations.find((a) => a.target)?.target });
  const fixed = fixedTime(s);
  if (fixed != null) {
    return html`<div>
      <div class="section"><div class="sh">Timing</div><div class="sb"><div class="form">
        <label>Duration</label><div class="ctl"><span class="tag">${fmtSec(fixed)}, set by the sequence it plays</span></div>
      </div></div></div>
      ${s.animations.map((a, ai) => html`<${AnimCard} sc=${sc} si=${i} ai=${ai} a=${a} />`)}
    </div>`;
  }
  return html`<div>
    <div class="section"><div class="sh">Timing</div>
      <div class="sb"><div class="form">
        <label>Duration</label>
        <div class="ctl"><${NumberInput} value=${s.run_time} min=${0.05} max=${600} step=${0.25} suffix="s"
          onChange=${(v) => set("run_time", v)} /></div>
        <label title="How the motion speeds up and slows down">Easing</label>
        <div class="ctl"><${Dropdown} value=${s.rate_func} options=${store.catalog.rateFuncs}
          onChange=${(v) => set("rate_func", v)} /></div>
        ${s.animations.length > 1 && html`
          <label title="0 plays everything together; higher values start each animation a bit after the previous one">Stagger</label>
          <div class="ctl"><input type="range" class="slider" min="0" max="1" step="0.05" value=${s.lag_ratio}
            onPointerDown=${() => { lagGesture = newGesture(); }} onPointerUp=${() => { lagGesture = null; }}
            onInput=${(e) => set("lag_ratio", Number(e.target.value), lagGesture ?? newGesture())} />
            <span class="tag" style="width:34px">${s.lag_ratio.toFixed(2)}</span></div>`}
      </div></div>
    </div>
    ${s.animations.map((a, ai) => html`<${AnimCard} sc=${sc} si=${i} ai=${ai} a=${a} />`)}
    <div class="sw-add">
      <button class="btn"
        onClick=${() => openAnimPicker({
          target,
          sub: `Plays together with the rest of step ${i + 1}`,
          oneStep: true,
          onPick: (anim, method) => sop("add_animation_to_step", { step: i, anim, method,
            target_id: target === SCENE_TARGET ? null : target }),
        })}>
        <${Icon} name="plus" /><span class="lbl">Play another animation in this step</span></button>
    </div>
  </div>`;
}

/** The step editor as a window in the middle of the screen (like the object window): every step on the left,
 *  the chosen step's timing and animations on the right. */
function StepWindow({ sc }) {
  const i = store.selectedStep;
  const s = store.stepOpen && i != null ? sc.steps[i] : null;
  if (!s) return null;
  const sub = s.kind === "wait" ? "A pause"
    : s.animations.length > 1 ? `${s.animations.length} animations played together` : "1 animation";
  return html`<div class="pal-back sw-back" onPointerDown=${(e) => e.target === e.currentTarget && closeStepEditor()}>
    <div class="sw-win" role="dialog" aria-label=${`Step ${i + 1}`}>
      <div class="pal-title">
        <${Icon} name=${s.kind === "wait" ? "wait" : "play"} />
        <span class="name">Step ${i + 1}: ${s.kind === "wait" ? "wait" : "play"}</span>
        <span class="path">${sub}</span>
        <span class="grow" />
        <button class="btn small icon ghost" title="Close (Esc)" onClick=${closeStepEditor}><${Icon} name="x" /></button>
      </div>
      <div class="pal-body">
        <nav class="pal-nav">
          ${sc.steps.map((x, k) => html`<button class=${`pal-nav-item ${k === i ? "on" : ""}`} onClick=${() => selectStep(k)}
              title=${`Step ${k + 1}: ${stepLabel(x)}`}>
            <span class="sw-dot" style=${x.kind === "wait" ? "" : `background:${CATEGORY_COLORS[animCategory(x.animations[0])]}`} />
            <span class="lbl">${stepLabel(x)}</span><span class="n">${fmtSec(stepLength(x))}</span></button>`)}
        </nav>
        <div class="pal-main sw-main"><${StepEditor} sc=${sc} /></div>
      </div>
    </div>
  </div>`;
}

/** Add, join, split, move and delete steps. Shown in the Animation panel's header. */
export function StepTools() {
  const sc = scene();
  const i = store.selectedStep;
  const merge = () => {
    if (i == null || i === 0 || sc.steps[i].kind !== "play" || sc.steps[i - 1].kind !== "play") {
      status("Select an animation step that comes right after another animation step.", "error");
      return;
    }
    sop("merge_steps", { step: i }).then((r) => r !== undefined && selectStep(r));
  };
  return html`<div class="steptools">
    <button class="btn small icon ghost add"
      title="Animate an object or the scene"
      onClick=${() => openAnimateWindow()}><${Icon} name="plus" /></button>
    <button class="btn small icon ghost" title="Add a pause" onClick=${addWait}><${Icon} name="wait" /></button>
    <button class="btn small icon ghost" title="Play together with the step before it" onClick=${merge}><${Icon} name="merge" /></button>
    <button class="btn small icon ghost" title="Split into separate steps" disabled=${i == null}
      onClick=${() => sop("split_step", { step: i })}><${Icon} name="split" /></button>
    <button class="btn small icon ghost" title="Move earlier" disabled=${i == null || i === 0}
      onClick=${() => sop("move_step", { step: i, delta: -1 }).then((r) => r !== undefined && selectStep(r))}><${Icon} name="left" /></button>
    <button class="btn small icon ghost" title="Move later" disabled=${i == null || i >= sc.steps.length - 1}
      onClick=${() => sop("move_step", { step: i, delta: 1 }).then((r) => r !== undefined && selectStep(r))}><${Icon} name="right" /></button>
    <button class="btn small icon ghost danger" title="Delete step" disabled=${i == null}
      onClick=${() => sop("delete_step", { step: i }).then(() => selectStep(null))}><${Icon} name="trash" /></button>
  </div>`;
}

export function StepsPanel() {
  const sc = scene();
  // keyed by scene: each scene's timeline starts out fitted, not zoomed like the last one
  return html`<div class="steps">
    <${Timeline} key=${sc.id} sc=${sc} />
    <${StepWindow} sc=${sc} />
  </div>`;
}
