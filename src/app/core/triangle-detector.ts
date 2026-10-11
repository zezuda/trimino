import {
  IDENTITY,
  Matrix,
  Point,
  Triangle,
  apply,
  area,
  centroid,
  containsStrictly,
  distance,
  multiply,
} from './geometry';

/**
 * Finds triangles drawn as vector lines in a PDF page.
 *
 * Works on the pdf.js operator list, so it does not care how the generator drew them:
 * one closed path per triangle, three loose lines, or long lines crossing the whole
 * sheet (a triangular grid) all produce the same result. Steps:
 *
 *  1. collect every stroked straight segment, mapped to page user space through the CTM
 *     and cut to the visible part when a (convex) clipping path is active;
 *  2. merge collinear, overlapping segments into maximal lines;
 *  3. take every segment endpoint and every crossing of two lines as a node; two nodes
 *     are connected when a single merged line covers the whole gap between them;
 *  4. every 3-cycle of connected nodes is a candidate triangle; slivers and tiny ones
 *     (decorations, corner markers) are dropped, and so are triangles that contain a
 *     smaller one (e.g. the big outline around a tessellation).
 *
 * Raster-only PDFs (scans) contain no vector paths and yield no triangles.
 */

/** pdf.js opcodes the detector needs (`OPS` from pdfjs-dist), passed in to keep this module DOM-free. */
export interface DetectorOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  clip: number;
  eoClip: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
}

export interface OperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

interface Segment {
  a: Point;
  b: Point;
}

/** pdf.js `DrawOPS` codes inside the constructPath float array. */
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const QUAD = 3;
const CLOSE = 4;

/** Geometric tolerance in PDF points (1 pt = 0.35 mm). */
const EPS = 0.5;
/** Shortest triangle side we consider a real piece (≈ 1 cm). */
const MIN_SIDE = 28;
/** Smallest allowed interior angle — rejects slivers made of nearly collinear nodes. */
const MIN_ANGLE_DEG = 15;
/** Safety caps against pathological pages (e.g. text converted to outlines). */
const MAX_SEGMENTS = 20000;
const MAX_NODES = 3000;

