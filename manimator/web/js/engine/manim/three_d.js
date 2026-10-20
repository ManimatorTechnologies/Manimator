// Ports of manim/mobject/three_d/three_dimensions.py (Surface, Sphere, Dot3D, Cube, Prism, Cone, Cylinder, Line3D,
// Arrow3D, Torus) and polyhedra.py (Polyhedron and the four regular solids).

import { ManimColor } from "../core/color.js";
import { add, cross, linspace, mul, norm, normalize, sub, zToVector } from "../core/math.js";
import { DEFAULT_DOT_RADIUS, IN, LEFT, ORIGIN, OUT, PI, RIGHT, TAU } from "./frozen.js";
import { Circle, Polygon, Square } from "./geometry.js";
import { Graph } from "./graph.js";
import { Mobject, WHITE, pt3 } from "./mobject.js";
import { VGroup, VMobject, VectorizedPoint } from "./vmobject.js";

export const BLUE_D = "#29ABCA";
export const BLUE_E = "#236B8E";
export const LIGHT_GREY = "#BBBBBB";
export const BLUE = "#58C4DD";
const Y_AXIS = [0, 1, 0];
const Z_AXIS = [0, 0, 1];

export class ThreeDVMobject extends VMobject {
  __init__({ shade_in_3d = true, ...kw } = {}) {
    return super.__init__({ ...kw, shade_in_3d });
  }
}

export class Surface extends VGroup {
  static SIG = ["func", "u_range", "v_range", "resolution", "surface_piece_config", "fill_color", "fill_opacity",
    "checkerboard_colors", "stroke_color", "stroke_width", "should_make_jagged", "pre_function_handle_to_anchor_scale_factor"];

  __init__({ func = null, u_range = [0, 1], v_range = [0, 1], resolution = 32, surface_piece_config = {},
    fill_color = BLUE_D, fill_opacity = 1.0, checkerboard_colors = [BLUE_D, BLUE_E], stroke_color = LIGHT_GREY,
    stroke_width = 0.5, should_make_jagged = false, pre_function_handle_to_anchor_scale_factor = 0.00001, ...kw } = {}) {
    this.u_range = u_range;
    this.v_range = v_range;
    super.__init__({ ...kw, fill_color, fill_opacity, stroke_color, stroke_width });
    this.resolution = resolution;
    this.surface_piece_config = surface_piece_config;
    this.checkerboard_colors = checkerboard_colors === false ? false : checkerboard_colors.map((c) => new ManimColor(c));
    this.should_make_jagged = should_make_jagged;
    this.pre_function_handle_to_anchor_scale_factor = pre_function_handle_to_anchor_scale_factor;
    this.list_of_faces = [];
    const fn = func ?? ((u, v) => this.func(u, v));
    this._func = fn;
    this._setup_in_uv_space();
    this.apply_function((p) => pt3(fn(p[0], p[1])));
    if (this.should_make_jagged) this.make_jagged();
    return this;
  }

  func(u, v) {
    return this._func(u, v);
  }

  _get_u_values_and_v_values() {
    const [uRes, vRes] = typeof this.resolution === "number" ? [this.resolution, this.resolution] : this.resolution;
    return [linspace(this.u_range[0], this.u_range[1], uRes + 1), linspace(this.v_range[0], this.v_range[1], vRes + 1)];
  }

  _setup_in_uv_space() {
    const [us, vs] = this._get_u_values_and_v_values();
    const faces = VGroup.make();
    this.list_of_faces = [];
    for (let i = 0; i + 1 < us.length; i += 1) {
      for (let j = 0; j + 1 < vs.length; j += 1) {
        const [u1, u2] = [us[i], us[i + 1]];
        const [v1, v2] = [vs[j], vs[j + 1]];
        const face = ThreeDVMobject.make();
        face.set_points_as_corners([[u1, v1, 0], [u2, v1, 0], [u2, v2, 0], [u1, v2, 0], [u1, v1, 0]]);
        faces.add(face);
        Object.assign(face, { u_index: i, v_index: j, u1, u2, v1, v2 });
        this.list_of_faces.push(face);
      }
    }
    faces.set_fill(this.fill_color, this.fill_opacity);
    faces.set_stroke(this.stroke_color, this.stroke_width, this.stroke_opacity);
    this.add(...faces.submobjects);
    if (this.checkerboard_colors) this.set_fill_by_checkerboard(...this.checkerboard_colors);
  }

