// The curves where fn(x, y) = 0: a port of isosurfaces 0.1.2 (plot_isoline), which Manim's ImplicitFunction uses.
// A quadtree refined where the sign changes, triangulated (Manson & Schaefer's simplicial partition), and traced.

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const avg2 = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : v === 0 ? 0 : NaN);

class ValuedPoint {
  constructor(pos, val = null) {
    this.pos = pos;
    this.val = val;
  }

  calc(fn) {
    this.val = fn(this.pos);
    return this;
  }

  static midpoint(p1, p2, fn) {
    const mid = avg2(p1.pos, p2.pos);
    return new ValuedPoint(mid, fn(mid));
  }

  static intersectZero(p1, p2, fn) {
    const denom = p1.val - p2.val;
    const k1 = -p2.val / denom;
    const k2 = p1.val / denom;
    const pt = [k1 * p1.pos[0] + k2 * p2.pos[0], k1 * p1.pos[1] + k2 * p2.pos[1]];
    return new ValuedPoint(pt, fn(pt));
  }
}

function binarySearchZero(p1, p2, fn, tol) {
  const d = sub2(p2.pos, p1.pos);
  if (Math.abs(d[0]) < tol[0] && Math.abs(d[1]) < tol[1]) {
    const pt = ValuedPoint.intersectZero(p1, p2, fn);
    // isosurfaces writes np.abs(pt.val < 1e200): the absolute value of the comparison
    const isZero = pt.val === 0 || (sign(pt.val - p1.val) === sign(p2.val - pt.val) && pt.val < 1e200);
    return [pt, isZero];
  }
  const mid = ValuedPoint.midpoint(p1, p2, fn);
  if (mid.val === 0) return [mid, true];
  if ((mid.val > 0) === (p1.val > 0)) return binarySearchZero(mid, p2, fn, tol);
  return binarySearchZero(p1, mid, fn, tol);
}

function verticesFromExtremes(pmin, pmax, fn) {
  const w = sub2(pmax, pmin);
  return [0, 1, 2, 3].map((i) => new ValuedPoint([pmin[0] + (i & 1) * w[0], pmin[1] + ((i >> 1) & 1) * w[1]]).calc(fn));
}

class Cell {
  constructor(vertices, depth, parent, childDirection) {
    this.vertices = vertices;
    this.depth = depth;
    this.children = [];
    this.parent = parent;
    this.child_direction = childDirection;
  }

  computeChildren(fn) {
    this.vertices.forEach((vertex, i) => {
      const pmin = avg2(this.vertices[0].pos, vertex.pos);
      const pmax = avg2(this.vertices[3].pos, vertex.pos);
      this.children.push(new Cell(verticesFromExtremes(pmin, pmax, fn), this.depth + 1, this, i));
    });
  }
}

function shouldDescend(cell, tol) {
  const d = sub2(cell.vertices[3].pos, cell.vertices[0].pos);
  if (d[0] < 10 * tol[0] && d[1] < 10 * tol[1]) return false;
  if (cell.vertices.every((v) => Number.isNaN(v.val))) return false;
  if (cell.vertices.some((v) => Number.isNaN(v.val))) return true;
  const s0 = sign(cell.vertices[0].val);
  return cell.vertices.slice(1).some((v) => sign(v.val) !== s0);
}

function buildTree(fn, pmin, pmax, minDepth, maxCells, tol) {
  const maxQuads = Math.max(4 ** minDepth, maxCells);
  const root = new Cell(verticesFromExtremes(pmin, pmax, fn), 0, null, 0);
  const queue = [root];
  let head = 0;
  let leafCount = 1;
  while (head < queue.length && leafCount < maxQuads) {
    const quad = queue[head];
    head += 1;
    if (quad.depth < minDepth || shouldDescend(quad, tol)) {
      quad.computeChildren(fn);
      queue.push(...quad.children);
      leafCount += 3;
    }
  }
  return root;
}

const triangle = (vertices) => ({ vertices, next: null, next_bisect_point: null, prev: null, visited: false });

const fourTriangles = (a, b, c, d, center) => [triangle([a, b, center]), triangle([b, c, center]),
  triangle([c, d, center]), triangle([d, a, center])];

class Triangulator {
  constructor(root, fn, tol) {
    this.triangles = [];
    this.hanging = new Map();
    this.root = root;
    this.fn = fn;
    this.tol = tol;
  }

  triangulate() {
    this.inside(this.root);
    return this.triangles;
  }

  inside(quad) {
    if (!quad.children.length) return;
    for (const child of quad.children) this.inside(child);
    const [c0, c1, c2, c3] = quad.children;
    this.row(c0, c1);
    this.row(c2, c3);
    this.col(c0, c2);
    this.col(c1, c3);
  }

