// The Presentations page: presentations made from a project, each its scenes in an order of your choosing, with
// videos you upload between them, played full screen by presenter.js. For accounts (the server says so).

import { html, useEffect, useRef, useState } from "./lib.js";
import { chooseLocalFile, get, post, sendWithProgress } from "./api.js";
import { openAuth } from "./account.js";
import { present } from "./presenter.js";
import { emit, status, store } from "./store.js";
import { confirmDialog, Dropdown, Icon, openMenu, promptDialog } from "./ui.js";

const PLAYBACK = { live: "Live", render: "Render first", stored: "Stored" };

function ago(seconds) {
  if (!seconds) return "";
  const d = Date.now() / 1000 - seconds;
  if (d < 60) return "just now";
  for (const [size, unit] of [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]]) {
    if (d >= size) {
      const n = Math.floor(d / size);
      return `${n} ${unit}${n > 1 ? "s" : ""} ago`;
    }
  }
  return "";
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const megabytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 * 1024
  ? `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const label = (file) => file.replace(/-[0-9a-f]{8}(\.\w+)$/, "$1"); // without the tag that keeps names unique

const openPresentation = (id) => { store.presentationId = id; store.menu = null; emit(); };

function Blank({ icon, title, children }) {
  return html`<div class="home-blank">
    <div class="ring"><${Icon} name=${icon} size=${20} /></div>
    <h3>${title}</h3>
    ${children}
  </div>`;
}

export function PresentationsPage() {
  const a = store.account;
  if (a?.accounts && !a.user) {
    return html`<main class="home-body">
      <div class="home-head"><h1>Presentations</h1></div>
      <${Blank} icon="present" title="Presentations are for accounts">
        <p>Sign in to turn a project into a presentation: its scenes in any order, with your own videos between them.</p>
        <div class="acct-actions">
          <button class="btn" onClick=${() => openAuth("signin")}><span class="lbl">Sign in</span></button>
          <button class="btn primary" onClick=${() => openAuth("signup")}><span class="lbl">Sign up</span></button>
        </div>
      <//>
    </main>`;
  }
  return store.presentationId ? html`<${Editor} id=${store.presentationId} />` : html`<${List} />`;
}

// ---------------------------------------------------------------- the list
function List() {
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState("");
  const [creating, setCreating] = useState(false);
  const refresh = () => get("/api/presentations").then((r) => { setList(r.presentations); setFailed(""); })
    .catch((err) => setFailed(err.message));
  useEffect(() => { refresh(); }, []);

  const rename = async (p) => {
    const name = await promptDialog({ title: "Rename presentation", message: "Name:", value: p.name, ok: "Rename" });
    if (!name || name === p.name) return;
    try { await post(`/api/presentations/${p.id}`, { name }); refresh(); } catch (err) { status(err.message, "error"); }
  };
  const remove = async (p) => {
    const ok = await confirmDialog({ title: `Delete ${p.name}?`, message: "The presentation is deleted. Its project, "
      + "scenes and uploaded videos stay.", ok: "Delete presentation", danger: true });
    if (!ok) return;
    try { setList((await post(`/api/presentations/${p.id}/delete`)).presentations); } catch (err) { status(err.message, "error"); }
  };
  const menu = (e, p) => {
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect?.() ?? { right: e.clientX + 180, bottom: e.clientY };
    openMenu([
      { label: "Present", onClick: () => present(p.id) },
      { label: "Edit", onClick: () => openPresentation(p.id) },
      { label: "Rename…", onClick: () => rename(p) },
      { separator: true },
      { label: "Delete…", onClick: () => remove(p) },
    ], e.type === "contextmenu" ? e.clientX : r.right - 180, e.type === "contextmenu" ? e.clientY : r.bottom + 4);
  };

  let body;
  if (failed) {
    body = html`<${Blank} icon="x" title="Couldn't load your presentations"><p>${failed}</p>
      <button class="btn" onClick=${refresh}><span class="lbl">Try again</span></button><//>`;
  } else if (!list) {
    body = null;
  } else if (!list.length) {
    body = html`<${Blank} icon="present" title="No presentations yet">
      <p>Pick a project: its scenes become the slides, in any order, with videos between them if you like.</p>
      <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" tight /><span class="lbl">New Presentation</span></button>
    <//>`;
  } else {
    body = html`<div class="home-list pres-list">
      <div class="prow head"><span>Name</span><span>Contents</span><span>Last edited</span><span /></div>
      ${list.map((p) => html`<div key=${p.id} class="prow" tabindex="0" onClick=${() => openPresentation(p.id)}
          onContextMenu=${(e) => menu(e, p)} onKeyDown=${(e) => e.key === "Enter" && openPresentation(p.id)}>
        <span class="pmain">
          <span class="pline"><span class="pname" title=${p.name}>${p.name}</span></span>
          <span class="psub">${p.project_name ? `From ${p.project_name}` : html`<span class="warn">Its project was deleted</span>`}</span>
        </span>
        <span class="meta">${[plural(p.items - p.videos, "scene"), p.videos && plural(p.videos, "video")].filter(Boolean).join(" · ")}</span>
        <span class="pwhen">${ago(p.modified)}</span>
        <span class="pres-row-actions">
          <button class="btn small icon ghost" title="Present" aria-label="Present"
            onClick=${(e) => { e.stopPropagation(); present(p.id); }}><${Icon} name="play" /></button>
          <button class="btn small icon ghost more" title="More" aria-label="More" onClick=${(e) => menu(e, p)}>
            <${Icon} name="more" /></button>
        </span>
      </div>`)}
    </div>`;
  }
  return html`<main class="home-body">
    <div class="home-head">
      <h1>Presentations</h1>
      <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" tight /><span class="lbl">New Presentation</span></button>
    </div>
    ${body}
    ${creating && html`<${NewDialog} close=${() => setCreating(false)} />`}
  </main>`;
}