  set_fill_by_checkerboard(...colors) {
    const n = colors.length;
    for (const face of this.list_of_faces) face.set_fill(colors[(face.u_index + face.v_index) % n], null);
    return this;
  }
}

export class Sphere extends Surface {
  static SIG = ["center", "radius", "resolution", "u_range", "v_range"];

  __init__({ center = ORIGIN, radius = 1, resolution = null, u_range = [0, TAU], v_range = [0, PI], ...kw } = {}) {
    this.radius = radius;
    super.__init__({ ...kw, func: null, resolution: resolution ?? [24, 12], u_range, v_range });
    this.shift(center);
    return this;
  }

  func(u, v) {
    return [Math.cos(u) * Math.sin(v), Math.sin(u) * Math.sin(v), -Math.cos(v)].map((x) => this.radius * x);
  }
}

export class Dot3D extends Sphere {
  static SIG = ["point", "radius", "color", "resolution"];

  __init__({ point = ORIGIN, radius = DEFAULT_DOT_RADIUS, color = WHITE, resolution = [8, 8], ...kw } = {}) {
    super.__init__({ ...kw, center: point, radius, resolution });
    this.set_color(color);
    return this;
  }
}

export class Cube extends VGroup {
  static SIG = ["side_length", "fill_opacity", "fill_color", "stroke_width"];

  __init__({ side_length = 2, fill_opacity = 0.75, fill_color = BLUE, stroke_width = 0, ...kw } = {}) {
    this.side_length = side_length;
    return super.__init__({ ...kw, fill_color, fill_opacity, stroke_width });
  }

  generate_points() {
    for (const vect of [IN, OUT, LEFT, RIGHT, [0, 1, 0], [0, -1, 0]]) {
      const face = Square.make({ side_length: this.side_length, shade_in_3d: true, joint_type: "bevel" });
      face.flip();
      face.shift(mul(OUT, this.side_length / 2.0));
      face.apply_matrix(zToVector(vect));
      this.add(face);
    }
    return this;
  }

  init_points() {
    return this.generate_points();
  }
}

export class Prism extends Cube {
  static SIG = ["dimensions"];

  __init__({ dimensions = [3, 2, 1], ...kw } = {}) {
    this.dimensions = dimensions;
    return super.__init__(kw);
  }

  generate_points() {
    super.generate_points();
    this.dimensions.forEach((value, dim) => this.rescale_to_fit(value, dim, true));
    return this;
  }
}

/** Cone and Cylinder turn their z axis toward `direction`. */
function rotateToDirection(mob) {
  const [x, y, z] = mob.direction;
  const r = Math.sqrt(x ** 2 + y ** 2 + z ** 2);
  const theta = r > 0 ? Math.acos(z / r) : 0;
  let phi;
  if (x === 0) {
    if (y === 0) phi = 0;
    else {
      phi = Math.atan(Infinity);
      if (y < 0) phi += PI;
    }
  } else {
    phi = Math.atan(y / x);
  }
  if (x < 0) phi += PI;
  mob.rotate(-mob._current_phi, Z_AXIS, { about_point: ORIGIN });
  mob.rotate(-mob._current_theta, Y_AXIS, { about_point: ORIGIN });
  mob.rotate(theta, Y_AXIS, { about_point: ORIGIN });
  mob.rotate(phi, Z_AXIS, { about_point: ORIGIN });
  mob._current_theta = theta;
  mob._current_phi = phi;
}

export class Cone extends Surface {
  static SIG = ["base_radius", "height", "direction", "show_base", "v_range", "u_min", "checkerboard_colors"];

