/**
 * Font for the sheet header: DejaVu Sans Bold cut down to Latin (Czech included), as the
 * PDF standard fonts cannot write č, ř, ž… Fetched from public/fonts on first use only.
 */
const FONT_URL = 'fonts/DejaVuSans-Bold-latin.ttf';
/** Family name under which the artboard preview uses the same font. */
export const HEADER_FONT_FAMILY = 'Trimino Header';

let bytes: Promise<ArrayBuffer> | null = null;
let face: Promise<void> | null = null;

export function headerFontBytes(): Promise<ArrayBuffer> {
  bytes ??= fetch(new URL(FONT_URL, document.baseURI)).then((r) => {
    if (!r.ok) throw new Error(`Font ${FONT_URL}: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  bytes.catch(() => (bytes = null)); // let a later export try again
  return bytes;
}

/** Registers the font for the page itself, so the preview measures and looks like the export. */
export function loadHeaderFontFace(): Promise<void> {
  face ??= headerFontBytes().then(async (b) => {
    const f = new FontFace(HEADER_FONT_FAMILY, b);
    document.fonts.add(await f.load());
  });
  face.catch(() => (face = null));
  return face;
}
