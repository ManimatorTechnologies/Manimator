// A little Markdown, drawn as Preact elements (never as HTML text, so nothing in it can run): headings, paragraphs,
// lists, quotes, code blocks, rules, and inside them **bold**, *italics*, `code` and [links](https://...). Enough for
// a customization's README.md.

import { html } from "./lib.js";

const INLINE = new RegExp([
  /`([^`]+)`/.source,
  /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/.source,
  /(?<![*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])|(?<![_\w])_(?=\S)([^_]*?\S)_(?![_\w])/.source,
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.source,
].join("|"), "g");

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(html`<code>${m[1]}</code>`);
    else if ((m[2] ?? m[3]) !== undefined) out.push(html`<strong>${inline(m[2] ?? m[3])}</strong>`);
    else if ((m[4] ?? m[5]) !== undefined) out.push(html`<em>${inline(m[4] ?? m[5])}</em>`);
    else out.push(html`<a href=${m[7]} target="_blank" rel="noopener noreferrer">${inline(m[6])}</a>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The blocks of `src`: [{ kind: "h", level, text } | { kind: "p" | "quote", text } | { kind: "ul" | "ol", items }
 *  | { kind: "code", text } | { kind: "hr" }]. */
export function blocks(src) {
  const out = [];
  let para = [], list = null, quote = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    if (list) out.push(list);
    if (quote.length) out.push({ kind: "quote", text: quote.join(" ") });
    para = []; list = null; quote = [];
  };
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    let m;
    if (/^\s*```/.test(line)) { // a code block, to its closing fence
      flush();
      const code = [];
      for (k += 1; k < lines.length && !/^\s*```/.test(lines[k]); k += 1) code.push(lines[k]);
      out.push({ kind: "code", text: code.join("\n") });
    } else if (!line.trim()) {
      flush();
    } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line))) {
      flush();
      out.push({ kind: "h", level: m[1].length, text: m[2] });
    } else if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ kind: "hr" });
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      const kind = /\d/.test(m[1]) ? "ol" : "ul";
      if (para.length || quote.length || (list && list.kind !== kind)) flush();
      list ??= { kind, items: [] };
      list.items.push(m[2]);
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      if (para.length || list) flush();
      quote.push(m[1]);
    } else if (list && /^\s+\S/.test(line)) { // a list item's next line
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list || quote.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out;
}

/** Markdown `text` as elements. `dropTitle`: leave out a first "# heading" (the page shows the name already). Headings
 *  start at h3: the page has its own h1 and h2. */
export function Markdown({ text, dropTitle = false, className = "" }) {
  let list = blocks(text);
  if (dropTitle && list[0]?.kind === "h" && list[0].level === 1) list = list.slice(1);
  return html`<div class=${`md ${className}`}>${list.map((b) => {
    switch (b.kind) {
      case "h": {
        const level = Math.min(6, b.level + 2);
        return html`<${`h${level}`}>${inline(b.text)}<//>`;
      }
      case "ul": return html`<ul>${b.items.map((i) => html`<li>${inline(i)}</li>`)}</ul>`;
      case "ol": return html`<ol>${b.items.map((i) => html`<li>${inline(i)}</li>`)}</ol>`;
      case "quote": return html`<blockquote>${inline(b.text)}</blockquote>`;
      case "code": return html`<pre><code>${b.text}</code></pre>`;
      case "hr": return html`<hr />`;
      default: return html`<p>${inline(b.text)}</p>`;
    }
  })}</div>`;
}
