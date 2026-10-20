// Ports of manim/mobject/graph.py: GenericGraph, Graph and DiGraph (vertex placement from core/layouts.js).

import { graphLayout } from "../core/layouts.js";
import { pt3 } from "./mobject.js";
import { Dot, LabeledDot, Line } from "./geometry.js";
import { MathTex } from "./tex.js";
import { BLACK, VMobject } from "./vmobject.js";

const key = (e) => `${e[0]}\u0000${e[1]}`;

export class GenericGraph extends VMobject {
  static SIG = ["vertices", "edges", "labels", "label_fill_color", "layout", "layout_scale", "layout_config",
    "vertex_type", "vertex_config", "vertex_mobjects", "edge_type", "partitions", "root_vertex", "edge_config"];

  static directed = false;

  __init__({ vertices, edges, labels = false, label_fill_color = BLACK, layout = "spring", layout_scale = 2,
    layout_config = null, vertex_type = Dot, vertex_config = null, vertex_mobjects = null, edge_type = Line,
    partitions = null, root_vertex = null, edge_config = null } = {}) {
    super.__init__();
    this._nodes = [...vertices];
    this._edge_list = edges.map((e) => [e[0], e[1]]);
    if (labels !== null && typeof labels === "object" && !Array.isArray(labels)) this._labels = { ...labels };
    else if (labels) {
      this._labels = Object.fromEntries(vertices.map((v) => [v, MathTex.make({ tex_strings: [String(v)], color: label_fill_color })]));
    } else this._labels = {};
    let vType = vertex_type;
    if (Object.keys(this._labels).length && vType === Dot) vType = LabeledDot;
    const vConfig = vertex_config ?? {};
    const defaultVertexConfig = Object.fromEntries(Object.entries(vConfig).filter(([k]) => !vertices.map(String).includes(k)));
    this._vertex_config = Object.fromEntries(vertices.map((v) => [v, { ...(vConfig[v] ?? defaultVertexConfig) }]));
    this.default_vertex_config = defaultVertexConfig;
    for (const [v, label] of Object.entries(this._labels)) this._vertex_config[v].label = label;
    this.vertices = new Map(vertices.map((v) => [v, vType.make({ ...this._vertex_config[v] })]));
    for (const [v, mob] of Object.entries(vertex_mobjects ?? {})) this.vertices.set(v, mob);
    this.change_layout(layout, layout_scale, layout_config, partitions, root_vertex);
    const eConfig = { ...(edge_config ?? {}) };
    const defaultTipConfig = eConfig.tip_config ?? {};
    delete eConfig.tip_config;
    const defaultEdgeConfig = Object.fromEntries(Object.entries(eConfig).filter(([k]) => !k.includes("\u0000")));
    this._edge_config = new Map();
    this._tip_config = new Map();
    for (const e of this._edge_list) {
      const specific = eConfig[key(e)];
      if (specific) {
        const { tip_config: tc, ...rest } = specific;
        this._tip_config.set(key(e), tc ?? { ...defaultTipConfig });
        this._edge_config.set(key(e), rest);
      } else {
        this._tip_config.set(key(e), { ...defaultTipConfig });
        this._edge_config.set(key(e), { ...defaultEdgeConfig });
      }
    }
    this.default_edge_config = defaultEdgeConfig;
    this._populate_edge_dict(this._edge_list, edge_type);
    this.add(...this.vertices.values());
    this.add(...this.edges.values());
    const self = this;
    this.add_updater((graph) => self.update_edges(graph));
    return this;
  }

  /** graph[v] or graph[(u, v)] */
  item(k) {
    if (Array.isArray(k)) {
      const e = this.edges.get(key(k));
      if (e) return e;
    } else if (this.vertices.has(k)) return this.vertices.get(k);
    throw new Error(`Could not find ${k} in vertices or edges`);
  }

  change_layout(layout = "spring", layout_scale = 2, layout_config = null, partitions = null, root_vertex = null) {
    const cfg = { ...(layout_config ?? {}) };
    if (partitions !== null && !("partitions" in cfg)) cfg.partitions = partitions;
    if (root_vertex !== null && !("root_vertex" in cfg)) cfg.root_vertex = root_vertex;
    let positions;
    if (layout !== null && typeof layout === "object" && !Array.isArray(layout)) {
      positions = this._nodes.map((v) => pt3(layout[v]));
    } else {
      positions = graphLayout(layout, this._nodes, this._edge_list, this.constructor.directed, layout_scale, cfg);
    }
    this._layout = new Map(this._nodes.map((v, i) => [v, positions[i]]));
    for (const v of this.vertices.keys()) this.item(v).move_to(this._layout.get(v));
    return this;
  }
}

export class Graph extends GenericGraph {
  static directed = false;

  _populate_edge_dict(edges, edgeType) {
    this.edges = new Map(edges.map(([u, v]) => [key([u, v]), edgeType.make({ ...this._edge_config.get(key([u, v])),
      start: this.item(u).get_center(), end: this.item(v).get_center(), z_index: -1 })]));
    this._edge_ends = new Map(edges.map((e) => [key(e), e]));
  }

  update_edges(graph) {
    for (const [k, edge] of graph.edges) {
      const [u, v] = graph._edge_ends.get(k);
      edge.set_points_by_ends(graph.item(u).get_center(), graph.item(v).get_center(),
        this._edge_config.get("buff") ?? 0, this._edge_config.get("path_arc") ?? 0);
    }
    return this;
  }
}

export class DiGraph extends GenericGraph {
  static directed = true;

  _populate_edge_dict(edges, edgeType) {
    this.edges = new Map(edges.map(([u, v]) => [key([u, v]), edgeType.make({ ...this._edge_config.get(key([u, v])),
      start: this.item(u), end: this.item(v), z_index: -1 })]));
    this._edge_ends = new Map(edges.map((e) => [key(e), e]));
    for (const [k, edge] of this.edges) edge.add_tip({ ...this._tip_config.get(k) });
  }

  update_edges(graph) {
    for (const [k, edge] of graph.edges) {
      const [u, v] = graph._edge_ends.get(k);
      const tip = edge.pop_tips().get(0);
      edge.set_points_by_ends(graph.item(u), graph.item(v), this._edge_config.get("buff") ?? 0,
        this._edge_config.get("path_arc") ?? 0);
      edge.add_tip({ tip });
    }
    return this;
  }
}
