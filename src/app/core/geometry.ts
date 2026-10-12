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

/** Convex outline of a piece (a triangle or a rectangle), vertices in drawing order. */
export type Polygon = readonly Point[];

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

/** Vertex mean — the centroid for triangles and parallelograms, the only shapes pieces have. */
export function centroid(poly: Polygon): Point {
  return { x: poly.reduce((a, p) => a + p.x, 0) / poly.length, y: poly.reduce((a, p) => a + p.y, 0) / poly.length };
}

export function area(poly: Polygon): number {
  return Math.abs(signedArea(poly));
}

/** Shoelace area; positive for counter-clockwise vertices in a y-up space. */
function signedArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Strict point-in-convex-polygon test (points on an edge, within `eps`, count as outside). */
export function containsStrictly(poly: Polygon, p: Point, eps = 0.5): boolean {
  const sign = Math.sign(signedArea(poly));
  if (sign === 0) return false;
  // Signed distances to each edge, normalised so that inside is positive.
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const d = (sign * cross(p1, p2, p)) / distance(p1, p2);
    if (d <= eps) return false;
  }
  return true;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Grows a convex polygon outward by `d` on every side (each edge moves `d` along its
 * outward normal), used so clips keep the full width of the outline stroke.
 */
export function inflate(poly: Polygon, d: number): Polygon {
  const sign = Math.sign(signedArea(poly));
  const normal = (a: Point, b: Point): Point => {
    const len = distance(a, b);
    return { x: (sign * (b.y - a.y)) / len, y: (-sign * (b.x - a.x)) / len };
  };
  return poly.map((v, i) => {
    const n1 = normal(poly[(i + poly.length - 1) % poly.length], v);
    const n2 = normal(v, poly[(i + 1) % poly.length]);
    // Miter: the corner moves along the bisector far enough that both edges move by d.
    const k = d / (1 + n1.x * n2.x + n1.y * n2.y);
    return { x: v.x + (n1.x + n2.x) * k, y: v.y + (n1.y + n2.y) * k };
  });
}
