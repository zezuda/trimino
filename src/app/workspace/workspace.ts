import { Component, Injector, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Artboard } from '../artboard/artboard';
import { LayoutStore } from '../core/layout.store';
import { CUSTOM_MM, HEADER, MAX_SHEETS, MM, Orientation, PAPER_PRESETS, PaperPreset, SCALE_PERCENT, scalePercent } from '../core/models';
import { JpgExportService } from '../core/jpg-export.service';
import { PdfExportService } from '../core/pdf-export.service';
import { PdfLoadError, PdfSourceService } from '../core/pdf-source.service';
import { PIECE_KIND, PIECE_KINDS } from '../core/piece-kind';
import { TemplateService } from '../core/template.service';

const NUDGE_MM = 5;

/**
 * One module (Trimino or Domino): load one or more PDFs, arrange their pieces, export, templates.
 * The module, its store and its templates come from the route (see app.routes.ts), so
 * each module keeps its document and layout while the other one is open.
 */
@Component({
  selector: 'app-workspace',
  imports: [Artboard, RouterLink, RouterLinkActive],
  templateUrl: './workspace.html',
  styleUrl: './workspace.css',
  host: { '(document:keydown)': 'onShortcut($event)' },
})
export class Workspace {
  protected readonly kind = inject(PIECE_KIND);
  protected readonly kinds = PIECE_KINDS;
  protected readonly store = inject(LayoutStore);
  protected readonly templates = inject(TemplateService);
  private readonly pdfSource = inject(PdfSourceService);
  private readonly pdfExport = inject(PdfExportService);
  private readonly jpgExport = inject(JpgExportService);
  private readonly injector = inject(Injector);

  protected readonly busy = signal(false);
  protected readonly status = signal('');
  protected readonly error = signal('');
  protected readonly saving = signal(false);
  protected readonly templateName = signal('');

  protected readonly ROTATE_STEP = this.kind.rotateStep;
  protected readonly CUSTOM_MM = CUSTOM_MM;
  protected readonly presets: readonly { value: PaperPreset; label: string }[] = [
    ...(Object.keys(PAPER_PRESETS) as PaperPreset[]).map((p) => ({ value: p, label: p })),
    { value: 'custom', label: 'Vlastní' },
  ];
  /** Current sheet size in whole mm, for the custom size inputs. */
  protected readonly sheetMm = computed(() => ({
    width: Math.round(this.store.sheet().width / MM),
    height: Math.round(this.store.sheet().height / MM),
  }));
  protected readonly NUDGE_MM = NUDGE_MM;
  protected readonly MAX_SHEETS = MAX_SHEETS;
  protected readonly HEADER = HEADER;
  protected readonly SCALE_PERCENT = SCALE_PERCENT;
  protected readonly fileNames = computed(() => this.store.source()?.files.map((f) => f.fileName).join(', ') ?? '');
  /** Size of the selected pieces in percent, or null when they differ. */
  protected readonly selectionScale = computed(() => {
    const sel = this.store.selection();
    const sizes = new Set(this.store.placements().filter((p) => sel.has(p.index)).map((p) => scalePercent(p.scale)));
    return sizes.size === 1 ? [...sizes][0] : null;
  });
  protected readonly selectionLabel = computed(() => {
    const single = this.store.single();
    if (single !== null) return `Dílek ${single + 1}`;
    const n = this.store.selection().size;
    return `${n} ${n >= 2 && n <= 4 ? 'dílky' : 'dílků'}`;
  });
  /** The selected placement when exactly one piece is selected (for the angle input). */
  protected readonly selectedPlacement = computed(() => {
    const i = this.store.single();
    return i === null ? undefined : this.store.placements().find((p) => p.index === i);
  });
  /**
   * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, anywhere on the page except
   * inside text fields, which keep their own undo.
   */
  protected onShortcut(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    const key = e.key.toLowerCase();
    if (key === 'z') e.shiftKey ? this.store.redo() : this.store.undo();
    else if (key === 'y' && !e.shiftKey) this.store.redo();
    else return;
    e.preventDefault();
  }

