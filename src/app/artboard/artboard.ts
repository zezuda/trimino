import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { Point, distance } from '../core/geometry';
import { LayoutStore } from '../core/layout.store';
import { HEADER_FONT_FAMILY, loadHeaderFontFace } from '../core/header-font';
import {
  HEADER,
  MAX_SHEETS,
  MM,
  Piece,
  Placement,
  SCALE_PERCENT,
  SHEET_GAP,
  SheetRect,
  hasHeader,
  headerSize,
  scalePercent,
  sheetIndexAt,
} from '../core/models';
import { PIECE_KIND } from '../core/piece-kind';
import { placedShape } from '../core/placement';

/** Snap distance in screen pixels (converted to sheet units on the fly). */
const SNAP_PX = 12;
const ROTATE_SNAP_DEG = 15;
/** Below this many screen pixels a background drag counts as a click. */
const CLICK_PX = 3;
/** Height of the "add a page" button below the last sheet, in points. */
const ADD_SHEET_HEIGHT = 18 * MM;
/** Margin kept around pieces lying outside the sheet, in points. */
const VIEW_MARGIN = 10 * MM;

const NO_GUIDES = { sheet: null, vertical: false, horizontal: false };

type Drag =
  | { kind: 'move'; start: Point; origins: ReadonlyMap<number, Point>; pointerId: number }
  | { kind: 'rotate'; index: number; pointerId: number }
  | { kind: 'marquee'; start: Point; base: ReadonlySet<number>; pointerId: number };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The sheet with the pieces.
 *
 * Pointer: click selects a piece, Shift+click adds/removes it; dragging on an empty spot
 * draws a selection box (Shift adds to the selection) — a piece is caught when its centre
 * is inside the box, so neighbours that merely touch a dense layout are not. Dragging a
 * selected piece moves the whole selection. While moving, corners snap to corners of the
 * other pieces and the selection's centre snaps to the sheet's centre lines (a guide line
 * shows it); Alt disables snapping. The round handle of a single selected piece rotates
 * it (15° steps, Shift for free angle).
 *
 * Keyboard: arrows move the selection 1 mm (Shift 10 mm), R / Shift+R rotate it by the
 * module's step (60° triangles, 90° rectangles) as one block, + / − resize it by 5 %,
 * Ctrl/Cmd+A selects all, Esc clears. Undo/redo (Ctrl/Cmd+Z, Ctrl+Y) is
 * handled app-wide in App. The selection toolbar in the app
 * offers the same without dragging.
 */
@Component({
  selector: 'app-artboard',
  templateUrl: './artboard.html',
  styleUrl: './artboard.css',
})
export class Artboard {
  protected readonly store = inject(LayoutStore);
  protected readonly kind = inject(PIECE_KIND);
  private readonly injector = inject(Injector);
  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Space for the drawing inside the scrolling host, in CSS pixels; 0 until measured. */
  private readonly viewport = signal({ width: 0, height: 0 });
  private drag: Drag | null = null;

  protected readonly marquee = signal<Rect | null>(null);
  /** Which centre lines of which sheet the dragged selection is snapped to. */
  protected readonly guides = signal<{ sheet: SheetRect | null; vertical: boolean; horizontal: boolean }>(NO_GUIDES);

  protected readonly pieces = computed(() => this.store.source()?.pieces ?? []);

