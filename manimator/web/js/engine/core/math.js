// Vector maths for points stored as [x, y, z] arrays, and ports of manim/utils/space_ops.py.
// Function names follow Manim's where they port a Manim function.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const mulv = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const neg = (a) => [-a[0], -a[1], -a[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const copyPoint = (p) => [p[0], p[1], p[2] ?? 0];
export const pt = (p) => [Number(p[0]), Number(p[1]), Number(p[2] ?? 0)];
export const lerp = (a, b, t) => (1 - t) * a + t * b;
/** bezier.interpolate for points: (1 - t) * a + t * b, elementwise. */
export const interpolatePoint = (a, b, t) => [(1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1], (1 - t) * a[2] + t * b[2]];
export const allZero = (a) => a[0] === 0 && a[1] === 0 && a[2] === 0;
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : v === 0 ? 0 : NaN);
export const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** np.linalg.norm(v) > 0 ? v / norm : fall_back or zeros. */
export function normalize(v, fallBack = null) {
  const n = norm(v);
  if (n > 0) return [v[0] / n, v[1] / n, v[2] / n];
  return fallBack ? copyPoint(fallBack) : [0, 0, 0];
}

/** np.allclose(a, b, atol) with numpy's default rtol=1e-05 (relative to b). */
export function allclose(a, b, atol = 1e-8, rtol = 1e-5) {
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= atol + rtol * Math.abs(b[i]))) {
      if (a[i] === b[i]) continue; // equal infinities
      return false;
    }
  }
  return true;
}

/** space_ops.rotation_matrix: scipy's Rotation.from_rotvec(angle * normalize(axis)).as_matrix(), as rows. */
export function rotationMatrix(angle, axis) {
  const u = normalize(axis);
  const rv = [angle * u[0], angle * u[1], angle * u[2]];
  const n = norm(rv);
  const scale = n <= 1e-3 ? 0.5 - (n * n) / 48 + (n * n * n * n) / 3840 : Math.sin(n / 2) / n;
  const x = scale * rv[0];
  const y = scale * rv[1];
  const z = scale * rv[2];
  const w = Math.cos(n / 2);
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  const w2 = w * w;
  const xy = x * y;
  const zw = z * w;
  const xz = x * z;
  const yw = y * w;
  const yz = y * z;
  const xw = x * w;
  return [
    [x2 - y2 - z2 + w2, 2 * (xy - zw), 2 * (xz + yw)],
    [2 * (xy + zw), -x2 + y2 - z2 + w2, 2 * (yz - xw)],
    [2 * (xz - yw), 2 * (yz + xw), -x2 - y2 + z2 + w2],
  ];
}

/** matrix (rows) @ vector */
export const matVec = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/** np.dot(points, M.T) for one point: the same as M @ p. */
export const applyMatrix = matVec;

export const transpose = (m) => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
export const matMul = (a, b) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));