function NewDialog({ close }) {
  const [projects, setProjects] = useState(null);
  const [pid, setPid] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get("/api/projects").then((r) => {
      setProjects(r.projects);
      if (r.projects.length) { setPid(r.projects[0].id); setName(r.projects[0].name); }
    }).catch((err) => status(err.message, "error"));
  }, []);
  const choose = (id) => {
    const before = projects.find((p) => p.id === pid);
    if (!name || name === before?.name) setName(projects.find((p) => p.id === id)?.name ?? "");
    setPid(id);
  };
  const create = async (e) => {
    e.preventDefault();
    if (!pid || busy) return;
    setBusy(true);
    try {
      const p = await post("/api/presentations/new", { project: pid, name });
      close();
      openPresentation(p.id);
    } catch (err) {
      status(err.message, "error");
      setBusy(false);
    }
  };
  return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && close()}
      onKeyDown=${(e) => e.key === "Escape" && close()}>
    <form class="modal pres-new" role="dialog" aria-label="New presentation" onSubmit=${create}>
      <h2>New presentation</h2>
      <p>It starts with the project's scenes in order. Reorder them and add videos next.</p>
      <label class="field-row">Project
        <${Dropdown} value=${pid} options=${(projects ?? []).map((p) => [p.id, p.name])}
          placeholder=${projects ? "No projects yet" : "Loading…"} onChange=${choose} /></label>
      <label class="field-row">Name
        <input class="input" value=${name} maxlength="80" onInput=${(e) => setName(e.target.value)} /></label>
      <div class="actions">
        <button type="button" class="btn" onClick=${close}><span class="lbl">Cancel</span></button>
        <button type="submit" class="btn primary" disabled=${!pid || busy}><span class="lbl">Create</span></button>
      </div>
    </form>
  </div>`;
}

// ---------------------------------------------------------------- one presentation
function Editor({ id }) {
  const [p, setP] = useState(null);
  const [failed, setFailed] = useState("");
  const [mode, setMode] = useState(null);
  const [upload, setUpload] = useState(null); // { name, progress } while a video is sent
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const addBtn = useRef();
  const latest = useRef(null); // the presentation as shown now (an upload ends after edits made while it ran)
  latest.current = p;
  useEffect(() => {
    get(`/api/presentations/${id}`).then(setP).catch((err) => setFailed(err.message));
    get("/api/prefs").then((r) => setMode(r.presentation_mode)).catch(() => {});
  }, [id]);
  const back = () => { store.presentationId = null; emit(); };
  if (failed) {
    return html`<main class="home-body"><${Blank} icon="x" title="Couldn't open the presentation"><p>${failed}</p>
      <button class="btn" onClick=${back}><span class="lbl">Back to presentations</span></button><//></main>`;
  }
  if (!p) return html`<main class="home-body" />`;

  const strip = (list) => list.map(({ id: iid, kind, scene, file }) => (kind === "scene" ? { id: iid, kind, scene } : { id: iid, kind, file }));
  /** Shows the change at once (items keep their names meanwhile), then the presentation as the server keeps it.
   *  Resolves with whether it was saved. */
  const save = async (patch) => {
    const before = latest.current;
    if (patch.items) setP({ ...before, items: patch.items });
    try {
      setP(await post(`/api/presentations/${id}`, patch.items ? { ...patch, items: strip(patch.items) } : patch));
      return true;
    } catch (err) {
      setP(before);
      status(err.message, "error");
      return false;
    }
  };
  const items = p.items;
  const move = (from, to) => {
    if (to < 0 || to >= items.length || from === to) return;
    const list = [...items];
    list.splice(to, 0, list.splice(from, 1)[0]);
    save({ items: list });
  };
  const removeAt = (i) => save({ items: items.filter((_, k) => k !== i) });
  const addScene = (scene) => save({ items: [...items, { kind: "scene", scene: scene.id, name: scene.name }] });
  const addMenu = () => {
    const r = addBtn.current.getBoundingClientRect();
    const scenes = p.scenes.map((s) => ({ label: s.name, onClick: () => addScene(s) }));
    openMenu(scenes.length ? [{ section: "Scenes of the project" }, ...scenes]
      : [{ label: "The project has no scenes", disabled: true }], r.left, r.bottom + 6,
    { kind: "dd", anchor: addBtn.current, above: r.top - 6 });
  };
  const addVideo = async () => {
    const file = await chooseLocalFile("video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v");
    if (!file) return;
    setUpload({ name: file.name, progress: 0 });
    try {
      const res = await sendWithProgress(`/api/upload?name=${encodeURIComponent(file.name)}`, file,
        (f) => setUpload({ name: file.name, progress: f }));
      // after the items as they are now: they may have been moved or removed while the video was uploading
      const added = { kind: "video", file: res.name, name: res.name, size: file.size };
      if (await save({ items: [...latest.current.items, added] })) status(`Added ${file.name}.`, "ok");
    } catch (err) {
      status(err.message, "error");
    } finally {
      setUpload(null);
    }
  };
  const rename = async (name) => { if (name.trim() && name.trim() !== p.name) save({ name: name.trim() }); };
  const openProject = async () => {
    try {
      const res = await post("/api/projects/open", { id: p.project });
      const { applyState } = await import("./store.js");
      const { resetView } = await import("./actions.js");
      resetView();
      applyState(res.state);
      store.home = false;
      emit();
    } catch (err) {
      status(err.message, "error");
    }
  };
  const drop = (to) => {
    if (dragging !== null) move(dragging, to > dragging ? to - 1 : to);
    setDragging(null);
    setOver(null);
  };

  return html`<main class="home-body pres-edit">
    <div class="pres-top">
      <button class="btn ghost small icon" title="Back to presentations" aria-label="Back" onClick=${back}>
        <${Icon} name="left" /></button>
      <input class="pres-name" value=${p.name} aria-label="Presentation name" maxlength="80"
        onBlur=${(e) => rename(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />
      <div class="spacer" />
      <button class="btn primary" disabled=${!items.length} onClick=${() => present(id)}>
        <${Icon} name="play" tight /><span class="lbl">Present</span></button>
    </div>
    <div class="pres-sub">
      ${p.project_name ? html`From <button class="link-btn" onClick=${openProject}>${p.project_name}</button>`
        : html`<span class="warn">Its project was deleted</span>`}
      ${mode && html` · Scenes play <b>${PLAYBACK[mode]}</b> (<button class="link-btn"
        onClick=${() => { store.homePage = "account"; store.presentationId = null; emit(); }}>change in Account</button>)`}
    </div>
    <ol class="pres-items" onDragOver=${(e) => e.preventDefault()}>
      ${items.map((it, i) => html`<li key=${it.id}
          class=${`pres-item ${it.missing ? "missing" : ""} ${dragging === i ? "dragging" : ""} ${over === i ? "over" : ""}`}
          draggable="true" onDragStart=${(e) => { setDragging(i); e.dataTransfer.effectAllowed = "move"; }}
          onDragEnd=${() => { setDragging(null); setOver(null); }}
          onDragOver=${(e) => { e.preventDefault(); setOver(i); }} onDrop=${(e) => { e.preventDefault(); drop(i); }}>
        <span class="pi-grip" aria-hidden="true"><${Icon} name="grip" size=${15} /></span>
        <span class="pi-num">${i + 1}</span>
        <span class="pi-kind"><${Icon} name=${it.kind === "video" ? "film" : "layers"} /></span>
        <span class="pi-what">
          <span class="pi-name">${it.kind === "video" ? label(it.name ?? "") : it.name ?? "Deleted scene"}</span>
          <span class="pi-sub">${it.missing ? (it.kind === "video" ? "This video was deleted" : "This scene was deleted")
            : it.kind === "video" ? `Video · ${megabytes(it.size)}` : "Scene"}</span>
        </span>
        <span class="pi-acts">
          <button class="btn small icon ghost" title="Move up" aria-label="Move up" disabled=${i === 0}
            onClick=${() => move(i, i - 1)}><${Icon} name="up" /></button>
          <button class="btn small icon ghost" title="Move down" aria-label="Move down" disabled=${i === items.length - 1}
            onClick=${() => move(i, i + 1)}><${Icon} name="down" /></button>
          <button class="btn small icon ghost" title="Remove" aria-label="Remove" onClick=${() => removeAt(i)}>
            <${Icon} name="x" /></button>
        </span>
      </li>`)}
      ${dragging !== null && html`<li class=${`pres-end ${over === items.length ? "over" : ""}`}
        onDragOver=${(e) => { e.preventDefault(); setOver(items.length); }} onDrop=${(e) => { e.preventDefault(); drop(items.length); }} />`}
    </ol>
    ${!items.length && html`<p class="pres-empty">Nothing to show yet: add a scene or a video.</p>`}
    <div class="pres-add">
      <button ref=${addBtn} class="btn" disabled=${!p.project_name} onClick=${addMenu}>
        <${Icon} name="plus" tight /><span class="lbl">Add scene</span></button>
      <button class="btn" disabled=${!!upload} onClick=${addVideo}>
        <${Icon} name="film" tight /><span class="lbl">Add video</span></button>
      ${upload && html`<span class="pres-upload">Uploading ${upload.name}… ${Math.round(100 * upload.progress)}%</span>`}
    </div>
  </main>`;
}
