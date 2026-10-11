import { Injectable, signal } from '@angular/core';
import { CUSTOM_MM, LayoutTemplate, MM, PAPER_PRESETS, Placement, SheetSpec } from './models';

const STORAGE_KEY = 'trimino.templates.v1';
const ACTIVE_KEY = 'trimino.activeTemplate';
const MAX_PIECES = 500;

/**
 * Templates live in the browser's localStorage; export/import as JSON moves them
 * between browsers or computers. Imported files are untrusted and validated field by
 * field — nothing from them is ever rendered as HTML.
 */
@Injectable({ providedIn: 'root' })
export class TemplateService {
  readonly templates = signal<readonly LayoutTemplate[]>(readStored());
  /** Template applied automatically to every newly loaded PDF. */
  readonly activeId = signal<string | null>(readActive());

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
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* storage unavailable (private mode) — selection just won't survive reload */
    }
  }

  active(): LayoutTemplate | null {
    return this.templates().find((t) => t.id === this.activeId()) ?? null;
  }

  /** Parses an imported file; returns null if it is not a valid template. */
  parse(json: string): LayoutTemplate | null {
    try {
      return validate(JSON.parse(json));
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.templates()));
    } catch {
      /* quota or private mode — templates remain for this session */
    }
  }
}

function readStored(): LayoutTemplate[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.map(validate).filter((t): t is LayoutTemplate => t !== null) : [];
  } catch {
    return [];
  }
}

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
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
    const { index, x, y, rotation } = p as Record<string, unknown>;
    if (!Number.isInteger(index) || (index as number) < 0 || seen.has(index as number)) return null;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(rotation)) return null;
    seen.add(index as number);
    placements.push({ index: index as number, x, y, rotation });
  }

  const sheet = validateSheet(o['sheet']);
  if (sheet === null) return null;

  const name = typeof o['name'] === 'string' && o['name'].trim() ? o['name'].trim().slice(0, 80) : 'Šablona';
  return {
    version: 1,
    id: typeof o['id'] === 'string' && /^[\w-]{1,64}$/.test(o['id']) ? o['id'] : crypto.randomUUID(),
    name,
    orientation: o['orientation'],
    ...(sheet && { sheet }),
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