  protected readonly HEADER = HEADER;
  /** Where the "add a page" button goes, below the last sheet; null once no more can be added. */
  protected readonly addSheetBox = computed(() => {
    const last = this.store.sheets().at(-1)!;
    return this.store.sheetCount() < MAX_SHEETS
      ? { x: last.x, y: last.y + last.height + SHEET_GAP, width: last.width, height: ADD_SHEET_HEIGHT }
      : null;
  });
  protected readonly HEADER_FONT_FAMILY = HEADER_FONT_FAMILY;
  /** Set once the header font is in the page, so the preview can be measured with it. */
  private readonly headerFontReady = signal(false);
  private readonly measure = document.createElement('canvas').getContext('2d');
  /** Header as previewed on each sheet (null where it is not printed), sized like the export. */
  protected readonly headers = computed(() => {
    const header = this.store.header();
    const text = header.text.trim();
    let width1 = 0;
    if (text && this.headerFontReady() && this.measure) {
      this.measure.font = `100px "${HEADER_FONT_FAMILY}"`;
      width1 = this.measure.measureText(text).width / 100;
    }
    return this.store.sheets().map((r, k) => (hasHeader(header, k) ? { text, size: headerSize(width1, r.width) } : null));
  });

  constructor() {
    const observer = new ResizeObserver(([entry]) =>
      this.viewport.set({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(this.host.nativeElement);
    inject(DestroyRef).onDestroy(() => observer.disconnect());

    effect(() => {
      if (this.store.header().text.trim() && !this.headerFontReady()) {
        loadHeaderFontFace().then(
          () => this.headerFontReady.set(true),
          (e) => console.error(e), // the preview falls back to the page font
        );
      }
    });
  }
  protected readonly sheetLabel = computed(() => {
    const { width, height } = this.store.sheet();
    const n = this.store.sheetCount();
    return `${n === 1 ? 'Stránka' : `${n} stránky`} ${Math.round(width / MM)} × ${Math.round(height / MM)} mm`;
  });
  /** True while a pointer drag runs; the view is not refitted then, so the zoom stays put. */
  private readonly dragging = signal(false);
  /**
   * The sheets (with the button below them) plus every piece lying outside them (e.g. the further pages of a multi-page
   * PDF, which start beside the sheet), so all pieces stay visible and reachable.
   */
  private readonly bounds = linkedSignal<
    { dragging: boolean; last: SheetRect; add: Rect | null; pieces: readonly Piece[]; placements: readonly Placement[] },
    Rect
  >({
    source: () => ({
      dragging: this.dragging(),
      last: this.store.sheets().at(-1)!,
      add: this.addSheetBox(),
      pieces: this.pieces(),
      placements: this.store.placements(),
    }),
    computation: ({ dragging, last, add, pieces, placements }, previous) => {
      if (dragging && previous) return previous.value;
      const width = last.width;
      const height = add ? add.y + add.height : last.y + last.height;
      let [minX, minY, maxX, maxY] = [0, 0, width, height];
      for (const p of placements) {
        for (const v of placedShape(pieces[p.index], p)) {
          minX = Math.min(minX, v.x - VIEW_MARGIN);
          minY = Math.min(minY, v.y - VIEW_MARGIN);
          maxX = Math.max(maxX, v.x + VIEW_MARGIN);
          maxY = Math.max(maxY, v.y + VIEW_MARGIN);
        }
      }
      if (minX > -VIEW_MARGIN) minX = 0;
      if (minY > -VIEW_MARGIN) minY = 0;
      if (maxX < width + VIEW_MARGIN) maxX = width;
      if (maxY < height + VIEW_MARGIN) maxY = height;
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },
  });
  protected readonly viewBox = computed(() => {
    const b = this.bounds();
    return `${b.x} ${b.y} ${b.width} ${b.height}`;
  });
  /**
   * Screen pixels per point. One page (with the add button) fits the height of the board and
   * everything fits its width; further pages extend the drawing downwards and the board
   * scrolls, so adding a page does not shrink the others.
   */
  private readonly zoom = linkedSignal<{ dragging: boolean; width: number; view: { width: number; height: number } }, number>({
    source: () => ({ dragging: this.dragging(), width: this.bounds().width, view: this.viewport() }),
    computation: ({ dragging, width, view }, previous) => {
      if (dragging && previous) return previous.value;
      if (!view.width || !view.height) return 1;
      const page = this.store.sheet().height + SHEET_GAP + ADD_SHEET_HEIGHT; // one page and the button below it
      return Math.min(view.width / width, view.height / page);
    },
  });
  /** Size of the drawing in CSS pixels. */
  protected readonly size = computed(() => ({
    width: Math.floor(this.bounds().width * this.zoom()),
    height: Math.floor(this.bounds().height * this.zoom()),
  }));

  /** Adds a page from the button on the board and scrolls to it. */
  protected addSheet(button: Element): void {
    this.store.addSheet(1);
    afterNextRender(() => button.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), { injector: this.injector });
  }

  protected transform(p: Placement): string {
    return `translate(${p.x} ${p.y}) rotate(${p.rotation})`;
  }

  /** Piece corners relative to the centroid, for the outline polygon. */
  protected localPoints(piece: Piece): string {
    return piece.viewShape.map((v) => `${v.x - piece.centroid.x},${v.y - piece.centroid.y}`).join(' ');
  }

  /** Distance of the rotate handle above the centroid. */
  protected handleOffset(piece: Piece, scale: number): number {
    return Math.max(...piece.viewShape.map((v) => distance(v, piece.centroid))) * scale + 14;
  }

  protected label(p: Placement): string {
    return `Dílek ${p.index + 1}, otočení ${p.rotation}°, velikost ${scalePercent(p.scale)} %`;
  }

  protected onBackgroundDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target !== this.svg().nativeElement && !target.classList.contains('paper')) return;
    e.preventDefault();
    const base = e.shiftKey ? new Set(this.store.selection()) : new Set<number>();
    this.store.select(base);
    this.drag = { kind: 'marquee', start: this.toSheet(e), base, pointerId: e.pointerId };
    this.svg().nativeElement.setPointerCapture(e.pointerId);
    this.dragging.set(true);
  }

