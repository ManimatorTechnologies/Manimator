// Calling the ports' methods the way Python code does: obj.name(*args, **kwargs).
//
// Each entry is the Python parameter list. Names before "|" are the port's positional parameters; names after it
// travel in one trailing object (the port's keyword arguments). "*name" collects the remaining positional arguments
// and is spread. A missing parameter is passed as undefined, so the port's default applies. "**" passes the keyword
// arguments as the one argument (Mobject.set(**kwargs)).

const SPECS = {
  // positioning
  shift: "*vectors",
  move_to: "point_or_mobject, aligned_edge, coor_mask",
  next_to: "mobject_or_point, direction, buff | aligned_edge, submobject_to_align, index_of_submobject_to_align, coor_mask",
  to_edge: "edge, buff",
  to_corner: "corner, buff",
  align_to: "mobject_or_point, direction",
  align_on_border: "direction, buff",
  center: "",
  set_x: "x, direction",
  set_y: "y, direction",
  set_z: "z, direction",
  set_coord: "value, dim, direction",
  put_start_and_end_on: "start, end",
  arrange: "direction, buff, center | aligned_edge, submobject_to_align, index_of_submobject_to_align, coor_mask",
  arrange_in_grid: "| rows, cols, buff, cell_alignment, row_alignments, col_alignments, row_heights, col_widths, flow_order",
  replace: "mobject, dim_to_match, stretch",
  surround: "mobject, dim_to_match, stretch, buff",
  match_x: "mobject, direction",
  match_y: "mobject, direction",
  match_width: "mobject | about_point, about_edge",
  match_height: "mobject | about_point, about_edge",
  // transforming
  scale: "scale_factor | about_point, about_edge, scale_stroke, scale_tips",
  rotate: "angle, axis | about_point, about_edge",
  rotate_about_origin: "angle, axis",
  flip: "axis | about_point, about_edge",
  stretch: "factor, dim | about_point, about_edge",
  apply_function: "function | about_point, about_edge",
  apply_matrix: "matrix | about_point, about_edge",
  scale_to_fit_width: "width | about_point, about_edge",
  scale_to_fit_height: "height | about_point, about_edge",
  stretch_to_fit_width: "width | about_point, about_edge",
  stretch_to_fit_height: "height | about_point, about_edge",
  set_length: "length",
  set_angle: "angle, about_point",
  // style
  set_color: "color, family",
  set_fill: "color, opacity, family",
  set_stroke: "color, width, opacity, background, family",
  set_background_stroke: "| color, width, opacity, family",
  set_opacity: "opacity, family",
  set_sheen: "factor, direction, family",
  set_sheen_direction: "direction, family",
  set_style: "| fill_color, fill_opacity, stroke_color, stroke_width, stroke_opacity, background_stroke_color, "
    + "background_stroke_width, background_stroke_opacity, sheen_factor, sheen_direction, family",
  set_color_by_gradient: "*colors",
  set_z_index: "z_index_value, family",
  fade: "darkness, family",
  match_style: "vmobject, family",
  round_corners: "radius, evenly_distribute_anchors, components_per_rounded_corner",
  // structure
  add: "*mobjects",
  remove: "*mobjects",
  add_to_back: "*mobjects",
  add_tip: "| tip, tip_shape, tip_length, tip_width, at_start",
  make_smooth: "",
  make_jagged: "",
  reverse_points: "",
  reverse_direction: "",
  set_points_as_corners: "points",
  set_points_smoothly: "points",
  insert_n_curves: "n",
  set: "**",
  save_state: "",
  restore: "",
  generate_target: "",
  // value trackers
  set_value: "value",
  increment_value: "d_value",
  // cameras (self.camera.<method>)
  auto_zoom: "mobjects, margin, only_mobjects_in_frame, animate",
  add_fixed_in_frame_mobjects: "*mobjects",
  remove_fixed_in_frame_mobjects: "*mobjects",
  add_fixed_orientation_mobjects: "*mobjects | use_static_center_func, center_func",
  remove_fixed_orientation_mobjects: "*mobjects",
};

const parsed = new Map();

function spec(name) {
  if (!parsed.has(name)) {
    const text = SPECS[name];
    if (text === undefined) return null;
    const [pos, kw = ""] = text.split("|");
    const names = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
    parsed.set(name, { pos: names(pos), kw: names(kw), hasKw: text.includes("|") });
  }
  return parsed.get(name);
}

/** obj.name(*args, **kwargs) */
export function callMethod(obj, name, args = [], kwargs = {}) {
  const fn = obj[name];
  if (typeof fn !== "function") throw new TypeError(`${obj.constructor.name} has no method ${name}`);
  const s = spec(name);
  if (SPECS[name] === "**") {
    if (args.length) throw new TypeError(`${name}() takes keyword arguments only`);
    return fn.call(obj, kwargs);
  }
  if (s === null) {
    if (Object.keys(kwargs).length) throw new TypeError(`${name}(): keyword arguments aren't supported yet`);
    return fn.apply(obj, args);
  }
  const out = [];
  let i = 0;
  for (const p of s.pos) {
    if (p.startsWith("*")) {
      out.push(...args.slice(i));
      i = args.length;
      continue;
    }
    out.push(i < args.length ? args[i] : kwargs[p]);
    i += 1;
  }
  if (s.hasKw) {
    const kw = {};
    for (const p of s.kw) {
      if (i < args.length) kw[p] = args[i];
      else if (p in kwargs) kw[p] = kwargs[p];
      i += 1;
    }
    out.push(kw);
  }
  const known = new Set([...s.pos, ...s.kw]);
  for (const k of Object.keys(kwargs)) {
    if (!known.has(k)) throw new TypeError(`${name}() got an unexpected keyword argument '${k}'`);
  }
  if (i < args.length) throw new TypeError(`${name}() got too many positional arguments`);
  return fn.apply(obj, out);
}
