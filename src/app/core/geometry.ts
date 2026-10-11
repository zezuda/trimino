/**
 * Small 2D geometry toolkit shared by detection, the artboard and the PDF export.
 *
 * Matrices follow the PDF / canvas convention `[a, b, c, d, e, f]`, i.e.
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export type Matrix = readonly [number, number, number, number, number, number];

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Triangle = readonly [Point, Point, Point];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Returns `m1 · m2` — applying the result equals applying `m2` first, then `m1`. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

/** Rotation by `deg` degrees; clockwise on screen in a y-down space. */
export function rotate(deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export function centroid(t: Triangle): Point {
  return { x: (t[0].x + t[1].x + t[2].x) / 3, y: (t[0].y + t[1].y + t[2].y) / 3 };
}

export function area(t: Triangle): number {
  return Math.abs((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y)) / 2;
}

/** Strict point-in-triangle test (points on an edge, within `eps`, count as outside). */
export function containsStrictly(t: Triangle, p: Point, eps = 0.5): boolean {
  const a = area(t);
  if (a === 0) return false;
  // Signed distances to each edge, normalised so that inside is positive.
  const sign = Math.sign(cross(t[0], t[1], t[2]));
  for (let i = 0; i < 3; i++) {
    const p1 = t[i];
    const p2 = t[(i + 1) % 3];
    const d = (sign * cross(p1, p2, p)) / distance(p1, p2);
    if (d <= eps) return false;
  }
  return true;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Grows a triangle outward by `d` on every side (each edge moves `d` away from the
 * incentre), used so clips keep the full width of the outline stroke.
 */
export function inflate(t: Triangle, d: number): Triangle {
  const a = distance(t[1], t[2]);
  const b = distance(t[0], t[2]);
  const c = distance(t[0], t[1]);
  const p = a + b + c;
  const incentre = {
    x: (a * t[0].x + b * t[1].x + c * t[2].x) / p,
    y: (a * t[0].y + b * t[1].y + c * t[2].y) / p,
  };
  const inradius = (2 * area(t)) / p;
  const k = (inradius + d) / inradius;
  return t.map((v) => ({
    x: incentre.x + (v.x - incentre.x) * k,
    y: incentre.y + (v.y - incentre.y) * k,
  })) as unknown as Triangle;
}
