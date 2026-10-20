// Paths points take during a Transform: a port of manim/utils/paths.py. A path function maps (start points,
// end points, alpha) to the points at alpha.

import { cross, normalize, rotationMatrix } from "./math.js";

const STRAIGHT_PATH_THRESHOLD = 0.01;
const OUT = [0, 0, 1];

/** np.dot(points, m.T): each point times the matrix. */
const rotateAll = (points, m) => points.map((p) => [
  p[0] * m[0][0] + p[1] * m[0][1] + p[2] * m[0][2],
  p[0] * m[1][0] + p[1] * m[1][1] + p[2] * m[1][2],
  p[0] * m[2][0] + p[1] * m[2][1] + p[2] * m[2][2],
]);

/** interpolate(start, end, alpha) on point arrays. */
export function straightPath() {
  return (start, end, alpha) => start.map((p, i) => {
    const q = end[i];
    return [(1 - alpha) * p[0] + alpha * q[0], (1 - alpha) * p[1] + alpha * q[1], (1 - alpha) * p[2] + alpha * q[2]];
  });
}

export function pathAlongCircles(arcAngle, circlesCenters, axis = OUT) {
  const unitAxis = normalize(axis, OUT);
  const centersOf = (n) => (Array.isArray(circlesCenters[0]) ? circlesCenters : Array.from({ length: n }, () => circlesCenters));
  return (start, end, alpha) => {
    const centers = centersOf(start.length).map((c) => [Number(c[0]), Number(c[1]), Number(c[2] ?? 0)]);
    const back = rotationMatrix(-arcAngle, unitAxis);
    const detransformed = rotateAll(end.map((p, i) => [p[0] - centers[i][0], p[1] - centers[i][1], p[2] - centers[i][2]]), back)
      .map((p, i) => [centers[i][0] + p[0], centers[i][1] + p[1], centers[i][2] + p[2]]);
    const rot = rotationMatrix(alpha * arcAngle, unitAxis);
    const mixed = straightPath()(start, detransformed, alpha)
      .map((p, i) => [p[0] - centers[i][0], p[1] - centers[i][1], p[2] - centers[i][2]]);
    return rotateAll(mixed, rot).map((p, i) => [centers[i][0] + p[0], centers[i][1] + p[1], centers[i][2] + p[2]]);
  };
}

export function pathAlongArc(arcAngle, axis = OUT) {
  if (Math.abs(arcAngle) < STRAIGHT_PATH_THRESHOLD) return straightPath();
  const unitAxis = normalize(axis, OUT);
  return (start, end, alpha) => {
    const centers = start.map((p, i) => {
      const v = [end[i][0] - p[0], end[i][1] - p[1], end[i][2] - p[2]];
      const c = [p[0] + 0.5 * v[0], p[1] + 0.5 * v[1], p[2] + 0.5 * v[2]];
      if (arcAngle !== Math.PI) {
        const k = cross(unitAxis, [v[0] / 2.0, v[1] / 2.0, v[2] / 2.0]);
        const t = Math.tan(arcAngle / 2);
        return [c[0] + k[0] / t, c[1] + k[1] / t, c[2] + k[2] / t];
      }
      return c;
    });
    const rot = rotationMatrix(alpha * arcAngle, unitAxis);
    return rotateAll(start.map((p, i) => [p[0] - centers[i][0], p[1] - centers[i][1], p[2] - centers[i][2]]), rot)
      .map((p, i) => [centers[i][0] + p[0], centers[i][1] + p[1], centers[i][2] + p[2]]);
  };
}

export const clockwisePath = () => pathAlongArc(-Math.PI);
export const counterclockwisePath = () => pathAlongArc(Math.PI);

export function spiralPath(angle, axis = OUT) {
  if (Math.abs(angle) < STRAIGHT_PATH_THRESHOLD) return straightPath();
  const unitAxis = normalize(axis, OUT);
  return (start, end, alpha) => {
    const rot = rotationMatrix((alpha - 1) * angle, unitAxis);
    const turned = rotateAll(end.map((q, i) => [q[0] - start[i][0], q[1] - start[i][1], q[2] - start[i][2]]), rot);
    return start.map((p, i) => [p[0] + alpha * turned[i][0], p[1] + alpha * turned[i][1], p[2] + alpha * turned[i][2]]);
  };
}
