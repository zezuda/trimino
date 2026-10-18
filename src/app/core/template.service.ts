import { Injectable, inject, signal } from '@angular/core';
import { CUSTOM_MM, LayoutTemplate, MAX_SHEETS, MM, PAPER_PRESETS, Placement, SheetSpec, snapScale } from './models';
import { PIECE_KIND, PIECE_KINDS } from './piece-kind';

const MAX_PIECES = 500;

/**
 * Templates live in the browser's localStorage, separately for each module (see
 * app.routes.ts); export/import as JSON moves them between browsers or computers.
 * Imported files are untrusted and validated field by field — nothing from them is
 * ever rendered as HTML.
 */
@Injectable()
export class TemplateService {
  private readonly kind = inject(PIECE_KIND);
  readonly templates = signal<readonly LayoutTemplate[]>(this.readStored());
  /** Template applied automatically to every newly loaded PDF. */
  readonly activeId = signal<string | null>(this.readActive());

  save(template: LayoutTemplate): void {
    this.templates.update((list) => [...list.filter((t) => t.id !== template.id), template]);
    this.persist();
  }

  remove(id: string): void {
    this.templates.update((list) => list.filter((t) => t.id !== id));
    if (this.activeId() === id) this.setActive(null);
    this.persist();
  }

  setActive(id: string | null): void {
    this.activeId.set(id);
    try {
      if (id) localStorage.setItem(this.kind.activeKey, id);
      else localStorage.removeItem(this.kind.activeKey);
    } catch {
      /* storage unavailable (private mode) — selection just won't survive reload */
    }
  }

  active(): LayoutTemplate | null {
    return this.templates().find((t) => t.id === this.activeId()) ?? null;
  }

  /** Parses an imported file; returns an error message if it is not a valid template of this module. */
  parse(json: string): LayoutTemplate | string {
    let t: LayoutTemplate | null;
    try {
      t = validate(JSON.parse(json));
    } catch {
      t = null;
    }
    if (!t) return 'Neplatný soubor šablony.';
    if ((t.kind ?? 'trimino') !== this.kind.id) {
      const other = PIECE_KINDS.find((k) => k.id === (t.kind ?? 'trimino'));
      return `Šablona je pro ${other?.title}, ne pro ${this.kind.title}.`;
    }
    return t;
  }

  private persist(): void {
    try {
      localStorage.setItem(this.kind.storageKey, JSON.stringify(this.templates()));
    } catch {
      /* quota or private mode — templates remain for this session */
    }
  }

  private readStored(): LayoutTemplate[] {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(this.kind.storageKey) ?? '[]');
      return Array.isArray(raw) ? raw.map(validate).filter((t): t is LayoutTemplate => t !== null) : [];
    } catch {
      return [];
    }
  }

  private readActive(): string | null {
    try {
      return localStorage.getItem(this.kind.activeKey);
    } catch {
      return null;
    }
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validate(v: unknown): LayoutTemplate | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1) return null;
  if (o['orientation'] !== 'portrait' && o['orientation'] !== 'landscape') return null;
  if (!Array.isArray(o['placements']) || o['placements'].length > MAX_PIECES) return null;

  const placements: Placement[] = [];
  const seen = new Set<number>();
  for (const p of o['placements'] as unknown[]) {
    if (typeof p !== 'object' || p === null) return null;
    const { index, x, y, rotation, scale } = p as Record<string, unknown>;
    if (!Number.isInteger(index) || (index as number) < 0 || seen.has(index as number)) return null;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(rotation)) return null;
    // Missing in templates saved before resizing existed, which means 100 %.
    if (scale !== undefined && !isFiniteNumber(scale)) return null;
    seen.add(index as number);
    placements.push({ index: index as number, x, y, rotation, scale: snapScale((scale ?? 1) * 100) });
  }

  const sheet = validateSheet(o['sheet']);
  if (sheet === null) return null;

  const sheetCount = o['sheetCount'];
  if (sheetCount !== undefined && !(Number.isInteger(sheetCount) && (sheetCount as number) >= 1 && (sheetCount as number) <= MAX_SHEETS)) {
    return null;
  }

  const kind = PIECE_KINDS.find((k) => k.id === o['kind'])?.id;
  if (o['kind'] !== undefined && !kind) return null;

  const name = typeof o['name'] === 'string' && o['name'].trim() ? o['name'].trim().slice(0, 80) : 'Šablona';
  return {
    version: 1,
    id: typeof o['id'] === 'string' && /^[\w-]{1,64}$/.test(o['id']) ? o['id'] : crypto.randomUUID(),
    ...(kind && { kind }),
    name,
    orientation: o['orientation'],
    ...(sheet && { sheet }),
    ...(sheetCount !== undefined && { sheetCount: sheetCount as number }),
    pieceCount: Number.isInteger(o['pieceCount']) ? (o['pieceCount'] as number) : placements.length,
    placements,
    createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'].slice(0, 40) : new Date().toISOString(),
  };
}

/** `undefined` = not present (old template, means A4); `null` = present but invalid. */
function validateSheet(v: unknown): SheetSpec | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null) return null;
  const { preset, width, height } = v as Record<string, unknown>;
  const presets = [...Object.keys(PAPER_PRESETS), 'custom'];
  if (typeof preset !== 'string' || !presets.includes(preset)) return null;
  const inRange = (n: unknown) => isFiniteNumber(n) && n >= CUSTOM_MM.min * MM - 1 && n <= CUSTOM_MM.max * MM + 1;
  if (!inRange(width) || !inRange(height)) return null;
  return { preset: preset as SheetSpec['preset'], width: width as number, height: height as number };
}
