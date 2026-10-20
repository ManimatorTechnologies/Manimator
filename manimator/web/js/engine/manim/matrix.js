// Ports of manim/mobject/matrix.py and manim/mobject/table.py.

import { ManimColor } from "../core/color.js";
import { DOWN, DR, LEFT, MED_SMALL_BUFF, RIGHT, UP } from "./frozen.js";
import { BackgroundRectangle, Line, PURE_YELLOW as PURE_YELLOW_HEX, Polygon } from "./geometry.js";
import { Mobject } from "./mobject.js";
import { DecimalNumber, Integer } from "./numbers.js";
import { pyKwargs } from "./pycall.js";
import { MathTex, Tex } from "./tex.js";
import { Paragraph } from "./text.js";
import { BLACK, VGroup, VMobject } from "./vmobject.js";

/** element_to_mobject(item, **config): a class is called the Python way, a function as fn(item, config). */
export function callElement(maker, item, config = {}) {
  if (typeof maker === "function" && maker.prototype instanceof Mobject) return maker.make(pyKwargs(maker, [item], config));
  return maker(item, config);
}

const chain = (rows) => rows.flat();

export class Matrix extends VMobject {
  static SIG = ["matrix", "v_buff", "h_buff", "bracket_h_buff", "bracket_v_buff", "add_background_rectangles_to_entries",
    "include_background_rectangle", "element_to_mobject", "element_to_mobject_config", "element_alignment_corner",
    "left_bracket", "right_bracket", "stretch_brackets", "bracket_config"];

  __init__({ matrix, v_buff = 0.8, h_buff = 1.3, bracket_h_buff = MED_SMALL_BUFF, bracket_v_buff = MED_SMALL_BUFF,
    add_background_rectangles_to_entries = false, include_background_rectangle = false, element_to_mobject = MathTex,
    element_to_mobject_config = {}, element_alignment_corner = DR, left_bracket = "[", right_bracket = "]",
    stretch_brackets = true, bracket_config = {}, ...kw } = {}) {
    this.v_buff = v_buff;
    this.h_buff = h_buff;
    this.bracket_h_buff = bracket_h_buff;
    this.bracket_v_buff = bracket_v_buff;
    this.add_background_rectangles_to_entries = add_background_rectangles_to_entries;
    this.include_background_rectangle = include_background_rectangle;
    this.element_to_mobject = element_to_mobject;
    this.element_to_mobject_config = element_to_mobject_config;
    this.element_alignment_corner = element_alignment_corner;
    this.left_bracket = left_bracket;
    this.right_bracket = right_bracket;
    this.stretch_brackets = stretch_brackets;
    super.__init__(kw);
    const mobMatrix = this._matrix_to_mob_matrix(matrix);
    this._organize_mob_matrix(mobMatrix);
    this.elements = VGroup.make({ vmobjects: chain(mobMatrix) });
    this.add(this.elements);
    this._add_brackets(this.left_bracket, this.right_bracket, bracket_config);
    this.center();
    this.mob_matrix = mobMatrix;
    if (this.add_background_rectangles_to_entries) for (const mob of this.elements.iter()) mob.add_background_rectangle();
    if (this.include_background_rectangle) this.add_background_rectangle();
    return this;
  }

  _matrix_to_mob_matrix(matrix) {
    return matrix.map((row) => (Array.isArray(row) ? row : [row])
      .map((item) => callElement(this.element_to_mobject, item, this.element_to_mobject_config)));
  }

  _organize_mob_matrix(matrix) {
    matrix.forEach((row, i) => row.forEach((mob, j) => {
      mob.move_to([j * this.h_buff, -i * this.v_buff, 0], this.element_alignment_corner);
    }));
    return this;
  }

  _add_brackets(left = "[", right = "]", kw = {}) {
    const BRACKET_HEIGHT = 0.5977;
    const n = Math.trunc(this.height / BRACKET_HEIGHT) + 1;
    const empty = `\\begin{array}{c}${"\\quad \\\\".repeat(n)}\\end{array}`;
    const lBracket = MathTex.make({ ...kw, tex_strings: [`\\left${left}${empty}\\right.`] });
    const rBracket = MathTex.make({ ...kw, tex_strings: [`\\left.${empty}\\right${right}`] });
    const pair = VGroup.make({ vmobjects: [lBracket, rBracket] });
    if (this.stretch_brackets) pair.stretch_to_fit_height(this.height + 2 * this.bracket_v_buff);
    lBracket.next_to(this, LEFT, this.bracket_h_buff);
    rBracket.next_to(this, RIGHT, this.bracket_h_buff);
    this.brackets = pair;
    this.add(lBracket, rBracket);
    return this;
  }

