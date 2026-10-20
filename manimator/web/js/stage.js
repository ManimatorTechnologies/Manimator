// The 16:9 canvas: shows the scene's starting layout (drawn by the browser engine), plays the scene, and handles
// placing, selecting and dragging.

import { html, useEffect, useLayoutEffect, useRef, useState } from "./lib.js";
import { addObject, deleteSelected, duplicateSelected, moveLayer, openAnimateWindow } from "./actions.js";
import { addObjectItems } from "./menus.js";
import { DRAG_TYPE } from "./palette.js";
import {
  activeEngine, attachCanvas, emit, mobSpec, resizeCanvas, names, onPlaybackTime, scene, seekPlayback, select, sop, stopPlayback, store, togglePlay,
} from "./store.js";
import { Icon, openMenu } from "./ui.js";
import {
  FH, FW, PH, PW, animSummary, clamp, drawsOwnContent, groupMembers, kindOf, newGesture, round, sceneSeconds, snap,
  transformRole,
} from "./util.js";

function position(m) {
  const spec = mobSpec(m.type);
  if (spec.pointParams.length) {
    const pts = spec.pointParams.map((p) => m.params[p]);
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  return m.position;
}

/** The part of the scene in the picture: [center x, center y, width] in scene units. A MovingCameraScene can
 *  start zoomed in or moved, so pixels and scene units are converted through it. */
const DEFAULT_VIEW = [0, 0, FW];
const viewHeight = (view) => (view[2] * FH) / FW;
const toPx = (view, x, y) => [((x - view[0]) / view[2] + 0.5) * PW, (0.5 - (y - view[1]) / viewHeight(view)) * PH];

function rectOf(view, box, pad = 5) {
  const [x0, y0, x1, y1] = box;
  const [ax, ay] = toPx(view, x0, y1);
  const [bx, by] = toPx(view, x1, y0);
  return { x: ax - pad, y: ay - pad, w: bx - ax + 2 * pad, h: by - ay + 2 * pad };
}

function Grid({ view }) {
  const lines = [];
  const [cx, cy, w] = view;
  const h = viewHeight(view);
  const step = w <= 20 ? 1 : w <= 60 ? 5 : 10;
  const [ox, oy] = toPx(view, 0, 0);
  for (let i = Math.ceil((cx - w / 2) / step) * step; i <= cx + w / 2; i += step) {
    const [x] = toPx(view, i, 0);
    lines.push(html`<line x1=${x} y1="0" x2=${x} y2=${PH} stroke=${i ? "rgba(255,255,255,.12)" : "rgba(88,196,221,.5)"} vector-effect="non-scaling-stroke" />`);
    if (i) lines.push(html`<text x=${x + 4} y=${Math.min(PH - 6, Math.max(18, oy - 6))} fill="rgba(255,255,255,.35)" font-size="15">${i}</text>`);
  }
  for (let j = Math.ceil((cy - h / 2) / step) * step; j <= cy + h / 2; j += step) {
    const [, y] = toPx(view, 0, j);
    lines.push(html`<line x1="0" y1=${y} x2=${PW} y2=${y} stroke=${j ? "rgba(255,255,255,.12)" : "rgba(88,196,221,.5)"} vector-effect="non-scaling-stroke" />`);
    if (j) lines.push(html`<text x=${Math.min(PW - 30, Math.max(4, ox + 5))} y=${y - 6} fill="rgba(255,255,255,.35)" font-size="15">${j}</text>`);
  }
  return html`<g>${lines}</g>`;
}

const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const SEG_GAP = 2; // px between the steps' segments of the seek bar
const MIN_SEG_PX = 10; // narrower than this on average and the bar is one plain track

/** The scene's steps as segments of the video: [{ start, end, what }], stretched to `duration` (the engine's
 *  length, which is what plays). */
function segmentsOf(sc, duration) {
  const nm = names();
  const lengths = sc.steps.map((s) => (s.kind === "wait" ? s.duration : s.run_time));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!total || !duration) return [{ start: 0, end: duration, what: "" }];
  const k = duration / total;
  let at = 0;
  return sc.steps.map((s, i) => {
    const start = at;
    at += lengths[i] * k;
    return { start, end: at, what: s.kind === "wait" ? "Wait" : s.animations.map((a) => animSummary(a, nm)).join(" + ") };
  });
}

/** The seek bar: one segment per step (like a video's chapters), filled up to `now`. Hovering shows the time and
 *  step under the pointer; press or drag to see any moment (a playing video carries on from where it's let go);
 *  arrow keys move 0.1 s (Shift: 1 s) while it has focus. */