  __init__({ base_radius = 1, height = 1, direction = Z_AXIS, show_base = false, v_range = [0, TAU], u_min = 0,
    checkerboard_colors = false, ...kw } = {}) {
    this.direction = pt3(direction);
    this.theta = PI - Math.atan(base_radius / height);
    super.__init__({ ...kw, func: null, v_range, u_range: [u_min, Math.sqrt(base_radius ** 2 + height ** 2)],
      checkerboard_colors });
    this.new_height = height;
    this._current_theta = 0;
    this._current_phi = 0;
    this.base_circle = Circle.make({ radius: base_radius, color: this.fill_color, fill_opacity: this.fill_opacity,
      stroke_width: 0 });
    this.base_circle.shift(mul(IN, height));
    this._set_start_and_end_attributes(this.direction);
    if (show_base) this.add(this.base_circle);
    rotateToDirection(this);
    return this;
  }

  func(u, v) {
    return [u * Math.sin(this.theta) * Math.cos(v), u * Math.sin(this.theta) * Math.sin(v), u * Math.cos(this.theta)];
  }

  get_start() {
    return this.start_point.get_center();
  }

  get_end() {
    return this.end_point.get_center();
  }

  set_direction(direction) {
    this.direction = pt3(direction);
    rotateToDirection(this);
    return this;
  }

  get_direction() {
    return this.direction;
  }

  _set_start_and_end_attributes(direction) {
    const scaled = mul(direction, norm(direction));
    const start = this.base_circle.get_center();
    const end = add(start, mul(scaled, this.new_height));
    this.start_point = VectorizedPoint.make({ location: start });
    this.end_point = VectorizedPoint.make({ location: end });
    this.add(this.start_point, this.end_point);
  }
}

export class Cylinder extends Surface {
  static SIG = ["radius", "height", "direction", "v_range", "show_ends", "resolution"];

  __init__({ radius = 1, height = 2, direction = Z_AXIS, v_range = [0, TAU], show_ends = true, resolution = [24, 24],
    ...kw } = {}) {
    this._height = height;
    this.radius = radius;
    super.__init__({ ...kw, func: null, resolution, u_range: [-this._height / 2, this._height / 2], v_range });
    if (show_ends) this.add_bases();
    this._current_phi = 0;
    this._current_theta = 0;
    this.set_direction(direction);
    return this;
  }

  func(u, v) {
    return [this.radius * Math.cos(v), this.radius * Math.sin(v), u];
  }

  add_bases() {
    const color = this.fill_color;
    const opacity = this.fill_opacity;
    this.base_top = Circle.make({ radius: this.radius, color, fill_opacity: opacity, shade_in_3d: true, stroke_width: 0 });
    this.base_top.shift(mul(IN, this.u_range[1]));
    this.base_bottom = Circle.make({ radius: this.radius, color, fill_opacity: opacity, shade_in_3d: true, stroke_width: 0 });
    this.base_bottom.shift(mul(IN, this.u_range[0]));
    this.add(this.base_top, this.base_bottom);
    return this;
  }

  set_direction(direction) {
    this.direction = pt3(direction);
    rotateToDirection(this);
    return this;
  }

  get_direction() {
    return this.direction;
  }
}

export class Line3D extends Cylinder {
  static SIG = ["start", "end", "thickness", "color", "resolution"];

  __init__({ start = LEFT, end = RIGHT, thickness = 0.02, color = null, resolution = 24, ...kw } = {}) {
    this.thickness = thickness;
    this.resolution = typeof resolution === "number" ? [2, resolution] : resolution;
    this.set_start_and_end_attrs(start instanceof Mobject ? start : pt3(start), end instanceof Mobject ? end : pt3(end), kw);
    if (color !== null) this.set_color(color);
    return this;
  }

