// Ports of manim/utils/bezier.py (the parts the engine uses). Control points are [x, y, z] arrays.

/** bezier(points)(t): a point on the curve. */
export function bezier(P) {
  const degree = P.length - 1;
  if (degree === 0) return () => [...P[0]];
  if (degree === 1) return (t) => P[0].map((p, i) => p + t * (P[1][i] - p));
  if (degree === 2) {
    return (t) => {
      const t2 = t * t;
      const mt = 1 - t;
      const mt2 = mt * mt;
      return [0, 1, 2].map((i) => mt2 * P[0][i] + 2 * t * mt * P[1][i] + t2 * P[2][i]);
    };
  }
  if (degree === 3) {
    return (t) => {
      const t2 = t * t;
      const t3 = t2 * t;
      const mt = 1 - t;
      const mt2 = mt * mt;
      const mt3 = mt2 * mt;
      return [0, 1, 2].map((i) => mt3 * P[0][i] + 3 * t * mt2 * P[1][i] + 3 * t2 * mt * P[2][i] + t3 * P[3][i]);
    };
  }
  return (t) => {
    const B = P.map((p) => [...p]);
    for (let i = 0; i < degree; i += 1) {
      for (let k = 0; k < degree - i; k += 1) {
        for (let d = 0; d < 3; d += 1) B[k][d] += t * (B[k + 1][d] - B[k][d]);
      }
    }
    return B[0];
  };
}

const matPoints = (M, P) => M.map((row) => [0, 1, 2].map((d) => row.reduce((s, w, j) => s + w * P[j][d], 0)));

/** The part of a Bézier curve between parameters a and b, as control points of the same degree. */
export function partialBezierPoints(points, a, b) {
  if (a === 1) return points.map(() => [...points[points.length - 1]]);
  if (b === 0) return points.map(() => [...points[0]]);
  const degree = points.length - 1;
  if (degree === 3) {
    const ma = 1 - a;
    const mb = 1 - b;
    const a2 = a * a;
    const b2 = b * b;
    const ma2 = ma * ma;
    const mb2 = mb * mb;
    const a3 = a2 * a;
    const b3 = b2 * b;
    const ma3 = ma2 * ma;
    const mb3 = mb2 * mb;
    return matPoints([
      [ma3, 3 * ma2 * a, 3 * ma * a2, a3],
      [ma2 * mb, 2 * ma * a * mb + ma2 * b, a2 * mb + 2 * ma * a * b, a2 * b],
      [ma * mb2, a * mb2 + 2 * ma * mb * b, 2 * a * mb * b + ma * b2, a * b2],
      [mb3, 3 * mb2 * b, 3 * mb * b2, b3],
    ], points);
  }
  if (degree === 2) {
    const ma = 1 - a;
    const mb = 1 - b;
    return matPoints([[ma * ma, 2 * a * ma, a * a], [ma * mb, a * mb + ma * b, a * b], [mb * mb, 2 * b * mb, b * b]], points);
  }
  if (degree === 1) {
    const d = [0, 1, 2].map((i) => points[1][i] - points[0][i]);
    return [points[0].map((p, i) => p + a * d[i]), points[0].map((p, i) => p + b * d[i])];
  }
  if (degree === 0) return points.map((p) => [...p]);
  const arr = points.map((p) => [...p]);
  const N = arr.length;
  if (a !== 0) {
    for (let i = 1; i < N; i += 1) {
      for (let k = 0; k < N - i; k += 1) for (let d = 0; d < 3; d += 1) arr[k][d] += a * (arr[k + 1][d] - arr[k][d]);
    }
  }
  if (b !== 1) {
    const mu = (1 - b) / (1 - a);
    for (let i = 1; i < N; i += 1) {
      for (let k = N - 1; k >= i; k -= 1) for (let d = 0; d < 3; d += 1) arr[k][d] += mu * (arr[k - 1][d] - arr[k][d]);
    }
  }
  return arr;
}

