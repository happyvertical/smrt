import type { FieldPolicyRow, FieldPolicyVisibility } from './policy.ts';
import type { ExposureSurface } from './types.ts';

/** What the URL carries about options: saved policy rows and narrowed surfaces. */
export interface OptionsState {
  rows: FieldPolicyRow[];
  /** Surfaces a person switched off, keyed by qualified model name. */
  narrowed: Record<string, ExposureSurface[]>;
}

/** Compact wire form: short keys, rows grouped under their object. */
interface Wire {
  r?: Record<
    string,
    Record<
      string,
      {
        v?: FieldPolicyVisibility;
        l?: string;
        h?: string | null;
        d?: string | null;
        o?: number;
        k?: boolean;
      }
    >
  >;
  x?: Record<string, ExposureSurface[]>;
}

const VISIBILITIES = new Set(['basic', 'advanced', 'hidden']);
const SURFACE_IDS = new Set(['api', 'mcp', 'cli']);

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/** Encode options for the `o` query parameter; empty options give `''`. */
export function encodeOptions(state: OptionsState): string {
  const wire: Wire = {};
  const sorted = [...state.rows].sort(
    (a, b) =>
      a.objectRef.localeCompare(b.objectRef) ||
      a.fieldName.localeCompare(b.fieldName),
  );
  for (const row of sorted) {
    const entry: NonNullable<Wire['r']>[string][string] = {};
    if (row.visibility) entry.v = row.visibility;
    if (row.label) entry.l = row.label;
    if (row.help !== undefined) entry.h = row.help;
    if (row.defaultValue !== undefined) entry.d = row.defaultValue;
    if (typeof row.displayOrder === 'number') entry.o = row.displayOrder;
    if (typeof row.locked === 'boolean') entry.k = row.locked;
    wire.r ??= {};
    wire.r[row.objectRef] ??= {};
    wire.r[row.objectRef][row.fieldName] = entry;
  }
  for (const ref of Object.keys(state.narrowed).sort()) {
    const surfaces = [...state.narrowed[ref]].sort();
    if (surfaces.length) {
      wire.x ??= {};
      wire.x[ref] = surfaces;
    }
  }
  return wire.r || wire.x ? toBase64Url(JSON.stringify(wire)) : '';
}

/** Decode the `o` parameter. Anything malformed decodes to no options. */
export function decodeOptions(value: string | null | undefined): OptionsState {
  const empty: OptionsState = { rows: [], narrowed: {} };
  if (!value) return empty;
  let wire: Wire;
  try {
    wire = JSON.parse(fromBase64Url(value)) as Wire;
  } catch {
    return empty;
  }
  if (!wire || typeof wire !== 'object') return empty;

  const rows: FieldPolicyRow[] = [];
  for (const [objectRef, fields] of Object.entries(wire.r ?? {})) {
    if (!fields || typeof fields !== 'object') continue;
    for (const [fieldName, entry] of Object.entries(fields)) {
      if (!entry || typeof entry !== 'object') continue;
      const row: FieldPolicyRow = { objectRef, fieldName, scopeType: 'app' };
      if (typeof entry.v === 'string' && VISIBILITIES.has(entry.v)) {
        row.visibility = entry.v;
      }
      if (typeof entry.l === 'string') row.label = entry.l;
      if (typeof entry.h === 'string' || entry.h === null) row.help = entry.h;
      if (typeof entry.d === 'string' || entry.d === null) {
        row.defaultValue = entry.d;
      }
      if (typeof entry.o === 'number' && Number.isFinite(entry.o)) {
        row.displayOrder = entry.o;
      }
      if (typeof entry.k === 'boolean') row.locked = entry.k;
      rows.push(row);
    }
  }

  const narrowed: Record<string, ExposureSurface[]> = {};
  for (const [ref, surfaces] of Object.entries(wire.x ?? {})) {
    if (!Array.isArray(surfaces)) continue;
    const valid = surfaces.filter((s): s is ExposureSurface =>
      SURFACE_IDS.has(s),
    );
    if (valid.length) narrowed[ref] = valid;
  }
  return { rows, narrowed };
}