  row(a, b) {
    if (a.children.length && b.children.length) {
      this.row(a.children[1], b.children[0]);
      this.row(a.children[3], b.children[2]);
    } else if (a.children.length) {
      this.row(a.children[1], b);
      this.row(a.children[3], b);
    } else if (b.children.length) {
      this.row(a, b.children[0]);
      this.row(a, b.children[2]);
    } else {
      const fa = this.faceDual(a);
      const fb = this.faceDual(b);
      if (a.depth < b.depth) {
        const e = this.edgeDual(b.vertices[2], b.vertices[0]);
        this.addFour(fourTriangles(b.vertices[2], fb, b.vertices[0], fa, e));
      } else {
        const e = this.edgeDual(a.vertices[3], a.vertices[1]);
        this.addFour(fourTriangles(a.vertices[3], fb, a.vertices[1], fa, e));
      }
    }
  }

  col(a, b) {
    if (a.children.length && b.children.length) {
      this.col(a.children[2], b.children[0]);
      this.col(a.children[3], b.children[1]);
    } else if (a.children.length) {
      this.col(a.children[2], b);
      this.col(a.children[3], b);
    } else if (b.children.length) {
      this.col(a, b.children[0]);
      this.col(a, b.children[1]);
    } else {
      const fa = this.faceDual(a);
      const fb = this.faceDual(b);
      if (a.depth < b.depth) {
        const e = this.edgeDual(b.vertices[0], b.vertices[1]);
        this.addFour(fourTriangles(b.vertices[0], fb, b.vertices[1], fa, e));
      } else {
        const e = this.edgeDual(a.vertices[2], a.vertices[3]);
        this.addFour(fourTriangles(a.vertices[2], fb, a.vertices[3], fa, e));
      }
    }
  }

  addFour(tris) {
    for (let i = 0; i < 4; i += 1) this.sandwich(tris[i], tris[(i + 1) % 4], tris[(i + 2) % 4]);
    this.triangles.push(...tris);
  }

  setNext(t1, t2, vpos, vneg) {
    if (!(vpos.val > 0 && vneg.val <= 0)) return;
    const [intersection, isZero] = binarySearchZero(vpos, vneg, this.fn, this.tol);
    if (!isZero) return;
    t1.next_bisect_point = intersection;
    t1.next = t2;
    t2.prev = t1;
  }

  sandwich(a, b, c) {
    const center = b.vertices[2];
    const x = b.vertices[0];
    const y = b.vertices[1];
    if (center.val > 0 && y.val <= 0) this.setNext(b, c, center, y);
    if (x.val > 0 && center.val <= 0) this.setNext(b, a, x, center);
    const id = `${x.pos[0] + y.pos[0]},${x.pos[1] + y.pos[1]}`;
    if (y.val > 0 && x.val <= 0) {
      if (this.hanging.has(id)) {
        this.setNext(b, this.hanging.get(id), y, x);
        this.hanging.delete(id);
      } else this.hanging.set(id, b);
    } else if (y.val <= 0 && x.val > 0) {
      if (this.hanging.has(id)) {
        this.setNext(this.hanging.get(id), b, x, y);
        this.hanging.delete(id);
      } else this.hanging.set(id, b);
    }
  }

  edgeDual(p1, p2) {
    if ((p1.val > 0) !== (p2.val > 0)) return ValuedPoint.midpoint(p1, p2, this.fn);
    const dt = 0.01;
    const df1 = this.fn([p1.pos[0] * (1 - dt) + p2.pos[0] * dt, p1.pos[1] * (1 - dt) + p2.pos[1] * dt]);
    const df2 = this.fn([p1.pos[0] * dt + p2.pos[0] * (1 - dt), p1.pos[1] * dt + p2.pos[1] * (1 - dt)]);
    if ((df1 > 0) === (df2 > 0)) return ValuedPoint.midpoint(p1, p2, this.fn);
    return ValuedPoint.intersectZero(new ValuedPoint(p1.pos, df1), new ValuedPoint(p2.pos, df2), this.fn);
  }

  faceDual(quad) {
    return ValuedPoint.midpoint(quad.vertices[0], quad.vertices[3], this.fn);
  }
}

function trace(triangles) {
  const curves = [];
  for (const start of triangles) {
    if (start.visited || start.next === null) continue;
    const curve = [];
    let t = start;
    let closed = false;
    while (t.prev !== null) {
      t = t.prev;
      if (t === start) {
        closed = true;
        break;
      }
    }
    while (t !== null && !t.visited) {
      if (t.next_bisect_point !== null) curve.push(t.next_bisect_point);
      t.visited = true;
      t = t.next;
    }
    if (closed) curve.push(curve[0]);
    curves.push(curve.map((v) => v.pos));
  }
  return curves;
}

/** plot_isoline(fn, pmin, pmax, min_depth, max_quads): curves (lists of [x, y]) where fn([x, y]) = 0. */
export function plotIsoline(fn, pmin, pmax, minDepth = 5, maxQuads = 10000, tol = null) {
  const t = tol ?? [(pmax[0] - pmin[0]) / 1000, (pmax[1] - pmin[1]) / 1000];
  const root = buildTree(fn, pmin, pmax, minDepth, maxQuads, t);
  return trace(new Triangulator(root, fn, t).triangulate());
}
