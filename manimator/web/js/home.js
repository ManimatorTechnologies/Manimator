// The start screen: a sidebar (Projects, Presentations, Account) and the chosen page. Projects lists your projects
// (kept on the server) and starts new ones.

import { html, useEffect, useRef, useState } from "./lib.js";
import { get, post } from "./api.js";
import { newProject, resetView } from "./actions.js";
import { AccountButton, AccountPage, signInThen } from "./account.js";
import { CustomizationsPage } from "./customizations.js";
import { PresentationsPage } from "./presentations.js";
import { applyState, emit, remakeThumbnail, sendThumbnail, status, store } from "./store.js";
import { confirmDialog, Icon, openMenu, promptDialog } from "./ui.js";

const PREFS_KEY = "manimator-home";
const SORTS = { recent: "Last Opened", modified: "Last Edited", name: "Name" };

function loadPrefs() {
  const prefs = { sort: "recent", view: "grid" };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"));
  } catch { /* storage unavailable */ }
  if (!SORTS[prefs.sort]) prefs.sort = "recent";
  return prefs;
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

function ago(seconds) {
  if (!seconds) return "";
  const d = Date.now() / 1000 - seconds;
  if (d < 60) return "just now";
  const units = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [size, name] of units) {
    if (d >= size) {
      const n = Math.floor(d / size);
      return `${n} ${name}${n > 1 ? "s" : ""} ago`;
    }
  }
  return "";
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const day = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const typing = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;

/** Go back to the start screen; the open project stays open until another one is chosen. With the browser engine,
 *  its card picture is made first if it was edited. */
export async function showHome() {
  await sendThumbnail();
  store.home = true;
  store.homePage = "projects";
  store.menu = null;
  emit();
}

const leaveHome = () => { store.home = false; emit(); };

/** A link to one of the account's projects (/app?project=<id>, from an AI chat that saved it): open it in the editor.
 *  Someone not signed in on this browser signs in first, then comes back to the link. */
export async function openLinkedProject() {
  const search = new URLSearchParams(location.search);
  const id = search.get("project");
  if (!id) return;
  search.delete("project");
  const rest = search.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  if (!store.account?.user && store.account?.accounts) {
    signInThen(`/app?project=${encodeURIComponent(id)}`);
    status("Sign in to open that project.", "info");
    return;
  }
  try {
    const res = await post("/api/projects/open", { id });
    resetView();
    applyState(res.state);
    store.home = false;
    emit();
  } catch (err) {
    status(err.message, "error");
  }
}

/** What the project holds, as one quiet line ("1 scene · 1 object · 3D"). */
function Meta({ p }) {
  if (p.broken) return html`<span class="warn">Can't read</span>`;
  return [plural(p.scenes, "scene"), plural(p.objects, "object"), p.three_d && "3D"].filter(Boolean).join(" · ");
}

/** The project's first scene; the dotted canvas shows until it arrives. The browser sends each project's picture
 *  when it leaves the project, so a picture can be missing (an edit made elsewhere): the open project's is made
 *  here. */
function Thumb({ p }) {
  const [shown, setShown] = useState(false);
  const [tries, setTries] = useState(0);
  const retry = () => {
    if (p.current && tries === 0) remakeThumbnail().then(() => setTries(1));
  };
  return html`<div class=${`pthumb ${shown ? "ready" : ""}`}>
    ${!p.broken && html`<img src=${`/api/thumb/${p.id}?v=${p.modified}${tries ? `&r=${tries}` : ""}`} alt=""
      loading="lazy" decoding="async" draggable=${false} onLoad=${() => setShown(true)} onError=${retry} />`}
  </div>`;
}

function Blank({ icon, title, children }) {
  return html`<div class="home-blank">
    <div class="ring"><${Icon} name=${icon} size=${20} /></div>
    <h3>${title}</h3>
    ${children}
  </div>`;
}

