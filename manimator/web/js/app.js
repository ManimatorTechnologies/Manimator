// The app shell: top bar and menus, resizable panels, keyboard shortcuts, messages.

import { html, useEffect, useState } from "./lib.js";
import {
  addWait, deleteSelected, duplicateSelected, exportPython, newProject, nudge, save, startRender, cancelRender,
} from "./actions.js";
import { AuthDialog, PricingDialog } from "./account.js";
import { PresenterLayer } from "./presenter.js";
import { Home, homeTitle, showHome } from "./home.js";
import { Inspector } from "./inspector.js";
import { ObjectList, SceneTabs } from "./lists.js";
import { closeRender, RenderDialog, showRender } from "./output.js";
import { closePalette, PalettePopover } from "./palette.js";
import { closeColorPicker, ColorWindow } from "./fields.js";
import { AnimWindow, closeAnimPicker } from "./animpicker.js";
import { closeMethodPicker, MethodWindow } from "./methodpicker.js";
import { Stage } from "./stage.js";
import { closeStepEditor, StepsPanel, StepTools } from "./steps.js";
import {
  CodeView, codeViewOn, openCodeView, openVisualView, playCode, runCode,
} from "./codeview.js";
import { emit, project, redo, run, select, stopPlayback, store, subscribe, togglePlay, undo } from "./store.js";
import {
  alertDialog, closeMenu, closePopover, Icon, MenuLayer, ModalLayer, openMenuAt, PopoverLayer, Toast,
} from "./ui.js";

const BOTTOM_BARS_H = 38; // the scene tabs; keep in sync with --sheets in style.css

const SHORTCUTS = `Ctrl+N  New Project        Ctrl+S  Download Project
Ctrl+E  Download Python    Ctrl+Z  Undo        Ctrl+Y  Redo
Ctrl+D  Duplicate          Del     Delete      Esc     Cancel / deselect
Arrows  Nudge 0.1 (Shift: 0.5)                 Ctrl+G  Grid
F5 / Space  Play           F6  Render scene    F7  Render all scenes
In the Code view: Ctrl+Enter  Run again    F5  Play    Tab / Shift+Tab  Indent    Ctrl+/  Comment
Drag a number's label sideways to change it. Hold Shift while placing or dragging to flip snapping.`;

const toggleGrid = () => { store.grid = !store.grid; emit(); };
const renderActive = () => store.render.state === "running";

// ---------------------------------------------------------------- keyboard
function onKey(e) {
  if (store.modal || (store.renderOpen && e.key !== "Escape")) return;
  const k = e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;
  const ctrl = e.ctrlKey || e.metaKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const handle = (fn) => { e.preventDefault(); fn(); };
  if (store.home) { // the start screen only knows New
    if (k === "Escape" && store.menu) return closeMenu();
    if (ctrl && lower === "n") return handle(() => newProject());
    if (ctrl && lower === "r") return handle(() => {});
    return;
  }
  const code = codeViewOn();
  if (code && ctrl && k === "Enter") return handle(runCode);
  if (k === "F5") return handle(code ? playCode : togglePlay);
  if (k === "F6") return handle(() => startRender("scene"));
  if (k === "F7") return handle(() => startRender("all"));
  if (ctrl && lower === "s") return handle(save);
  if (ctrl && lower === "n") return handle(() => newProject());
  if (ctrl && lower === "e") return handle(() => exportPython());
  if (ctrl && lower === "r") return handle(() => {}); // no accidental page reloads
  if (k === "Escape") {
    if (store.menu) return closeMenu(); // a dropdown inside a window closes before the window
    if (store.playback && !store.renderOpen && !store.modal) return stopPlayback();
    if (store.renderOpen) return closeRender();
    if (store.paletteOpen) return closePalette();
    if (store.colorPick) return closeColorPicker();
    if (store.animPick) return closeAnimPicker();
    if (store.methodPick) return closeMethodPicker();
    if (store.popover) return closePopover();
    if (store.stepOpen) return closeStepEditor();
    if (typing) return e.target.blur();
    if (store.armed) { store.armed = null; return emit(); }
    return select(null);
  }
  if (typing) return;
  if (code) { // the script has its own keys; the visual editor's don't apply
    if (ctrl && lower === "z") return handle(() => (e.shiftKey ? redo() : undo()));
    if (ctrl && lower === "y") return handle(redo);
    return;
  }
  if (k === " " && !/^(BUTTON|A)$/.test(e.target.tagName)) return handle(togglePlay);
  if (ctrl && lower === "z") return handle(() => (e.shiftKey ? redo() : undo()));
  if (ctrl && lower === "y") return handle(redo);
  if (ctrl && lower === "d") return handle(duplicateSelected);
  if (ctrl && lower === "g") return handle(toggleGrid);
  if (k === "Delete" || k === "Backspace") return handle(deleteSelected);
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (arrows[k] && store.selectedId) {
    const step = e.shiftKey ? 0.5 : 0.1;
    return handle(() => nudge(arrows[k][0] * step, arrows[k][1] * step));
  }
}