  set_start_and_end_attrs(start, end, kw = {}) {
    const roughStart = this.pointify(start);
    const roughEnd = this.pointify(end);
    this.vect = sub(roughEnd, roughStart);
    this.length = norm(this.vect);
    this.direction = normalize(this.vect);
    this.start = this.pointify(start, this.direction);
    this.end = this.pointify(end, mul(this.direction, -1));
    super.__init__({ ...kw, height: norm(this.vect), radius: this.thickness, direction: this.direction,
      resolution: this.resolution });
    this.shift(mul(add(this.start, this.end), 0.5));
    return this;
  }

  pointify(mobOrPoint, direction = null) {
    if (mobOrPoint instanceof Mobject) {
      return direction === null ? mobOrPoint.get_center() : mobOrPoint.get_boundary_point(direction);
    }
    return pt3(mobOrPoint);
  }

  get_start() {
    return this.start;
  }

  get_end() {
    return this.end;
  }
}

export class Arrow3D extends Line3D {
  static SIG = ["start", "end", "thickness", "height", "base_radius", "color", "resolution"];

  __init__({ start = LEFT, end = RIGHT, thickness = 0.02, height = 0.3, base_radius = 0.08, color = WHITE,
    resolution = 24, ...kw } = {}) {
    super.__init__({ ...kw, start, end, thickness, color, resolution });
    this.length = norm(this.vect);
    this.set_start_and_end_attrs(this.start, sub(this.end, mul(this.direction, height)), kw);
    this.cone = Cone.make({ ...kw, direction: this.direction, base_radius, height });
    const npEnd = pt3(end);
    this.cone.shift(npEnd);
    this.end_point = VectorizedPoint.make({ location: npEnd });
    this.add(this.end_point, this.cone);
    this.set_color(color);
    return this;
  }

  get_end() {
    return this.end_point.get_center();
  }
}

export class Torus extends Surface {
  static SIG = ["major_radius", "minor_radius", "u_range", "v_range", "resolution"];

  __init__({ major_radius = 3, minor_radius = 1, u_range = [0, TAU], v_range = [0, TAU], resolution = null, ...kw } = {}) {
    this.R = major_radius;
    this.r = minor_radius;
    return super.__init__({ ...kw, func: null, u_range, v_range, resolution: resolution ?? [24, 24] });
  }

  func(u, v) {
    const P = [Math.cos(u), Math.sin(u), 0];
    const k = this.R - this.r * Math.cos(v);
    const s = this.r * Math.sin(v);
    return [k * P[0] - s * OUT[0], k * P[1] - s * OUT[1], k * P[2] - s * OUT[2]];
  }
}

// ------------------------------------------------------------------------------------------------ polyhedra.py

export class Polyhedron extends VGroup {
  static SIG = ["vertex_coords", "faces_list", "faces_config", "graph_config"];

  __init__({ vertex_coords, faces_list, faces_config = {}, graph_config = {} } = {}) {
    super.__init__();
    this.faces_config = { fill_opacity: 0.5, shade_in_3d: true, ...faces_config };
    this.graph_config = { vertex_type: Dot3D, edge_config: { stroke_opacity: 0 }, ...graph_config };
    this.vertex_coords = vertex_coords.map(pt3);
    this.vertex_indices = this.vertex_coords.map((_, i) => i);
    this.layout = Object.fromEntries(this.vertex_coords.map((p, i) => [i, p]));
    this.faces_list = faces_list;
    this.face_coords = faces_list.map((f) => f.map((j) => this.layout[j]));
    this.edges = this.get_edges(this.faces_list);
    this.faces = this.create_faces(this.face_coords);
    this.graph = Graph.make({ ...this.graph_config, vertices: this.vertex_indices, edges: this.edges, layout: this.layout });
    this.add(this.faces, this.graph);
    const self = this;
    this.add_updater((m) => self.update_faces(m));
    return this;
  }

  get_edges(faces) {
    return faces.flatMap((f) => f.map((v, i) => [v, f[(i + 1) % f.length]]));
  }

  create_faces(faceCoords) {
    return VGroup.make({ vmobjects: faceCoords.map((face) => Polygon.make({ ...this.faces_config, vertices: face })) });
  }

