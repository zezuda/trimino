import { InjectionToken } from '@angular/core';
import { Polygon } from './geometry';
import { detectRectangles } from './rectangle-detector';
import { detectTriangles } from './triangle-detector';
import { Segment } from './vector-lines';

export type PieceKindId = 'trimino' | 'domino';

/** What differs between the modules; everything else (arranging, export, templates) is shared. */
export interface PieceKind {
  readonly id: PieceKindId;
  readonly title: string;
  /** Keyboard / button rotation step; keeps the pieces on their grid (60° triangles, 90° rectangles). */
  readonly rotateStep: number;
  /** Finds the pieces on one page, in page user space. */
  readonly detect: (segments: Segment[]) => Polygon[];
  /** Error shown when a PDF has no pieces of this kind. */
  readonly notFound: string;
  /** localStorage keys: each module keeps its own templates. */
  readonly storageKey: string;
  readonly activeKey: string;
}

export const TRIMINO: PieceKind = {
  id: 'trimino',
  title: 'Trimino',
  rotateStep: 60,
  detect: detectTriangles,
  notFound: 'V PDF nebyly nalezeny žádné trojúhelníky.',
  storageKey: 'trimino.templates.v1',
  activeKey: 'trimino.activeTemplate',
};

export const DOMINO: PieceKind = {
  id: 'domino',
  title: 'Domino',
  rotateStep: 90,
  detect: detectRectangles,
  notFound: 'V PDF nebyly nalezeny žádné obdélníky (obrysy ani ořezové značky).',
  storageKey: 'domino.templates.v1',
  activeKey: 'domino.activeTemplate',
};

export const PIECE_KINDS: readonly PieceKind[] = [TRIMINO, DOMINO];

/** The module a workspace runs as; provided per route together with its store and templates. */
export const PIECE_KIND = new InjectionToken<PieceKind>('PIECE_KIND');
