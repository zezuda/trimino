import { Triangle, distance } from './geometry';
import { MIN_SIDE, Segment, buildLineGraph, keepMinimal } from './vector-lines';

/** Smallest allowed interior angle — rejects slivers made of nearly collinear nodes. */
const MIN_ANGLE_DEG = 15;

/**
 * Finds triangles drawn as vector lines (see {@link buildLineGraph}): every 3-cycle of
 * connected nodes is a candidate; slivers and tiny ones (decorations, corner markers)
 * are dropped, and so are triangles that contain a smaller one (e.g. the big outline
 * around a tessellation). Returned in page user space, in no particular order.
 */
export function detectTriangles(segments: Segment[]): Triangle[] {
  const { nodes, adjacent } = buildLineGraph(segments);
  const candidates: Triangle[] = [];
  for (let a = 0; a < nodes.length; a++) {
    for (const b of adjacent[a]) {
      if (b <= a) continue;
      for (const c of adjacent[b]) {
        if (c <= b || !adjacent[a].has(c)) continue;
        const t: Triangle = [nodes[a], nodes[b], nodes[c]];
        if (isPlausible(t)) candidates.push(t);
      }
    }
  }
  return keepMinimal(candidates);
}

function isPlausible(t: Triangle): boolean {
  const sides = [distance(t[1], t[2]), distance(t[0], t[2]), distance(t[0], t[1])];
  if (Math.min(...sides) < MIN_SIDE) return false;
  const [a, b, c] = sides;
  const angles = [
    Math.acos((b * b + c * c - a * a) / (2 * b * c)),
    Math.acos((a * a + c * c - b * b) / (2 * a * c)),
  ];
  angles.push(Math.PI - angles[0] - angles[1]);
  return Math.min(...angles) * (180 / Math.PI) >= MIN_ANGLE_DEG;
}
