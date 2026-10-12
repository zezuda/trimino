import { Injectable } from '@angular/core';
import { Matrix, Polygon, apply, centroid, inflate } from './geometry';
import { Piece, SourceDocument, SourcePage } from './models';
import { PieceKind } from './piece-kind';
import { extractStrokedSegments, sortReadingOrder } from './vector-lines';

/** Raster scale for the artboard previews (3 ≈ 216 dpi; the export stays vector). */
const RENDER_SCALE = 3;
/** Outward growth of the clip so the full outline stroke stays on the piece, in pt. */
export const CLIP_BLEED = 0.6;
/** Refuse very large inputs; a worksheet PDF is a few hundred kB. */
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 20;

export class PdfLoadError extends Error {}

/**
 * pdf.js, loaded on demand to keep the initial bundle small. The worker file is copied
 * to the app root by angular.json (see the `assets` entry for pdfjs-dist).
 */
export async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).href;
  return pdfjs;
}

/**
 * Loads a PDF entirely in the browser (nothing is uploaded anywhere), detects the
 * pieces of the given kind on every page and cuts a preview image for each of them.
 */
@Injectable({ providedIn: 'root' })
export class PdfSourceService {
  async load(file: File, kind: PieceKind): Promise<SourceDocument> {
    if (file.size > MAX_BYTES) throw new PdfLoadError('Soubor je příliš velký (max. 50 MB).');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { OPS, getDocument } = await loadPdfJs();

    // pdf.js detaches the buffer it is given, so it gets a copy; the original is kept for export.
    const task = getDocument({ data: bytes.slice(), enableXfa: false });
    let doc;
    try {
      doc = await task.promise;
    } catch {
      throw new PdfLoadError('Soubor se nepodařilo načíst jako PDF.');
    }

    try {
      const pages: SourcePage[] = [];
      const pieces: Piece[] = [];
      for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGES); p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        const viewTransform = viewport.transform as unknown as Matrix;
        pages.push({ width: viewport.width, height: viewport.height, viewTransform });

        const segments = extractStrokedSegments(await page.getOperatorList(), OPS);
        const found = kind.detect(segments).map((userShape) => ({
          userShape,
          viewShape: userShape.map((pt) => apply(viewTransform, pt)),
        }));
        if (found.length === 0) continue;

        const ordered = sortReadingOrder(found.map((f) => f.viewShape));
        const byView = new Map(found.map((f) => [f.viewShape, f.userShape]));

        const canvas = document.createElement('canvas');
        const scaled = page.getViewport({ scale: RENDER_SCALE });
        canvas.width = Math.ceil(scaled.width);
        canvas.height = Math.ceil(scaled.height);
        await page.render({ canvas, viewport: scaled }).promise;

        for (const viewShape of ordered) {
          pieces.push(await cutPiece(canvas, pieces.length, p - 1, viewShape, byView.get(viewShape)!));
        }
        canvas.width = canvas.height = 0; // release the bitmap early
      }

      if (pieces.length === 0) {
        throw new PdfLoadError(kind.notFound);
      }
      return { fileName: file.name, bytes, pages, pieces };
    } finally {
      await task.destroy();
    }
  }

  /** Frees preview images of a document that is no longer shown. */
  release(doc: SourceDocument | null): void {
    doc?.pieces.forEach((p) => URL.revokeObjectURL(p.imageUrl));
  }
}

async function cutPiece(
  pageCanvas: HTMLCanvasElement,
  index: number,
  page: number,
  viewShape: Polygon,
  userShape: Polygon,
): Promise<Piece> {
  const clip = inflate(viewShape, CLIP_BLEED);
  const xs = clip.map((p) => p.x);
  const ys = clip.map((p) => p.y);
  const box = {
    x: Math.floor(Math.min(...xs)),
    y: Math.floor(Math.min(...ys)),
    width: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
    height: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
  };

  const canvas = document.createElement('canvas');
  canvas.width = box.width * RENDER_SCALE;
  canvas.height = box.height * RENDER_SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  ctx.translate(-box.x, -box.y);
  ctx.beginPath();
  for (const v of clip) ctx.lineTo(v.x, v.y);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(pageCanvas, 0, 0, pageCanvas.width / RENDER_SCALE, pageCanvas.height / RENDER_SCALE);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
  const c = centroid(viewShape);
  return {
    index,
    page,
    userShape,
    viewShape,
    centroid: c,
    imageUrl: URL.createObjectURL(blob),
    imageBox: { x: box.x - c.x, y: box.y - c.y, width: box.width, height: box.height },
  };
}