export function rotationAboutZ(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

export function rotateVector(vector, angle, axis = [0, 0, 1]) {
  return matVec(rotationMatrix(angle, axis), pt(vector));
}

/** np.angle(complex(x, y)) */
export const angleOfVector = (v) => Math.atan2(v[1], v[0]);

export function angleBetweenVectors(v1, v2) {
  const a = normalize(v1);
  const b = normalize(v2);
  return 2 * Math.atan2(norm(sub(a, b)), norm(add(a, b)));
}

export function getUnitNormal(v1, v2, tol = 1e-6) {
  const div1 = Math.max(...v1.map(Math.abs));
  const div2 = Math.max(...v2.map(Math.abs));
  let u;
  if (div1 === 0.0) {
    if (div2 === 0.0) return [0, -1, 0];
    u = mul(v2, 1 / div2);
  } else if (div2 === 0.0) {
    u = mul(v1, 1 / div1);
  } else {
    const u1 = mul(v1, 1 / div1);
    const u2 = mul(v2, 1 / div2);
    const cp = cross(u1, u2);
    const cpNorm = Math.sqrt(dot(cp, cp));
    if (cpNorm > tol) return mul(cp, 1 / cpNorm);
    u = u1;
  }
  if (Math.abs(u[0]) < tol && Math.abs(u[1]) < tol) return [0, -1, 0];
  const cp = [-u[0] * u[2], -u[1] * u[2], u[0] * u[0] + u[1] * u[1]];
  return mul(cp, 1 / Math.sqrt(dot(cp, cp)));
}

export function compassDirections(n = 4, startVect = [1, 0, 0]) {
  const angle = (2 * Math.PI) / n;
  return Array.from({ length: n }, (_, k) => rotateVector(startVect, k * angle));
}

export function regularVertices(n, { radius = 1, startAngle = null } = {}) {
  const start = startAngle ?? (n % 2 === 0 ? 0 : (2 * Math.PI) / 4);
  const startVector = rotateVector([radius, 0, 0], start);
  return [compassDirections(n, startVector), start];
}

export function centerOfMass(points) {
  const s = [0, 0, 0];
  for (const p of points) {
    s[0] += p[0];
    s[1] += p[1];
    s[2] += p[2];
  }
  return mul(s, 1 / points.length);
}

export const midpoint = (a, b) => centerOfMass([a, b]);

/** space_ops.line_intersection: two lines, each given by two points in the xy plane. */
export function lineIntersection(line1, line2) {
  if ([...line1, ...line2].some((p) => p[2])) throw new Error("Coords must be in the xy-plane.");
  const l1 = cross([line1[0][0], line1[0][1], 1], [line1[1][0], line1[1][1], 1]);
  const l2 = cross([line2[0][0], line2[0][1], 1], [line2[1][0], line2[1][1], 1]);
  const [x, y, z] = cross(l1, l2);
  if (z === 0) throw new Error("The lines are parallel, there is no unique intersection point.");
  return [x / z, y / z, 0];
}

export function findIntersection(p0s, v0s, p1s, v1s, threshold = 1e-5) {
  return p0s.map((p0, i) => {
    const v0 = v0s[i];
    const v1 = v1s[i];
    const normal = cross(v1, cross(v0, v1));
    const denom = Math.max(dot(v0, normal), threshold);
    return add(p0, mul(v0, dot(sub(p1s[i], p0), normal) / denom));
  });
}

/** np.trapezoid(y, x) over the points' coordinates (space_ops.shoelace). */
export function shoelace(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += ((points[i][0] - points[i - 1][0]) * (points[i][1] + points[i - 1][1])) / 2;
  }
  return total;
}

export const shoelaceDirection = (points) => (shoelace(points) > 0 ? "CW" : "CCW");

export function zToVector(vector) {
  const axisZ = normalize(vector);
  let axisY = normalize(cross(axisZ, [1, 0, 0]));
  let axisX = cross(axisY, axisZ);
  if (norm(axisY) === 0) {
    axisX = normalize(cross([0, 1, 0], axisZ));
    axisY = neg(cross(axisX, axisZ));
  }
  // columns are axis_x, axis_y, axis_z
  return [[axisX[0], axisY[0], axisZ[0]], [axisX[1], axisY[1], axisZ[1]], [axisX[2], axisY[2], axisZ[2]]];
}

export function cartesianToSpherical(v) {
  const r = norm(v);
  if (r === 0) return [0, 0, 0];
  return [r, Math.atan2(v[1], v[0]), Math.acos(v[2] / r)];
}

export function sphericalToCartesian([r, theta, phi]) {
  return [r * Math.cos(theta) * Math.sin(phi), r * Math.sin(theta) * Math.sin(phi), r * Math.cos(phi)];
}

/** np.linspace(start, stop, num) */
export function linspace(start, stop, num) {
  if (num <= 0) return [];
  if (num === 1) return [start];
  const step = (stop - start) / (num - 1);
  const out = Array.from({ length: num }, (_, i) => start + i * step);
  out[num - 1] = stop;
  return out;
}

/** np.arange(start, stop, step): numpy's length rule, ceil((stop - start) / step), and its fill rule: the second
 *  value is start + step, the rest start + i * ((start + step) - start). */
export function arange(start, stop, step = 1) {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  if (n === 0) return [];
  const second = start + step;
  const delta = second - start;
  return Array.from({ length: n }, (_, i) => (i === 0 ? start : i === 1 ? second : start + i * delta));
}

/** Python's % (the result has the divisor's sign), as numpy's np.mod / Python floats use. */
export function pymod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

/** np.interp(x, xp, fp) for increasing xp. */
export function interp(x, xp, fp) {
  if (x <= xp[0]) return fp[0];
  const last = xp.length - 1;
  if (x >= xp[last]) return fp[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  const slope = (fp[hi] - fp[lo]) / (xp[hi] - xp[lo]);
  return slope * (x - xp[lo]) + fp[lo];
}
