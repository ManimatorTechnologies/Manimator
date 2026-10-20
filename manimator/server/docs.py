"""The docs (/docs), laid out like Vercel's: one page per topic, each an HTML fragment in web/docs/pages/, put into one
frame (web/docs/page.html) with the sidebar of every page, the page's own "On this page" list (its h2 and h3 headings)
and Previous / Next links. The sidebar's search reads /docs/search.json: every section of every page as plain text."""

from __future__ import annotations

import json
import re
from html import escape, unescape
from pathlib import Path

# address under /docs, title, sidebar group, the line under the title. This order is the sidebar's and Previous/Next's.
PAGES = [
    ("", "Getting started", "Start",
     "Manimator is a visual editor for Manim. Build a scene with buttons, animate it step by step, and make a video, "
     "all in your browser."),
    ("objects", "Scenes and objects", "Make videos",
     "Add Manim's objects to a scene, change how they look, and choose what the scene's camera can do."),
    ("animation", "Animation", "Make videos",
     "A scene's video is a list of steps. Each step plays animations together, or waits."),
    ("videos", "Videos and downloads", "Make videos",
     "Play a scene in the editor, make its video in your browser, or download it as Python for Manim."),
    ("presentations", "Presentations", "Go further",
     "Play a project's scenes full screen, one after another, with your own videos in between."),
    ("customizations", "Customizations", "Go further",
     "Add your own objects and animations to the editor, or ones other people made, and learn to write them."),
    ("ai", "AI chats", "Go further",
     "Use Manimator inside AI chat apps that support custom connectors."),
    ("shortcuts", "Keyboard shortcuts", "Reference",
     "Every key the editor and the presenter know, and a few things to do with the mouse."),
]
SLUGS = {slug for slug, *_ in PAGES}

HEADING = re.compile(r'<h([23]) id="([a-z0-9-]+)">(.*?)</h\1>', re.S)
CODE = re.compile(r'<pre data-label="([^"]*)">(.*?)</pre>', re.S)
SPACES = re.compile(r"\s+")
TAGS = re.compile(r"<[^>]+>")

_ICON = ('<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" '
         'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{}</svg>')
ICONS = {
    "terminal": _ICON.format('<path d="M2.5 4.5l3.5 3.5-3.5 3.5M7.5 12h6" />'),
    "file": _ICON.format('<path d="M4 1.75h5l3 3v9.5H4zM9 1.75v3h3" />'),
    "copy": _ICON.format('<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />'
                         '<path d="M10.75 5.25v-2a1.5 1.5 0 0 0-1.5-1.5h-6a1.5 1.5 0 0 0-1.5 1.5v6a1.5 1.5 0 0 0 1.5 1.5h2" />'),
    "prev": _ICON.format('<path d="M10 3.5L5.5 8l4.5 4.5" />'),
    "next": _ICON.format('<path d="M6 3.5l4.5 4.5L6 12.5" />'),
}


def address(slug: str) -> str:
    return f"/docs/{slug}" if slug else "/docs"


def _read(web_dir: Path | list[Path], name: str) -> str:
    """A file under web/, from the first of the folders that has it (an add-on's own come first: server/addon.py)."""
    dirs = web_dir if isinstance(web_dir, list) else [web_dir]
    path = next((d / name for d in dirs if (d / name).is_file()), dirs[-1] / name)
    return path.read_text(encoding="utf-8")


def _fragment(web_dir: Path | list[Path], slug: str) -> str:
    return _read(web_dir, f"docs/pages/{slug or 'index'}.html")


def _text(html: str) -> str:
    return SPACES.sub(" ", unescape(TAGS.sub(" ", html))).strip()


def _dress(html: str) -> str:
    """Headings link to themselves, code blocks get a bar with their name and a Copy button, tables a frame."""
    html = HEADING.sub(lambda m: f'<h{m[1]} id="{m[2]}"><a href="#{m[2]}">{m[3]}</a></h{m[1]}>', html)

    def code(m: re.Match) -> str:
        label = m[1]
        icon = ICONS["terminal" if label == "Terminal" else "file"]
        return (f'<figure class="d-code"><figcaption>{icon}<span>{escape(label)}</span>'
                f'<button class="d-copy" type="button" title="Copy" aria-label="Copy">{ICONS["copy"]}</button>'
                f'</figcaption><pre>{m[2]}</pre></figure>')

    html = CODE.sub(code, html)
    return html.replace("<table>", '<div class="d-table"><table>').replace("</table>", "</table></div>")


def _nav(current: str) -> str:
    out, group = [], None
    for slug, title, g, _ in PAGES:
        if g != group:
            group = g
            out.append(f'<p class="d-group">{escape(g)}</p>')
        here = ' aria-current="page"' if slug == current else ""
        out.append(f'<a class="d-item" href="{address(slug)}"{here}>{escape(title)}</a>')
    return "\n".join(out)


def _toc(html: str) -> str:
    return "\n".join(f'<li class="l{level}"><a href="#{hid}">{escape(_text(text))}</a></li>'
                     for level, hid, text in HEADING.findall(html))


def _pager(i: int) -> str:
    out = []
    if i > 0:
        slug, title, *_ = PAGES[i - 1]
        out.append(f'<a class="d-prev" href="{address(slug)}"><span class="d-dir">Previous</span>'
                   f'<span class="d-to">{ICONS["prev"]}{escape(title)}</span></a>')
    if i < len(PAGES) - 1:
        slug, title, *_ = PAGES[i + 1]
        out.append(f'<a class="d-next" href="{address(slug)}"><span class="d-dir">Next</span>'
                   f'<span class="d-to">{escape(title)}{ICONS["next"]}</span></a>')
    return "\n".join(out)


def render(web_dir: Path | list[Path], slug: str) -> str | None:
    """The page at /docs/<slug>, or None when there's no such page."""
    if slug not in SLUGS:
        return None
    i = next(k for k, page in enumerate(PAGES) if page[0] == slug)
    _, title, _, lead = PAGES[i]
    body = _fragment(web_dir, slug)
    page = _read(web_dir, "docs/page.html")
    for key, value in (("title", escape(title)), ("lead", escape(lead)), ("path", address(slug)),
                       ("nav", _nav(slug)), ("toc", _toc(body)), ("pager", _pager(i)), ("content", _dress(body))):
        page = page.replace("{{" + key + "}}", value)
    return page


def search_index(web_dir: Path | list[Path]) -> list[dict]:
    """Every page, and every section of it (an h2 or h3 and what follows up to the next one), as plain text."""
    out = []
    for slug, title, _, lead in PAGES:
        body = _fragment(web_dir, slug)
        out.append({"page": title, "url": address(slug), "title": title, "text": lead})
        marks = list(HEADING.finditer(body))
        for k, m in enumerate(marks):
            end = marks[k + 1].start() if k + 1 < len(marks) else len(body)
            out.append({"page": title, "url": f"{address(slug)}#{m[2]}", "title": _text(m[3]),
                        "text": _text(body[m.end():end])})
    return out


def search_json(web_dir: Path | list[Path]) -> str:
    return json.dumps(search_index(web_dir), ensure_ascii=False, separators=(",", ":"))