  /**
   * Adds the chosen PDFs to what is already loaded, one after another. The active template
   * is applied only when the sheet was empty: on top of an arranged layout it would
   * rearrange that too.
   */
  protected async onPdf(input: HTMLInputElement): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    const wasEmpty = !this.store.source();
    this.busy.set(true);
    this.error.set('');
    const errors: string[] = [];
    let added = 0;
    for (const file of files) {
      try {
        const doc = await this.pdfSource.load(file, this.kind);
        this.store.add(doc);
        added += doc.pieces.length;
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof PdfLoadError ? e.message : 'Zpracování PDF selhalo.'}`);
        if (!(e instanceof PdfLoadError)) console.error(e);
      }
    }
    this.busy.set(false);
    if (errors.length) this.error.set(errors.join(' '));
    if (!added) return;
    const t = wasEmpty ? this.templates.active() : null;
    const total = this.store.source()!.pieces.length;
    this.status.set(
      (wasEmpty ? `${total} dílků` : `Přidáno ${added} dílků, celkem ${total}`) +
        (t ? ` · ${this.applyTemplateMessage(t.id)}` : ''),
    );
  }

  protected deleteAll(): void {
    if (!confirm('Odstranit všechna nahraná PDF a jejich dílky?')) return;
    this.pdfSource.release(this.store.source());
    this.store.clear();
    this.error.set('');
    this.status.set('');
  }

  protected onTemplateChange(id: string): void {
    this.templates.setActive(id || null);
    this.error.set('');
    if (id && this.store.source()) this.status.set(this.applyTemplateMessage(id));
  }

  private applyTemplateMessage(id: string): string {
    const t = this.templates.templates().find((x) => x.id === id);
    if (!t) return '';
    const placed = this.store.applyTemplate(t);
    const count = this.store.source()?.pieces.length ?? 0;
    return placed === count && t.pieceCount === count
      ? `šablona „${t.name}“ použita`
      : `šablona „${t.name}“: použito ${placed} z ${count} dílků`;
  }

  protected startSave(): void {
    this.templateName.set(this.templates.active()?.name ?? '');
    this.saving.set(true);
    // The name field replaces the button that was clicked, so focus moves into it.
    afterNextRender(() => document.getElementById('template-name')?.focus(), { injector: this.injector });
  }

  protected saveTemplate(event: Event): void {
    event.preventDefault();
    const name = this.templateName().trim().slice(0, 80);
    if (!name) return;
    // Same name overwrites, so re-saving an edited layout keeps one template.
    const existing = this.templates.templates().find((t) => t.name === name);
    const t = this.store.toTemplate(this.kind.id, name, existing?.id);
    this.templates.save(t);
    this.templates.setActive(t.id);
    this.saving.set(false);
    this.status.set(`Šablona „${name}“ uložena`);
  }

  protected deleteTemplate(): void {
    const t = this.templates.active();
    if (t && confirm(`Smazat šablonu „${t.name}“?`)) {
      this.templates.remove(t.id);
      this.status.set('Šablona smazána');
    }
  }

  protected exportTemplate(): void {
    const t = this.templates.active();
    if (!t) return;
    download(new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' }), `${safeFileName(t.name)}.json`);
  }

  protected async importTemplate(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const t = file.size < 1_000_000 ? this.templates.parse(await file.text()) : 'Neplatný soubor šablony.';
    if (typeof t === 'string') {
      this.error.set(t);
      return;
    }
    this.error.set('');
    this.templates.save(t);
    this.onTemplateChange(t.id);
    if (!this.store.source()) this.status.set(`Šablona „${t.name}“ načtena`);
  }

  protected setOrientation(o: Orientation): void {
    this.store.setOrientation(o);
  }

  protected rotateSelected(delta: number): void {
    this.store.rotateSelection(delta);
  }

  protected setRotation(value: string): void {
    const p = this.selectedPlacement();
    const deg = Number(value);
    if (p && value !== '' && Number.isFinite(deg)) {
      this.store.checkpoint('angle');
      this.store.update(p.index, { rotation: deg });
    }
  }

  protected resizeBy(deltaPercent: number): void {
    this.store.resizeSelection((percent) => percent + deltaPercent);
  }

  /** Sets every selected piece to the typed size, rounded to the allowed step. */
  protected setScale(input: HTMLInputElement): void {
    const percent = Number(input.value);
    if (input.value !== '' && Number.isFinite(percent)) this.store.resizeSelection(() => percent);
    // Show the rounded value even when it did not change the stored one.
    input.value = String(this.selectionScale() ?? '');
  }

  protected nudge(dx: number, dy: number): void {
    this.store.moveSelection(dx * NUDGE_MM * MM, dy * NUDGE_MM * MM);
  }

  protected setCustomSize(widthMm: string, heightMm: string): void {
    const w = Number(widthMm);
    const h = Number(heightMm);
    if (widthMm !== '' && heightMm !== '' && Number.isFinite(w) && Number.isFinite(h)) {
      this.store.setCustomSizeMm(w, h);
    }
  }

  protected async downloadSheet(format: 'pdf' | 'jpg'): Promise<void> {
    const source = this.store.source();
    if (!source) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const pdf = await this.pdfExport.export(
        source,
        this.store.placements(),
        this.store.sheets(),
        this.store.header(),
      );
      const name = `${source.files[0].fileName.replace(/\.pdf$/i, '')}-rozlozeni`;
      if (format === 'pdf') {
        download(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${name}.pdf`);
      } else {
        // One JPG per sheet; spaced out, as browsers drop rapid successive downloads.
        const jpgs = await this.jpgExport.export(pdf);
        for (const [i, jpg] of jpgs.entries()) {
          if (i) await new Promise((resolve) => setTimeout(resolve, 300));
          download(jpg, jpgs.length > 1 ? `${name}-${i + 1}.jpg` : `${name}.jpg`);
        }
      }
    } catch (e) {
      console.error(e);
      this.error.set(format === 'pdf' ? 'Vytvoření PDF selhalo.' : 'Vytvoření JPG selhalo.');
    } finally {
      this.busy.set(false);
    }
  }
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'sablona';
}