/** bezier._get_subdivision_matrix for 1 to 4 control points. */
const SUBDIVISION = [new Map(), new Map(), new Map(), new Map()];
function subdivisionMatrix(nPoints, n) {
  const memo = SUBDIVISION[nPoints - 1];
  if (memo.has(n)) return memo.get(n);
  let m = [];
  if (nPoints === 4) {
    for (let i = 0; i < n; i += 1) {
      const i2 = i * i;
      const i3 = i2 * i;
      const ip1 = i + 1;
      const ip12 = ip1 * ip1;
      const ip13 = ip12 * ip1;
      const nmi = n - i;
      const nmi2 = nmi * nmi;
      const nmi3 = nmi2 * nmi;
      const nmim1 = nmi - 1;
      const nmim12 = nmim1 * nmim1;
      const nmim13 = nmim12 * nmim1;
      m.push([nmi3, 3 * nmi2 * i, 3 * nmi * i2, i3],
        [nmi2 * nmim1, 2 * nmi * nmim1 * i + nmi2 * ip1, nmim1 * i2 + 2 * nmi * i * ip1, i2 * ip1],
        [nmi * nmim12, nmim12 * i + 2 * nmi * nmim1 * ip1, 2 * nmim1 * i * ip1 + nmi * ip12, i * ip12],
        [nmim13, 3 * nmim12 * ip1, 3 * nmim1 * ip12, ip13]);
    }
    const d = n * n * n;
    m = m.map((row) => row.map((v) => v / d));
  } else if (nPoints === 3) {
    for (let i = 0; i < n; i += 1) {
      const ip1 = i + 1;
      const nmi = n - i;
      const nmim1 = nmi - 1;
      m.push([nmi * nmi, 2 * i * nmi, i * i], [nmi * nmim1, i * nmim1 + ip1 * nmi, i * ip1],
        [nmim1 * nmim1, 2 * ip1 * nmim1, ip1 * ip1]);
    }
    const d = n * n;
    m = m.map((row) => row.map((v) => v / d));
  } else if (nPoints === 2) {
    for (let i = 0; i < n; i += 1) m.push([n - i, i], [n - i - 1, i + 1]);
    m = m.map((row) => row.map((v) => v / n));
  } else {
    m = Array.from({ length: n }, () => [1]);
  }
  memo.set(n, m);
  return m;
}

/** Split a Bézier curve into n equal-parameter pieces (all their control points, one after another). */
export function subdivideBezier(points, n) {
  if (n === 1) return points.map((p) => [...p]);
  if (points.length <= 4) return matPoints(subdivisionMatrix(points.length, n), points);
  throw new Error("subdivideBezier: more than 4 control points");
}

/** bezier_remap: the curves split into `newCount` curves, splitting the earlier ones first. */
export function bezierRemap(tuples, newCount) {
  const current = tuples.length;
  const splits = new Array(current).fill(0);
  for (let i = 0; i < newCount; i += 1) splits[Math.floor((i * current) / newCount)] += 1;
  const out = [];
  tuples.forEach((curve, k) => {
    const sf = splits[k];
    if (sf === 0) return;
    const pts = subdivideBezier(curve, sf);
    for (let j = 0; j < sf; j += 1) out.push(pts.slice(j * curve.length, (j + 1) * curve.length));
  });
  return out;
}

export const interpolate = (a, b, t) => (1 - t) * a + t * b;

/** bezier.integer_interpolate: [index, residue] */
export function integerInterpolate(start, end, alpha) {
  if (alpha >= 1) return [Math.trunc(end - 1), 1.0];
  if (alpha <= 0) return [Math.trunc(start), 0];
  const value = Math.trunc(interpolate(start, end, alpha));
  const x = (end - start) * alpha;
  const residue = x - Math.floor(x);
  return [value, residue];
}

export const mid = (a, b) => (a + b) / 2.0;
export const inverseInterpolate = (start, end, value) => (value - start) / (end - start);
export const matchInterpolate = (newStart, newEnd, oldStart, oldEnd, oldValue) => interpolate(newStart, newEnd,
  inverseInterpolate(oldStart, oldEnd, oldValue));

/** bezier.is_closed (np.isclose-like, relative to the start point) */
export function isClosed(points) {
  const s = points[0];
  const e = points[points.length - 1];
  for (let d = 0; d < 3; d += 1) {
    const tol = 1e-8 + 1e-5 * s[d];
    if (!(Math.abs(e[d] - s[d]) <= tol)) return false;
  }
  return true;
}