export function extractStrokedSegments(list: OperatorList, ops: DetectorOps): Segment[] {
  const stroking = new Set([
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  const segments: Segment[] = [];
  const stack: GraphicsState[] = [];
  let state: GraphicsState = { ctm: IDENTITY, clips: [] };
  let clipPending = false;

  for (let i = 0; i < list.fnArray.length && segments.length < MAX_SEGMENTS; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as unknown[] | null;

    if (fn === ops.save) {
      stack.push(state);
    } else if (fn === ops.restore) {
      state = stack.pop() ?? { ctm: IDENTITY, clips: [] };
    } else if (fn === ops.transform) {
      state = { ...state, ctm: multiply(state.ctm, args as unknown as Matrix) };
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(state);
      const m = args?.[0] as Matrix | null | undefined;
      if (m) state = { ...state, ctm: multiply(state.ctm, m) };
    } else if (fn === ops.paintFormXObjectEnd) {
      state = stack.pop() ?? { ctm: IDENTITY, clips: [] };
    } else if (fn === ops.clip || fn === ops.eoClip) {
      clipPending = true; // applies to the path constructed next
    } else if (fn === ops.constructPath && args) {
      const paintOp = args[0] as number;
      const data = (args[1] as unknown[] | undefined)?.[0];
      if (!isNumberArray(data)) continue;
      const path = parsePath(data, state.ctm);

      if (clipPending) {
        clipPending = false;
        // Only convex straight-edged clips are honoured (our own exports and typical
        // generators); anything else is ignored, i.e. treated as no clip.
        const polygon = path.closedPolygon && toConvexCcw(path.closedPolygon);
        if (polygon) state = { ...state, clips: [...state.clips, polygon] };
      }
      if (stroking.has(paintOp)) {
        for (const seg of path.segments) {
          const visible = state.clips.reduce<Segment | null>((s, c) => s && clipSegment(s, c), seg);
          if (visible && distance(visible.a, visible.b) > EPS) segments.push(visible);
        }
      }
    }
  }
  return segments;
}

interface GraphicsState {
  ctm: Matrix;
  /** Active clipping polygons (convex, counter-clockwise), in user space. */
  clips: readonly Point[][];
}

function isNumberArray(v: unknown): v is ArrayLike<number> {
  return v instanceof Float32Array || v instanceof Float64Array || Array.isArray(v);
}

/**
 * Decodes a pdf.js path into straight segments (curves are skipped) mapped through
 * the CTM. `closedPolygon` is set when the path is a single straight-edged shape.
 */
function parsePath(d: ArrayLike<number>, ctm: Matrix): { segments: Segment[]; closedPolygon: Point[] | null } {
  const segments: Segment[] = [];
  const points: Point[] = [];
  let subpaths = 0;
  let hasCurves = false;
  let start: Point | null = null;
  let current: Point | null = null;
  const push = (a: Point, b: Point) => {
    if (distance(a, b) > EPS) segments.push({ a: apply(ctm, a), b: apply(ctm, b) });
  };

  for (let i = 0; i < d.length; ) {
    switch (d[i++]) {
      case MOVE:
        current = start = { x: d[i++], y: d[i++] };
        subpaths++;
        points.push(current);
        break;
      case LINE: {
        const p = { x: d[i++], y: d[i++] };
        if (current) push(current, p);
        current = p;
        points.push(p);
        break;
      }
      case CURVE:
        i += 4;
        current = { x: d[i++], y: d[i++] };
        hasCurves = true;
        break;
      case QUAD:
        i += 2;
        current = { x: d[i++], y: d[i++] };
        hasCurves = true;
        break;
      case CLOSE:
        if (current && start) push(current, start);
        current = start;
        break;
      default:
        // Unknown encoding — keep what was read so far rather than misread the rest.
        return { segments, closedPolygon: null };
    }
  }
  const closedPolygon = subpaths === 1 && !hasCurves && points.length >= 3 ? points.map((p) => apply(ctm, p)) : null;
  return { segments, closedPolygon };
}

/** Returns the polygon counter-clockwise (in the y-up sense) if it is convex, else null. */
function toConvexCcw(poly: Point[]): Point[] | null {
  const pts = poly.filter((p, i) => distance(p, poly[(i + 1) % poly.length]) > EPS);
  if (pts.length < 3) return null;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return null;
  }
  if (sign === 0) return null;
  return sign > 0 ? pts : [...pts].reverse();
}

/** Cyrus–Beck: the part of a segment inside a convex counter-clockwise polygon, or null. */
function clipSegment(s: Segment, poly: Point[]): Segment | null {
  let t0 = 0;
  let t1 = 1;
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    // Inward normal of edge p→q for a counter-clockwise polygon.
    const nx = -(q.y - p.y);
    const ny = q.x - p.x;
    const len = Math.hypot(nx, ny);
    const num = (nx * (s.a.x - p.x) + ny * (s.a.y - p.y)) / len + EPS; // tolerate the bleed
    const den = (nx * dx + ny * dy) / len;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null;
    } else {
      const t = -num / den;
      if (den > 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  return {
    a: { x: s.a.x + dx * t0, y: s.a.y + dy * t0 },
    b: { x: s.a.x + dx * t1, y: s.a.y + dy * t1 },
  };
}

/** A maximal straight line: unit direction, origin and covered intervals along it. */
interface Line {
  o: Point;
  dir: Point;
  /** Merged [from, to] parameter intervals, in points along `dir`. */
  spans: [number, number][];
}

function mergeCollinear(segments: Segment[]): Line[] {
  const lines: Line[] = [];
  for (const s of segments) {
    let dx = s.b.x - s.a.x;
    let dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    // Canonical direction so that opposite segments land on the same line.
    if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) {
      dx = -dx;
      dy = -dy;
    }
    let line = lines.find(
      (l) =>
        Math.abs(l.dir.x * dy - l.dir.y * dx) < 0.004 && // ~0.25°
        Math.abs((s.a.x - l.o.x) * l.dir.y - (s.a.y - l.o.y) * l.dir.x) < EPS,
    );
    if (!line) {
      line = { o: s.a, dir: { x: dx, y: dy }, spans: [] };
      lines.push(line);
    }
    const t1 = param(line, s.a);
    const t2 = param(line, s.b);
    line.spans.push([Math.min(t1, t2), Math.max(t1, t2)]);
  }

  for (const l of lines) {
    l.spans.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const s of l.spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + EPS) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    l.spans = merged;
  }
  return lines;
}

