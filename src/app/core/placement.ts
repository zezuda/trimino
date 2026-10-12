import { Matrix, Point, Polygon, apply, multiply, rotate, translate } from './geometry';
import { Piece, Placement } from './models';

/** Source view space → sheet space: move the centroid to the origin, rotate, then move to (x, y). */
export function placementMatrix(p: Placement, pieceCentroid: Point): Matrix {
  return multiply(translate(p.x, p.y), multiply(rotate(p.rotation), translate(-pieceCentroid.x, -pieceCentroid.y)));
}

/** Piece corners on the sheet. */
export function placedShape(piece: Piece, p: Placement): Polygon {
  const m = placementMatrix(p, piece.centroid);
  return piece.viewShape.map((v) => apply(m, v));
}

/** Normalises an angle to (-180, 180] so templates stay readable. */
export function normaliseAngle(deg: number): number {
  const a = ((((deg + 180) % 360) + 360) % 360) - 180;
  return a === -180 ? 180 : Math.round(a * 100) / 100;
}
