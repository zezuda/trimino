import { Injectable } from '@angular/core';
import type { PDFPage, PDFRef } from 'pdf-lib';
import { Matrix, Polygon, inflate, multiply } from './geometry';
import { headerFontBytes } from './header-font';
import { HEADER, Placement, SheetHeader, SheetRect, SourceDocument, hasHeader, headerSize } from './models';
import { placedShape, placementMatrix } from './placement';
import { CLIP_BLEED } from './pdf-source.service';

/**
 * Builds the sheets as a vector PDF, one page each: every source page (of every loaded file) is embedded
 * once as a form XObject and each piece draws it through a clip of its outline, moved and rotated into
 * place. Text and lines stay crisp for printing, unlike the raster previews. A piece is drawn on every
 * sheet it reaches, cut at the sheet edge just as on screen; pieces off all sheets are left out.
 * The header, if any, is set centred at the top under the pieces (as in the preview), in an embedded
 * font subset.
 */
@Injectable({ providedIn: 'root' })
export class PdfExportService {
  async export(
    source: SourceDocument,
    placements: readonly Placement[],
    sheets: readonly SheetRect[],
    header: SheetHeader,
  ): Promise<Uint8Array> {
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
      rgb,
    } = await import('pdf-lib'); // loaded on demand, only needed for export
    const files = await Promise.all(source.files.map((f) => PDFDocument.load(f.bytes, { ignoreEncryption: true })));
    const out = await PDFDocument.create();
    const headerText = header.text.trim();
    let font: Awaited<ReturnType<typeof out.embedFont>> | null = null;
    if (sheets.some((_, k) => hasHeader(header, k))) {
      const [fontkit, bytes] = await Promise.all([import('@pdf-lib/fontkit'), headerFontBytes()]);
      out.registerFontkit(fontkit.default);
      font = await out.embedFont(bytes, { subset: true });
    }

    // Embed in the page's own user space (identity matrix) so detected coordinates apply as-is.
    const embedded = new Map<number, PDFRef>();
    const embeddedRef = async (pageIndex: number): Promise<PDFRef> => {
      let ref = embedded.get(pageIndex);
      if (!ref) {
        const { file, pageInFile } = source.pages[pageIndex];
        const page = files[file].getPage(pageInFile);
        const mb = page.getMediaBox();
        ref = (
          await out.embedPage(page, { left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height }, [1, 0, 0, 1, 0, 0])
        ).ref;
        embedded.set(pageIndex, ref);
      }
      return ref;
    };

    for (const [k, rect] of sheets.entries()) {
      const sheet: PDFPage = out.addPage([rect.width, rect.height]);
      const names = new Map<number, ReturnType<PDFPage['node']['newXObject']>>();
      const flip: Matrix = [1, 0, 0, -1, -rect.x, rect.y + rect.height]; // sheet space (y down) → this page (y up)
      if (font && hasHeader(header, k)) {
        const size = headerSize(font.widthOfTextAtSize(headerText, 1), rect.width);
        sheet.drawText(headerText, {
          x: (rect.width - font.widthOfTextAtSize(headerText, size)) / 2,
          y: rect.height - HEADER.baseline,
          size,
          font,
          color: rgb(0, 0, 0),
        });
      }

      for (const placement of placements) {
        const piece = source.pieces[placement.index];
        if (!piece || !reaches(placedShape(piece, placement), rect)) continue;
        if (!names.has(piece.page)) names.set(piece.page, sheet.node.newXObject('Src', await embeddedRef(piece.page)));
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
          drawObject(names.get(piece.page)!),
          popGraphicsState(),
        );
      }
    }

    out.setTitle(source.files[0].fileName.replace(/\.pdf$/i, ''));
    out.setCreator('Trimino');
    return out.save();
  }
}

/** Whether a placed piece overlaps the sheet at all (bounding boxes are enough here). */
function reaches(shape: Polygon, r: SheetRect): boolean {
  const xs = shape.map((v) => v.x);
  const ys = shape.map((v) => v.y);
  return Math.max(...xs) > r.x && Math.min(...xs) < r.x + r.width && Math.max(...ys) > r.y && Math.min(...ys) < r.y + r.height;
}
