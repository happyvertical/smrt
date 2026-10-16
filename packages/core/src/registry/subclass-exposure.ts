/**
 * Generated-surface (api/mcp/cli) exposure that a model subclass takes from
 * its parent model.
 *
 * A model that extends another registered model (an STI child such as
 * `Person extends Profile`, or a CTI subclass) is generated as a resource of
 * its own: `person_create` MCP tools, `person:create` CLI commands, routes
 * for its public methods. Every operation it inherits from its parent is the
 * parent's operation, so a subclass must not publish what its parent closes
 * just because its own `@smrt()` (or the lack of one) does not restate the
 * parent's config.
 *
 * - A surface the subclass leaves unset inherits its parent's effective
 *   value as is: `false`, `include`/`exclude` lists and the surface's other
 *   options. A parent that leaves the surface unset leaves it unset.
 * - `sensitive: true` is inherited the same way and cannot be turned off.
 * - A subclass that configures a surface itself keeps its own value. It may
 *   narrow its parent's surface; widening it (opening a CRUD verb or a
 *   parent method the parent keeps closed) fails the build
 *   (`CONFIG_SUBCLASS_EXPOSURE`) unless the subclass names each such
 *   operation in `widenParentExposure`, so every deliberate widening is
 *   visible in source. Methods only the subclass declares are its own API
 *   and are not checked.
 *
 * `abstract` is not inherited and is not a closure here: an abstract parent
 * exists so that concrete subclasses can open what it cannot.
 *
 * Pure functions over config objects: the manifest generator applies them at
 * build time and `ObjectRegistry.getConfig()` applies them again at runtime,
 * so a manifest built before this rule existed is held to it too.
 */
import type { ExposureSurface } from './collection-exposure';
import { EXPOSURE_SURFACES } from './collection-exposure';
import type { SmartObjectConfig } from './types';

const CRUD_VERBS = new Set(['list', 'get', 'create', 'update', 'delete']);

function isCrud(name: string): boolean {
  return CRUD_VERBS.has(name);
}

/**
 * The surfaces and `sensitive` flag a subclass inherits from its parent's
 * effective config: every surface the subclass leaves unset that the parent
 * sets, plus `sensitive: true`. Returns an empty object when nothing changes.
 */
export function inheritSubclassExposure(
  childConfig: SmartObjectConfig,
  parentConfig: SmartObjectConfig,
): Partial<Pick<SmartObjectConfig, ExposureSurface | 'sensitive'>> {
  const inherited: Partial<
    Pick<SmartObjectConfig, ExposureSurface | 'sensitive'>
  > = {};
  for (const surface of EXPOSURE_SURFACES) {
    if (childConfig[surface] !== undefined) continue;
    const value = parentConfig[surface];
    if (value === undefined) continue;
    (inherited as Record<string, unknown>)[surface] =
      value && typeof value === 'object' ? { ...value } : value;
  }
  if (parentConfig.sensitive === true && childConfig.sensitive === undefined) {
    inherited.sensitive = true;
  }
  return inherited;
}

/**
 * Whether a surface config opens `operation` (a CRUD verb or a method name),
 * read the way that transport's generator reads it:
 *
 * - `false` opens nothing; an absent value or `true` opens everything.
 * - `exclude` withholds a name (case-insensitively for MCP methods).
 * - `include` is the complete allowlist for CRUD verbs on every transport,
 *   and for methods on MCP and REST. On the CLI an `include` that names only
 *   CRUD verbs leaves methods open; one that names a method is strict.
 */
export function surfaceOpensOperation(
  surface: ExposureSurface,
  value: unknown,
  operation: string,
): boolean {
  if (value === false) return false;
  if (!value || typeof value !== 'object') return true;
  const { include, exclude } = value as {
    include?: unknown;
    exclude?: unknown;
  };
  const excluded = Array.isArray(exclude)
    ? exclude.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const crud = isCrud(operation);
  if (excluded.includes(operation)) return false;
  if (
    !crud &&
    surface === 'mcp' &&
    excluded.some((entry) => entry.toLowerCase() === operation.toLowerCase())
  ) {
    return false;
  }
  if (!Array.isArray(include)) return true;
  if (include.includes(operation)) return true;
  if (crud) return false;
  if (surface === 'cli') {
    // CLI strict mode only switches on when the list names a method.
    return !include.some(
      (entry) => typeof entry === 'string' && !isCrud(entry),
    );
  }
  return false;
}

