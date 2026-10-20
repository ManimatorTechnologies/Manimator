// The Customizations page: custom objects and animations, written as code and uploaded as .manimkit files
// (server/kits.py). Mine: the visitor's own (upload, new versions, make public) and the ones they added from the
// gallery. Gallery: the public ones, which the site's owner approved first; the owner also sees there the ones waiting
// for review or reported, and reviews each on its own page. Every preview plays in the sandbox (sandboxed.js):
// customizations' code never runs on this page. The editor's palette and animation window offer the visitor's own and library ones in a Custom group.

import { html, useEffect, useRef, useState } from "./lib.js";
import { chooseLocalFile, get, post } from "./api.js";
import { openAuth, openPricing } from "./account.js";
import { loadKits, status, store } from "./store.js";
import { confirmDialog, Icon, openMenu, promptDialog } from "./ui.js";

const KINDS = { object: "Object", animation: "Animation" };
const STATUS = { private: "Private", pending: "Waiting for review", public: "Public", rejected: "Not approved",
  taken_down: "Taken down" };

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

const reportCount = (n) => `${n} report${n === 1 ? "" : "s"}`;

/** What waits for the site's owner on a customization, in a few words ("" if nothing, or not the owner). */
function waits(kit) {
  const n = kit.review?.reports.length ?? 0;
  return kit.review?.version ? "Waiting for review" : n ? reportCount(n) : "";
}

