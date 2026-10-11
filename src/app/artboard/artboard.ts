import { Component, ElementRef, afterNextRender, computed, inject, viewChild, Injector } from '@angular/core';
import { Point, distance } from '../core/geometry';
import { LayoutStore } from '../core/layout.store';
import { MM, Piece, Placement } from '../core/models';
import { placedTriangle } from '../core/placement';

/** Snap distance in screen pixels (converted to sheet units on the fly). */
const SNAP_PX = 12;
const ROTATE_SNAP_DEG = 15;
/** Keyboard / button rotation step: 60° keeps equilateral pieces on the same grid. */
export const ROTATE_STEP = 60;

type Drag =
  | { kind: 'move'; index: number; offset: Point; pointerId: number }
  | { kind: 'rotate'; index: number; pointerId: number };

/**
 * The sheet with the pieces. Pointer: drag a piece to move it (corners snap to
 * neighbouring corners, Alt disables), drag the round handle to rotate (15° steps,
 * Shift for free angle). Keyboard: arrows move by 1 mm (Shift 10 mm), R / Shift+R
 * rotate by 60°. The selection toolbar in the app offers the same without dragging.
 */
@Component({
  selector: 'app-artboard',
  templateUrl: './artboard.html',
  styleUrl: './artboard.css',
})
export class Artboard {
  protected readonly store = inject(LayoutStore);
  private readonly injector = inject(Injector);
  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  private drag: Drag | null = null;

  protected readonly pieces = computed(() => this.store.source()?.pieces ?? []);
  protected readonly sheetLabel = computed(() => {
    const { width, height } = this.store.sheet();
    return `Arch ${Math.round(width / MM)} × ${Math.round(height / MM)} mm`;
  });
  protected readonly viewBox = computed(() => `0 0 ${this.store.sheet().width} ${this.store.sheet().height}`);

  protected transform(p: Placement): string {
    return `translate(${p.x} ${p.y}) rotate(${p.rotation})`;
  }

  /** Triangle corners relative to the centroid, for the outline polygon. */
  protected localPoints(piece: Piece): string {
    return piece.viewTri.map((v) => `${v.x - piece.centroid.x},${v.y - piece.centroid.y}`).join(' ');
  }

  /** Distance of the rotate handle above the centroid. */
  protected handleOffset(piece: Piece): number {
    return Math.max(...piece.viewTri.map((v) => distance(v, piece.centroid))) + 14;
  }

  protected label(p: Placement): string {
    return `Dílek ${p.index + 1}, otočení ${p.rotation}°`;
  }

  protected onBackgroundDown(e: PointerEvent): void {
    if (e.target === this.svg().nativeElement || (e.target as Element).classList.contains('paper')) {
      this.store.select(null);
    }
  }

  protected onPieceDown(e: PointerEvent, index: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const placement = this.store.placementOf(index);
    if (!placement) return;
    const pt = this.toSheet(e);
    this.store.select(index, true);
    this.focusPiece(index);
    this.drag = { kind: 'move', index, offset: { x: pt.x - placement.x, y: pt.y - placement.y }, pointerId: e.pointerId };
    this.svg().nativeElement.setPointerCapture(e.pointerId);
  }

  protected onHandleDown(e: PointerEvent, index: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.drag = { kind: 'rotate', index, pointerId: e.pointerId };
    this.svg().nativeElement.setPointerCapture(e.pointerId);
  }

  protected onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const pt = this.toSheet(e);
    const placement = this.store.placementOf(drag.index);
    if (!placement) return;

    if (drag.kind === 'move') {
      let next = { ...placement, x: pt.x - drag.offset.x, y: pt.y - drag.offset.y };
      if (!e.altKey) next = this.snapToNeighbours(next);
      this.store.update(drag.index, { x: next.x, y: next.y });
    } else {
      // Handle sits straight "up" from the centroid, i.e. at -90° in screen angles.
      let angle = (Math.atan2(pt.y - placement.y, pt.x - placement.x) * 180) / Math.PI + 90;
      if (!e.shiftKey) angle = Math.round(angle / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
      this.store.update(drag.index, { rotation: angle });
    }
  }

  protected onPointerUp(e: PointerEvent): void {
    if (this.drag?.pointerId !== e.pointerId) return;
    this.svg().nativeElement.releasePointerCapture(e.pointerId);
    this.drag = null;
  }

  protected onKey(e: KeyboardEvent, index: number): void {
    const p = this.store.placementOf(index);
    if (!p) return;
    const step = (e.shiftKey ? 10 : 1) * MM;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      this.store.update(index, { x: p.x + moves[e.key][0], y: p.y + moves[e.key][1] });
    } else if (e.key === 'r' || e.key === 'R') {
      this.store.update(index, { rotation: p.rotation + (e.shiftKey ? -ROTATE_STEP : ROTATE_STEP) });
    } else if (e.key === 'Escape') {
      this.store.select(null);
      (e.target as SVGElement).blur();
    } else {
      return;
    }
    e.preventDefault();
  }

  /** Moves the piece so its nearest corner lands exactly on a neighbour's corner, if close enough. */
  private snapToNeighbours(next: Placement): Placement {
    const pieces = this.pieces();
    const own = placedTriangle(pieces[next.index], next);
    const threshold = SNAP_PX / (this.svg().nativeElement.getScreenCTM()?.a || 1);
    let best: { d: number; dx: number; dy: number } | null = null;

    for (const other of this.store.placements()) {
      if (other.index === next.index) continue;
      for (const target of placedTriangle(pieces[other.index], other)) {
        for (const corner of own) {
          const d = distance(corner, target);
          if (d < threshold && (!best || d < best.d)) best = { d, dx: target.x - corner.x, dy: target.y - corner.y };
        }
      }
    }
    return best ? { ...next, x: next.x + best.dx, y: next.y + best.dy } : next;
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
