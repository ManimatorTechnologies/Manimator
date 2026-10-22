// The little Markdown reader that shows a customization's README.md (web/js/markdown.js): its blocks, and that what
// it reads only ever becomes text, never markup.
import { test } from "node:test";
import assert from "node:assert/strict";

const { blocks, Markdown } = await import("../../manimator/web/js/markdown.js");

/** Every string in an element tree, and every element type, in order. */
function walk(node, out = { text: [], tags: [] }) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
  } else if (typeof node === "object") {
    out.tags.push(node.type);
    walk(node.props?.children, out);
  } else {
    out.text.push(String(node));
  }
  return out;
}

test("reads headings, paragraphs, lists, quotes, code and rules", () => {
  const src = "# Battery\n\nA battery\nthat runs down.\n\n- **Charge**: how full\n  it is\n- *Pop in*\n\n"
    + "1. one\n2. two\n\n> a note\n\n```\nx = 1\n```\n\n---\n## Animations";
  assert.deepEqual(blocks(src), [
    { kind: "h", level: 1, text: "Battery" },
    { kind: "p", text: "A battery that runs down." },
    { kind: "ul", items: ["**Charge**: how full it is", "*Pop in*"] },
    { kind: "ol", items: ["one", "two"] },
    { kind: "quote", text: "a note" },
    { kind: "code", text: "x = 1" },
    { kind: "hr" },
    { kind: "h", level: 2, text: "Animations" },
  ]);
});

test("draws inline marks as elements and leaves out the title", () => {
  const tree = walk(Markdown({ text: "# Refraction\n\n**Top speed** and `v1`, see [docs](https://example.com/a)", dropTitle: true }));
  assert.deepEqual(tree.tags, ["div", "p", "strong", "code", "a"]);
  assert.deepEqual(tree.text, ["Top speed", " and ", "v1", ", see ", "docs"]);
});

test("markup in a README stays text", () => {
  const tree = walk(Markdown({ text: '<img src=x onerror="alert(1)"> and [x](javascript:alert(1))' }));
  assert.deepEqual(tree.tags, ["div", "p"]);
  assert.equal(tree.text.join(""), '<img src=x onerror="alert(1)"> and [x](javascript:alert(1))');
});