  get_columns() {
    return VGroup.make({ vmobjects: this.mob_matrix[0].map((_, i) => VGroup.make({ vmobjects: this.mob_matrix.map((r) => r[i]) })) });
  }

  set_column_colors(...colors) {
    this.get_columns().submobjects.forEach((c, i) => { if (i < colors.length) c.set_color(colors[i]); });
    return this;
  }

  get_rows() {
    return VGroup.make({ vmobjects: this.mob_matrix.map((r) => VGroup.make({ vmobjects: r })) });
  }

  set_row_colors(...colors) {
    this.get_rows().submobjects.forEach((r, i) => { if (i < colors.length) r.set_color(colors[i]); });
    return this;
  }

  add_background_to_entries() {
    for (const mob of this.get_entries().iter()) mob.add_background_rectangle();
    return this;
  }

  get_mob_matrix() {
    return this.mob_matrix;
  }

  get_entries() {
    return this.elements;
  }

  get_brackets() {
    return this.brackets;
  }
}

export class DecimalMatrix extends Matrix {
  static SIG = ["matrix", "element_to_mobject", "element_to_mobject_config"];

  __init__({ element_to_mobject = DecimalNumber, element_to_mobject_config = { num_decimal_places: 1 }, ...kw } = {}) {
    return super.__init__({ ...kw, element_to_mobject, element_to_mobject_config });
  }
}

export class IntegerMatrix extends Matrix {
  static SIG = ["matrix", "element_to_mobject"];

  __init__({ element_to_mobject = Integer, ...kw } = {}) {
    return super.__init__({ ...kw, element_to_mobject });
  }
}

export class MobjectMatrix extends Matrix {
  static SIG = ["matrix", "element_to_mobject"];

  __init__({ element_to_mobject = (m) => m, ...kw } = {}) {
    return super.__init__({ ...kw, element_to_mobject });
  }
}

// ------------------------------------------------------------------------------------------------ table.py

export class Table extends VGroup {
  static SIG = ["table", "row_labels", "col_labels", "top_left_entry", "v_buff", "h_buff", "include_outer_lines",
    "include_inner_lines", "add_background_rectangles_to_entries", "entries_background_color",
    "include_background_rectangle", "background_rectangle_color", "element_to_mobject", "element_to_mobject_config",
    "arrange_in_grid_config", "line_config"];

  __init__({ table, row_labels = null, col_labels = null, top_left_entry = null, v_buff = 0.8, h_buff = 1.3,
    include_outer_lines = false, include_inner_lines = true, add_background_rectangles_to_entries = false,
    entries_background_color = BLACK, include_background_rectangle = false, background_rectangle_color = BLACK,
    element_to_mobject = Paragraph, element_to_mobject_config = {}, arrange_in_grid_config = {}, line_config = {},
    ...kw } = {}) {
    const tableData = table.map((row) => [...row]);
    const rowLabelData = row_labels ? [...row_labels] : [];
    const colLabelData = col_labels ? [...col_labels] : [];
    this.row_labels = rowLabelData.length ? rowLabelData : null;
    this.col_labels = colLabelData.length ? colLabelData : null;
    this.top_left_entry = top_left_entry;
    this.row_dim = tableData.length;
    this.col_dim = tableData[0].length;
    this.v_buff = v_buff;
    this.h_buff = h_buff;
    this.include_outer_lines = include_outer_lines;
    this.include_inner_lines = include_inner_lines;
    this.add_background_rectangles_to_entries = add_background_rectangles_to_entries;
    this.entries_background_color = new ManimColor(entries_background_color);
    this.include_background_rectangle = include_background_rectangle;
    this.background_rectangle_color = new ManimColor(background_rectangle_color);
    this.element_to_mobject = element_to_mobject;
    this.element_to_mobject_config = element_to_mobject_config;
    this.arrange_in_grid_config = arrange_in_grid_config;
    this.line_config = line_config;
    for (const row of tableData) {
      if (row.length !== tableData[0].length) throw new Error("Not all rows in table have the same length.");
    }
    super.__init__(kw);
    let mobTable = this._table_to_mob_table(tableData);
    this.elements_without_labels = VGroup.make({ vmobjects: chain(mobTable) });
    mobTable = this._add_labels(mobTable);
    this._organize_mob_table(mobTable);
    this.elements = VGroup.make({ vmobjects: chain(mobTable) });
    if (this.elements.get(0).get_all_points().length === 0) this.elements.remove(this.elements.get(0));
    this.add(this.elements);
    this.center();
    this.mob_table = mobTable;
    this._add_horizontal_lines();
    this._add_vertical_lines();
    if (this.add_background_rectangles_to_entries) this.add_background_to_entries(this.entries_background_color);
    if (this.include_background_rectangle) this.add_background_rectangle({ color: this.background_rectangle_color });
    return this;
  }