// ---------------------------------------------------------------- resizable panels
const SIZES = { left: [220, 520], right: [280, 620], bottom: [150, 700] };

/** Back to the sizes in style.css (dragging a splitter only lasts until the page is reloaded). */
function resetSizes() {
  for (const name of Object.keys(SIZES)) document.documentElement.style.removeProperty(`--${name}`);
}

function Splitter({ name }) {
  const [active, setActive] = useState(false);
  const horizontal = name === "bottom";
  const onMove = (e) => {
    const [lo, hi] = SIZES[name];
    let v;
    if (name === "left") v = e.clientX;
    else if (name === "right") v = window.innerWidth - e.clientX;
    else v = window.innerHeight - BOTTOM_BARS_H - e.clientY; // above the scene tabs
    v = Math.round(Math.min(hi, Math.max(lo, v)));
    document.documentElement.style.setProperty(`--${name}`, `${v}px`);
  };
  return html`<div class=${`splitter ${horizontal ? "h" : ""} ${active ? "active" : ""}`}
    onPointerDown=${(e) => { e.currentTarget.setPointerCapture(e.pointerId); setActive(true); }}
    onPointerMove=${(e) => active && onMove(e)}
    onPointerUp=${() => setActive(false)} onPointerCancel=${() => setActive(false)} />`;
}

// ---------------------------------------------------------------- top bar
function fileMenu(e) {
  openMenuAt(e, [
    { label: "All Projects", onClick: showHome },
    { separator: true },
    { label: "New Project", key: "Ctrl+N", onClick: newProject },
    { separator: true },
    { label: "Download Project", key: "Ctrl+S", onClick: save },
    { label: "Download Python", key: "Ctrl+E", onClick: exportPython },
  ]);
}

// The qualities this browser can encode (checked once, in the background).
let encodable = null;
function checkEncodable() {
  if (encodable) return;
  encodable = {};
  import("./engine/export.js").then((m) => m.supportedQualities()).then((ok) => { encodable = ok; emit(); })
    .catch(() => { encodable = {}; });
}

function buildMenus() {
  const s = store.server;
  return {
    File: fileMenu,
    Edit: (e) => openMenuAt(e, [
      { label: s.undo_label ? `Undo ${s.undo_label.toLowerCase()}` : "Undo", key: "Ctrl+Z", disabled: !s.can_undo, onClick: undo },
      { label: s.redo_label ? `Redo ${s.redo_label.toLowerCase()}` : "Redo", key: "Ctrl+Y", disabled: !s.can_redo, onClick: redo },
      { separator: true },
      { label: "Duplicate object", key: "Ctrl+D", disabled: !store.selectedId, onClick: duplicateSelected },
      { label: "Delete object", key: "Del", disabled: !store.selectedId, onClick: deleteSelected },
      { label: "Add a wait step", onClick: addWait },
    ]),
    View: (e) => openMenuAt(e, [
      { label: `${store.grid ? "✓ " : ""}Grid`, key: "Ctrl+G", onClick: toggleGrid },
      { label: `${store.snap ? "✓ " : ""}Snap to grid`, onClick: () => { store.snap = !store.snap; emit(); } },
      { separator: true },
      { label: "Reset panel sizes", onClick: resetSizes },
    ]),
    Render: (e) => (checkEncodable(), openMenuAt(e, [
      { label: "Quick preview (480p)", onClick: () => startRender("preview") },
      { label: "Render this scene", key: "F6", onClick: () => startRender("scene") },
      { label: "Render all scenes", key: "F7", onClick: () => startRender("all") },
      { label: "Quality", title: "Quality for Render this scene / Render all scenes", children: store.catalog.qualities.map(([q, label]) => ({
        label,
        icon: q === project().settings.quality ? html`<${Icon} name="check" size=${15} />` : "",
        disabled: encodable?.[q] === false, // this browser can't encode it
        title: encodable?.[q] === false ? "This browser can't make videos this large" : "",
        onClick: () => q !== project().settings.quality && run("set_setting", { name: "quality", value: q }),
      })) },
      { separator: true },
      { label: "Cancel render", disabled: !renderActive(), onClick: cancelRender },
      { label: "Show render output", onClick: showRender },
    ])),
    Help: (e) => openMenuAt(e, [
      { label: "Keyboard shortcuts", onClick: () => alertDialog({ title: "Keyboard shortcuts", message: SHORTCUTS }) },
      { label: "About Manimator", onClick: () => alertDialog({ title: "Manimator",
        message: "Build Manim animations with buttons.\n\nProjects are saved as JSON (.manimator). "
          + "Export the Python code at any time and keep editing it by hand.\n\n"
          + "Manim reference: docs.manim.community" }) },
    ]),
  };
}