/** Sends a .manimkit file; resolves with the server's answer. */
async function sendPackage(url, file) {
  const res = await fetch(url, { method: "POST", body: file,
    headers: { "X-Manimator": "1", "Content-Type": "application/octet-stream" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (res.status === 413 ? "That file is too large." : `Server error (${res.status})`));
  return data;
}

const choosePackage = () => chooseLocalFile(".manimkit,application/zip");
const latest = (kit) => kit.versions.at(-1);

function Blank({ icon, title, children }) {
  return html`<div class="home-blank">
    <div class="ring"><${Icon} name=${icon} size=${20} /></div>
    <h3>${title}</h3>
    ${children}
  </div>`;
}

const needsSignIn = (why) => why.startsWith("Sign in");

/** Why the visitor can't make or add customizations, with the way on (sign in, or the plans). */
function NeedPlan({ why }) {
  return html`<div class="acct-actions">
    ${needsSignIn(why) ? html`<button class="btn" onClick=${() => openAuth("signin")}><span class="lbl">Sign in</span></button>
      <button class="btn primary" onClick=${() => openAuth("signup")}><span class="lbl">Sign up</span></button>`
      : html`<button class="btn primary" onClick=${openPricing}><span class="lbl">See plans</span></button>`}
  </div>`;
}

function Row({ kit, sub, right, onOpen, onMenu }) {
  return html`<div class="prow" tabindex="0" onClick=${onOpen} onContextMenu=${onMenu}
      onKeyDown=${(e) => e.key === "Enter" && onOpen()}>
    <span class="pmain">
      <span class="pline"><span class="pname" title=${kit.name}>${kit.name}</span></span>
      <span class="psub">${sub}</span>
    </span>
    <span class="meta">${KINDS[kit.kind]}</span>
    <span class="pwhen">${right}</span>
    ${onMenu ? html`<button class="btn small icon ghost more" title="More" aria-label="More" onClick=${onMenu}>
      <${Icon} name="more" /></button>` : html`<span />`}
  </div>`;
}

export function CustomizationsPage() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState("");
  const [picked, setTab] = useState(null); // null: the first tab
  const [open, setOpen] = useState(null); // { id, version? }
  const [busy, setBusy] = useState(false);
  const refresh = () => get("/api/kits").then((r) => { setData(r); setFailed(""); }).catch((e) => setFailed(e.message));
  useEffect(() => { refresh(); }, []);

  const changed = (res, message) => {
    if (res?.kits) setData(res);
    loadKits(); // the editor's Custom groups
    if (message) status(message, "ok");
  };
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      status(err.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const actions = {
    upload: (kitId = null) => act(async () => {
      const file = await choosePackage();
      if (!file) return;
      const res = await sendPackage(kitId ? `/api/kits/${kitId}/versions` : "/api/kits", file);
      changed(res, kitId ? `Added version ${latest(res.kit).label} of ${res.kit.name}.`
        : `Added ${res.kit.name}. Find it in the editor under Custom.`);
      if (kitId) setOpen({ id: kitId, nonce: Date.now() });
    }),
    remove: (kit) => act(async () => {
      const ok = await confirmDialog({ title: `Delete ${kit.name}?`, message: "It leaves your list, the gallery and the "
        + "editor's Custom group. Projects that already use it keep it.", ok: "Delete customization", danger: true });
      if (!ok) return;
      changed(await post(`/api/kits/${kit.id}/delete`), `Deleted ${kit.name}.`);
      setOpen(null);
    }),
    submit: (kit) => act(async () => {
      const ok = await confirmDialog({ title: `Make ${kit.name} public?`, message: "Manimator looks at its code before "
        + "it joins the gallery, where anyone with an account can add it to their projects. Its newest version is the "
        + "one that becomes public.", ok: "Ask to make it public" });
      if (!ok) return;
      changed(await post(`/api/kits/${kit.id}/submit`), `${kit.name} is waiting for review.`);
      setOpen({ id: kit.id, nonce: Date.now() });
    }),
    library: (kit, add) => act(async () => {
      changed(await post(`/api/kits/${kit.id}/library`, { add }),
        add ? `Added ${kit.name}. Find it in the editor under Custom.` : `Removed ${kit.name} from your library.`);
      setOpen({ id: kit.id, nonce: Date.now() });
    }),
    report: (kit) => act(async () => {
      const reason = await promptDialog({ title: `Report ${kit.name}`, message: "What is wrong with it?", value: "",
        ok: "Send report" });
      if (!reason?.trim()) return;
      await post(`/api/kits/${kit.id}/report`, { reason });
      status("Thank you. Manimator will look at it.", "ok");
    }),
    review: (kit, action, version = 0) => act(async () => { // the site's owner: approve, reject, take_down, dismiss
      let reason = "";
      if (action === "reject" || action === "take_down") {
        reason = await promptDialog({ title: action === "reject" ? `Not approve ${kit.name}` : `Take down ${kit.name}`,
          message: action === "reject" ? "Why (the author reads this)?" : "Why (the author reads this)? Its code stops "
            + "running everywhere and projects show its objects as unavailable.", value: "",
          ok: action === "reject" ? "Don't approve" : "Take down" });
        if (!reason) return; // cancelled (a reason is needed: the author reads it)
      }
      const url = action === "take_down" ? `/api/admin/kits/${kit.id}/take_down`
        : action === "dismiss" ? `/api/admin/kits/${kit.id}/dismiss` : `/api/admin/kits/${kit.id}/${version}/decide`;
      await post(url, action === "approve" || action === "reject" ? { action, reason } : { reason });
      changed(null, { approve: `${kit.name} is public.`, reject: `${kit.name} wasn't approved.`,
        take_down: `${kit.name} was taken down.`, dismiss: "Reports dismissed." }[action]);
      setOpen((o) => ({ ...o, nonce: Date.now() }));
    }),
  };

  if (open) {
    return html`<${Detail} key=${`${open.id}:${open.version ?? ""}:${open.nonce ?? ""}`} id=${open.id} version=${open.version}
      back=${() => { setOpen(null); refresh(); }} busy=${busy} actions=${actions} isPublic=${!!data?.public} />`;
  }
  const tabs = [...(data?.public ? [["gallery", "Gallery"]] : []), ["mine", "Mine"]];
  const tab = picked ?? tabs[0][0];
  const full = data && !data.why && data.kits.length >= data.limit;
  return html`<main class="home-body">
    <div class="home-head">
      <h1>Customizations</h1>
      ${tab === "mine" && data && !data.why && html`<button class="btn primary" disabled=${busy || full}
        title=${full ? `Your plan keeps up to ${data.limit} customizations` : "Add a .manimkit file"}
        onClick=${() => actions.upload()}><${Icon} name="plus" tight /><span class="lbl">Upload .manimkit</span></button>`}
    </div>
    ${tabs.length > 1 && html`<div class="cz-tabs" role="tablist">${tabs.map(([key, label]) => html`<button role="tab"
      class=${`cz-tab ${tab === key ? "on" : ""}`} aria-selected=${tab === key} onClick=${() => setTab(key)}>${label}</button>`)}</div>`}
    ${failed ? html`<${Blank} icon="x" title="Couldn't load your customizations"><p>${failed}</p>
        <button class="btn" onClick=${refresh}><span class="lbl">Try again</span></button><//>`
      : !data ? null
      : tab === "gallery" ? html`<${Gallery} open=${(id, version) => setOpen({ id, version })} />`
      : html`<${Mine} data=${data} actions=${actions} open=${(id) => setOpen({ id })} />`}
  </main>`;
}

function Mine({ data, actions, open }) {
  const menu = (e, kit) => {
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect?.() ?? { right: e.clientX + 180, bottom: e.clientY };
    openMenu([
      { label: "Open", onClick: () => open(kit.id) },
      ...(latest(kit)?.status === "taken_down" ? [] // it gets no new versions
        : [{ label: "Upload a new version…", onClick: () => actions.upload(kit.id) }]),
      ...(data.public && ["private", "rejected"].includes(latest(kit)?.status)
        ? [{ label: "Make public…", onClick: () => actions.submit(kit) }] : []),
      { separator: true },
      { label: "Delete…", onClick: () => actions.remove(kit) },
    ], e.type === "contextmenu" ? e.clientX : r.right - 200, e.type === "contextmenu" ? e.clientY : r.bottom + 4);
  };
  if (data.why) {
    return html`<${Blank} icon="spark" title="Make your own objects and animations">
      ${!needsSignIn(data.why) && html`<p>${data.why}</p>`}<${NeedPlan} why=${data.why} /><//>`;
  }
  if (!data.kits.length && !data.library.length) {
    return html`<${Blank} icon="spark" title="No customizations yet" />`;
  }
  return html`${data.kits.length > 0 && html`<div class="home-list cz-list">
      <div class="prow head"><span>Name</span><span>Kind</span><span>Version</span><span /></div>
      ${data.kits.map((k) => html`<${Row} key=${k.id} kit=${k} sub=${k.description || k.class}
        right=${latest(k) ? `${latest(k).label} · ${STATUS[latest(k).status] ?? latest(k).status}` : ""}
        onOpen=${() => open(k.id)} onMenu=${(e) => menu(e, k)} />`)}
    </div>`}
    ${data.library.length > 0 && html`<h3 class="cz-h">From the gallery</h3>
      <div class="home-list cz-list">
        ${data.library.map((k) => html`<${Row} key=${k.id} kit=${k} sub=${`by ${k.author || "someone"}`}
          right=${latest(k)?.label ?? ""} onOpen=${() => open(k.id)} />`)}
      </div>`}`;
}

