import { Injectable, computed, signal } from '@angular/core';
import {
  CUSTOM_MM,
  LayoutTemplate,
  MAX_SHEETS,
  MM,
  Orientation,
  PaperPreset,
  Placement,
  SheetSize,
  SheetSpec,
  SourceDocument,
  appendDocument,
  presetSize,
  scalePercent,
  sheetIndexAt,
  sheetRects,
  snapScale,
} from './models';
import { Polygon } from './geometry';
import { PieceKindId } from './piece-kind';
import { normaliseAngle, placedShape } from './placement';

/** Space between the sheet and the pages laid out beside it, in points. */
const PAGE_GAP = 10 * MM;
/** Undo steps kept. */
const HISTORY_LIMIT = 100;
/** Repeated steps of the same kind (e.g. arrow nudges) closer than this merge into one undo step. */
const MERGE_MS = 1000;

/** Everything undo restores: the layout and the sheets it sits on. */
interface Snapshot {
  readonly placements: readonly Placement[];
  readonly orientation: Orientation;
  readonly preset: PaperPreset;
  readonly customSize: SheetSize;
  readonly sheetCount: number;
}

/** Current document, piece placements on the sheet and selection; one per module (see app.routes.ts). */
@Injectable()
export class LayoutStore {
  readonly source = signal<SourceDocument | null>(null);
  readonly orientation = signal<Orientation>('portrait');
  readonly preset = signal<PaperPreset>('A4');
  /** Size used when `preset` is 'custom', in points (already oriented). */
  readonly customSize = signal<SheetSize>(presetSize('A4', 'portrait'));
  /** Number of output sheets (pages of the exported PDF), stacked top to bottom. */
  readonly sheetCount = signal(1);
  /** Array order is the stacking order (last = on top). */
  readonly placements = signal<readonly Placement[]>([]);
  readonly selection = signal<ReadonlySet<number>>(new Set());
  /** The selected piece when exactly one is selected, else null. */
  readonly single = computed(() => (this.selection().size === 1 ? [...this.selection()][0] : null));

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastStep: { kind: string; at: number } | null = null;

  readonly sheet = computed<SheetSize>(() =>
    this.preset() === 'custom' ? this.customSize() : presetSize(this.preset() as Exclude<PaperPreset, 'custom'>, this.orientation()),
  );

  /** Every output sheet with its place on the board. */
  readonly sheets = computed(() => sheetRects(this.sheet(), this.sheetCount()));

  /** Indexes of pieces not lying wholly on one sheet. */
  readonly overflowing = computed(() => {
    const src = this.source();
    const sheets = this.sheets();
    if (!src) return new Set<number>();
    const inside = (shape: Polygon) =>
      sheets.some((r) =>
        shape.every((v) => v.x >= r.x - 0.5 && v.y >= r.y - 0.5 && v.x <= r.x + r.width + 0.5 && v.y <= r.y + r.height + 0.5),
      );
    return new Set(this.placements().filter((p) => !inside(placedShape(src.pieces[p.index], p))).map((p) => p.index));
  });

  /**
   * Adds a loaded PDF. The first one is shown with every piece where it was on the source
   * page, centred on the sheet; the pages of each further one are laid out in a row to the
   * right of everything already there. Undo history is cleared, as it does not track files.
   */
  add(doc: SourceDocument): void {
    const current = this.source();
    if (!current) {
      this.source.set(doc);
      this.layOutPages();
    } else {
      const merged = appendDocument(current, doc);
      const right = Math.max(
        this.sheet().width,
        ...this.placements().flatMap((p) => placedShape(current.pieces[p.index], p).map((v) => v.x)),
      );
      this.source.set(merged);
      this.placements.update((list) => [...list, ...this.pagePlacements(merged, current.pages.length, right + PAGE_GAP)]);
    }
    this.clearSelection();
    this.resetHistory();
  }

  /** Removes every loaded file and its pieces. */
  clear(): void {
    this.source.set(null);
    this.placements.set([]);
    this.clearSelection();
    this.resetHistory();
  }

