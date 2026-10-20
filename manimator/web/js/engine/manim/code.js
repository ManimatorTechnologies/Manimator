// A port of manim/mobject/text/code_mobject.py. Manim colours the listing with Pygments; the server works the
// colours out the same way (manimator/CodeHighlight.py) and the scene plan hands them over as `highlight`:
// {lines, spans: [[line, start, end, "#RRGGBB"]], foreground, line_number_color, background}.

import { DOWN, LEFT, RIGHT, UP } from "./frozen.js";
import { Dot, SurroundingRectangle } from "./geometry.js";
import { Paragraph } from "./text.js";
import { VGroup, VMobject } from "./vmobject.js";

const WHITE = "#FFFFFF";

export class Code extends VMobject {
  static SIG = ["code_file", "code_string", "language", "formatter_style", "tab_width", "add_line_numbers",
    "line_numbers_from", "background", "background_config", "paragraph_config"];

  static default_background_config = { buff: 0.3, fill_color: null, stroke_color: WHITE, corner_radius: 0.2,
    stroke_width: 1, fill_opacity: 1 };

  static default_paragraph_config = { font: "Monospace", font_size: 24, line_spacing: 0.5, disable_ligatures: true };

  __init__({ code_file = null, code_string = null, language = null, formatter_style = "vim", tab_width = 4,
    add_line_numbers = true, line_numbers_from = 1, background = "rectangle", background_config = null,
    paragraph_config = null, highlight = null } = {}) {
    super.__init__();
    void language;
    void formatter_style;
    if (code_file === null && code_string === null) throw new Error("Either a code file or a code string must be specified.");
    const hl = highlight ?? { lines: expandTabs(String(code_string ?? ""), tab_width).replace(/\n$/, "").split("\n"),
      spans: [], foreground: "#000000", line_number_color: "#000000", background: "#FFFFFF" };
    const base = { ...Code.default_paragraph_config, ...(paragraph_config ?? {}) };
    delete base.color;
    const foreground = hl.foreground;
    const codeLines = hl.lines;
    const rendered = codeLines.some((l) => l.trim()) ? codeLines : codeLines.map(() => "");
    const suffix = ` pA${line_numbers_from}`;
    const reference = Paragraph.make({ ...base, text: [suffix] });
    const alignmentLength = reference.get(0).__len__();
    const boundary = [...new Set([0, rendered.length - 1])].sort((a, b) => a - b);
    const aligned = [...rendered];
    for (const i of boundary) aligned[i] += suffix;
    this.code_lines = Paragraph.make({ ...base, text: aligned, color: foreground });
    for (const [line, start, end, color] of hl.spans) {
      if (line < this.code_lines.__len__()) this.code_lines.get(line).slice(start, end).set_color(color);
    }
    if (add_line_numbers) {
      const numbers = Array.from({ length: this.code_lines.__len__() }, (_, i) => String(line_numbers_from + i));
      this.line_numbers = Paragraph.make({ ...base, alignment: "right", text: numbers, color: hl.line_number_color });
      this.line_numbers.next_to(this.code_lines, LEFT);
      const firstLine = this.code_lines.get(0).submobjects;
      const reference0 = VGroup.make({ vmobjects: firstLine.slice(-String(line_numbers_from).length) });
      this.line_numbers.shift(UP.map((v) => v * (reference0.get_y() - this.line_numbers.get(0).get_y())));
      this.add(this.line_numbers);
    }
    const popped = [];
    for (const i of boundary) for (let k = 0; k < alignmentLength; k += 1) popped.push(this.code_lines.get(i).submobjects.pop());
    const alignmentMobjects = VGroup.make({ vmobjects: popped }).stretch_to_fit_width(0, { about_edge: LEFT });
    for (const line of this.code_lines.iter()) line.submobjects = line.submobjects.filter((c) => !(c instanceof Dot));
    this.add(this.code_lines);
    const cfg = { ...Code.default_background_config, ...(background_config ?? {}) };
    if (cfg.fill_color === null) cfg.fill_color = hl.background;
    if (background === "rectangle") {
      this.background = SurroundingRectangle.make({ ...cfg, mobjects: [this, alignmentMobjects] });
    } else if (background === "window") {
      const buttons = VGroup.make({ vmobjects: ["#ff5f56", "#ffbd2e", "#27c93f"].map((color) =>
        Dot.make({ radius: 0.1, stroke_width: 0, color })) }).arrange(RIGHT, 0.1);
      const codeAndAlignment = VGroup.make({ vmobjects: [this, alignmentMobjects] });
      buttons.next_to(codeAndAlignment, UP, 0.1).align_to(codeAndAlignment, LEFT).shift([-0.1, 0, 0]);
      this.background = SurroundingRectangle.make({ ...cfg, mobjects: [codeAndAlignment, buttons] });
      buttons.shift([-0.1, 0.1, 0]);
      this.background.add(buttons);
    } else {
      throw new Error(`Unknown background type: ${background}`);
    }
    this.add_to_back(this.background);
    return this;
  }
}

/** str.expandtabs(tabsize) */
function expandTabs(s, tab) {
  let out = "";
  let col = 0;
  for (const ch of s) {
    if (ch === "\t") {
      const n = tab - (col % tab);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col = ch === "\n" || ch === "\r" ? 0 : col + 1;
    }
  }
  return out;
}

export { DOWN };
