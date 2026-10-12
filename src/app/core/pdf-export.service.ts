import { Injectable } from '@angular/core';
import type { PDFName } from 'pdf-lib';
import { Matrix, inflate, multiply } from './geometry';
import { Placement, SheetSize, SourceDocument } from './models';
import { placementMatrix } from './placement';
import { CLIP_BLEED } from './pdf-source.service';

/**
 * Builds the sheet as a vector PDF: every source page is embedded once as a form
 * XObject and each piece draws it through a clip of its outline, moved and rotated into
 * place. Text and lines stay crisp for printing, unlike the raster previews.
 */
@Injectable({ providedIn: 'root' })
export class PdfExportService {
  async export(source: SourceDocument, placements: readonly Placement[], sheetSize: SheetSize): Promise<Uint8Array> {
    const {
      PDFDocument,
      clip,
      closePath,
      concatTransformationMatrix,
      drawObject,
      endPath,
      lineTo,
      moveTo,
      popGraphicsState,
      pushGraphicsState,
    } = await import('pdf-lib'); // loaded on demand, only needed for export
    const src = await PDFDocument.load(source.bytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const { width, height } = sheetSize;
    const sheet = out.addPage([width, height]);

    // Embed in the page's own user space (identity matrix) so detected coordinates apply as-is.
    const xObjects = new Map<number, PDFName>();
    const xObjectFor = async (pageIndex: number): Promise<PDFName> => {
      let name = xObjects.get(pageIndex);
      if (!name) {
        const page = src.getPage(pageIndex);
        const mb = page.getMediaBox();
        const embedded = await out.embedPage(
          page,
          { left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height },
          [1, 0, 0, 1, 0, 0],
        );
        name = sheet.node.newXObject('Src', embedded.ref);
        xObjects.set(pageIndex, name);
      }
      return name;
    };

    const flip: Matrix = [1, 0, 0, -1, 0, height]; // sheet space (y down) → PDF (y up)
    for (const placement of placements) {
      const piece = source.pieces[placement.index];
      if (!piece) continue;
      const page = source.pages[piece.page];
      const m = multiply(flip, multiply(placementMatrix(placement, piece.centroid), page.viewTransform));
      const [first, ...rest] = inflate(piece.userShape, CLIP_BLEED);

      sheet.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...m),
        moveTo(first.x, first.y),
        ...rest.map((v) => lineTo(v.x, v.y)),
        closePath(),
        clip(),
        endPath(),
        drawObject(await xObjectFor(piece.page)),
        popGraphicsState(),
      );
    }

    out.setTitle(source.fileName.replace(/\.pdf$/i, ''));
    out.setCreator('Trimino');
    return out.save();
  }
}