  _table_to_mob_table(table) {
    return table.map((row) => row.map((item) => callElement(this.element_to_mobject, item, this.element_to_mobject_config)));
  }

  _organize_mob_table(table) {
    const help = VGroup.make();
    for (const row of table) for (const mob of row) help.add(mob);
    help.arrange_in_grid({ rows: table.length, cols: table[0].length, buff: [this.h_buff, this.v_buff],
      ...this.arrange_in_grid_config });
    return help;
  }

  _add_labels(mobTable) {
    if (this.row_labels !== null) {
      for (let k = 0; k < this.row_labels.length; k += 1) mobTable[k] = [this.row_labels[k], ...mobTable[k]];
    }
    if (this.col_labels !== null) {
      if (this.row_labels !== null) {
        const first = this.top_left_entry ?? VMobject.make();
        mobTable.splice(0, 0, [first, ...this.col_labels]);
      } else {
        mobTable.splice(0, 0, this.col_labels);
      }
    }
    return mobTable;
  }

  _add_horizontal_lines() {
    const anchorLeft = this.get_left()[0] - 0.5 * this.h_buff;
    const anchorRight = this.get_right()[0] + 0.5 * this.h_buff;
    const group = VGroup.make();
    const line = (y) => Line.make({ ...this.line_config, start: [anchorLeft, y, 0], end: [anchorRight, y, 0] });
    const rows = this.get_rows().submobjects;
    if (this.include_outer_lines) {
      for (const y of [rows[0].get_top()[1] + 0.5 * this.v_buff, rows[rows.length - 1].get_bottom()[1] - 0.5 * this.v_buff]) {
        const l = line(y);
        group.add(l);
        this.add(l);
      }
    }
    if (this.include_inner_lines) {
      for (let k = 0; k < this.mob_table.length - 1; k += 1) {
        const r = this.get_rows().submobjects;
        const y = r[k + 1].get_top()[1] + 0.5 * (r[k].get_bottom()[1] - r[k + 1].get_top()[1]);
        const l = line(y);
        group.add(l);
        this.add(l);
      }
    }
    this.horizontal_lines = group;
    return this;
  }

  _add_vertical_lines() {
    const rowsGroup = this.get_rows();
    const anchorTop = rowsGroup.get_top()[1] + 0.5 * this.v_buff;
    const anchorBottom = rowsGroup.get_bottom()[1] - 0.5 * this.v_buff;
    const group = VGroup.make();
    if (this.include_outer_lines) {
      const cols = this.get_columns().submobjects;
      for (const x of [cols[0].get_left()[0] - 0.5 * this.h_buff, cols[cols.length - 1].get_right()[0] + 0.5 * this.h_buff]) {
        const l = Line.make({ ...this.line_config, start: [x, anchorTop, 0], end: [x, anchorBottom, 0] });
        group.add(l);
        this.add(l);
      }
    }
    if (this.include_inner_lines) {
      for (let k = 0; k < this.mob_table[0].length - 1; k += 1) {
        const c = this.get_columns().submobjects;
        const x = c[k + 1].get_left()[0] + 0.5 * (c[k].get_right()[0] - c[k + 1].get_left()[0]);
        const l = Line.make({ ...this.line_config, start: [x, anchorBottom, 0], end: [x, anchorTop, 0] });
        group.add(l);
        this.add(l);
      }
    }
    this.vertical_lines = group;
    return this;
  }

  get_horizontal_lines() {
    return this.horizontal_lines;
  }

