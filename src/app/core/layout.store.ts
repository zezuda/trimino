import { Injectable, computed, signal } from '@angular/core';
import {
  CUSTOM_MM,
  LayoutTemplate,
  MM,
  Orientation,
  PaperPreset,
  Placement,
  SheetSize,
  SheetSpec,
  SourceDocument,
  presetSize,
} from './models';
import { normaliseAngle, placedTriangle } from './placement';

/** Current document, piece placements on the sheet and selection. */
@Injectable({ providedIn: 'root' })
export class LayoutStore {
  readonly source = signal<SourceDocument | null>(null);
  readonly orientation = signal<Orientation>('portrait');
  readonly preset = signal<PaperPreset>('A4');
  /** Size used when `preset` is 'custom', in points (already oriented). */
  readonly customSize = signal<SheetSize>(presetSize('A4', 'portrait'));
  /** Array order is the stacking order (last = on top). */
  readonly placements = signal<readonly Placement[]>([]);
  readonly selection = signal<ReadonlySet<number>>(new Set());
  /** The selected piece when exactly one is selected, else null. */
  readonly single = computed(() => (this.selection().size === 1 ? [...this.selection()][0] : null));

  readonly sheet = computed<SheetSize>(() =>
    this.preset() === 'custom' ? this.customSize() : presetSize(this.preset() as Exclude<PaperPreset, 'custom'>, this.orientation()),
  );

  /** Indexes of pieces reaching outside the sheet. */
  readonly overflowing = computed(() => {
    const src = this.source();
    const { width, height } = this.sheet();
    if (!src) return new Set<number>();
    return new Set(
      this.placements()
        .filter((p) =>
          placedTriangle(src.pieces[p.index], p).some((v) => v.x < -0.5 || v.y < -0.5 || v.x > width + 0.5 || v.y > height + 0.5),
        )
        .map((p) => p.index),
    );
  });

  /** Shows a new document with every piece where it was on the source page, centred on the sheet. */
  load(doc: SourceDocument): void {
    this.source.set(doc);
    this.clearSelection();
    this.resetLayout();
  }

  resetLayout(): void {
    const doc = this.source();
    if (!doc) return;
    const { width, height } = this.sheet();
    this.placements.set(
      doc.pieces.map((piece) => {
        const page = doc.pages[piece.page];
        return {
          index: piece.index,
          x: piece.centroid.x + (width - page.width) / 2,
          y: piece.centroid.y + (height - page.height) / 2,
          rotation: 0,
        };
      }),
    );
  }

  /**
   * Applies a template by piece index. Pieces the template does not know keep their
   * current place; returns how many pieces were placed from the template.
   */
  applyTemplate(t: LayoutTemplate): number {
    const doc = this.source();
    if (!doc) return 0;
    this.applySheet(t.sheet ?? { preset: 'A4', ...presetSize('A4', t.orientation) }, t.orientation);
    this.resetLayout();
    const fromTemplate = t.placements.filter((p) => p.index < doc.pieces.length);
    const used = new Set(fromTemplate.map((p) => p.index));
    this.placements.update((current) => [...current.filter((p) => !used.has(p.index)), ...fromTemplate]);
    return fromTemplate.length;
  }

  toTemplate(name: string, id: string = crypto.randomUUID()): LayoutTemplate {
    return {
      version: 1,
      id,
      name,
      orientation: this.orientation(),
      sheet: { preset: this.preset(), ...this.sheet() },
      pieceCount: this.source()?.pieces.length ?? 0,
      placements: this.placements(),
      createdAt: new Date().toISOString(),
    };
  }

  /** Switches orientation; a custom sheet swaps its width and height. */
  setOrientation(o: Orientation): void {
    if (o === this.orientation()) return;
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
    this.keepCentred(() => {
      if (p === 'custom') this.customSize.set(current);
      this.preset.set(p);
    });
  }

  /** Sets a custom size in mm (clamped to {@link CUSTOM_MM}); orientation follows the shape. */
  setCustomSizeMm(widthMm: number, heightMm: number): void {
    const clamp = (v: number) => Math.min(CUSTOM_MM.max, Math.max(CUSTOM_MM.min, v));
    this.keepCentred(() => {
      this.preset.set('custom');
      this.customSize.set({ width: clamp(widthMm) * MM, height: clamp(heightMm) * MM });
      if (widthMm !== heightMm) this.orientation.set(widthMm > heightMm ? 'landscape' : 'portrait');
    });
  }

  private applySheet(spec: SheetSpec, o: Orientation): void {
    this.orientation.set(o);
    this.preset.set(spec.preset);
    if (spec.preset === 'custom') this.customSize.set({ width: spec.width, height: spec.height });
  }

  /** Runs a sheet change, shifting pieces so the layout stays centred on the new sheet. */
  private keepCentred(change: () => void): void {
    const before = this.sheet();
    change();
    const after = this.sheet();
    const dx = (after.width - before.width) / 2;
    const dy = (after.height - before.height) / 2;
    if (dx || dy) this.placements.update((list) => list.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })));
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

  placementOf(index: number): Placement | undefined {
    return this.placements().find((p) => p.index === index);
  }
}
