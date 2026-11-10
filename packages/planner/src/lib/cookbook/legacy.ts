import { recipesById } from '../recipes/index.ts';
import type {
  FieldPolicyRow,
  FieldPolicyVisibility,
} from '../recipes/policy.ts';
import { knownRecipes, withRequirements } from '../recipes/resolve.ts';
import type { ExposureSurface } from '../recipes/types.ts';
import { COOKBOOK_SCHEMA, COOKBOOK_VERSION, type Cookbook } from './types.ts';

/**
 * The URL encoding the planner used before the cookbook (`?r=` recipes and
 * `?o=` options). Read-only now: it exists so old shared links migrate once
 * into the cookbook, then the layout cleans the URL.
 */

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

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/** The legacy recipe and options parameters, if the query carries any. */
export function hasLegacyState(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('r') || params.has('o');
}

function decodeOptions(value: string): {
  rows: FieldPolicyRow[];
  narrowed: Record<string, ExposureSurface[]>;
} {
  const empty = { rows: [], narrowed: {} };
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

/**
 * Turn a legacy query into a cookbook. Lenient like the old reader: unknown
 * recipe ids and malformed options are dropped, since a stale link should
 * still open what it can.
 */
export function cookbookFromLegacySearch(search: string): Cookbook {
  const params = new URLSearchParams(search);
  const ids = (params.get('r') ?? '').split(',').filter(Boolean);
  const recipes = withRequirements(knownRecipes(ids, recipesById), recipesById);
  const covered = new Set(
    recipes.flatMap((id) => recipesById.get(id)?.models ?? []),
  );
  const { rows, narrowed } = decodeOptions(params.get('o') ?? '');
  const cookbook: Cookbook = {
    $schema: COOKBOOK_SCHEMA,
    version: COOKBOOK_VERSION,
    recipes,
    features: [],
    policies: rows.filter((row) => covered.has(row.objectRef)),
  };
  const exposure = Object.fromEntries(
    Object.entries(narrowed).filter(([ref]) => covered.has(ref)),
  );
  if (Object.keys(exposure).length) cookbook.exposure = exposure;
  return cookbook;
}
