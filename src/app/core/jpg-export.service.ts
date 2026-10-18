import { Injectable } from '@angular/core';
import { loadPdfJs } from './pdf-source.service';

/** Target resolution of the JPG; lowered automatically for very large sheets. */
const DPI = 300;
/**
 * Canvas limits: browsers cap canvas side and area (Safari at ~16.7 Mpx); staying under
 * both keeps big custom sheets exportable at a lower DPI instead of failing.
 */
const MAX_SIDE_PX = 8192;
const MAX_AREA_PX = 16_000_000;
const QUALITY = 0.92;

/**
 * Rasterises the exported sheet PDF (so the JPG looks exactly like the PDF), one JPG per
 * page, and writes the DPI into the JPEG header, so printing at 100 % keeps the real piece size.
 */
@Injectable({ providedIn: 'root' })
export class JpgExportService {
  async export(pdfBytes: Uint8Array): Promise<Blob[]> {
    const { getDocument } = await loadPdfJs();
    const task = getDocument({ data: pdfBytes, enableXfa: false });
    try {
      const doc = await task.promise;
      const jpgs: Blob[] = [];
      for (let n = 1; n <= doc.numPages; n++) jpgs.push(await renderPage(await doc.getPage(n)));
      return jpgs;
    } finally {
      await task.destroy();
    }
  }
}

async function renderPage(page: import('pdfjs-dist').PDFPageProxy): Promise<Blob> {
  const base = page.getViewport({ scale: 1 });
  const dpi = Math.floor(
    Math.min(
      DPI,
      (MAX_SIDE_PX / Math.max(base.width, base.height)) * 72,
      Math.sqrt(MAX_AREA_PX / (base.width * base.height)) * 72,
    ),
  );
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  // JPEG has no transparency: paint the paper white first.
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      QUALITY,
    ),
  );
  canvas.width = canvas.height = 0;
  return withDpi(blob, dpi);
}

/** Sets the JFIF density fields (units = dots per inch) when the encoder wrote a JFIF APP0 segment. */
async function withDpi(jpeg: Blob, dpi: number): Promise<Blob> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const isJfif =
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0';
  if (!isJfif) return jpeg;
  bytes[13] = 1; // units: dots per inch
  bytes[14] = bytes[16] = dpi >> 8;
  bytes[15] = bytes[17] = dpi & 0xff;
  return new Blob([bytes], { type: 'image/jpeg' });
}
