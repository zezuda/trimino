import { Component, computed, inject, signal } from '@angular/core';
import { Artboard, ROTATE_STEP } from './artboard/artboard';
import { LayoutStore } from './core/layout.store';
import { CUSTOM_MM, MM, Orientation, PAPER_PRESETS, PaperPreset } from './core/models';
import { JpgExportService } from './core/jpg-export.service';
import { PdfExportService } from './core/pdf-export.service';
import { PdfLoadError, PdfSourceService } from './core/pdf-source.service';
import { TemplateService } from './core/template.service';

const NUDGE_MM = 5;

@Component({
  selector: 'app-root',
  imports: [Artboard],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly store = inject(LayoutStore);
  protected readonly templates = inject(TemplateService);
  private readonly pdfSource = inject(PdfSourceService);
  private readonly pdfExport = inject(PdfExportService);
  private readonly jpgExport = inject(JpgExportService);

  protected readonly busy = signal(false);
  protected readonly status = signal('');
  protected readonly error = signal('');
  protected readonly saving = signal(false);
  protected readonly templateName = signal('');

  protected readonly ROTATE_STEP = ROTATE_STEP;
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
  protected readonly selectedPlacement = computed(() => {
    const i = this.store.selected();
    return i === null ? undefined : this.store.placements().find((p) => p.index === i);
  });

  protected async onPdf(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const doc = await this.pdfSource.load(file);
      this.pdfSource.release(this.store.source());
      this.store.load(doc);
      const t = this.templates.active();
      this.status.set(`${doc.pieces.length} dílků` + (t ? ` · ${this.applyTemplateMessage(t.id)}` : ''));
    } catch (e) {
      this.error.set(e instanceof PdfLoadError ? e.message : 'Zpracování PDF selhalo.');
      if (!(e instanceof PdfLoadError)) console.error(e);
    } finally {
      this.busy.set(false);
    }
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
  }

  protected saveTemplate(event: Event): void {
    event.preventDefault();
    const name = this.templateName().trim().slice(0, 80);
    if (!name) return;
    // Same name overwrites, so re-saving an edited layout keeps one template.
    const existing = this.templates.templates().find((t) => t.name === name);
    const t = this.store.toTemplate(name, existing?.id);
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
    const t = file.size < 1_000_000 ? this.templates.parse(await file.text()) : null;
    if (!t) {
      this.error.set('Neplatný soubor šablony.');
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
    const p = this.selectedPlacement();
    if (p) this.store.update(p.index, { rotation: p.rotation + delta });
  }

  protected setRotation(value: string): void {
    const p = this.selectedPlacement();
    const deg = Number(value);
    if (p && value !== '' && Number.isFinite(deg)) this.store.update(p.index, { rotation: deg });
  }

  protected nudge(dx: number, dy: number): void {
    const p = this.selectedPlacement();
    if (p) this.store.update(p.index, { x: p.x + dx * NUDGE_MM * MM, y: p.y + dy * NUDGE_MM * MM });
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
      const pdf = await this.pdfExport.export(source, this.store.placements(), this.store.sheet());
      const blob =
        format === 'pdf'
          ? new Blob([pdf as BlobPart], { type: 'application/pdf' })
          : await this.jpgExport.export(pdf);
      download(blob, `${source.fileName.replace(/\.pdf$/i, '')}-rozlozeni.${format}`);
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