function SeekBar({ segs, duration, now }) {
  const ref = useRef();
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(null); // pointer x in px
  const [dragging, setDragging] = useState(false);
  const resume = useRef(false);
  useLayoutEffect(() => {
    setWidth(ref.current.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const parts = segs.length > 1 && width / segs.length >= MIN_SEG_PX ? segs : [{ start: 0, end: duration, what: "" }];
  const gap = parts.length > 1 ? SEG_GAP : 0;
  const room = Math.max(1, width - gap * (parts.length - 1)); // the width the segments share, gaps left out
  const xOf = (t, i) => (room * t) / (duration || 1) + i * gap;
  const indexOf = (t) => Math.max(0, parts.findIndex((p, i) => t < p.end || i === parts.length - 1));
  /** The time at x px: inside a segment as drawn, or the nearest end of one in a gap. */
  const timeAt = (x) => {
    let best = 0, dist = Infinity;
    parts.forEach((p, i) => {
      const t = clamp(((x - i * gap) / room) * duration, p.start, p.end);
      const d = Math.abs(xOf(t, i) - x);
      if (d < dist) [best, dist] = [t, d];
    });
    return best;
  };
  const pointerX = (e) => clamp(e.clientX - ref.current.getBoundingClientRect().left, 0, width);
  const off = !duration;

  const down = (e) => {
    if (off || e.button !== 0) return;
    e.preventDefault();
    ref.current.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    resume.current = !!store.playback?.playing;
    setDragging(true);
    seekPlayback(timeAt(pointerX(e)));
  };
  const move = (e) => {
    const x = pointerX(e);
    setHover(x);
    if (dragging) seekPlayback(timeAt(x));
  };
  const up = () => {
    if (!dragging) return;
    setDragging(false);
    if (resume.current && store.playback) togglePlay();
    resume.current = false;
  };
  const key = (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    const to = { ArrowLeft: now - step, ArrowDown: now - step, ArrowRight: now + step, ArrowUp: now + step,
      Home: 0, End: duration }[e.key];
    if (to === undefined || off) return;
    e.preventDefault();
    e.stopPropagation(); // not the editor's arrow keys (they move the selected object)
    seekPlayback(clamp(to, 0, duration));
  };

  const at = indexOf(now);
  const tipT = hover == null ? null : timeAt(hover);
  const tipSeg = tipT == null ? null : parts[indexOf(tipT)];
  const hot = dragging ? at : tipT == null ? -1 : indexOf(tipT);
  return html`<div ref=${ref} class=${`seek ${dragging ? "drag" : ""} ${off ? "off" : ""}`} tabindex=${off ? -1 : 0}
      role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax=${duration} aria-valuenow=${now}
      aria-valuetext=${`${clock(now)} of ${clock(duration)}`}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}
      onPointerLeave=${() => setHover(null)} onKeyDown=${key}>
    <div class="segs" style=${`gap:${gap}px`}>
      ${parts.map((p, i) => html`<div key=${i} class=${`seg ${i === hot ? "hot" : ""}`} style=${`flex:${p.end - p.start} 1 0`}>
        <i style=${`width:${p.end > p.start ? clamp((now - p.start) / (p.end - p.start), 0, 1) * 100 : now >= p.end ? 100 : 0}%`} /></div>`)}
    </div>
    <div class="knob" style=${`left:${xOf(now, at)}px`} />
    ${tipT != null && !off && html`<div class="tip" style=${`left:${clamp(hover, 0, width)}px`}>
      <span class="t">${clock(tipT)}</span>${tipSeg?.what && html`<span class="what">${tipSeg.what}</span>`}</div>`}
  </div>`;
}

/** The player over the canvas while the scene plays (Space): play, the seek bar, the time, and the way back to
 *  editing. It shows only while the pointer is on the video (or a key or drag is using it). */
function Player({ duration }) {
  const [t, setT] = useState(store.playback?.t ?? 0);
  useEffect(() => onPlaybackTime(setT), []);
  const pb = store.playback;
  if (!pb) return null;
  const now = Math.min(t, duration);
  const ended = !pb.playing && duration > 0 && now >= duration - 1e-3;
  const icon = pb.playing ? "pause" : ended ? "replay" : "play";
  return html`<div class="scrubber" onPointerDown=${(e) => e.stopPropagation()} onContextMenu=${(e) => e.stopPropagation()}>
    <button class=${`vp-btn ${icon}`} aria-label=${pb.playing ? "Pause" : ended ? "Play again" : "Play"}
      title=${pb.playing ? "Pause (Space)" : ended ? "Play again (Space)" : "Play (Space)"}
      onClick=${togglePlay} disabled=${!duration}><${Icon} name=${icon} size=${18} /></button>
    <${SeekBar} segs=${segmentsOf(scene(), duration)} duration=${duration} now=${now} />
    <span class="vp-time"><b>${clock(now)}</b> / ${clock(duration)}</span>
    <button class="vp-btn x" aria-label="Back to editing" title="Back to editing (Esc)" onClick=${stopPlayback}>
      <${Icon} name="x" size=${16} /></button>
  </div>`;
}

export function Stage() {
  const wrapRef = useRef();
  const stageRef = useRef();
  const lastClick = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null);
  const [drag, setDrag] = useState(null);
  const canvasRef = useRef();
  const dragDrawn = useRef("null");

  useLayoutEffect(() => {
    // Fit a 16:9 stage inside the available area.
    const measure = () => {
      const { width, height } = wrapRef.current.getBoundingClientRect();
      let w = width - 32;
      let h = (w * 9) / 16;
      if (h > height - 32) {
        h = height - 32;
        w = (h * 16) / 9;
      }
      const next = { w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(h)) };
      setSize((old) => (old.w === next.w && old.h === next.h ? old : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const sc = scene();
  const preview = store.preview?.scene_id === sc.id ? store.preview : null;
  const boxes = preview?.boxes ?? {};
  const errors = preview?.errors ?? {};
  const view = preview?.view ?? DEFAULT_VIEW;
  // After a drag, keep showing the moved box until a preview of the final state arrives.
  const lastMove = useRef(null);
  const settled = drag?.done && drag.version != null && preview && preview.version >= drag.version;
  useEffect(() => {
    if (settled) setDrag(null);
  });

  // The engine draws on this stage's canvas, at the screen's pixel size.
  useLayoutEffect(() => {
    let alive = true;
    if (alive) attachCanvas(canvasRef.current);
    return () => {
      alive = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (!size.w) return;
    const w = Math.round(size.w * (window.devicePixelRatio || 1));
    resizeCanvas(w, Math.round((w * 9) / 16));
  }, [size.w, size.h]);
  // While dragging, the engine draws the object moved from where the last frame has it (until the frame of the
  // final position arrives); the server only gets the new position.
  useLayoutEffect(() => {
    const shownBox = preview?.boxes?.[drag?.id];
    const args = drag?.moved && !settled && drag.box && shownBox
      ? [drag.id, drag.box[0] + drag.pos[0] - drag.origin[0] - shownBox[0], drag.box[1] + drag.pos[1] - drag.origin[1] - shownBox[1]]
      : null;
    const key = JSON.stringify(args);
    if (key === dragDrawn.current) return;
    dragDrawn.current = key;
    activeEngine().then((engine) => (args ? engine.drag(...args) : engine.drag(null)));
  });

  const units = (e) => {
    const r = stageRef.current.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [view[0] + ((e.clientX - r.left) / r.width - 0.5) * view[2],
      view[1] + (0.5 - (e.clientY - r.top) / r.height) * viewHeight(view)];
  };
  const snapping = (e) => store.snap !== e.shiftKey;
  const showCoords = (x, y) => {
    const el = document.getElementById("coords");
    if (el) el.textContent = x === null ? "" : `x ${x >= 0 ? "+" : ""}${x.toFixed(2)}   y ${y >= 0 ? "+" : ""}${y.toFixed(2)}`;
  };

  const hitsAt = (x, y) => {
    const pad = 0.12;
    const order = Object.fromEntries(sc.mobjects.map((m, i) => [m.id, i]));
    const area = ([x0, y0, x1, y1]) => (x1 - x0 + 2 * pad) * (y1 - y0 + 2 * pad);
    // Smallest first, so big backgrounds (planes, axes) don't swallow clicks.
    return Object.entries(boxes)
      .filter(([id, [x0, y0, x1, y1]]) => id in order && x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad)
      .sort((a, b) => area(a[1]) - area(b[1]) || order[b[0]] - order[a[0]])
      .map(([id]) => id);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    stageRef.current.focus();
    if (store.playback) { // the video is shown: a click goes back to editing
      stopPlayback();
      return;
    }
    const u = units(e);
    if (!u) return;
    const [x, y] = u;
    if (store.armed) {
      const [px, py] = snapping(e) ? [snap(x), snap(y)] : [round(x), round(y)];
      addObject(store.armed, px, py);
      return;
    }
    const hits = hitsAt(x, y);
    let pick = hits[0] ?? null;
    const lc = lastClick.current;
    if (lc && hits.length && Math.abs(lc.cx - e.clientX) + Math.abs(lc.cy - e.clientY) <= 4 && lc.key === hits.join()) {
      pick = hits[(lc.index + 1) % hits.length]; // click again to reach objects underneath
    }
    lastClick.current = { cx: e.clientX, cy: e.clientY, key: hits.join(), index: hits.indexOf(pick) };
    select(pick);
    const m = sc.mobjects.find((o) => o.id === pick);
    if (!m) return;
    const spec = mobSpec(m.type);
    // In a 3D scene the screen position isn't the object's x, y, so dragging would drift. A vector that a
    // LinearTransformationScene carries along stays at the origin.
    const fromOrigin = sc.kind === "LinearTransformationScene" && m.type === "Vector" && transformRole(m) === "vector"
      && !groupMembers(sc).has(m.id);
    if ((spec.positioned || spec.pointParams.length) && !kindOf(sc).threeD && !fromOrigin) {
      stageRef.current.setPointerCapture(e.pointerId);
      setDrag({ id: pick, start: [x, y], origin: position(m), box: boxes[pick], moved: false,
        gesture: newGesture(), cx: e.clientX, cy: e.clientY, pos: position(m) });
    }
  };

  const onPointerMove = (e) => {
    const u = units(e);
    if (!u) return;
    const [x, y] = u;
    showCoords(x, y);
    if (drag && !drag.done) {
      if (!drag.moved && Math.abs(e.clientX - drag.cx) + Math.abs(e.clientY - drag.cy) < 4) return;
      let nx = drag.origin[0] + x - drag.start[0];
      let ny = drag.origin[1] + y - drag.start[1];
      [nx, ny] = snapping(e) ? [snap(nx), snap(ny)] : [round(nx), round(ny)];
      if (drag.moved && nx === drag.pos[0] && ny === drag.pos[1]) return;
      setDrag({ ...drag, moved: true, pos: [nx, ny] });
      lastMove.current = sop("set_position", { mob_id: drag.id, x: nx, y: ny }, `live:drag:${drag.id}:${drag.gesture}`);
      return;
    }
    if (!store.armed) {
      const h = hitsAt(x, y)[0] ?? null;
      if (h !== hover) setHover(h);
    }
  };

  const onPointerUp = () => {
    if (!drag || drag.done) return;
    if (!drag.moved) {
      setDrag(null);
      return;
    }
    setDrag({ ...drag, done: true, version: null });
    Promise.resolve(lastMove.current).finally(() => {
      setDrag((d) => (d && d.done ? { ...d, version: store.server.version } : d));
    });
  };

  const onContextMenu = (e) => {
    e.preventDefault();
    if (store.playback) return;
    const u = units(e);
    if (!u) return;
    const [x, y] = u;
    const hit = hitsAt(x, y)[0];
    if (hit) {
      select(hit);
      const m = sc.mobjects.find((o) => o.id === hit);
      openMenu([
        { section: m.name },
        { label: "Animate…", onClick: () => openAnimateWindow(hit) },
        { separator: true },
        { label: "Duplicate", key: "Ctrl+D", onClick: duplicateSelected },
        { label: "Delete", key: "Del", onClick: deleteSelected },
        { separator: true },
        { label: "Bring forward", onClick: () => moveLayer(1) },
        { label: "Send backward", onClick: () => moveLayer(-1) },
        { label: m.on_screen_at_start ? "Hide until animated in" : "Show from the start",
          onClick: () => sop("set_on_screen", { mob_id: hit, value: !m.on_screen_at_start }) },
      ], e.clientX, e.clientY);
    } else {
      openMenu([
        { section: `Add at (${x.toFixed(1)}, ${y.toFixed(1)})` },
        ...addObjectItems((key) => addObject(key, round(x), round(y))),
      ], e.clientX, e.clientY);
    }
  };

  // ---- overlay (not over the video)
  const overlay = [];
  const editing = !store.playback;
  if (store.grid && editing) overlay.push(html`<${Grid} view=${view} />`);
  if (editing && hover && hover !== store.selectedId && boxes[hover] && !drag) {
    const r = rectOf(view, boxes[hover]);
    overlay.push(html`<rect x=${r.x} y=${r.y} width=${r.w} height=${r.h} fill="none" stroke="rgba(255,255,255,.45)"
      stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />`);
  }
  const sel = editing ? sc.mobjects.find((m) => m.id === store.selectedId) : null;
  if (sel) {
    let box = boxes[sel.id];
    if (drag && drag.id === sel.id && drag.moved && drag.box && !settled) {
      // While dragging (and until the preview catches up) move the outline locally.
      const dx = drag.pos[0] - drag.origin[0];
      const dy = drag.pos[1] - drag.origin[1];
      box = [drag.box[0] + dx, drag.box[1] + dy, drag.box[2] + dx, drag.box[3] + dy];
    }
    if (box) {
      const r = rectOf(view, box);
      const ly = r.y > 34 ? r.y - 9 : r.y + r.h + 22;
      overlay.push(html`<rect x=${r.x} y=${r.y} width=${r.w} height=${r.h} fill="rgba(50,145,255,.07)" stroke="#3291FF"
        stroke-width="1.6" stroke-dasharray="6 4" vector-effect="non-scaling-stroke" />
        <text x=${Math.max(4, r.x)} y=${ly} fill="#3291FF" font-size="19" font-weight="600"
          style="paint-order:stroke; stroke:#000; stroke-width:4px">${sel.name}</text>`);
    }
    if (errors[sel.id]) {
      overlay.push(html`<text x="16" y=${PH - 18} fill="#FC6255" font-size="20" font-weight="600"
        style="paint-order:stroke; stroke:#000; stroke-width:4px">⚠ ${sel.name}: ${errors[sel.id]}</text>`);
    }
  }
  if (editing && preview?.scene_error) {
    overlay.push(html`<text x="16" y="30" fill="#FC6255" font-size="20" font-weight="600"
      style="paint-order:stroke; stroke:#000; stroke-width:4px">⚠ ${preview.scene_error}</text>`);
  }

  const empty = sc.mobjects.length === 0 && !drawsOwnContent(sc);
  const seconds = sceneSeconds(sc);
  const timecode = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
  return html`<div class="viewer">
    <div class="viewer-head">
      <div class="group">
        <button class=${`btn small ghost ${store.grid ? "on" : ""}`} title="Show the coordinate grid (Ctrl+G)"
          onClick=${() => { store.grid = !store.grid; emit(); }}><${Icon} name="grid" /><span class="lbl">Grid</span></button>
        <button class=${`btn small ghost ${store.snap ? "on" : ""}`} title="Snap to a 0.25 grid while placing and dragging (hold Shift to flip)"
          onClick=${() => { store.snap = !store.snap; emit(); }}><${Icon} name="magnet" /><span class="lbl">Snap</span></button>
      </div>
      <span class="name" title="The scene shown on the canvas">${sc.name}</span>
      <div class="group end"><span id="coords" class="coords" title="Where the pointer is, in scene units" /><span class="tc" title="Length of this scene">${timecode}</span></div>
    </div>
    <div class="stage-wrap" ref=${wrapRef}>
    <div ref=${stageRef} tabindex="0"
      class=${`stage ${store.armed ? "armed" : ""} ${drag?.moved && !drag.done ? "dragging" : ""}`}
      style=${`width:${size.w}px; height:${size.h}px`}
      onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}
      onPointerLeave=${() => { showCoords(null); setHover(null); }}
      onContextMenu=${onContextMenu}
      onDragOver=${(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDrop=${(e) => {
        const key = e.dataTransfer.getData(DRAG_TYPE);
        if (!key) return;
        e.preventDefault();
        const u = units(e);
        if (!u) return;
        const [x, y] = u;
        const [px, py] = snapping(e) ? [snap(x), snap(y)] : [round(x), round(y)];
        addObject(key, px, py);
      }}>
      <canvas class="frame" ref=${canvasRef} />
      <svg class="overlay" viewBox=${`0 0 ${PW} ${PH}`} preserveAspectRatio="none">${overlay}</svg>
      ${empty && !store.armed && editing && html`<div class="stage-hint">Empty Scene</div>`}
      ${preview && store.playback && html`<${Player} duration=${preview.duration ?? seconds} />`}
      ${store.armed && html`<div class="stage-banner">Click to place <b>${store.armed}</b> · Esc cancels · Shift snaps</div>`}
    </div>
    </div>
  </div>`;
}
