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
  /** 0-based index into {@link SourceDocument.pages} (across all loaded files). */
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
  /** Index into {@link SourceDocument.files}. */
  readonly file: number;
  /** 0-based page number within that file. */
  readonly pageInFile: number;
  readonly width: number;
  readonly height: number;
  /** pdf.js viewport transform at scale 1: user space → view space. */
  readonly viewTransform: Matrix;
}

export interface SourceFile {
  readonly fileName: string;
  /** Original bytes, kept for the vector export. */
  readonly bytes: Uint8Array;
}

/** Every loaded PDF together; pages and pieces of later files follow those of earlier ones. */
export interface SourceDocument {
  readonly files: readonly SourceFile[];
  readonly pages: readonly SourcePage[];
  readonly pieces: readonly Piece[];
}

/** Joins two documents: pages and pieces of `next` are renumbered to follow those of `base`. */
export function appendDocument(base: SourceDocument, next: SourceDocument): SourceDocument {
  return {
    files: [...base.files, ...next.files],
    pages: [...base.pages, ...next.pages.map((p) => ({ ...p, file: p.file + base.files.length }))],
    pieces: [
      ...base.pieces,
      ...next.pieces.map((p) => ({ ...p, index: p.index + base.pieces.length, page: p.page + base.pages.length })),
    ],
  };
}

/** Where a piece sits on the sheet: its centroid position, clockwise rotation and size. */
export interface Placement {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  /** Size relative to the original (1 = 100 %), always a multiple of {@link SCALE_PERCENT}.step. */
  readonly scale: number;
}

/** Allowed piece sizes, in percent of the original. */
export const SCALE_PERCENT = { min: 10, max: 500, step: 5 } as const;

/** Rounds a size in percent to the allowed step and range and returns it as a factor. */
export function snapScale(percent: number): number {
  const { min, max, step } = SCALE_PERCENT;
  return Math.min(max, Math.max(min, Math.round(percent / step) * step)) / 100;
}

export const scalePercent = (scale: number): number => Math.round(scale * 100);

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

/** Line of text printed at the top of the sheets. */
export interface SheetHeader {
  readonly text: string;
  /** Unchecked leaves the first sheet without it (e.g. when it has a title of its own). */
  readonly onFirstPage: boolean;
}

/** Header type size (pt), its baseline below the sheet top and the side margins it keeps. */
export const HEADER = { size: 14, baseline: 12 * MM, margin: 10 * MM, maxLength: 120 } as const;

/** Whether sheet `k` (0-based) gets the header. */
export function hasHeader(header: SheetHeader, k: number): boolean {
  return header.text.trim() !== '' && (k > 0 || header.onFirstPage);
}

/** Type size that fits the header between the margins, given its width at size 1. */
export function headerSize(widthAtSize1: number, sheetWidth: number): number {
  return widthAtSize1 > 0 ? Math.min(HEADER.size, (sheetWidth - 2 * HEADER.margin) / widthAtSize1) : HEADER.size;
}

/** Most output sheets one layout can have. */
export const MAX_SHEETS = 20;
/** Space between output sheets stacked on the board, in points. */
export const SHEET_GAP = 10 * MM;

/** An output sheet on the board, in sheet space. */
export interface SheetRect extends SheetSize {
  readonly x: number;
  readonly y: number;
}

/** Output sheets of the same size stacked top to bottom: sheet `k` starts `k · (height + gap)` down. */
export function sheetRects(size: SheetSize, count: number): SheetRect[] {
  return Array.from({ length: count }, (_, k) => ({ x: 0, y: k * (size.height + SHEET_GAP), ...size }));
}

/** The sheet whose row a point at height `y` falls into (the first or last one beyond them). */
export function sheetIndexAt(y: number, size: SheetSize, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor((y + SHEET_GAP / 2) / (size.height + SHEET_GAP))));
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
  /** Output sheets, stacked top to bottom (see {@link sheetRects}); missing in older templates, which means 1. */
  readonly sheetCount?: number;
  readonly pieceCount: number;
  /** Array order is the stacking order (last = on top). */
  readonly placements: readonly Placement[];
  readonly createdAt: string;
}
