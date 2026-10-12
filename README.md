# Trimino

Angular 22 app that cuts the triangles out of a Trimino PDF (e.g. from
[paul-matthies.de/Schule/Trimino.php](http://paul-matthies.de/Schule/Trimino.php)), lets you arrange
them on a sheet (A5, A4, A3, Letter or custom size) and downloads the arrangement as PDF or JPG. Layouts are saved as **templates** and
re-applied to the next PDF you load.

Everything runs in the browser; the PDF is never uploaded anywhere.

```bash
npm install
npm start          # http://localhost:4200
npm run build      # static files in dist/trimino/browser
```

## How to use

1. **Nahrát PDF** – the triangles are detected and shown on the sheet where they were in the original,
   each with its number (the number is not printed).
2. Arrange the pieces:
   - **select**: click a piece; **Shift+click** adds/removes it; **drag on an empty spot** draws a
     selection box (Shift adds to the current selection) – a piece is caught when its centre is inside
     the box, so neighbours that only touch it in a dense layout are not; **Ctrl/Cmd+A** selects all;
   - **drag** a selected piece to move the whole selection. Corners snap to corners of the other pieces;
     otherwise the centre of the selection snaps to the sheet's vertical and horizontal centre line (a
     dashed guide shows it). Hold **Alt** to turn snapping off;
   - **drag the round handle** (single piece only) to rotate it in 15° steps (hold **Shift** for any angle);
   - **keyboard** – Tab to a piece, arrows move the selection 1 mm (**Shift** = 10 mm), **R** / **Shift+R**
     rotates it by ±60° as one block (an assembled group stays assembled), **Esc** deselects;
   - **Ctrl/Cmd+Z** undoes the last change (moves, rotations, sheet size, template, reset),
     **Ctrl/Cmd+Shift+Z** or **Ctrl+Y** redoes it. Held arrow keys count as one step;
   - the bar above the sheet does the same with buttons (±60°, exact angle for a single piece, 5 mm nudges).
   Pieces reaching outside the sheet get a red dashed outline and are counted as "mimo arch".
3. **Arch** – paper size: A5, A4, A3, Letter or **Vlastní** (custom width × height in mm, 50–1500 mm).
   **Na výšku / Na šířku** – orientation (for a custom size it swaps width and height). Changing the
   sheet keeps the layout centred. **Původní rozložení** – back to the original positions.
4. **Stáhnout PDF** – vector PDF of the sheet. **Stáhnout JPG** – the same sheet rendered at 300 DPI
   (lower for very large custom sheets, to stay within browser canvas limits); the DPI is written into
   the file. Print either at **100 % / actual size**, not "fit to page", or the pieces won't match the
   original size.

## Templates

- **Uložit** stores the current layout under a name (same name = overwrite). The saved template becomes
  the active one.
- The active template (**Šablona** select) is applied automatically to every PDF you load afterwards,
  and immediately when you pick it.
- A template stores, for every piece, its **index**, the position of its centre on the sheet (pt) and its
  **rotation** (degrees, clockwise), plus the sheet orientation and paper size (templates saved before
  paper sizes existed load as A4). Pieces are indexed in reading order of
  the source PDF (rows top to bottom, then left to right), so any PDF from the same generator with the
  same piece layout is reordered the same way. If the new PDF has more pieces than the template, the
  extra ones stay at their original positions; the status line then says how many were placed.
- Templates live in the browser's localStorage. **Export** / **Import** moves them as JSON between
  browsers and computers.
- `examples/trimino-9-velky-trojuhelnik.json` – the 9-piece set assembled into one big triangle
  (landscape). The big triangle is 24 cm wide and 20.8 cm tall, so it leaves only ~1 mm top and bottom
  margin on A4; printers that cannot print borderless will clip the top tip and the bottom edge slightly.

## How detection works

`src/app/core/triangle-detector.ts` reads the vector drawing operations of each page (pdf.js operator
list): stroked straight lines are merged, crossings become nodes, and every closed 3-cycle of lines that
is large enough and contains no smaller triangle is a piece. It therefore works whether the generator
draws one closed path per triangle, separate lines, or one long line per grid row. Clipping paths are
respected, so a PDF downloaded from this app can be loaded again.

Limits: scanned (raster-only) PDFs have no vector lines and are not supported; at most 20 pages / 50 MB.
With a multi-page PDF the first page starts centred on the sheet and every further page is laid out to
the right of it, outside the sheet (flagged as overflowing); drag the pieces you need onto the sheet.
Only what lies on the sheet is exported.

## Code map

| File | Role |
| --- | --- |
| `core/triangle-detector.ts` | Finds triangles in the pdf.js operator list (DOM-free). |
| `core/pdf-source.service.ts` | Loads the PDF (pdf.js, lazy-loaded), detects pieces, cuts preview PNGs. |
| `core/pdf-export.service.ts` | Builds the output PDF with pdf-lib (lazy-loaded): source page embedded once, clipped per piece. |
| `core/jpg-export.service.ts` | Renders that PDF with pdf.js into a JPG and stamps its DPI. |
| `core/layout.store.ts` | Signals: document, placements, paper size, orientation, selection. |
| `core/template.service.ts` | Template storage, JSON import validation. |
| `core/models.ts` | Types and the coordinate spaces (user / view / sheet). |
| `artboard/` | The SVG sheet: selection box, group drag, rotate handle, corner and centre snapping, keyboard. |
