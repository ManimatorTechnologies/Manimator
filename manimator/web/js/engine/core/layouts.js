// Graph layouts as Manim gets them from networkx 3.7 (drawing/layout.py), with numpy's legacy RandomState for the
// seeded ones. Where networkx computes in float32 (circular, shell, random) the values are rounded the same way.
//
// Exact: circular, shell, random, spring (Fruchterman-Reingold, dense). Close but not bit-exact: spectral (an
// eigenvector's sign, and the basis of a repeated eigenvalue, are LAPACK's choice) and kamada_kawai (scipy's
// L-BFGS-B is replaced by an L-BFGS with the same objective, start and tolerances).

const f32 = Math.fround;

// ------------------------------------------------------------------------------------------------ MT19937

/** numpy.random.RandomState(seed) for an integer seed: rand() gives the same doubles. */
export class RandomState {
  constructor(seed = 0) {
    this.mt = new Uint32Array(624);
    this.index = 624;
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i += 1) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      // 1812433253 * prev + i, mod 2^32, without losing precision
      this.mt[i] = (((((prev & 0xffff0000) >>> 16) * 1812433253) << 16) + (prev & 0x0000ffff) * 1812433253 + i) >>> 0;
    }
  }

  nextUint32() {
    if (this.index >= 624) {
      const mt = this.mt;
      for (let k = 0; k < 624; k += 1) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = this.mt[this.index];
    this.index += 1;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random_sample(): (a >> 5) * 2^26 + (b >> 6), over 2^53. */
  random() {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
  }

  /** rand(rows, cols) in row-major order. */
  rand(rows, cols) {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => this.random()));
  }
}

// ------------------------------------------------------------------------------------------------ helpers

/** numpy's mean over axis 0 (pairwise sums are sequential below 8 rows). */
function meanRows(pos) {
  const n = pos.length;
  return pos[0].map((_, d) => {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += pos[i][d];
    return s / n;
  });
}

/** rescale_layout(pos, scale): centre, then scale so the largest coordinate is `scale`. */
export function rescaleLayout(pos, scale = 1) {
  const mean = meanRows(pos);
  const out = pos.map((p) => p.map((v, d) => v - mean[d]));
  let lim = 0;
  for (const p of out) for (const v of p) lim = Math.max(lim, Math.abs(v));
  if (lim > 0) {
    const k = scale / lim;
    for (const p of out) for (let d = 0; d < p.length; d += 1) p[d] *= k;
  }
  return out;
}

/** nx.to_numpy_array(G): 1.0 for each edge (both ways for an undirected graph). */
function adjacency(nodes, edges, directed) {
  const index = new Map(nodes.map((n, i) => [n, i]));
  const A = nodes.map(() => nodes.map(() => 0));
  for (const [u, v] of edges) {
    const i = index.get(u);
    const j = index.get(v);
    A[i][j] = 1;
    if (!directed) A[j][i] = 1;
  }
  return A;
}

// ------------------------------------------------------------------------------------------------ layouts

export function circularLayout(nodes, scale = 1) {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return [[0, 0]];
  const n = nodes.length;
  const step = 1 / n; // np.linspace(0, 1, n + 1)
  const pos = Array.from({ length: n }, (_, i) => {
    const t = f32((i * step) * 2 * Math.PI);
    return [f32(Math.cos(t)), f32(Math.sin(t))];
  });
  return rescaleLayout(pos, scale);
}

export function shellLayout(nodes, scale = 1) {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return [[0, 0]];
  const nlist = [nodes];
  const bump = scale / nlist.length;
  let radius = nlist[0].length === 1 ? 0.0 : bump;
  const rotate = Math.PI / nlist.length;
  let first = rotate;
  const out = [];
  for (const group of nlist) {
    const m = group.length;
    for (let i = 0; i < m; i += 1) {
      const theta = f32(f32(i * ((2 * Math.PI) / m)) + f32(first)); // np.linspace(..., endpoint=False, dtype=float32)
      out.push([f32(radius * f32(Math.cos(theta))), f32(radius * f32(Math.sin(theta)))]);
    }
    radius += bump;
    first += rotate;
  }
  return out;
}

/** Manim's _random_layout: networkx's random_layout (float32), spread to +-scale. */
export function randomLayout(nodes, scale = 2, seed = 0) {
  const rs = new RandomState(seed);
  return rs.rand(nodes.length, 2).map((p) => p.map((v) => 2 * scale * (f32(v) - 0.5)));
}