const param = (l: Line, p: Point) => (p.x - l.o.x) * l.dir.x + (p.y - l.o.y) * l.dir.y;
const pointAt = (l: Line, t: number): Point => ({ x: l.o.x + l.dir.x * t, y: l.o.y + l.dir.y * t });
const covered = (l: Line, t: number) => l.spans.some(([a, b]) => t >= a - EPS && t <= b + EPS);

/** Detects triangles, in page user space and in no particular order (see {@link sortReadingOrder}). */
export function detectTriangles(segments: Segment[]): Triangle[] {
  const lines = mergeCollinear(segments);

  // Nodes: span endpoints plus pairwise crossings that lie on both lines' spans.
  const nodes: Point[] = [];
  const nodeIndex = new Map<string, number>();
  const addNode = (p: Point): number => {
    const key = `${Math.round(p.x / EPS)},${Math.round(p.y / EPS)}`;
    const found = nodeIndex.get(key) ?? findNear(nodes, p);
    if (found !== undefined) return found;
    nodes.push(p);
    nodeIndex.set(key, nodes.length - 1);
    return nodes.length - 1;
  };

  for (const l of lines) {
    for (const [a, b] of l.spans) {
      addNode(pointAt(l, a));
      addNode(pointAt(l, b));
    }
  }
  for (let i = 0; i < lines.length && nodes.length < MAX_NODES; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = intersect(lines[i], lines[j]);
      if (p && covered(lines[i], param(lines[i], p)) && covered(lines[j], param(lines[j], p))) addNode(p);
    }
  }

  // Adjacency: nodes lying on the same line, connected when one span covers both.
  const adjacent = nodes.map(() => new Set<number>());
  for (const l of lines) {
    const onLine = nodes
      .map((p, idx) => ({ idx, t: param(l, p), off: Math.abs((p.x - l.o.x) * l.dir.y - (p.y - l.o.y) * l.dir.x) }))
      .filter((n) => n.off < EPS && covered(l, n.t));
    for (const [from, to] of l.spans) {
      const inSpan = onLine.filter((n) => n.t >= from - EPS && n.t <= to + EPS);
      for (let i = 0; i < inSpan.length; i++) {
        for (let j = i + 1; j < inSpan.length; j++) {
          adjacent[inSpan[i].idx].add(inSpan[j].idx);
          adjacent[inSpan[j].idx].add(inSpan[i].idx);
        }
      }
    }
  }

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

  // Keep only minimal triangles: drop any that strictly contains a smaller candidate.
  const minimal = candidates.filter(
    (t) => !candidates.some((o) => o !== t && area(o) < area(t) - EPS && containsStrictly(t, centroid(o))),
  );
  return minimal;
}

function findNear(nodes: Point[], p: Point): number | undefined {
  const i = nodes.findIndex((n) => distance(n, p) < EPS);
  return i < 0 ? undefined : i;
}

function intersect(l1: Line, l2: Line): Point | null {
  const den = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.o.x - l1.o.x) * l2.dir.y - (l2.o.y - l1.o.y) * l2.dir.x) / den;
  return pointAt(l1, t);
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

/**
 * Reading order in a y-down space (as seen on screen): rows top to bottom with a
 * tolerance of a third of the typical triangle height, then left to right. This order
 * is what makes piece indexes stable between PDFs from the same generator.
 */
export function sortReadingOrder(tris: Triangle[]): Triangle[] {
  if (tris.length === 0) return tris;
  // Rows use the bounding-box middle, not the centroid: an up- and a down-pointing
  // triangle in the same row have centroids a third of their height apart.
  const items = tris.map((t) => {
    const ys = t.map((p) => p.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return { t, mid: (top + bottom) / 2, height: bottom - top, x: centroid(t).x };
  });
  const heights = items.map((i) => i.height).sort((p, q) => p - q);
  const tol = heights[Math.floor(heights.length / 2)] / 3;
  items.sort((p, q) => p.mid - q.mid);

  const rows: (typeof items)[] = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].mid - item.mid) <= tol) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((p, q) => p.x - q.x).map((i) => i.t));
}