function Gallery({ open }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      get(`/api/kits-gallery?q=${encodeURIComponent(query)}`).then(setFound).catch((e) => status(e.message, "error"));
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query]);
  return html`${found && !found.can_add && found.why && !needsSignIn(found.why) && html`<p class="cz-how">${found.why}</p>`}
    <label class="home-search cz-search"><${Icon} name="search" />
      <input class="input" placeholder="Search customizations" value=${query} spellcheck=${false}
        onInput=${(e) => setQuery(e.currentTarget.value)} /></label>
    ${found && !found.kits.length ? html`<${Blank} icon="spark" title=${query ? `Nothing matches “${query}”` : "Nothing here yet"}>
        <p>${query ? "Try other words." : "Approved customizations will appear here."}</p><//>`
      : found && html`<div class="home-list cz-list">
        <div class="prow head"><span>Name</span><span>Kind</span><span>By</span><span /></div>
        ${found.kits.map((k) => html`<${Row} key=${k.id} kit=${k} sub=${k.description || k.class}
          right=${html`${k.author || "someone"}${waits(k) ? html` · <span class="cz-waits">${waits(k)}</span>`
            : k.in_library ? html` · <span class="cz-in">In your library</span>` : ""}`}
          onOpen=${() => open(k.id, k.review?.version || undefined)} />`)}
      </div>`}`;
}

function Detail({ id, version, back, busy, actions, isPublic }) {
  const [kit, setKit] = useState(null);
  const [missing, setMissing] = useState("");
  useEffect(() => {
    get(`/api/kits/${id}${version ? `?version=${version}` : ""}`).then(setKit).catch((e) => setMissing(e.message));
  }, [id, version]);
  if (missing) {
    return html`<main class="home-body"><${Blank} icon="x" title="Couldn't open it"><p>${missing}</p>
      <button class="btn" onClick=${back}><span class="lbl">Back</span></button><//></main>`;
  }
  if (!kit) return html`<main class="home-body" />`;
  const shown = kit.versions.find((v) => v.version === kit.shown_version) ?? latest(kit);
  const newest = latest(kit);
  const canSubmit = kit.mine && isPublic && ["private", "rejected"].includes(newest?.status);
  const review = kit.review; // only for the site's owner, who reviews: { version waiting (0: none), reports }
  const waiting = review?.version ? kit.versions.find((v) => v.version === review.version) : null;
  const inGallery = kit.versions.some((v) => v.status === "public");
  return html`<main class="home-body cz-detail">
    <div class="pres-top">
      <button class="btn ghost small icon" title="Back" aria-label="Back" onClick=${back}><${Icon} name="left" /></button>
      <h1 class="cz-name">${kit.name}</h1>
      <span class="cz-kind">${KINDS[kit.kind]}</span>
      <div class="spacer" />
      ${waiting && html`<button class="btn" disabled=${busy} onClick=${() => actions.review(kit, "reject", waiting.version)}>
          <span class="lbl">Don't approve</span></button>
        <button class="btn primary" disabled=${busy} onClick=${() => actions.review(kit, "approve", waiting.version)}>
          <span class="lbl">Approve</span></button>`}
      ${review?.reports.length > 0 && html`<button class="btn" disabled=${busy} onClick=${() => actions.review(kit, "dismiss")}>
        <span class="lbl">Dismiss reports</span></button>`}
      ${review && inGallery && html`<button class="btn danger" disabled=${busy}
        onClick=${() => actions.review(kit, "take_down")}><span class="lbl">Take down</span></button>`}
      ${kit.mine ? html`
        ${canSubmit && html`<button class="btn" disabled=${busy} onClick=${() => actions.submit(kit)}>
          <span class="lbl">Make public</span></button>`}
        ${newest?.status !== "taken_down" && html`<button class="btn" disabled=${busy}
          onClick=${() => actions.upload(kit.id)}><span class="lbl">Upload new version</span></button>`}
        <button class="btn" onClick=${() => actions.remove(kit)}><span class="lbl">Delete</span></button>`
      : html`
        ${!review && html`<button class="btn" onClick=${() => actions.report(kit)}><span class="lbl">Report</span></button>`}
        ${kit.in_library ? html`<button class="btn" disabled=${busy} onClick=${() => actions.library(kit, false)}>
            <span class="lbl">Remove from library</span></button>`
          : kit.can_add ? html`<button class="btn primary" disabled=${busy} onClick=${() => actions.library(kit, true)}>
            <span class="lbl">Add to my library</span></button>`
          : inGallery && (store.account?.user
            ? html`<button class="btn primary" onClick=${openPricing}><span class="lbl">See plans</span></button>`
            : html`<button class="btn primary" onClick=${() => openAuth("signup")}><span class="lbl">Sign up to use it</span></button>`)}`}
    </div>
    <p class="cz-desc">${kit.description || ""} <span class="cz-class">${kit.class}</span>
      ${!kit.mine && html` · by ${kit.author || "someone"}`}</p>
    ${waiting && html`<p class="cz-state">Version ${waiting.label || `#${waiting.version}`} is waiting for your review.</p>`}
    ${review?.reports.length > 0 && html`<div class="cz-state warn">${reportCount(review.reports.length)}:
      <ul class="cz-reasons">${review.reports.map((r) => html`<li>${r.reason} <span class="dim">${ago(r.created)}</span></li>`)}</ul>
    </div>`}
    ${kit.mine && !waiting && newest?.status === "pending" && html`<p class="cz-state">Waiting for review: Manimator looks at its code
      before it joins the gallery.</p>`}
    ${kit.mine && newest?.status === "rejected" && html`<p class="cz-state warn">Not approved${newest.reason
      ? `: ${newest.reason}` : ""}. Upload a fixed version, then make it public again.</p>`}
    ${kit.mine && newest?.status === "taken_down" && html`<p class="cz-state warn">Taken down${newest.reason
      ? `: ${newest.reason}` : ""}. Its objects don't play any more.</p>`}
    ${newest?.status === "taken_down" ? null : html`<${Preview} kitId=${kit.id} version=${shown?.version} />`}
    <h3 class="cz-h">Versions</h3>
    <ul class="cz-versions">
      ${[...kit.versions].reverse().map((v) => html`<li key=${v.version}>
        <b>${v.label || `#${v.version}`}</b><span>${STATUS[v.status] ?? v.status}${v.reason ? `: ${v.reason}` : ""}</span>
        <span class="dim">${ago(v.created)}</span></li>`)}
    </ul>
    <p class="dim cz-note">Projects keep the version they were made with. New objects and animations use the newest.
      ${shown && html` Code: <span class="cz-files">${["kit.js", "kit.py"].map((f) => html`<a
        href=${`/api/kits/${kit.id}/${shown.version}/${f}`} target="_blank" rel="noopener">${f}</a>`)}</span>`}</p>
    ${kit.readme && html`<h3 class="cz-h">README</h3><pre class="cz-readme">${kit.readme}</pre>`}
  </main>`;
}

/** The customization playing on a loop, drawn in the sandbox. */
function Preview({ kitId, version }) {
  const canvas = useRef();
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let alive = true;
    let engine = null;
    let timer = 0;
    (async () => {
      try {
        const { plan } = await get(`/api/kits/${kitId}/demo${version ? `?version=${version}` : ""}`);
        const { createSandboxedEngine } = await import("./sandboxed.js");
        engine = await createSandboxedEngine({ canvas: canvas.current });
        if (!alive) return engine.dispose();
        const r = canvas.current.getBoundingClientRect();
        const k = Math.min(window.devicePixelRatio || 1, 2);
        engine.resize(Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k)));
        const shown = await engine.show(plan);
        if (!alive || !shown) return;
        const errors = [...Object.values(shown.errors ?? {}), ...(shown.scene_error ? [shown.scene_error] : [])];
        setProblem(errors.map(String).join(" · "));
        await engine.prepare();
        const loop = () => engine.play(0, (_t, ended) => {
          if (ended && alive) timer = setTimeout(() => alive && loop(), 900);
        });
        if (alive) loop();
      } catch (err) {
        if (alive) setProblem(err.message);
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      engine?.dispose();
    };
  }, [kitId, version]);
  return html`<div class="cz-preview"><canvas ref=${canvas} />
    ${problem && html`<div class="cz-problem">${problem}</div>`}</div>`;
}