function Skeleton({ view }) {
  if (view === "list") {
    return html`<div class="home-list skel">${[0, 1, 2].map(() => html`<div class="prow">
      <span class="pmain"><i class="bar" style="width: 40%" /><i class="bar" style="width: 24%" /></span>
    </div>`)}</div>`;
  }
  return html`<div class="home-grid skel">${[0, 1, 2].map(() => html`<div class="pcard">
    <div class="pthumb" />
    <div class="pbody"><i class="bar" style="width: 52%" /><i class="bar" style="width: 34%" /></div>
  </div>`)}</div>`;
}

function ProjectsPage() {
  const [projects, setProjects] = useState(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState(null); // the project being opened
  const [query, setQuery] = useState("");
  const [prefs, setPrefsState] = useState(loadPrefs);
  const search = useRef();
  const sortBtn = useRef();
  const setPrefs = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    savePrefs(next);
  };

  const refresh = () => get("/api/projects")
    .then((res) => { setProjects(res.projects); setFailed(""); })
    .catch((err) => { setProjects(null); setFailed(err.message); });
  useEffect(() => {
    refresh();
    const back = () => { if (document.visibilityState === "visible") refresh(); }; // a chat may have added projects
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && !store.modal && !store.menu && !typing(e.target)) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const call = async (url, body) => {
    try {
      return await post(url, body);
    } catch (err) {
      status(err.message, "error");
      return null;
    }
  };

  const open = async (p) => {
    if (busy) return;
    if (p.current) return leaveHome();
    setBusy(p.id);
    const res = await call("/api/projects/open", { id: p.id });
    setBusy(null);
    if (!res) return;
    resetView();
    applyState(res.state);
    if (res.notes?.length) status(`Opened, with fixes: ${res.notes.slice(0, 3).join("; ")}`, "error");
  };

  const rename = async (p) => {
    const name = await promptDialog({ title: "Rename project", message: "Name:", value: p.name, ok: "Rename" });
    if (name == null || !name.trim() || name.trim() === p.name) return;
    const res = await call("/api/projects/rename", { id: p.id, name });
    if (res) { applyState(res.state); refresh(); }
  };

  const remove = async (p) => {
    const ok = await confirmDialog({
      title: `Delete ${p.name}?`,
      message: "The project is deleted from the server for good. Download it first if you want to keep a copy.",
      ok: "Delete project",
      danger: true,
    });
    if (!ok) return;
    const res = await call("/api/projects/delete", { id: p.id });
    if (res) { resetView(); store.home = true; applyState(res.state); refresh(); }
  };

  const menuItems = (p) => [
    { label: "Open", onClick: () => open(p) },
    { label: "Rename…", onClick: () => rename(p) },
    { separator: true },
    { label: "Delete…", onClick: () => remove(p) },
  ];
  const moreMenu = (e, p) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(menuItems(p), r.right - 180, r.bottom + 4);
  };
  const contextMenu = (e, p) => {
    e.preventDefault();
    openMenu(menuItems(p), e.clientX, e.clientY);
  };
  const sortMenu = () => {
    const r = sortBtn.current.getBoundingClientRect();
    openMenu(Object.entries(SORTS).map(([key, label]) => ({
      label,
      icon: key === prefs.sort ? html`<${Icon} name="check" size=${15} />` : "",
      onClick: () => setPrefs({ sort: key }),
    })), r.left, r.bottom + 6, { kind: "dd", minWidth: r.width, anchor: sortBtn.current, above: r.top - 6 });
  };

  const q = query.trim().toLowerCase();
  let list = (projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  if (prefs.sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  if (prefs.sort === "modified") list = [...list].sort((a, b) => b.modified - a.modified);
  const sortOpen = !!sortBtn.current && store.menu?.anchor === sortBtn.current;

  const item = (p) => ({
    key: p.id,
    title: `${p.name}\nCreated ${day(p.created)}`,
    tabindex: "0",
    onClick: () => open(p),
    onContextMenu: (e) => contextMenu(e, p),
    onKeyDown: (e) => e.key === "Enter" && e.target === e.currentTarget && open(p),
  });
  const cls = (base, p) => `${base} ${p.current ? "current" : ""} ${busy === p.id ? "busy" : ""}`;
  const more = (p) => html`<button class="btn small icon ghost more" title="More" aria-label="More"
    onClick=${(e) => moreMenu(e, p)}><${Icon} name="more" /></button>`;

  let body;
  if (failed) {
    body = html`<${Blank} icon="x" title="Couldn't load your projects">
      <p>${failed}</p>
      <button class="btn" onClick=${() => { setFailed(""); refresh(); }}><span class="lbl">Try again</span></button>
    <//>`;
  } else if (!projects) {
    body = html`<${Skeleton} view=${prefs.view} />`;
  } else if (!projects.length) {
    body = html`<${Blank} icon="layers" title="No projects yet">
      <button class="btn primary" onClick=${newProject}><${Icon} name="plus" tight /><span class="lbl">New Project</span></button>
    <//>`;
  } else if (!list.length) {
    body = html`<${Blank} icon="search" title=${`No projects match “${query.trim()}”`}>
      <button class="btn" onClick=${() => { setQuery(""); search.current?.focus(); }}><span class="lbl">Clear search</span></button>
    <//>`;
  } else if (prefs.view === "list") {
    body = html`<div class="home-list">
      <div class="prow head"><span>Name</span><span>Contents</span><span>Last edited</span><span /></div>
      ${list.map((p) => html`<div class=${cls("prow", p)} ...${item(p)}>
        <span class="pmain">
          <span class="pline"><span class="pname" title=${p.name}>${p.name}</span></span>
          <span class="psub">Created ${day(p.created)}</span>
        </span>
        <span class="meta"><${Meta} p=${p} /></span>
        <span class="pwhen">${ago(p.modified)}</span>
        ${more(p)}
      </div>`)}
    </div>`;
  } else {
    body = html`<div class="home-grid">${list.map((p) => html`<div class=${cls("pcard", p)} ...${item(p)}>
      <${Thumb} key=${`${p.id}-${p.modified}`} p=${p} />
      <div class="pbody">
        <div class="pline"><span class="pname" title=${p.name}>${p.name}</span>${more(p)}</div>
        <div class="psub">${p.modified ? `Edited ${ago(p.modified)}` : `Created ${day(p.created)}`}</div>
        <div class="meta"><${Meta} p=${p} /></div>
      </div>
    </div>`)}</div>`;
  }

  return html`<main class="home-body">
      <div class="home-head">
        <h1>Projects</h1>
        <button class="btn primary" onClick=${newProject}><${Icon} name="plus" tight /><span class="lbl">New Project</span></button>
      </div>
      <div class="home-tools">
        <label class="home-search">
          <${Icon} name="search" />
          <input ref=${search} class="input" placeholder="Search for a project" value=${query} spellcheck=${false}
            onInput=${(e) => setQuery(e.currentTarget.value)}
            onKeyDown=${(e) => { if (e.key === "Escape") { e.stopPropagation(); if (query) setQuery(""); else e.currentTarget.blur(); } }} />
          ${query && html`<button class="clear" title="Clear search" aria-label="Clear search"
            onClick=${(e) => { e.preventDefault(); setQuery(""); search.current?.focus(); }}><${Icon} name="x" size=${14} /></button>`}
        </label>
        <button ref=${sortBtn} class=${`btn ghost sort ${sortOpen ? "open" : ""}`} aria-haspopup="listbox" onClick=${sortMenu}>
          <${Icon} name="sort" /><span class="lbl">Sorted By ${SORTS[prefs.sort]}</span></button>
        <div class="spacer" />
        <div class="seg" role="group" aria-label="View">
          <button class=${prefs.view === "grid" ? "on" : ""} title="Cards" aria-pressed=${prefs.view === "grid"}
            onClick=${() => setPrefs({ view: "grid" })}><${Icon} name="cards" /></button>
          <button class=${prefs.view === "list" ? "on" : ""} title="List" aria-pressed=${prefs.view === "list"}
            onClick=${() => setPrefs({ view: "list" })}><${Icon} name="list" /></button>
        </div>
      </div>
      ${body}
    </main>`;
}

// ---------------------------------------------------------------- sidebar
const SIDE_KEY = "manimator-sidebar";
const SIDE_MODES = { expanded: "Expanded", collapsed: "Collapsed", hover: "Expand on hover" };

function loadSideMode() {
  try {
    const mode = localStorage.getItem(SIDE_KEY);
    if (SIDE_MODES[mode]) return mode;
  } catch { /* storage unavailable */ }
  return "hover";
}

const PAGES = [
  { key: "projects", label: "Projects", icon: "box" },
  { key: "presentations", label: "Presentations", icon: "present" },
  { key: "customizations", label: "Customizations", icon: "spark" },
  { key: "account", label: "Account", icon: "user", needsAccounts: true },
];

/** Icons down the left. Like Supabase's: it can stay open, stay closed, or open over the page while the pointer is on
 *  it (the default). */
function Sidebar({ page, setPage }) {
  const [mode, setModeState] = useState(loadSideMode);
  const [hover, setHover] = useState(false);
  const ctl = useRef();
  const setMode = (m) => {
    setModeState(m);
    setHover(false);
    try { localStorage.setItem(SIDE_KEY, m); } catch { /* storage unavailable */ }
  };
  const ctlOpen = !!ctl.current && store.menu?.anchor === ctl.current;
  const controlMenu = (e) => {
    e.stopPropagation();
    const r = ctl.current.getBoundingClientRect();
    openMenu([{ section: "Sidebar control" }, ...Object.entries(SIDE_MODES).map(([key, label]) => ({
      label,
      icon: key === mode ? html`<${Icon} name="check" size=${15} />` : "",
      onClick: () => setMode(key),
    }))], r.right + 8, r.bottom, { kind: "dd", anchor: ctl.current, above: r.bottom });
  };
  const open = mode === "expanded" || (mode === "hover" && (hover || ctlOpen));
  const pages = PAGES.filter((p) => !p.needsAccounts || store.account?.accounts);
  return html`<nav class=${`side ${mode} ${open ? "open" : ""}`} aria-label="Pages">
    <div class="side-panel" onMouseEnter=${() => setHover(true)} onMouseLeave=${() => setHover(false)}>
      ${pages.map((p) => html`<button key=${p.key} class=${`side-item ${page === p.key ? "on" : ""}`} title=${open ? "" : p.label}
        aria-current=${page === p.key ? "page" : null} onClick=${() => setPage(p.key)}>
        <${Icon} name=${p.icon} size=${18} /><span class="lbl">${p.label}</span></button>`)}
      <div class="spacer" />
      <button ref=${ctl} class=${`side-item ctl ${ctlOpen ? "on" : ""}`} title="Sidebar control" aria-label="Sidebar control"
        onClick=${controlMenu}><${Icon} name="sidebar" size=${18} /></button>
    </div>
  </nav>`;
}

function AccountScreen() {
  return html`<main class="home-body">
    <div class="home-head"><h1>Account</h1></div>
    <${AccountPage} />
  </main>`;
}

function currentPage() {
  const page = store.homePage || "projects";
  return page === "account" && !store.account?.accounts ? "projects" : page;
}

// The browser tab's title for the start screen: the sidebar page you are on.
export function homeTitle() {
  const page = currentPage();
  return `${PAGES.find((p) => p.key === page)?.label || "Projects"} — Manimator`;
}

export function Home() {
  const page = currentPage();
  const setPage = (key) => { store.homePage = key; store.presentationId = null; store.menu = null; emit(); };
  const Page = { projects: ProjectsPage, presentations: PresentationsPage, customizations: CustomizationsPage,
    account: AccountScreen }[page];
  return html`<div class="home">
    <header class="topbar home-top">
      <div class="group"><div class="brand">Manimator</div></div>
      <div class="group end"><${AccountButton} /></div>
    </header>
    <div class="home-page">
      <${Sidebar} page=${page} setPage=${setPage} />
      <div class="home-scroll"><${Page} /></div>
    </div>
  </div>`;
}