  protected onPieceDown(e: PointerEvent, index: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      this.store.toggle(index);
      return;
    }
    if (!this.store.selection().has(index)) this.store.select([index], true);
    else this.store.select(this.store.selection(), true);
    this.focusPiece(index);

    const origins = new Map(
      this.store
        .placements()
        .filter((p) => this.store.selection().has(p.index))
        .map((p) => [p.index, { x: p.x, y: p.y }]),
    );
    this.store.checkpoint();
    this.drag = { kind: 'move', start: this.toSheet(e), origins, pointerId: e.pointerId };
    this.svg().nativeElement.setPointerCapture(e.pointerId);
    this.dragging.set(true);
  }

  protected onHandleDown(e: PointerEvent, index: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.store.checkpoint();
    this.drag = { kind: 'rotate', index, pointerId: e.pointerId };
    this.svg().nativeElement.setPointerCapture(e.pointerId);
    this.dragging.set(true);
  }

  protected onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const pt = this.toSheet(e);

    if (drag.kind === 'move') {
      let delta = { x: pt.x - drag.start.x, y: pt.y - drag.start.y };
      if (e.altKey) this.guides.set(NO_GUIDES);
      else delta = this.snap(drag.origins, delta);
      const positions = new Map([...drag.origins].map(([i, o]) => [i, { x: o.x + delta.x, y: o.y + delta.y }]));
      this.store.setPositions(positions);
    } else if (drag.kind === 'rotate') {
      const placement = this.store.placementOf(drag.index);
      if (!placement) return;
      // Handle sits straight "up" from the centroid, i.e. at -90° in screen angles.
      let angle = (Math.atan2(pt.y - placement.y, pt.x - placement.x) * 180) / Math.PI + 90;
      if (!e.shiftKey) angle = Math.round(angle / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
      this.store.update(drag.index, { rotation: angle });
    } else {
      const rect = {
        x: Math.min(drag.start.x, pt.x),
        y: Math.min(drag.start.y, pt.y),
        width: Math.abs(pt.x - drag.start.x),
        height: Math.abs(pt.y - drag.start.y),
      };
      if (Math.max(rect.width, rect.height) * this.pxPerUnit() < CLICK_PX) return;
      this.marquee.set(rect);
      const caught = this.store
        .placements()
        .filter((p) => p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height)
        .map((p) => p.index);
      this.store.select([...drag.base, ...caught]);
    }
  }

  protected onPointerUp(e: PointerEvent): void {
    if (this.drag?.pointerId !== e.pointerId) return;
    this.svg().nativeElement.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.dragging.set(false);
    this.marquee.set(null);
    this.guides.set(NO_GUIDES);
  }

  protected onPieceFocus(index: number): void {
    if (!this.store.selection().has(index)) this.store.select([index]);
  }

  protected onKey(e: KeyboardEvent): void {
    const step = (e.shiftKey ? 10 : 1) * MM;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      this.store.moveSelection(...moves[e.key]);
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      const step = e.key === '-' ? -SCALE_PERCENT.step : SCALE_PERCENT.step;
      this.store.resizeSelection((percent) => percent + step);
    } else if (e.key === 'r' || e.key === 'R') {
      this.store.rotateSelection(e.shiftKey ? -this.kind.rotateStep : this.kind.rotateStep);
    } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      this.store.selectAll();
    } else if (e.key === 'Escape') {
      this.store.clearSelection();
      (e.target as SVGElement).blur();
    } else {
      return;
    }
    e.preventDefault();
  }

  /**
   * Adjusts a group drag offset. Corner-to-corner snapping wins (it is what makes cut
   * edges line up); otherwise the centre of the group's bounding box snaps to the vertical
   * and/or horizontal centre line of the sheet it is over, each axis on its own.
   */
  private snap(origins: ReadonlyMap<number, Point>, delta: Point): Point {
    const pieces = this.pieces();
    const threshold = SNAP_PX / this.pxPerUnit();
    const moving = this.store.placements().filter((p) => origins.has(p.index));
    const corners = (d: Point) =>
      moving.flatMap((p) => {
        const o = origins.get(p.index)!;
        return placedShape(pieces[p.index], { ...p, x: o.x + d.x, y: o.y + d.y });
      });

    const own = corners(delta);
    let best: { d: number; dx: number; dy: number } | null = null;
    for (const other of this.store.placements()) {
      if (origins.has(other.index)) continue;
      for (const target of placedShape(pieces[other.index], other)) {
        for (const corner of own) {
          const d = distance(corner, target);
          if (d < threshold && (!best || d < best.d)) best = { d, dx: target.x - corner.x, dy: target.y - corner.y };
        }
      }
    }

    const next = best ? { x: delta.x + best.dx, y: delta.y + best.dy } : { ...delta };
    const pts = best ? corners(next) : own;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const sheet = this.store.sheets()[sheetIndexAt(centreY, this.store.sheet(), this.store.sheetCount())];
    const offX = sheet.x + sheet.width / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
    const offY = sheet.y + sheet.height / 2 - centreY;

    // After a corner snap only report coincidental alignment; never pull the group off the corner.
    const tolerance = best ? 0.01 : threshold;
    const vertical = Math.abs(offX) < tolerance;
    const horizontal = Math.abs(offY) < tolerance;
    if (!best) {
      if (vertical) next.x += offX;
      if (horizontal) next.y += offY;
    }
    this.guides.set({ sheet, vertical, horizontal });
    return next;
  }

  /** Screen pixels per sheet unit at the current zoom. */
  private pxPerUnit(): number {
    return this.svg().nativeElement.getScreenCTM()?.a || 1;
  }

  private toSheet(e: PointerEvent): Point {
    const ctm = this.svg().nativeElement.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  /** Raising a piece re-orders the DOM, so focus is restored once it has rendered. */
  private focusPiece(index: number): void {
    afterNextRender(
      () => this.svg().nativeElement.querySelector<SVGGElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true }),
      { injector: this.injector },
    );
  }
}