/** spring_layout with the dense Fruchterman-Reingold solver (graphs under 500 nodes). */
export function springLayout(nodes, edges, directed, { scale = 1, seed = 0, k = null, iterations = 50,
  threshold = 1e-4 } = {}) {
  const n = nodes.length;
  if (n === 0) return [];
  if (n === 1) return [[0, 0]];
  const A = adjacency(nodes, edges, directed);
  const rs = new RandomState(seed);
  const pos = rs.rand(n, 2);
  const kk = k ?? Math.sqrt(1.0 / n);
  const xs = pos.map((p) => p[0]);
  const ys = pos.map((p) => p[1]);
  let t = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.1;
  const dt = t / (iterations + 1);
  for (let it = 0; it < iterations; it += 1) {
    const disp = pos.map(() => [0, 0]);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const dx = pos[i][0] - pos[j][0];
        const dy = pos[i][1] - pos[j][1];
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.01) d = 0.01;
        const f = (kk * kk) / d ** 2 - (A[i][j] * d) / kk;
        disp[i][0] += dx * f;
        disp[i][1] += dy * f;
      }
    }
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      let len = Math.sqrt(disp[i][0] * disp[i][0] + disp[i][1] * disp[i][1]);
      if (len < 0.01) len = 0.01;
      const s = t / len;
      const ddx = disp[i][0] * s;
      const ddy = disp[i][1] * s;
      pos[i][0] += ddx;
      pos[i][1] += ddy;
      total += ddx * ddx + ddy * ddy;
    }
    t -= dt;
    if (Math.sqrt(total) / n < threshold) break;
  }
  return rescaleLayout(pos, scale);
}

/** Symmetric eigen-decomposition (cyclic Jacobi): [values, vectors as columns]. */
function symmetricEigen(M) {
  const n = M.length;
  const a = M.map((r) => [...r]);
  const v = M.map((_, i) => M.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) for (let q = p + 1; q < n; q += 1) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(tt * tt + 1);
        const s = tt * c;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [a.map((r, i) => r[i]), v];
}

export function spectralLayout(nodes, edges, directed, scale = 1) {
  const n = nodes.length;
  if (n <= 2) return n === 0 ? [] : n === 1 ? [[0, 0]] : [[0, 0], [0, 0]];
  const D = adjacency(nodes, edges, directed);
  const A = directed ? D.map((row, i) => row.map((v, j) => v + D[j][i])) : D; // A += A.T
  const L = A.map((row, i) => row.map((v, j) => (i === j ? row.reduce((s, x) => s + x, 0) : 0) - v));
  const [values, vectors] = symmetricEigen(L);
  const order = values.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[1]);
  const cols = order.slice(1, 3).map((c) => {
    // LAPACK leaves an eigenvector's sign open; numpy's result had the first non-zero entry negative in our tests
    const col = vectors.map((r) => r[c]);
    const first = col.find((x) => Math.abs(x) > 1e-12) ?? 0;
    return first > 0 ? col.map((x) => -x) : col;
  });
  const pos = nodes.map((_, i) => [cols[0]?.[i] ?? 0, cols[1]?.[i] ?? 0]);
  return rescaleLayout(pos, scale);
}

/** All-pairs shortest path lengths (unweighted, following edge direction for a digraph); 1e6 where unreachable. */
function distances(nodes, edges, directed) {
  const n = nodes.length;
  const index = new Map(nodes.map((v, i) => [v, i]));
  const adj = nodes.map(() => []);
  for (const [u, v] of edges) {
    adj[index.get(u)].push(index.get(v));
    if (!directed) adj[index.get(v)].push(index.get(u));
  }
  return nodes.map((_, s) => {
    const d = new Array(n).fill(1e6);
    d[s] = 0;
    const queue = [s];
    for (let h = 0; h < queue.length; h += 1) {
      const u = queue[h];
      for (const w of adj[u]) if (d[w] === 1e6) {
        d[w] = d[u] + 1;
        queue.push(w);
      }
    }
    return d;
  });
}

