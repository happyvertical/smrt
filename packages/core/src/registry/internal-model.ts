/**
 * Internal-model classification: the pure facts shared by the scanner
 * (`scanner/manifest-generator.ts`), the registry's decorator and manifest
 * paths, and later the load-time manifest normaliser.
 *
 * Two kinds of model are internal:
 * - `junction`: the item model of a junction collection (a collection whose
 *   ancestry ends at `SmrtJunction` or `SmrtJunctionBase`);
 * - `system`: a model whose resolved table name starts with `_smrt_`.
 *
 * This module only classifies. Which generated surfaces a kind closes is
 * decided elsewhere; a kind is recorded on the manifest entry
 * (`SmartObjectDefinition.internal`) and the registration
 * (`RegisteredClass.internalKind`), and is never cleared once recorded.
 */

/** Kind of an internal model. */
export type InternalModelKind = 'junction' | 'system';

/** The framework junction collection bases, matched by simple name. */
export const JUNCTION_BASE_NAMES = [
  'SmrtJunction',
  'SmrtJunctionBase',
] as const;

const SYSTEM_TABLE_PREFIX = '_smrt_';

function unquote(part: string): string {
  const trimmed = part.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    trimmed.length >= 2 &&
    ((first === '"' && last === '"') ||
      (first === '`' && last === '`') ||
      (first === '[' && last === ']'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Normalise a table name for classification: trim, drop one schema qualifier
 * and identifier quotes, and case-fold.
 */
export function normalizeTableName(name: string): string {
  const trimmed = name.trim();
  // Split on the first dot outside quotes, so a quoted name may contain dots.
  let split = -1;
  let quote: string | undefined;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === '`') {
      quote = char;
    } else if (char === '[') {
      quote = ']';
    } else if (char === '.') {
      split = i;
      break;
    }
  }
  const table = split === -1 ? trimmed : trimmed.slice(split + 1);
  return unquote(table).toLowerCase();
}

/** True when the table name, normalised, starts with `_smrt_`. */
export function isSystemTableName(name: string | undefined | null): boolean {
  if (typeof name !== 'string' || name.trim() === '') return false;
  return normalizeTableName(name).startsWith(SYSTEM_TABLE_PREFIX);
}

/** True for `SmrtJunction` / `SmrtJunctionBase`, simple or qualified. */
export function isJunctionBaseName(name: string | undefined | null): boolean {
  if (typeof name !== 'string') return false;
  const simple = name.includes(':')
    ? name.slice(name.lastIndexOf(':') + 1)
    : name;
  return (JUNCTION_BASE_NAMES as readonly string[]).includes(simple);
}

/**
 * True for a junction collection constructor: one that carries the static
 * `_isJunctionBase` brand `SmrtJunctionBase` declares. A static property is
 * read through the constructor chain, so this also holds for a class built on
 * another copy of smrt-core, where `instanceof` fails.
 */
export function isJunctionCollectionConstructor(ctor: unknown): boolean {
  return (
    typeof ctor === 'function' &&
    (ctor as { _isJunctionBase?: unknown })._isJunctionBase === true
  );
}

/**
 * Merge two kinds without ever clearing one. `system` wins over `junction`:
 * a system model stays `system` whatever collection joins it.
 */
export function mergeInternalKind(
  current: InternalModelKind | undefined,
  incoming: InternalModelKind | undefined,
): InternalModelKind | undefined {
  if (current === 'system' || incoming === 'system') return 'system';
  return current ?? incoming;
}

/** The internal-model stamps a registration carries. */
export interface InternalModelStamps {
  internalKind?: InternalModelKind;
  junctionCollection?: true;
  defaultedExposure?: Array<'api' | 'mcp' | 'cli'>;
}

/** The registration stamps a manifest entry records. */
export function internalStampsFromEntry(
  entry:
    | {
        internal?: InternalModelKind;
        junction?: true;
        defaultedExposure?: Array<'api' | 'mcp' | 'cli'>;
      }
    | undefined,
): InternalModelStamps {
  const stamps: InternalModelStamps = {};
  if (entry?.internal === 'junction' || entry?.internal === 'system')
    stamps.internalKind = entry.internal;
  if (entry?.junction === true) stamps.junctionCollection = true;
  if (Array.isArray(entry?.defaultedExposure))
    stamps.defaultedExposure = [...entry.defaultedExposure];
  return stamps;
}

/**
 * Carry `source`'s stamps onto `target` without clearing any: the kind merges
 * monotonically, the junction flag only turns on, and a present
 * `defaultedExposure` replaces an absent or different one. Returns whether
 * `target` changed, so the caller can invalidate generation-keyed memos.
 */
export function mergeInternalStamps(
  target: InternalModelStamps,
  source: InternalModelStamps | undefined,
): boolean {
  if (!source) return false;
  let changed = false;
  const kind = mergeInternalKind(target.internalKind, source.internalKind);
  if (kind !== target.internalKind) {
    target.internalKind = kind;
    changed = true;
  }
  if (source.junctionCollection && !target.junctionCollection) {
    target.junctionCollection = true;
    changed = true;
  }
  if (
    source.defaultedExposure &&
    source.defaultedExposure.join() !== target.defaultedExposure?.join()
  ) {
    target.defaultedExposure = [...source.defaultedExposure];
    changed = true;
  }
  return changed;
}
