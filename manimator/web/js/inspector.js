// Right panel: properties, style, placement and methods of the selected object,
// or the scene's settings when nothing is selected.

import { html } from "./lib.js";
import { ColorButton, ParamForm, TextInput, Toggle } from "./fields.js";
import { openMethodPicker } from "./methodpicker.js";
import { iconImg } from "./palette.js";
import { emit, mk, mobSpec, project, run, scene, selected, sop, status, store } from "./store.js";
import { Dropdown, Icon } from "./ui.js";
import { groupMembers, kindOf, refChoices, transformRole, typeLabel } from "./util.js";

const LINEAR = "LinearTransformationScene";

const PLACEMENT = {
  position: { name: "position", kind: "point", default: [0, 0], label: "Position", tooltip: "Center of the object" },
  rotation: { name: "rotation", kind: "angle", default: 0, label: "Rotation", tooltip: "Degrees, counter-clockwise" },
  scale: { name: "scale", kind: "float", default: 1, label: "Scale", min: 0.01, max: 100, step: 0.1, decimals: 2 },
  z_index: { name: "z_index", kind: "int", default: 0, label: "Layer", min: -100, max: 100, step: 1,
    tooltip: "Higher numbers draw on top, whatever the list order" },
  z: { name: "z", kind: "float", default: 0, label: "Height (z)", min: -50, max: 50, step: 0.25, decimals: 2,
    tooltip: "How far above (or below) the screen plane the object sits" },
};

/** Whether a scene setting is in effect: some only matter while another one is on (see SceneKind.requires). */
function optionActive(kind, name, values) {
  const need = kind.requires[name];
  if (!need) return true;
  const p = kind.options.find((o) => o.name === need);
  return !!(values[need] ?? p.default) && optionActive(kind, need, values);
}

function changeKind(sc, kind) {
  run("set_scene_kind", { scene_id: sc.id, kind }).then((removed) => {
    if (removed?.length) status(`Removed ${removed.join(", ")}: a ${kind} can't do ${removed.length > 1 ? "them" : "that"}.`, "error");
  });
}

function Section({ title, sub, children, actions }) {
  return html`<div class="section">
    ${title && html`<div class="sh"><span>${title}</span>${sub && html`<span class="sub">${sub}</span>`}<span class="grow" />${actions}</div>`}
    <div class="sb">${children}</div>
  </div>`;
}