function Topbar() {
  const s = store.server;
  const running = renderActive();
  const code = codeViewOn();
  return html`<header class="topbar">
    <div class="group">
      <button class="brand link" title="All Projects" onClick=${showHome}><span class="lbl">Manimator</span></button>
      ${Object.entries(buildMenus()).map(([name, open]) => html`<button class="menubtn" onClick=${open}><span class="lbl">${name}</span></button>`)}
      <span class="sep" />
      <button class="btn icon ghost" title=${`Undo ${s.undo_label} (Ctrl+Z)`} disabled=${!s.can_undo} onClick=${undo}><${Icon} name="undo" /></button>
      <button class="btn icon ghost" title=${`Redo ${s.redo_label} (Ctrl+Y)`} disabled=${!s.can_redo} onClick=${redo}><${Icon} name="redo" /></button>
      <button class="btn ghost collapse" title="Download your project as a file (Ctrl+S)"
        onClick=${save}><${Icon} name="export" /><span class="lbl">Download</span></button>
    </div>
    <div class="group end">
      <button class="btn ghost collapse" title="Render this scene at the chosen quality (F6)" disabled=${running}
        onClick=${() => startRender("scene")}><${Icon} name="film" /><span class="lbl">Render scene</span></button>
      <button class="btn ghost collapse" title="Render every scene (F7)" disabled=${running}
        onClick=${() => startRender("all")}><${Icon} name="layers" /><span class="lbl">Render all</span></button>
      ${code ? html`<button class="btn ghost collapse" title="Back to building scenes with buttons" onClick=${openVisualView}>
          <${Icon} name="layers" /><span class="lbl">Visual</span></button>`
        : html`<button class="btn ghost collapse" title="Write the animation as Manim Python code, with your own data files"
          onClick=${openCodeView}><${Icon} name="code" /><span class="lbl">Code</span></button>`}
    </div>
  </header>`;
}

function BottomPanel() {
  return html`<div class="bottom">
    <div class="panel-head anim-head"><span class="grow">Animation</span><${StepTools} /></div>
    <div class="bbody"><${StepsPanel} /></div>
  </div>`;
}

export function App() {
  const [, force] = useState(0);
  useEffect(() => {
    const off = subscribe(() => force((n) => n + 1));
    force((n) => n + 1); // changes made before this subscribed (main.js: a message, the password dialog) show too
    return off;
  }, []);
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    // Projects are kept on the server as you edit, so closing the tab loses nothing.
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const hash = store.home ? "" : "#editor"; // so reloading the page comes back to the same screen
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
  const title = store.home ? homeTitle() : `${store.server.name}${store.server.dirty ? " *" : ""} — Manimator`;
  if (document.title !== title) document.title = title;
  if (store.home) {
    return html`<div class="shell home-shell">
      <${Home} />
      <${PresenterLayer} />
      <${Toast} />
      <${AuthDialog} />
      <${PricingDialog} />
      <${MenuLayer} />
      <${ModalLayer} />
    </div>`;
  }
  if (codeViewOn()) {
    return html`<div class="shell code-shell">
      <${Topbar} />
      <${CodeView} />
      <${Toast} />
      <${RenderDialog} />
      <${MenuLayer} />
      <${PopoverLayer} />
      <${AuthDialog} />
      <${PricingDialog} />
      <${ModalLayer} />
    </div>`;
  }
  return html`<div class="shell">
    <${Topbar} />
    <div class="main">
      <div class="column">
        <${ObjectList} />
      </div>
      <${Splitter} name="left" />
      <div class="center">
        <${Stage} />
        <${Splitter} name="bottom" />
        <${BottomPanel} />
      </div>
      <${Splitter} name="right" />
      <div class="column">
        <div class="panel" style="flex: 1">
          <div class="panel-head">Inspector</div>
          <${Inspector} />
        </div>
      </div>
    </div>
    <${SceneTabs} />
    <${Toast} />
    <${RenderDialog} />
    <${PalettePopover} />
    <${ColorWindow} />
    <${AnimWindow} />
    <${MethodWindow} />
    <${MenuLayer} />
    <${PopoverLayer} />
    <${AuthDialog} />
    <${PricingDialog} />
    <${ModalLayer} />
  </div>`;
}