let CP_CLOSED = [1 / 3];
let UP_CLOSED = [1 / 3];
let CP_OPEN = [0.5];

function smoothClosed(A) {
  const N = A.length - 1;
  if (CP_CLOSED.length < N - 1) {
    const cp = [...CP_CLOSED];
    const up = [...UP_CLOSED];
    for (let i = cp.length; i < N - 1; i += 1) {
      cp[i] = 1 / (4 - cp[i - 1]);
      up[i] = -cp[i] * up[i - 1];
    }
    CP_CLOSED = cp;
    UP_CLOSED = up;
  }
  const cp = CP_CLOSED;
  const up = UP_CLOSED;
  const cpLast = 1 / (3 - cp[N - 2]);
  const upLast = cpLast * (1 - up[N - 2]);
  const q = new Array(N);
  q[N - 1] = upLast;
  for (let i = N - 2; i >= 0; i -= 1) q[i] = up[i] - cp[i] * q[i + 1];
  const aux = (i) => [0, 1, 2].map((d) => 4 * A[i][d] + 2 * A[i + 1][d]);
  const Dp = new Array(N);
  Dp[0] = aux(0).map((v) => v / 3);
  for (let i = 1; i < N - 1; i += 1) Dp[i] = aux(i).map((v, d) => cp[i] * (v - Dp[i - 1][d]));
  Dp[N - 1] = aux(N - 1).map((v, d) => cpLast * (v - Dp[N - 2][d]));
  const Y = Dp;
  for (let i = N - 2; i >= 0; i -= 1) Y[i] = Dp[i].map((v, d) => v - cp[i] * Y[i + 1][d]);
  const k = 1 / (1 + q[0] + q[N - 1]);
  const H1 = Y.map((y, i) => y.map((v, d) => v - k * q[i] * (Y[0][d] + Y[N - 1][d])));
  const H2 = new Array(N);
  for (let i = 0; i < N - 1; i += 1) H2[i] = [0, 1, 2].map((d) => 2 * A[i + 1][d] - H1[i + 1][d]);
  H2[N - 1] = [0, 1, 2].map((d) => 2 * A[N][d] - H1[0][d]);
  return [H1, H2];
}

function smoothOpen(A) {
  const N = A.length - 1;
  if (CP_OPEN.length < N - 1) {
    const cp = [...CP_OPEN];
    for (let i = cp.length; i < N - 1; i += 1) cp[i] = 1 / (4 - cp[i - 1]);
    CP_OPEN = cp;
  }
  const cp = CP_OPEN;
  const Dp = new Array(N);
  Dp[0] = [0, 1, 2].map((d) => 0.5 * A[0][d] + A[1][d]);
  for (let i = 1; i < N - 1; i += 1) {
    Dp[i] = [0, 1, 2].map((d) => cp[i] * (4 * A[i][d] + 2 * A[i + 1][d] - Dp[i - 1][d]));
  }
  const last = 1 / (7 - 2 * cp[N - 2]);
  Dp[N - 1] = [0, 1, 2].map((d) => last * (8 * A[N - 1][d] + A[N][d] - 2 * Dp[N - 2][d]));
  const H1 = Dp;
  for (let i = N - 2; i >= 0; i -= 1) H1[i] = Dp[i].map((v, d) => v - cp[i] * H1[i + 1][d]);
  const H2 = new Array(N);
  for (let i = 0; i < N - 1; i += 1) H2[i] = [0, 1, 2].map((d) => 2 * A[i + 1][d] - H1[i + 1][d]);
  H2[N - 1] = [0, 1, 2].map((d) => 0.5 * (A[N][d] + H1[N - 1][d]));
  return [H1, H2];
}

/** Handles that make a smooth curve through the anchors: [H1, H2], one pair per curve. */
export function getSmoothCubicBezierHandlePoints(anchors) {
  const n = anchors.length;
  if (n === 1) return [[], []];
  if (n === 2) {
    const [a, b] = anchors;
    return [[[0, 1, 2].map((d) => (1 - 1 / 3) * a[d] + (1 / 3) * b[d])], [[0, 1, 2].map((d) => (1 - 2 / 3) * a[d] + (2 / 3) * b[d])]];
  }
  return isClosed(anchors) ? smoothClosed(anchors) : smoothOpen(anchors);
}
