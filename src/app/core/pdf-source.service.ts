import { Injectable } from '@angular/core';
import { Matrix, Triangle, apply, centroid, inflate } from './geometry';
import { Piece, SourceDocument, SourcePage } from './models';
import { detectTriangles, extractStrokedSegments, sortReadingOrder } from './triangle-detector';

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
 * triangles on every page and cuts a preview image for each of them.
 */
@Injectable({ providedIn: 'root' })
export class PdfSourceService {
  async load(file: File): Promise<SourceDocument> {
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
        const found = detectTriangles(segments).map((userTri) => ({
          userTri,
          viewTri: userTri.map((pt) => apply(viewTransform, pt)) as unknown as Triangle,
        }));
        if (found.length === 0) continue;

        const ordered = sortReadingOrder(found.map((f) => f.viewTri));
        const byView = new Map(found.map((f) => [f.viewTri, f.userTri]));

        const canvas = document.createElement('canvas');
        const scaled = page.getViewport({ scale: RENDER_SCALE });
        canvas.width = Math.ceil(scaled.width);
        canvas.height = Math.ceil(scaled.height);
        await page.render({ canvas, viewport: scaled }).promise;

        for (const viewTri of ordered) {
          pieces.push(await cutPiece(canvas, pieces.length, p - 1, viewTri, byView.get(viewTri)!));
        }
        canvas.width = canvas.height = 0; // release the bitmap early
      }

      if (pieces.length === 0) {
        throw new PdfLoadError('V PDF nebyly nalezeny žádné trojúhelníky.');
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
  viewTri: Triangle,
  userTri: Triangle,
): Promise<Piece> {
  const clip = inflate(viewTri, CLIP_BLEED);
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
  ctx.moveTo(clip[0].x, clip[0].y);
  ctx.lineTo(clip[1].x, clip[1].y);
  ctx.lineTo(clip[2].x, clip[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(pageCanvas, 0, 0, pageCanvas.width / RENDER_SCALE, pageCanvas.height / RENDER_SCALE);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
  const c = centroid(viewTri);
  return {
    index,
    page,
    userTri,
    viewTri,
    centroid: c,
    imageUrl: URL.createObjectURL(blob),
    imageBox: { x: box.x - c.x, y: box.y - c.y, width: box.width, height: box.height },
  };
}
