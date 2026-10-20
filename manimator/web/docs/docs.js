// The docs pages (server/docs.py): search in the sidebar, the "On this page" list following the scroll, Copy on code
// blocks, and the phone's Menu. Every page works without it; this only adds to them.

// The docs were one page until 2026-10-19: its #sections now live on their own pages (and /manimkit led to #making).
const MOVED = {
  start: "/docs#first-steps", objects: "/docs/objects#objects", inspector: "/docs/objects#inspector",
  scenes: "/docs/objects#scenes", animation: "/docs/animation", videos: "/docs/videos",
  downloads: "/docs/videos#project-file", presentations: "/docs/presentations", customizations: "/docs/customizations",
  ai: "/docs/ai", keys: "/docs/shortcuts", making: "/docs/customizations#writing",
};
const moved = location.pathname === "/docs" && MOVED[location.hash.slice(1)];
if (moved) location.replace(moved);

// ------------------------------------------------------------------ the phone's Menu
const menu = document.querySelector(".d-menu");
const setMenu = (open) => {
  document.body.classList.toggle("menu-open", open);
  menu?.setAttribute("aria-expanded", String(open));
};
menu?.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
document.querySelector(".d-side")?.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
matchMedia("(min-width: 1024px)").addEventListener("change", () => setMenu(false));

// ------------------------------------------------------------------ Copy
document.addEventListener("click", async (e) => {
  const button = e.target.closest(".d-copy");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.closest(".d-code").querySelector("pre").textContent);
  } catch {
    return; // no clipboard here: the code can still be selected
  }
  button.classList.add("done");
  button.title = "Copied";
  setTimeout(() => { button.classList.remove("done"); button.title = "Copy"; }, 1500);
});

// ------------------------------------------------------------------ On this page
const links = [...document.querySelectorAll(".d-toc a")];
const headings = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
function markCurrent() {
  if (!headings.length) return;
  const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
  let current = headings[0];
  for (const h of headings) if (h.getBoundingClientRect().top <= line + 8) current = h;
  if (atEnd) current = headings[headings.length - 1];
  for (const a of links) a.classList.toggle("on", a.hash === `#${current.id}`);
}
let queued = false;
addEventListener("scroll", () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; markCurrent(); });
}, { passive: true });
addEventListener("resize", markCurrent);
markCurrent();

// ------------------------------------------------------------------ search
const input = document.querySelector(".d-search input");
const results = document.querySelector(".d-results");
const nav = document.querySelector(".d-nav");
let index = null;
let hits = [];
let chosen = 0;

const load = () => (index ??= fetch("/docs/search.json").then((r) => r.json()).catch(() => { index = null; return []; }));
const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Sections holding every word, those with the words in their title first. */
function find(entries, query) {
  const ws = words(query);
  return entries
    .map((e) => {
      const title = e.title.toLowerCase();
      const all = `${title} ${e.page.toLowerCase()} ${e.text.toLowerCase()}`;
      if (!ws.every((w) => all.includes(w))) return null;
      return { e, score: ws.filter((w) => title.includes(w)).length * 10 - (e.url.includes("#") ? 0 : 1) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((r) => r.e);
}

function show() {
  const query = input.value.trim();
  results.hidden = !query;
  nav.hidden = !!query;
  if (!query) return;
  results.innerHTML = hits.length
    ? hits.map((e, i) => `<a class="d-hit${i === chosen ? " on" : ""}" href="${esc(e.url)}" role="option">`
      + `<span class="t">${esc(e.title)}</span>${e.title === e.page ? "" : `<span class="p">${esc(e.page)}</span>`}</a>`).join("")
    : `<p class="d-none">Nothing matches “${esc(query)}”</p>`;
}

input?.addEventListener("focus", load);
input?.addEventListener("input", async () => {
  const query = input.value;
  const entries = await load();
  if (query !== input.value) return; // typed on meanwhile
  hits = find(entries, query);
  chosen = 0;
  show();
});
input?.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!hits.length) return;
    chosen = (chosen + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
    show();
    results.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && hits[chosen]) {
    e.preventDefault();
    setMenu(false);
    location.href = hits[chosen].url;
  } else if (e.key === "Escape") {
    input.value = "";
    hits = [];
    show();
    input.blur();
  }
});
// Ctrl+K (or ⌘K) and "/" go to the search box, opening the phone's Menu if needed
addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
    e.preventDefault();
    if (!matchMedia("(min-width: 1024px)").matches) setMenu(true);
    input?.focus();
    input?.select();
  }
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelector(".d-search kbd")?.replaceChildren("⌘ K");
