import { Point, Polygon, distance } from './geometry';
import { EPS, MIN_SIDE, Segment, buildLineGraph, keepMinimal } from './vector-lines';

/** Longest stroke still taken for a crop mark (≈ 15 mm); real outlines are longer. */
const MAX_CROP_MARK = 43;
/** |cos| of the corner angle allowed for a right angle (≈ 0.6°). */
const RIGHT_ANGLE_COS = 0.01;

/**
 * Finds rectangles (domino cards) on a page, in page user space and in no particular
 * order. Outlines drawn as lines are used when there are any (see {@link buildLineGraph}).
 * Generators that draw the cards as filled areas only mark the cuts with crop marks in
 * the margin; then each pair of marks facing each other across the page becomes a cut
 * line and the cells of that grid are the pieces.
 */
export function detectRectangles(segments: Segment[]): Polygon[] {
  const outlined = findRectangles(segments);
  return outlined.length ? outlined : findRectangles(cutLinesFromCropMarks(segments));
}

/** Every 4-cycle of connected nodes with right-angled corners; only the smallest ones are kept. */
function findRectangles(segments: Segment[]): Polygon[] {
  const { nodes, adjacent, find } = buildLineGraph(segments);
  const candidates: Polygon[] = [];
  for (let a = 0; a < nodes.length; a++) {
    const near = [...adjacent[a]];
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const [b, c] = [near[i], near[j]];
        // Found once from each corner; keep the copy seen from its lowest-numbered one.
        if (b < a || c < a) continue;
        const pa = nodes[a];
        const pb = nodes[b];
        const pc = nodes[c];
        const ab = distance(pa, pb);
        const ac = distance(pa, pc);
        if (Math.min(ab, ac) < MIN_SIDE) continue;
        const dot = (pb.x - pa.x) * (pc.x - pa.x) + (pb.y - pa.y) * (pc.y - pa.y);
        if (Math.abs(dot) / (ab * ac) > RIGHT_ANGLE_COS) continue;
        const d = find({ x: pb.x + pc.x - pa.x, y: pb.y + pc.y - pa.y });
        if (d === undefined || d < a || !adjacent[b].has(d) || !adjacent[c].has(d)) continue;
        candidates.push([pa, pb, nodes[d], pc]);
      }
    }
  }
  return keepMinimal(candidates);
}

/**
 * Turns crop marks into cut lines: short horizontal (vertical) strokes lying on the same
 * horizontal (vertical) line, at least one piece apart, are joined into one long line.
 * A single mark, or marks close together (text underlines, the corner of an L-mark),
 * produce nothing.
 */
function cutLinesFromCropMarks(segments: Segment[]): Segment[] {
  const groups: { horizontal: boolean; at: number; spans: [number, number][] }[] = [];
  for (const s of segments) {
    if (distance(s.a, s.b) > MAX_CROP_MARK) continue;
    const horizontal = Math.abs(s.a.y - s.b.y) < EPS;
    if (!horizontal && Math.abs(s.a.x - s.b.x) >= EPS) continue; // slanted: not a crop mark
    const at = horizontal ? s.a.y : s.a.x;
    const [p, q] = horizontal ? [s.a.x, s.b.x] : [s.a.y, s.b.y];
    let g = groups.find((x) => x.horizontal === horizontal && Math.abs(x.at - at) < EPS);
    if (!g) groups.push((g = { horizontal, at, spans: [] }));
    g.spans.push([Math.min(p, q), Math.max(p, q)]);
  }

  const lines: Segment[] = [];
  for (const g of groups) {
    const spans = g.spans.sort((p, q) => p[0] - q[0]);
    let reach = spans[0][1];
    let gap = false;
    for (const [from, to] of spans.slice(1)) {
      gap ||= from - reach >= MIN_SIDE;
      reach = Math.max(reach, to);
    }
    if (!gap) continue;
    const point = (t: number): Point => (g.horizontal ? { x: t, y: g.at } : { x: g.at, y: t });
    lines.push({ a: point(spans[0][0]), b: point(reach) });
  }
  return lines;
}