/** Operations a subclass opens on one transport where its parent does not. */
export interface SubclassExposureEscalation {
  surface: ExposureSurface | 'sensitive';
  operations: string[];
}

function widenedOperations(
  config: SmartObjectConfig,
  surface: ExposureSurface,
): Set<string> {
  const declared = config.widenParentExposure?.[surface];
  return new Set(Array.isArray(declared) ? declared : []);
}

/**
 * Operations the subclass's effective config opens that its parent's
 * effective config closes, per transport. `operations` is every method the
 * parent declares or inherits (CRUD verbs are always checked). Pass both
 * configs AFTER inheritance; a subclass that configures nothing then never
 * escalates, so a finding always points at the subclass's own `@smrt()`.
 * Operations named in the subclass's `widenParentExposure` are accepted.
 */
export function findSubclassExposureEscalations(
  childConfig: SmartObjectConfig,
  parentConfig: SmartObjectConfig,
  parentOperations: Iterable<string>,
): SubclassExposureEscalation[] {
  const operations = [...CRUD_VERBS];
  for (const name of parentOperations) {
    if (!isCrud(name) && !operations.includes(name)) operations.push(name);
  }
  const escalations: SubclassExposureEscalation[] = [];
  for (const surface of EXPOSURE_SURFACES) {
    const accepted = widenedOperations(childConfig, surface);
    const opened = operations.filter(
      (operation) =>
        !accepted.has(operation) &&
        surfaceOpensOperation(surface, childConfig[surface], operation) &&
        !surfaceOpensOperation(surface, parentConfig[surface], operation),
    );
    if (opened.length > 0) escalations.push({ surface, operations: opened });
  }
  if (parentConfig.sensitive === true && childConfig.sensitive !== true) {
    escalations.push({ surface: 'sensitive', operations: [] });
  }
  return escalations;
}

/**
 * `widenParentExposure` entries that accept nothing: the operation is not
 * opened by the subclass, or is already open on the parent. A stale entry
 * would otherwise silently pre-approve a later widening.
 */
export function findStaleWidenings(
  childConfig: SmartObjectConfig,
  parentConfig: SmartObjectConfig,
): Array<{ surface: ExposureSurface; operations: string[] }> {
  const stale: Array<{ surface: ExposureSurface; operations: string[] }> = [];
  for (const surface of EXPOSURE_SURFACES) {
    const operations = [...widenedOperations(childConfig, surface)].filter(
      (operation) =>
        !surfaceOpensOperation(surface, childConfig[surface], operation) ||
        surfaceOpensOperation(surface, parentConfig[surface], operation),
    );
    if (operations.length > 0) stale.push({ surface, operations });
  }
  return stale;
}

/** Build-time error text for subclasses that widen their parent's surface. */
export function formatSubclassExposureEscalations(
  findings: Array<{
    subclass: string;
    parent: string;
    escalations: SubclassExposureEscalation[];
    stale?: Array<{ surface: ExposureSurface; operations: string[] }>;
  }>,
): string {
  const lines = findings.flatMap(({ subclass, parent, escalations, stale }) => [
    ...escalations.map(({ surface, operations }) =>
      surface === 'sensitive'
        ? `  - ${subclass} is not sensitive, but ${parent} is.`
        : `  - ${subclass} opens ${surface} ${operations.join(', ')}, which ${parent} closes.`,
    ),
    ...(stale ?? []).map(
      ({ surface, operations }) =>
        `  - ${subclass} lists ${surface} ${operations.join(', ')} in widenParentExposure, but does not open it beyond ${parent}.`,
    ),
  ]);
  return [
    '[smrt] A model subclass publishes generated operations its parent closes:',
    ...lines,
    '',
    "A subclass's inherited operations are its parent's operations, so its own",
    "@smrt() may narrow the parent's api/mcp/cli surface but not widen it.",
    'Either:',
    "  - narrow the subclass's surface (or drop that surface key so the subclass",
    "    inherits the parent's), or",
    '  - if the subclass deliberately opens it, name each operation in',
    "    `widenParentExposure: { <surface>: ['<operation>'] }` on the subclass.",
    "A subclass cannot drop its parent's `sensitive: true`.",
    'Methods only the subclass declares are not affected.',
  ].join('\n');
}
