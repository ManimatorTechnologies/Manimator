// Scene tabs (bottom bar) and the Objects (layers) list.

import { html, useRef, useState } from "./lib.js";
import { deleteSelected, duplicateSelected, moveLayer } from "./actions.js";
import { project, run, scene, select, setScene, sop, status, store } from "./store.js";
import { togglePalette } from "./palette.js";
import { confirmDialog, Icon, openMenu } from "./ui.js";
import { typeLabel } from "./util.js";

function RenameInput({ value, onDone }) {
  return html`<input class="rename" value=${value} ref=${(el) => el && !el.dataset.f && (el.dataset.f = 1, el.select())}
    onBlur=${(e) => onDone(e.target.value)}
    onKeyDown=${(e) => {
      if (e.key === "Enter") e.target.blur();
      if (e.key === "Escape") onDone(null);
      e.stopPropagation();
    }}
    onClick=${(e) => e.stopPropagation()} />`;
}

/** Scenes as sheet tabs along the bottom, like a spreadsheet: click to select the scene, drag to reorder.
 *  (Scenes are renamed in the Inspector.) */
export function SceneTabs() {
  const [overId, setOverId] = useState(null);
  const dragId = useRef(null);
  const p = project();
  const current = scene();
  const last = p.scenes.length - 1;

  const add = async () => {
    const id = await run("add_scene");
    if (id) setScene(id);
  };
  const duplicate = async (s) => {
    const id = await run("duplicate_scene", { scene_id: s.id });
    if (id) setScene(id);
  };
  const remove = async (s) => {
    if (p.scenes.length <= 1) return status("A project needs at least one scene.", "error");
    const ok = await confirmDialog({
      title: "Delete scene", message: `Delete “${s.name}” and everything in it?\nCtrl+Z can bring it back.`,
      ok: "Delete", danger: true,
    });
    if (ok) run("delete_scene", { scene_id: s.id });
  };
  const move = (s, delta) => run("move_scene", { scene_id: s.id, delta });
  // Selecting a scene shows it, with no object selected, so the Inspector shows the scene's settings.
  const open = (s) => {
    setScene(s.id);
    select(null);
  };
  const menu = (e, s, i) => {
    e.preventDefault();
    open(s);
    openMenu([
      { label: "Duplicate", onClick: () => duplicate(s) },
      { separator: true },
      { label: "Move left", disabled: i === 0, onClick: () => move(s, -1) },
      { label: "Move right", disabled: i === last, onClick: () => move(s, 1) },
      { separator: true },
      { label: "Delete", disabled: last === 0, onClick: () => remove(s) },
    ], e.clientX, e.clientY - 4);
  };
  const drop = (target) => {
    const from = p.scenes.findIndex((s) => s.id === dragId.current);
    const to = p.scenes.findIndex((s) => s.id === target.id);
    dragId.current = null;
    setOverId(null);
    if (from >= 0 && to >= 0 && from !== to) move(p.scenes[from], to - from);
  };

  return html`<div class="sheetbar">
    <div class="sheets" onWheel=${(e) => { e.currentTarget.scrollLeft += e.deltaY; }}>
      ${p.scenes.map((s, i) => html`<div
        class=${`sheet ${s.id === current.id ? "on" : ""} ${overId === s.id ? "over" : ""}`}
        title=${`${s.name}: ${s.mobjects.length} objects, ${s.steps.length} steps. Drag to reorder, right-click for more.`}
        draggable="true"
        ref=${(el) => { if (el && s.id === current.id) el.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
        onClick=${() => open(s)}
        onContextMenu=${(e) => menu(e, s, i)}
        onDragStart=${(e) => { dragId.current = s.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.name); }}
        onDragOver=${(e) => { if (dragId.current) { e.preventDefault(); setOverId(s.id); } }}
        onDragLeave=${() => setOverId((o) => (o === s.id ? null : o))}
        onDrop=${(e) => { e.preventDefault(); drop(s); }}
        onDragEnd=${() => { dragId.current = null; setOverId(null); }}>
        <span class="nm">${s.name}</span>
      </div>`)}
    </div>
    <button class="sheet-add" title="Add a scene (each scene becomes its own video)" onClick=${add}><${Icon} name="plus" /></button>
  </div>`;
}

export function ObjectList() {
  const [renaming, setRenaming] = useState(null);
  const sc = scene();
  const errors = store.preview?.scene_id === sc.id ? store.preview.errors : {};
  const items = [...sc.mobjects].reverse(); // top layer first
  return html`<div class="panel" style="flex: 1 1 40%">
    <div class="panel-head"><span class="grow">Objects</span>
      <button class="btn small icon ghost add" data-palette-toggle title="Add an object" onClick=${togglePalette}><${Icon} name="plus" /></button>
      <button class="btn small icon ghost" title="Bring forward (draw on top)" onClick=${() => moveLayer(1)}><${Icon} name="up" /></button>
      <button class="btn small icon ghost" title="Send backward" onClick=${() => moveLayer(-1)}><${Icon} name="down" /></button>
      <button class="btn small icon ghost" title="Duplicate (Ctrl+D)" onClick=${duplicateSelected}><${Icon} name="copy" /></button>
      <button class="btn small icon ghost danger" title="Delete (Del)" onClick=${deleteSelected}><${Icon} name="trash" /></button>
    </div>
    <div class="panel-body" style=${items.length === 0 ? "display:flex" : ""}>
      ${items.length === 0 && html`<div class="empty-center">No Objects</div>`}
      <ul class="list">
        ${items.map((m) => html`<li class=${`row ${m.id === store.selectedId ? "sel" : ""} ${m.on_screen_at_start ? "" : "dim"}`}
            onClick=${() => select(m.id)} onDblClick=${() => setRenaming(m.id)}
            title=${m.on_screen_at_start ? "Visible when the scene starts" : "Hidden at start: an animation brings it in"}>
          <button class=${`eye ${m.on_screen_at_start ? "" : "off"}`}
            title=${m.on_screen_at_start ? "On screen at start (click to hide until an animation brings it in)" : "Hidden at start (click to show from the beginning)"}
            onClick=${(e) => { e.stopPropagation(); sop("set_on_screen", { mob_id: m.id, value: !m.on_screen_at_start }); }}>
            <${Icon} name=${m.on_screen_at_start ? "eye" : "eyeoff"} />
          </button>
          ${renaming === m.id
            ? html`<${RenameInput} value=${m.name} onDone=${(v) => { setRenaming(null); if (v && v !== m.name) sop("rename_mobject", { mob_id: m.id, name: v }); }} />`
            : html`<span class="name">${m.name}</span>
                ${errors?.[m.id] ? html`<span class="warn" title=${errors[m.id]}>⚠</span>` : null}
                <span class="meta">${typeLabel(m.type)}</span>`}
        </li>`)}
      </ul>
    </div>
  </div>`;
}