  private resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastStep = null;
  }

  /** Back to the original positions (an undoable step). */
  resetLayout(): void {
    this.checkpoint();
    this.layOutPages();
  }

  /**
   * Records the current state as an undo step; call it before a change. Steps of the same
   * `kind` in quick succession (holding an arrow key) collapse into the first one.
   */
  checkpoint(kind?: string): void {
    const now = Date.now();
    const merge = kind !== undefined && this.lastStep?.kind === kind && now - this.lastStep.at < MERGE_MS;
    this.lastStep = kind === undefined ? null : { kind, at: now };
    if (merge) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): boolean {
    return this.travel(this.undoStack, this.redoStack);
  }

  redo(): boolean {
    return this.travel(this.redoStack, this.undoStack);
  }

  /** Restores the newest step of `from` that differs from now (a click without a drag records none). */
  private travel(from: Snapshot[], to: Snapshot[]): boolean {
    const current = this.snapshot();
    this.lastStep = null;
    let target: Snapshot | undefined;
    while ((target = from.pop()) && sameSnapshot(target, current));
    if (!target) return false;
    to.push(current);
    this.placements.set(target.placements);
    this.orientation.set(target.orientation);
    this.preset.set(target.preset);
    this.customSize.set(target.customSize);
    this.sheetCount.set(target.sheetCount);
    return true;
  }

  private snapshot(): Snapshot {
    return {
      placements: this.placements(),
      orientation: this.orientation(),
      preset: this.preset(),
      customSize: this.customSize(),
      sheetCount: this.sheetCount(),
    };
  }

  /**
   * The first page is centred on the sheet; every further page is laid out to the right
   * of it, outside the sheet, so pages do not cover each other.
   */
  private layOutPages(): void {
    const doc = this.source();
    if (doc) this.placements.set(this.pagePlacements(doc, 0, null));
  }

  /**
   * Placements for the pieces on pages `fromPage`… at their spot on their page, at full size.
   * The pages go in a row to the right from `startX`; with `startX` null the first of them
   * is centred on the sheet and the rest start beside the sheet.
   */
  private pagePlacements(doc: SourceDocument, fromPage: number, startX: number | null): Placement[] {
    const { width, height } = this.sheet();
    const offsets = new Map<number, number>();
    let nextX = startX ?? width + PAGE_GAP;
    doc.pages.forEach((page, i) => {
      if (i < fromPage) return;
      if (i === fromPage && startX === null) {
        offsets.set(i, (width - page.width) / 2);
      } else {
        offsets.set(i, nextX);
        nextX += page.width + PAGE_GAP;
      }
    });
    return doc.pieces
      .filter((piece) => offsets.has(piece.page))
      .map((piece) => {
        const page = doc.pages[piece.page];
        return {
          index: piece.index,
          x: piece.centroid.x + offsets.get(piece.page)!,
          y: piece.centroid.y + (height - page.height) / 2,
          rotation: 0,
          scale: 1,
        };
      });
  }

  /**
   * Applies a template by piece index. Pieces the template does not know keep their
   * current place; returns how many pieces were placed from the template.
   */
  applyTemplate(t: LayoutTemplate): number {
    const doc = this.source();
    if (!doc) return 0;
    this.checkpoint();
    this.applySheet(t.sheet ?? { preset: 'A4', ...presetSize('A4', t.orientation) }, t.orientation);
    this.sheetCount.set(t.sheetCount ?? 1);
    this.layOutPages();
    const fromTemplate = t.placements.filter((p) => p.index < doc.pieces.length);
    const used = new Set(fromTemplate.map((p) => p.index));
    this.placements.update((current) => [...current.filter((p) => !used.has(p.index)), ...fromTemplate]);
    return fromTemplate.length;
  }

  toTemplate(kind: PieceKindId, name: string, id: string = crypto.randomUUID()): LayoutTemplate {
    return {
      version: 1,
      id,
      kind,
      name,
      orientation: this.orientation(),
      sheet: { preset: this.preset(), ...this.sheet() },
      sheetCount: this.sheetCount(),
      pieceCount: this.source()?.pieces.length ?? 0,
      placements: this.placements(),
      createdAt: new Date().toISOString(),
    };
  }

  /** Switches orientation; a custom sheet swaps its width and height. */
  setOrientation(o: Orientation): void {
    if (o === this.orientation()) return;
    this.checkpoint();
    this.keepCentred(() => {
      this.orientation.set(o);
      if (this.preset() === 'custom') {
        const { width, height } = this.customSize();
        this.customSize.set({ width: height, height: width });
      }
    });
  }

  /** Picks a paper preset; 'custom' starts from the current size. */
  setPreset(p: PaperPreset): void {
    if (p === this.preset()) return;
    const current = this.sheet();
    this.checkpoint();
    this.keepCentred(() => {
      if (p === 'custom') this.customSize.set(current);
      this.preset.set(p);
    });
  }

  /** Sets a custom size in mm (clamped to {@link CUSTOM_MM}); orientation follows the shape. */
  setCustomSizeMm(widthMm: number, heightMm: number): void {
    const clamp = (v: number) => Math.min(CUSTOM_MM.max, Math.max(CUSTOM_MM.min, v));
    this.checkpoint();
    this.keepCentred(() => {
      this.preset.set('custom');
      this.customSize.set({ width: clamp(widthMm) * MM, height: clamp(heightMm) * MM });
      if (widthMm !== heightMm) this.orientation.set(widthMm > heightMm ? 'landscape' : 'portrait');
    });
  }

  /**
   * Adds a sheet below the last one, or removes the last one; pieces lying on a removed
   * sheet stay where they are (and show as outside the sheets).
   */
  addSheet(delta: 1 | -1): void {
    const count = this.sheetCount() + delta;
    if (count < 1 || count > MAX_SHEETS) return;
    this.checkpoint();
    this.sheetCount.set(count);
  }

  private applySheet(spec: SheetSpec, o: Orientation): void {
    this.orientation.set(o);
    this.preset.set(spec.preset);
    if (spec.preset === 'custom') this.customSize.set({ width: spec.width, height: spec.height });
  }

  /**
   * Runs a sheet change, shifting pieces so the layout of each sheet stays centred on it
   * (the sheets below move with a change of height).
   */
  private keepCentred(change: () => void): void {
    const before = this.sheet();
    change();
    const after = this.sheet();
    const dx = (after.width - before.width) / 2;
    const dh = after.height - before.height;
    if (!dx && !dh) return;
    const count = this.sheetCount();
    this.placements.update((list) =>
      list.map((p) => ({ ...p, x: p.x + dx, y: p.y + (sheetIndexAt(p.y, before, count) + 0.5) * dh })),
    );
  }

  update(index: number, change: Partial<Omit<Placement, 'index'>>): void {
    this.placements.update((list) =>
      list.map((p) =>
        p.index === index
          ? { ...p, ...change, ...(change.rotation !== undefined && { rotation: normaliseAngle(change.rotation) }) }
          : p,
      ),
    );
  }

  /**
   * Replaces the selection, optionally raising the pieces to the top of the stack (in
   * their current order). Keyboard focus does not raise: re-ordering the DOM would drop
   * focus from the element being focused.
   */
  select(indexes: Iterable<number>, raise = false): void {
    const set = new Set(indexes);
    this.selection.set(set);
    if (!raise || set.size === 0) return;
    this.placements.update((list) => [...list.filter((p) => !set.has(p.index)), ...list.filter((p) => set.has(p.index))]);
  }

  toggle(index: number): void {
    const set = new Set(this.selection());
    if (!set.delete(index)) set.add(index);
    this.selection.set(set);
  }

  clearSelection(): void {
    if (this.selection().size) this.selection.set(new Set());
  }

  selectAll(): void {
    this.selection.set(new Set(this.placements().map((p) => p.index)));
  }

  /** Sets several centre positions in one update (group drag). */
  setPositions(positions: ReadonlyMap<number, { x: number; y: number }>): void {
    this.placements.update((list) => list.map((p) => (positions.has(p.index) ? { ...p, ...positions.get(p.index)! } : p)));
  }

  moveSelection(dx: number, dy: number): void {
    const sel = this.selection();
    if (sel.size === 0) return;
    this.checkpoint('nudge');
    this.placements.update((list) => list.map((p) => (sel.has(p.index) ? { ...p, x: p.x + dx, y: p.y + dy } : p)));
  }

  /**
   * Rotates the selection as one rigid block around the mean of the piece centres, so
   * an assembled group stays assembled. A single piece just turns in place.
   */
  rotateSelection(deg: number): void {
    const sel = this.selection();
    const chosen = this.placements().filter((p) => sel.has(p.index));
    if (chosen.length === 0) return;
    this.checkpoint();
    const cx = chosen.reduce((a, p) => a + p.x, 0) / chosen.length;
    const cy = chosen.reduce((a, p) => a + p.y, 0) / chosen.length;
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    this.placements.update((list) =>
      list.map((p) =>
        sel.has(p.index)
          ? {
              ...p,
              x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
              y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
              rotation: normaliseAngle(p.rotation + deg),
            }
          : p,
      ),
    );
  }

  /**
   * Resizes every selected piece to `toPercent(its current percent)`, rounded to the
   * allowed step. Piece centres move with it, relative to the mean of the centres (as in
   * {@link rotateSelection}), so an assembled group grows or shrinks as one block.
   */
  resizeSelection(toPercent: (percent: number) => number): void {
    const sel = this.selection();
    const chosen = this.placements().filter((p) => sel.has(p.index));
    if (chosen.length === 0) return;
    this.checkpoint('resize');
    const cx = chosen.reduce((a, p) => a + p.x, 0) / chosen.length;
    const cy = chosen.reduce((a, p) => a + p.y, 0) / chosen.length;
    this.placements.update((list) =>
      list.map((p) => {
        if (!sel.has(p.index)) return p;
        const scale = snapScale(toPercent(scalePercent(p.scale)));
        const k = scale / p.scale;
        return { ...p, x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k, scale };
      }),
    );
  }

  placementOf(index: number): Placement | undefined {
    return this.placements().find((p) => p.index === index);
  }
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.orientation === b.orientation &&
    a.preset === b.preset &&
    a.customSize.width === b.customSize.width &&
    a.customSize.height === b.customSize.height &&
    a.sheetCount === b.sheetCount &&
    a.placements.length === b.placements.length &&
    a.placements.every((p, i) => {
      const q = b.placements[i];
      return p.index === q.index && p.x === q.x && p.y === q.y && p.rotation === q.rotation && p.scale === q.scale;
    })
  );
}