  get_vertical_lines() {
    return this.vertical_lines;
  }

  get_columns() {
    return VGroup.make({ vmobjects: this.mob_table[0].map((_, i) => VGroup.make({ vmobjects: this.mob_table.map((r) => r[i]) })) });
  }

  get_rows() {
    return VGroup.make({ vmobjects: this.mob_table.map((r) => VGroup.make({ vmobjects: r })) });
  }

  set_column_colors(...colors) {
    this.get_columns().submobjects.forEach((c, i) => { if (i < colors.length) c.set_color(colors[i]); });
    return this;
  }

  set_row_colors(...colors) {
    this.get_rows().submobjects.forEach((r, i) => { if (i < colors.length) r.set_color(colors[i]); });
    return this;
  }

  get_entries(pos = null) {
    if (pos === null) return this.elements;
    const offset = this.row_labels !== null && this.col_labels !== null && this.top_left_entry === null ? 2 : 1;
    return this.elements.get(this.mob_table[0].length * (pos[0] - 1) + pos[1] - offset);
  }

  get_entries_without_labels(pos = null) {
    if (pos === null) return this.elements_without_labels;
    return this.elements_without_labels.get(this.col_dim * (pos[0] - 1) + pos[1] - 1);
  }

  get_row_labels() {
    return VGroup.make({ vmobjects: this.row_labels ?? [] });
  }

  get_col_labels() {
    return VGroup.make({ vmobjects: this.col_labels ?? [] });
  }

  get_labels() {
    const group = VGroup.make();
    if (this.top_left_entry !== null) group.add(this.top_left_entry);
    for (const labels of [this.col_labels, this.row_labels]) if (labels !== null) group.add(...labels);
    return group;
  }

  add_background_to_entries(color = BLACK) {
    for (const mob of this.get_entries().iter()) mob.add_background_rectangle({ color: new ManimColor(color) });
    return this;
  }

  get_cell(pos = [1, 1], kw = {}) {
    const row = this.get_rows().get(pos[0] - 1);
    const col = this.get_columns().get(pos[1] - 1);
    const x0 = col.get_left()[0] - this.h_buff / 2;
    const x1 = col.get_right()[0] + this.h_buff / 2;
    const y0 = row.get_top()[1] + this.v_buff / 2;
    const y1 = row.get_bottom()[1] - this.v_buff / 2;
    return Polygon.make({ ...kw, vertices: [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]] });
  }

  get_highlighted_cell(pos = [1, 1], color = PURE_YELLOW_HEX, kw = {}) {
    return BackgroundRectangle.make({ ...kw, mobjects: [this.get_cell(pos)], color: new ManimColor(color) });
  }

  add_highlighted_cell(pos = [1, 1], color = PURE_YELLOW_HEX, kw = {}) {
    const cell = this.get_highlighted_cell(pos, color, kw);
    this.add_to_back(cell);
    this.get_entries(pos).background_rectangle = cell;
    return this;
  }

  scale(scale_factor, { scale_stroke = false, ...kw } = {}) {
    this.h_buff *= scale_factor;
    this.v_buff *= scale_factor;
    super.scale(scale_factor, { ...kw, scale_stroke });
    return this;
  }
}

export class MathTable extends Table {
  static SIG = ["table", "element_to_mobject"];

  __init__({ element_to_mobject = MathTex, ...kw } = {}) {
    return super.__init__({ ...kw, element_to_mobject });
  }
}

export class MobjectTable extends Table {
  static SIG = ["table", "element_to_mobject"];

  __init__({ element_to_mobject = (m) => m, ...kw } = {}) {
    return super.__init__({ ...kw, element_to_mobject });
  }
}

export class IntegerTable extends Table {
  static SIG = ["table", "element_to_mobject"];

  __init__({ element_to_mobject = Integer, ...kw } = {}) {
    return super.__init__({ ...kw, element_to_mobject });
  }
}

export class DecimalTable extends Table {
  static SIG = ["table", "element_to_mobject", "element_to_mobject_config"];

  __init__({ element_to_mobject = DecimalNumber, element_to_mobject_config = { num_decimal_places: 1 }, ...kw } = {}) {
    return super.__init__({ ...kw, element_to_mobject, element_to_mobject_config });
  }
}

export { DOWN, RIGHT, Tex, UP };