/** Minimises f with L-BFGS (m = 10) and a backtracking Wolfe line search; f returns [cost, grad]. */
function lbfgs(f, x0, { maxIter = 15000, pgtol = 1e-5, factr = 1e7 } = {}) {
  const eps = 2.220446049250313e-16;
  let x = [...x0];
  let [fx, g] = f(x);
  const S = [];
  const Y = [];
  for (let iter = 0; iter < maxIter; iter += 1) {
    if (Math.max(...g.map(Math.abs)) <= pgtol) break;
    // two-loop recursion
    const q = [...g];
    const alpha = [];
    for (let i = S.length - 1; i >= 0; i -= 1) {
      const rho = 1 / Y[i].reduce((s, y, k) => s + y * S[i][k], 0);
      const a = rho * S[i].reduce((s, sv, k) => s + sv * q[k], 0);
      alpha[i] = [a, rho];
      for (let k = 0; k < q.length; k += 1) q[k] -= a * Y[i][k];
    }
    let gamma = 1;
    if (S.length) {
      const sy = S[S.length - 1].reduce((s, v, k) => s + v * Y[Y.length - 1][k], 0);
      const yy = Y[Y.length - 1].reduce((s, v) => s + v * v, 0);
      gamma = sy / yy;
    }
    const r = q.map((v) => v * gamma);
    for (let i = 0; i < S.length; i += 1) {
      const [a, rho] = alpha[i];
      const b = rho * Y[i].reduce((s, y, k) => s + y * r[k], 0);
      for (let k = 0; k < r.length; k += 1) r[k] += S[i][k] * (a - b);
    }
    const dir = r.map((v) => -v);
    let slope = dir.reduce((s, d, k) => s + d * g[k], 0);
    if (slope >= 0) {
      S.length = 0;
      Y.length = 0;
      for (let k = 0; k < dir.length; k += 1) dir[k] = -g[k];
      slope = dir.reduce((s, d, k) => s + d * g[k], 0);
    }
    let step = iter === 0 && S.length === 0 ? Math.min(1, 1 / Math.sqrt(g.reduce((s, v) => s + v * v, 0))) : 1;
    let xNew;
    let fNew;
    let gNew;
    for (let ls = 0; ls < 40; ls += 1) {
      xNew = x.map((v, k) => v + step * dir[k]);
      [fNew, gNew] = f(xNew);
      if (fNew <= fx + 1e-4 * step * slope) break;
      step *= 0.5;
    }
    const s = xNew.map((v, k) => v - x[k]);
    const y = gNew.map((v, k) => v - g[k]);
    if (s.reduce((acc, v, k) => acc + v * y[k], 0) > eps * y.reduce((acc, v) => acc + v * v, 0)) {
      S.push(s);
      Y.push(y);
      if (S.length > 10) {
        S.shift();
        Y.shift();
      }
    }
    const done = (fx - fNew) / Math.max(Math.abs(fx), Math.abs(fNew), 1) <= factr * eps;
    x = xNew;
    fx = fNew;
    g = gNew;
    if (done) break;
  }
  return x;
}

export function kamadaKawaiLayout(nodes, edges, directed, scale = 1) {
  const n = nodes.length;
  if (n === 0) return [];
  const dist = distances(nodes, edges, directed);
  const start = circularLayout(nodes, 1);
  const invdist = dist.map((row, i) => row.map((d, j) => 1 / (d + (i === j ? 1e-3 : 0))));
  const meanwt = 1e-3;
  const cost = (vec) => {
    let c = 0;
    const grad = new Array(2 * n).fill(0);
    const sum = [0, 0];
    for (let i = 0; i < n; i += 1) {
      sum[0] += vec[2 * i];
      sum[1] += vec[2 * i + 1];
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const dx = vec[2 * i] - vec[2 * j];
        const dy = vec[2 * i + 1] - vec[2 * j + 1];
        const sep = Math.sqrt(dx * dx + dy * dy);
        const off = sep * invdist[i][j] - 1.0;
        c += 0.5 * off * off;
        const w = (invdist[i][j] * off) / sep;
        grad[2 * i] += w * dx;
        grad[2 * i + 1] += w * dy;
        grad[2 * j] -= w * dx;
        grad[2 * j + 1] -= w * dy;
      }
    }
    c += 0.5 * meanwt * (sum[0] * sum[0] + sum[1] * sum[1]);
    for (let i = 0; i < n; i += 1) {
      grad[2 * i] += meanwt * sum[0];
      grad[2 * i + 1] += meanwt * sum[1];
    }
    return [c, grad];
  };
  const x = lbfgs(cost, start.flat());
  const pos = nodes.map((_, i) => [x[2 * i], x[2 * i + 1]]);
  return rescaleLayout(pos, scale);
}

/** _determine_graph_layout for a named layout: positions in node order, each [x, y, 0]. */
export function graphLayout(name, nodes, edges, directed, scale = 2, config = {}) {
  const seed = config.seed ?? 0;
  let pos;
  switch (name) {
    case "circular": pos = circularLayout(nodes, scale); break;
    case "shell": pos = shellLayout(nodes, scale); break;
    case "spring": pos = springLayout(nodes, edges, directed, { scale, seed, k: config.k ?? null,
      iterations: config.iterations ?? 50 }); break;
    case "spectral": pos = spectralLayout(nodes, edges, directed, scale); break;
    case "kamada_kawai": pos = kamadaKawaiLayout(nodes, edges, directed, scale); break;
    case "random": pos = randomLayout(nodes, scale, seed); break;
    default: throw new Error(`The layout '${name}' is neither a recognized layout, a layout function,nor a vertex placement dictionary.`);
  }
  return pos.map((p) => [p[0], p[1], 0]);
}
