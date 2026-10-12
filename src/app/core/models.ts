import { Matrix, Point, Polygon } from './geometry';
import type { PieceKindId } from './piece-kind';

/**
 * Coordinate spaces used across the app (all in PDF points, 1 pt = 1/72 in):
 *  - user space: the source PDF page's own coordinates (y up); used for the vector export;
 *  - view space: the source page as displayed (y down, page rotation applied);
 *  - sheet space: the output sheet (y down); placements live here.
 */

/** One detected piece (a triangle or a rectangle) cut out of the source PDF. */
export interface Piece {
  /** Stable index in reading order of the source — the key templates are stored by. */
  readonly index: number;
  /** 0-based page of the source PDF. */
  readonly page: number;
  readonly userShape: Polygon;
  readonly viewShape: Polygon;
  /** Centroid in view space; placements position this point. */
  readonly centroid: Point;
  /** Raster crop for the artboard (object URL) and its box relative to the centroid. */
  readonly imageUrl: string;
  readonly imageBox: { x: number; y: number; width: number; height: number };
}

export interface SourcePage {
  readonly width: number;
  readonly height: number;
  /** pdf.js viewport transform at scale 1: user space → view space. */
  readonly viewTransform: Matrix;
}

export interface SourceDocument {
  readonly fileName: string;
  /** Original bytes, kept for the vector export. */
  readonly bytes: Uint8Array;
  readonly pages: readonly SourcePage[];
  readonly pieces: readonly Piece[];
}

/** Where a piece sits on the sheet: its centroid position and clockwise rotation. */
export interface Placement {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

export type Orientation = 'portrait' | 'landscape';

export const MM = 72 / 25.4;

export type PaperPreset = 'A5' | 'A4' | 'A3' | 'Letter' | 'custom';

/** Preset paper sizes in points (short × long side). */
export const PAPER_PRESETS: Readonly<Record<Exclude<PaperPreset, 'custom'>, { short: number; long: number }>> = {
  A5: { short: 419.53, long: 595.28 },
  A4: { short: 595.28, long: 841.89 },
  A3: { short: 841.89, long: 1190.55 },
  Letter: { short: 612, long: 792 },
};

/** Allowed custom size, in mm. Upper bound keeps the JPG export within browser canvas limits. */
export const CUSTOM_MM = { min: 50, max: 1500 } as const;

export interface SheetSize {
  readonly width: number;
  readonly height: number;
}

/** Sheet stored in a template: the preset and the resulting size in points. */
export interface SheetSpec extends SheetSize {
  readonly preset: PaperPreset;
}

export function presetSize(preset: Exclude<PaperPreset, 'custom'>, o: Orientation): SheetSize {
  const { short, long } = PAPER_PRESETS[preset];
  return o === 'portrait' ? { width: short, height: long } : { width: long, height: short };
}

/**
 * Saved layout. Placements reference pieces by index only, so a template made for one
 * PDF reorders any other PDF from the same generator the same way.
 */
export interface LayoutTemplate {
  readonly version: 1;
  readonly id: string;
  /** Module the template belongs to; missing in templates saved before Domino existed, which means Trimino. */
  readonly kind?: PieceKindId;
  readonly name: string;
  readonly orientation: Orientation;
  /** Paper; missing in templates saved before sizes existed, which means A4. */
  readonly sheet?: SheetSpec;
  readonly pieceCount: number;
  /** Array order is the stacking order (last = on top). */
  readonly placements: readonly Placement[];
  readonly createdAt: string;
}