function positionOf(m) {
  const spec = mobSpec(m.type);
  if (spec.pointParams.length) {
    const pts = spec.pointParams.map((p) => m.params[p]);
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  return m.position;
}

function SceneInspector() {
  const sc = scene();
  const p = project();
  return html`<div>
    <div class="insp-head">
      <span class="insp-ic"><${Icon} name="film" size=${22} /></span>
      <div><div class="t" title=${sc.name}>${sc.name}</div><div class="s">Scene · nothing selected</div></div>
    </div>
    <${Section} title="Scene">
      <div class="form">
        <label>Name</label>
        <div class="ctl"><${TextInput} value=${sc.name} onChange=${(v) => run("rename_scene", { scene_id: sc.id, name: v })} /></div>
        <label>Background</label>
        <div class="ctl"><${ColorButton} value=${p.settings.background}
          onChange=${(v) => run("set_setting", { name: "background", value: v })} /></div>
      </div>
    <//>
    <${SceneKindSection} sc=${sc} />
  </div>`;
}

function SceneKindSection({ sc }) {
  const kind = kindOf(sc);
  const params = kind.options.filter((p) => optionActive(kind, p.name, sc.options));
  return html`<${Section} title="Scene type">
    <div class="form">
      <label>Class</label>
      <div class="ctl"><${Dropdown} value=${sc.kind} title=${kind.description}
        options=${store.catalog.sceneKinds.map((k) => [k.key, k.key])} onChange=${(v) => changeKind(sc, v)} /></div>
    </div>
    ${params.length > 0 && html`<div style="height:10px" /><${ParamForm} params=${params} values=${sc.options}
      onChange=${(name, value, g) => run("set_scene_option", { scene_id: sc.id, name, value }, mk(`scene:${sc.id}:${name}`, g))} />`}
  <//>`;
}

/** How the object takes part in a 3D scene or a LinearTransformationScene. */
function SceneRoleSection({ m }) {
  const sc = scene();
  const kind = kindOf(sc);
  if (!kind.threeD && sc.kind !== LINEAR) return null;
  const set = (name, value) => sop("set_scene_role", { mob_id: m.id, name, value });
  let field;
  if (groupMembers(sc).has(m.id)) {
    field = html`<div class="note">It follows the group it is in.</div>`;
  } else if (kind.threeD) {
    field = html`<div class="form"><label>Camera</label>
      <div class="ctl"><${Dropdown} value=${m.fixed} options=${store.catalog.fixedChoices} onChange=${(v) => set("fixed", v)} /></div></div>`;
  } else {
    const roles = store.catalog.transformRoles;
    const auto = roles.find(([r]) => r === mobSpec(m.type).transformRole)?.[1];
    const options = [["", `Automatic: ${auto.toLowerCase()}`],
      ...roles.filter(([r]) => r !== "vector" || store.catalog.vectorTypes.includes(m.type))];
    field = html`<div class="form"><label>Grid</label>
      <div class="ctl"><${Dropdown} value=${m.transform_role} options=${options}
        onChange=${(v) => set("transform_role", v)} /></div></div>`;
  }
  return html`<${Section} title="In this scene">${field}<//>`;
}

function MethodsTab({ m }) {
  const sc = scene();
  const refs = () => refChoices(sc, m.id, true);
  return html`<div>
    <div class="methods-head">
      <button class="btn primary" title="Methods run once, top to bottom, after the object is created"
        onClick=${() => openMethodPicker(m.id)}><span class="lbl">Add Method</span></button>
    </div>
    ${m.methods.map((call, i) => {
      const spec = store.specs.methods[call.method];
      return html`<div class="card">
        <div class="ch">
          <span class="title">${i + 1}. ${spec.label}</span>
          <button class="btn small icon ghost" title="Run earlier" disabled=${i === 0}
            onClick=${() => sop("move_method", { mob_id: m.id, index: i, delta: -1 })}><${Icon} name="up" /></button>
          <button class="btn small icon ghost" title="Run later" disabled=${i === m.methods.length - 1}
            onClick=${() => sop("move_method", { mob_id: m.id, index: i, delta: 1 })}><${Icon} name="down" /></button>
          <button class="btn small icon ghost danger" title="Remove"
            onClick=${() => sop("remove_method", { mob_id: m.id, index: i })}><${Icon} name="x" /></button>
        </div>
        <div class="cb">
          <div class="desc">${spec.description}</div>
          ${spec.params.length > 0 && html`<${ParamForm} params=${spec.params} values=${call.args} refs=${refs}
            onChange=${(name, value, g) => sop("set_method_arg", { mob_id: m.id, index: i, name, value }, mk(`${m.id}:m${i}:${name}`, g))} />`}
        </div>
      </div>`;
    })}
  </div>`;
}

function PropertiesTab({ m }) {
  const spec = mobSpec(m.type);
  const sc = scene();
  const styleFields = store.catalog.styleFields[spec.styleKind];
  const placement = [PLACEMENT.rotation, PLACEMENT.scale, PLACEMENT.z_index];
  // A vector that a LinearTransformationScene carries along is drawn from the origin.
  const fromOrigin = sc.kind === LINEAR && m.type === "Vector" && transformRole(m) === "vector" && !groupMembers(sc).has(m.id);
  if ((spec.positioned || spec.pointParams.length) && !fromOrigin) placement.unshift(PLACEMENT.position);
  if (spec.threeD && spec.positioned) placement.push(PLACEMENT.z);
  const pos = positionOf(m);
  return html`<div>
    ${spec.params.length > 0 && html`<${Section} title=${typeLabel(m.type)}>
      <${ParamForm} params=${spec.params} values=${m.params} refs=${() => refChoices(sc, m.id, true)}
        onChange=${(name, value, g) => sop("set_param", { mob_id: m.id, name, value }, mk(`${m.id}:p:${name}`, g))} />
    <//>`}
    ${styleFields.length > 0 && html`<${Section} title="Style">
      <${ParamForm} params=${styleFields} values=${m.style}
        onChange=${(name, value, g) => sop("set_style", { mob_id: m.id, name, value }, mk(`${m.id}:s:${name}`, g))} />
    <//>`}
    <${Section} title="Placement">
      <${ParamForm} params=${placement}
        values=${{ position: [Math.round(pos[0] * 1000) / 1000, Math.round(pos[1] * 1000) / 1000], rotation: m.rotation, scale: m.scale, z_index: m.z_index, z: m.z }}
        onChange=${(name, value, g) => (name === "position"
          ? sop("set_position", { mob_id: m.id, x: value[0], y: value[1] }, mk(`${m.id}:pos`, g))
          : sop("set_placement", { mob_id: m.id, name, value }, mk(`${m.id}:place:${name}`, g)))} />
      ${!spec.positioned && !spec.pointParams.length && html`<div class="note">${spec.needsTarget
        ? "This is placed around its target."
        : "This has no position of its own; it is drawn at scene coordinates."}${" "}
        To shift it, add a <code>shift</code> method.</div>`}
      ${fromOrigin && html`<div class="note">It starts at the origin, like every vector the grid carries.</div>`}
    <//>
    <${SceneRoleSection} m=${m} />
    <div style="height:12px" />
  </div>`;
}

/** A newer version of this customization the visitor can add (the one the editor's Custom group offers), if the
 *  object is an older one: updating moves the whole project's uses of it to that version (a project holds one
 *  version of each, and a version's animations play only on its own object). */
function NewerKit({ m }) {
  const kit = store.specs.mobjects[m.type]?.kit;
  const newer = kit && store.kits.mobjects.find((s) => s.kit?.id === kit.id && s.kit.version > kit.version)?.kit;
  if (!newer) return null;
  const update = async () => {
    const done = await run("update_kit", { kit_id: newer.id, version: newer.version });
    if (done) status(`This project now uses ${newer.name} ${newer.label || `#${newer.version}`}.`);
  };
  return html`<div class="kit-newer">
    <span>Version ${newer.label || `#${newer.version}`} is available.</span>
    <button class="btn small" title="Use it for every ${newer.name} in this project, with its new animations"
      onClick=${update}><span class="lbl">Update</span></button>
  </div>`;
}

export function Inspector() {
  const m = selected();
  if (!m) return html`<div class="panel-body"><${SceneInspector} /></div>`;
  const spec = mobSpec(m.type);
  const error = store.preview?.errors?.[m.id];
  const tab = store.inspectorTab;
  const setTab = (t) => { store.inspectorTab = t; emit(); };
  return html`<div class="panel-body">
    <div class="insp-head">
      <span class="insp-ic">${iconImg(m.type)}<span class="glyph">${spec.icon}</span></span>
      <div>
        <div class="t">${typeLabel(m.type)}</div>
        <div class="s" title=${spec.description || ""}>${spec.description || "Manim object"}</div>
      </div>
    </div>
    <${NewerKit} m=${m} />
    <${Section}>
      <div class="form">
        <label>Name</label>
        <div class="ctl"><${TextInput} value=${m.name} title="Variable name in the generated Python code"
          onChange=${(v) => sop("rename_mobject", { mob_id: m.id, name: v })} /></div>
        <label>At start</label>
        <${Toggle} value=${m.on_screen_at_start} label=${m.on_screen_at_start ? "Visible" : "Hidden"}
          title="Whether the object is already on screen when the scene starts, or stays hidden until an animation brings it in"
          onChange=${(value) => sop("set_on_screen", { mob_id: m.id, value })} />
      </div>
    <//>
    ${error && html`<div class="err">⚠ ${error}</div>`}
    <div class="tabs">
      <button class=${`tab ${tab === "props" ? "on" : ""}`} onClick=${() => setTab("props")}><span class="lbl">Properties</span></button>
      <button class=${`tab ${tab === "methods" ? "on" : ""}`} onClick=${() => setTab("methods")}><span class="lbl">Methods</span></button>
    </div>
    ${tab === "props" ? html`<${PropertiesTab} m=${m} />` : html`<${MethodsTab} m=${m} />`}
  </div>`;
}