  update_faces() {
    this.faces.match_points(this.create_faces(this.extract_face_coords()));
    return this;
  }

  extract_face_coords() {
    const coords = [...this.graph.vertices.keys()].map((v) => this.graph.item(v).get_center());
    return this.faces_list.map((f) => f.map((j) => coords[j]));
  }
}

export class Tetrahedron extends Polyhedron {
  static SIG = ["edge_length"];

  __init__({ edge_length = 1, ...kw } = {}) {
    const u = (edge_length * Math.sqrt(2)) / 4;
    return super.__init__({ ...kw, vertex_coords: [[u, u, u], [u, -u, -u], [-u, u, -u], [-u, -u, u]],
      faces_list: [[0, 1, 2], [3, 0, 2], [0, 1, 3], [3, 1, 2]] });
  }
}

export class Octahedron extends Polyhedron {
  static SIG = ["edge_length"];

  __init__({ edge_length = 1, ...kw } = {}) {
    const u = (edge_length * Math.sqrt(2)) / 2;
    return super.__init__({ ...kw, vertex_coords: [[u, 0, 0], [-u, 0, 0], [0, u, 0], [0, -u, 0], [0, 0, u], [0, 0, -u]],
      faces_list: [[2, 4, 1], [0, 4, 2], [4, 3, 0], [1, 3, 4], [3, 5, 0], [1, 5, 3], [2, 5, 1], [0, 5, 2]] });
  }
}

export class Icosahedron extends Polyhedron {
  static SIG = ["edge_length"];

  __init__({ edge_length = 1, ...kw } = {}) {
    const a = edge_length * ((1 + Math.sqrt(5)) / 4);
    const b = edge_length * (1 / 2);
    return super.__init__({ ...kw,
      vertex_coords: [[0, b, a], [0, -b, a], [0, b, -a], [0, -b, -a], [b, a, 0], [b, -a, 0], [-b, a, 0], [-b, -a, 0],
        [a, 0, b], [a, 0, -b], [-a, 0, b], [-a, 0, -b]],
      faces_list: [[1, 8, 0], [1, 5, 7], [8, 5, 1], [7, 3, 5], [5, 9, 3], [8, 9, 5], [3, 2, 9], [9, 4, 2], [8, 4, 9],
        [0, 4, 8], [6, 4, 0], [6, 2, 4], [11, 2, 6], [3, 11, 2], [0, 6, 10], [10, 1, 0], [10, 7, 1], [11, 7, 3],
        [10, 11, 7], [10, 11, 6]] });
  }
}

export class Dodecahedron extends Polyhedron {
  static SIG = ["edge_length"];

  __init__({ edge_length = 1, ...kw } = {}) {
    const a = edge_length * ((1 + Math.sqrt(5)) / 4);
    const b = edge_length * ((3 + Math.sqrt(5)) / 4);
    const c = edge_length * (1 / 2);
    return super.__init__({ ...kw,
      vertex_coords: [[a, a, a], [a, a, -a], [a, -a, a], [a, -a, -a], [-a, a, a], [-a, a, -a], [-a, -a, a], [-a, -a, -a],
        [0, c, b], [0, c, -b], [0, -c, -b], [0, -c, b], [c, b, 0], [-c, b, 0], [c, -b, 0], [-c, -b, 0], [b, 0, c],
        [-b, 0, c], [b, 0, -c], [-b, 0, -c]],
      faces_list: [[18, 16, 0, 12, 1], [3, 18, 16, 2, 14], [3, 10, 9, 1, 18], [1, 9, 5, 13, 12], [0, 8, 4, 13, 12],
        [2, 16, 0, 8, 11], [4, 17, 6, 11, 8], [17, 19, 5, 13, 4], [19, 7, 15, 6, 17], [6, 15, 14, 2, 11],
        [19, 5, 9, 10, 7], [7, 10, 3, 14, 15]] });
  }
}

export { cross };
