# Trimino

Angular 22 app that cuts the pieces out of a Trimino or Domino PDF (e.g. from
[paul-matthies.de/Schule/Trimino.php](http://paul-matthies.de/Schule/Trimino.php)), lets you arrange
them on a sheet (A5, A4, A3, Letter or custom size) and downloads the arrangement as PDF or JPG. Layouts are saved as **templates** and
re-applied to the next PDF you load.

Two modules, switched by the tabs at the top (`#/trimino`, `#/domino`), work the same way and differ
only in the shape they cut out:

| | Trimino | Domino |
| --- | --- | --- |
| Pieces | triangles | rectangles |
| Rotation step (R, ⟲/⟳) | 60° | 90° |
| Templates | own list | own list |

Each module keeps its own PDF, layout, undo history and templates while you are in the other one.

Everything runs in the browser; the PDF is never uploaded anywhere.

```bash
npm install
npm start          # http://localhost:4200
npm run build      # static files in dist/trimino/browser
```

## How to use

1. **Nahrát PDF** – the triangles are detected and shown on the sheet where they were in the original,
   each with its number (the number is not printed). Several files can be picked at once, and once
   something is loaded the button becomes **Přidat PDF**: the pieces of further files are added to the
   existing ones (numbered after them, their pages laid out to the right of everything on the board).
   Adding a file clears the undo history; the active template is applied only when the board was empty.
   **Smazat vše** removes all loaded files and pieces.
2. Arrange the pieces:
   - **select**: click a piece; **Shift+click** adds/removes it; **drag on an empty spot** draws a
     selection box (Shift adds to the current selection) – a piece is caught when its centre is inside
     the box, so neighbours that only touch it in a dense layout are not; **Ctrl/Cmd+A** selects all;
   - **drag** a selected piece to move the whole selection. Corners snap to corners of the other pieces;
     otherwise the centre of the selection snaps to the sheet's vertical and horizontal centre line (a
     dashed guide shows it). Hold **Alt** to turn snapping off;
   - **drag the round handle** (single piece only) to rotate it in 15° steps (hold **Shift** for any angle);
   - **keyboard** – Tab to a piece, arrows move the selection 1 mm (**Shift** = 10 mm), **R** / **Shift+R**
     rotates it by ±60° (Domino ±90°) as one block (an assembled group stays assembled), **+** / **−**
     resizes it by 5 %, **Esc** deselects;
   - **resize** – the size in % of the original (10–500 %, steps of 5 %) is shown in the bar above the
     sheet; **−** / **+** change it by 5 %, or type a value (rounded to 5 %). A multi-selection is resized
     as one block around its centre (an assembled group stays assembled); if its pieces have different
     sizes the field is empty and ± changes each piece by 5 %;
   - **Ctrl/Cmd+Z** undoes the last change (moves, rotations, sheet size, template, reset),
     **Ctrl/Cmd+Shift+Z** or **Ctrl+Y** redoes it. Held arrow keys count as one step;
   - the bar above the sheet does the same with buttons (±60° / ±90°, exact angle for a single piece, 5 mm nudges).
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
- A template stores, for every piece, its **index**, the position of its centre on the sheet (pt), its
  **rotation** (degrees, clockwise) and its **scale** (1 = 100 %; missing in older templates = 100 %), plus the sheet orientation and paper size (templates saved before
  paper sizes existed load as A4). Pieces are indexed in reading order of
  the source PDF (rows top to bottom, then left to right), so any PDF from the same generator with the
  same piece layout is reordered the same way. If the new PDF has more pieces than the template, the
  extra ones stay at their original positions; the status line then says how many were placed.
- Templates live in the browser's localStorage, separately for Trimino and Domino. **Export** / **Import**
  moves them as JSON between browsers and computers. A template records its module (`"kind": "domino"`;
  files without `kind` are Trimino templates) and is refused by the other module.
- `examples/trimino-9-velky-trojuhelnik.json` – the 9-piece set assembled into one big triangle
  (landscape). The big triangle is 24 cm wide and 20.8 cm tall, so it leaves only ~1 mm top and bottom
  margin on A4; printers that cannot print borderless will clip the top tip and the bottom edge slightly.

## How detection works

`src/app/core/vector-lines.ts` reads the vector drawing operations of each page (pdf.js operator
list): stroked straight lines are merged and crossings become nodes of a graph. It therefore works whether
the generator draws one closed path per piece, separate lines, or one long line per grid row. Clipping
paths are respected, so a PDF downloaded from this app can be loaded again.

- **Trimino** (`triangle-detector.ts`): every closed 3-cycle of lines that is large enough and contains
  no smaller triangle is a piece.
- **Domino** (`rectangle-detector.ts`): every closed 4-cycle with right-angled corners that is at least
  ~1 cm on each side and contains no smaller rectangle is a piece. Some generators draw the cards only as
  filled areas, with no outlines; on such a page the **crop marks** are used instead – two short marks
  lying on the same line on opposite sides of the page become a cut line, and the cells of that grid are
  the pieces (in `M-Midi-Domi-L.pdf` page 1 is cut this way, page 2 by its dashed outlines).

Limits: scanned (raster-only) PDFs have no vector lines and are not supported, nor are Domino pages with
neither outlines nor crop marks; at most 20 pages / 50 MB.
With a multi-page PDF the first page starts centred on the sheet and every further page is laid out to
the right of it, outside the sheet (flagged as overflowing); drag the pieces you need onto the sheet.
Only what lies on the sheet is exported.

## Code map

| File | Role |
| --- | --- |
| `core/vector-lines.ts` | Stroked lines from the pdf.js operator list, line graph, reading order (DOM-free). |
| `core/triangle-detector.ts` | Finds triangles in the line graph. |
| `core/rectangle-detector.ts` | Finds rectangles in the line graph, or in the grid given by crop marks. |
| `core/piece-kind.ts` | The two modules: detector, rotation step, template storage keys. |
| `core/pdf-source.service.ts` | Loads the PDF (pdf.js, lazy-loaded), detects pieces, cuts preview PNGs. |
| `core/pdf-export.service.ts` | Builds the output PDF with pdf-lib (lazy-loaded): source page embedded once, clipped per piece. |
| `core/jpg-export.service.ts` | Renders that PDF with pdf.js into a JPG and stamps its DPI. |
| `core/layout.store.ts` | Signals: document, placements, paper size, orientation, selection (one per module). |
| `core/template.service.ts` | Template storage, JSON import validation. |
| `core/models.ts` | Types and the coordinate spaces (user / view / sheet). |
| `app.routes.ts` | One route per module, each with its own store and template service. |
| `workspace/` | Toolbar, templates, status and module tabs around the artboard. |
| `artboard/` | The SVG sheet: selection box, group drag, rotate handle, corner and centre snapping, keyboard. |
