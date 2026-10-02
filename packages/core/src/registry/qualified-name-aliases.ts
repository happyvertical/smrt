/**
 * Deprecated qualified-name aliases (#3338).
 *
 * A class that moves package (or is renamed) changes its qualified name, and
 * every persisted or declared reference to the old name — a polymorphic
 * `metaType`, a `@crossPackageRef` target, a playbook `model:` — would stop
 * resolving silently. `@smrt({ previousQualifiedNames })` declares the old
 * names; this module turns them into lookup bridges.
 *
 * An alias is never a registry key. The `classes` map — and so
 * `getAllClasses()`, schema/DDL, MCP, CLI and REST generation, and every other
 * iteration — still holds exactly one entry per class. Qualified-name lookups
 * consult the derived alias index only after a direct miss, so a live class
 * always wins and an alias can never shadow one; registration refuses the
 * collisions that would make that ambiguous.
 *
 * Like the simple-name index in `name-resolver.ts`, the alias index is
 * derived, not maintained: it is rebuilt from `classes` once per registry
 * generation (#3047).
 */

import { createLogger } from '@happyvertical/logger';
import { ConfigurationError } from '../errors';
import {
  getLocalTestManifestCache,
  getManifestCache,
  getStaticManifestCache,
  getTestManifestCache,
} from '../manifest/store.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  isQualifiedNameAliasFormat,
  readPreviousQualifiedNames,
} from '../utils/qualified-names.js';
import { recordRegistryDiagnostic } from './diagnostics';
import { getRegistryGeneration } from './generation';
import { getClasses } from './shared-state';
import type { RegisteredClass } from './types';

export {
  isQualifiedNameAliasFormat,
  readPreviousQualifiedNames,
} from '../utils/qualified-names.js';

/** Error code for an alias that collides with a live class or another alias. */
export const QUALIFIED_NAME_ALIAS_COLLISION =
  'CONFIG_QUALIFIED_NAME_ALIAS_COLLISION';

/** Error code for a malformed `previousQualifiedNames` declaration. */
export const QUALIFIED_NAME_ALIAS_INVALID =
  'CONFIG_QUALIFIED_NAME_ALIAS_INVALID';

/** Diagnostic code recorded (once per alias) when a lookup uses an old name. */
export const QUALIFIED_NAME_ALIAS_DEPRECATED =
  'QUALIFIED_NAME_ALIAS_DEPRECATED';

const logger = createLogger({ level: 'info' });

declare global {
  // eslint-disable-next-line no-var
  var __smrtRegistryWarnedQualifiedNameAliases: Set<string> | undefined;
}

function getWarnedAliases(): Set<string> {
  if (!globalThis.__smrtRegistryWarnedQualifiedNameAliases) {
    globalThis.__smrtRegistryWarnedQualifiedNameAliases = new Set();
  }
  return globalThis.__smrtRegistryWarnedQualifiedNameAliases;
}

/** Forget which aliases already warned (`ObjectRegistry.clear()`, tests). */
export function resetQualifiedNameAliasWarnings(): void {
  getWarnedAliases().clear();
}

/**
 * Two registrations describe the same class: one object, one constructor, or
 * one qualified name (a manifest stub later replaced by its real class, or
 * an HMR reload).
 */
function sameClass(left: RegisteredClass, right: RegisteredClass): boolean {
  return (
    left === right ||
    left.constructor === right.constructor ||
    (!!left.qualifiedName && left.qualifiedName === right.qualifiedName)
  );
}

function ownName(entry: RegisteredClass, registrationKey?: string): string {
  return entry.qualifiedName ?? registrationKey ?? entry.name;
}

let aliasIndex:
  | {
      generation: number;
      classes: Map<string, RegisteredClass>;
      byAlias: Map<string, RegisteredClass>;
    }
  | undefined;

/** Alias → registered class, rebuilt once per registry generation. */
function getAliasIndex(): Map<string, RegisteredClass> {
  const classes = getClasses();
  const generation = getRegistryGeneration();
  if (
    aliasIndex &&
    aliasIndex.generation === generation &&
    aliasIndex.classes === classes
  ) {
    return aliasIndex.byAlias;
  }

  const byAlias = new Map<string, RegisteredClass>();
  for (const [key, entry] of classes) {
    for (const alias of readPreviousQualifiedNames(entry.config)) {
      // A live class always wins over an alias (registration refuses the
      // collision; this guards registries assembled before that check ran).
      if (classes.has(alias)) continue;
      const existing = byAlias.get(alias);
      // The same class can sit under a transitional simple key and its
      // qualified key; prefer the qualified registration.
      if (!existing || (sameClass(existing, entry) && key.includes(':'))) {
        byAlias.set(alias, entry);
      }
    }
  }
  aliasIndex = { generation, classes, byAlias };
  return byAlias;
}

/**
 * The class a deprecated qualified name now resolves to, WITHOUT warning.
 * Returns `undefined` for live names and unknown names alike.
 */
export function lookupQualifiedNameAlias(
  name: string,
): RegisteredClass | undefined {
  if (!name.includes(':')) return undefined;
  return getAliasIndex().get(name);
}

/**
 * Resolve a deprecated qualified name to its current class, logging the
 * one-time deprecation warning. `source` names the resolution site for that
 * warning (e.g. `SmrtPolymorphicAssociation.hydrate`).
 */
export function resolveQualifiedNameAlias(
  name: string,
  source = 'ObjectRegistry qualified-name lookup',
): RegisteredClass | undefined {
  const registered = lookupQualifiedNameAlias(name);
  if (registered) {
    warnDeprecatedQualifiedName(
      name,
      registered.qualifiedName ?? registered.name,
      source,
    );
  }
  return registered;
}

/**
 * Warn — once per old name per process — that a lookup used a deprecated
 * qualified name. Also recorded as a `warn` registry diagnostic so apps and
 * tests can inspect it through `ObjectRegistry.getDiagnostics()`.
 */
export function warnDeprecatedQualifiedName(
  alias: string,
  current: string,
  source: string,
): void {
  const warned = getWarnedAliases();
  if (warned.has(alias)) return;
  warned.add(alias);
  const message =
    `Qualified name "${alias}" is deprecated; it now resolves to "${current}" ` +
    `(resolved from ${source}). Store and declare "${current}" instead — ` +
    'the alias will be removed in a later breaking release. ' +
    '`smrt doctor --db` counts stored references that still use it.';
  const context = { alias, current, source };
  recordRegistryDiagnostic('warn', QUALIFIED_NAME_ALIAS_DEPRECATED, message, {
    ...context,
  });
  logger.warn(`[smrt:${QUALIFIED_NAME_ALIAS_DEPRECATED}] ${message}`, context);
}

/** Every declared alias → its class's current qualified name, sorted. */
export function getQualifiedNameAliasMap(): Map<string, string> {
  const entries = [...getAliasIndex()].map(
    ([alias, registered]) =>
      [alias, registered.qualifiedName ?? registered.name] as const,
  );
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return new Map(entries);
}

/**
 * Refuse a registration whose aliases would make a qualified name resolve to
 * two classes. Called before a class is stored in `classes` — and, for an
 * update of a live entry, with the PROPOSED entry and `replacing` set to the
 * live one, before anything is mutated, so a refused update changes nothing.
 *
 * - every alias is a scoped `@scope/package:ClassName` string, distinct from the
 *   class's own name, and declared once;
 * - no alias is the key of a different live class;
 * - no alias is also declared by a different class;
 * - the class's own name is not another class's alias.
 *
 * @throws {ConfigurationError} `CONFIG_QUALIFIED_NAME_ALIAS_INVALID` or
 *   `CONFIG_QUALIFIED_NAME_ALIAS_COLLISION`.
 */
export function assertQualifiedNameAliasesAvailable(
  registrationKey: string,
  entry: RegisteredClass,
  replacing?: RegisteredClass,
): void {
  const self = ownName(entry, registrationKey);
  const declared = (entry.config as { previousQualifiedNames?: unknown })
    ?.previousQualifiedNames;
  if (declared !== undefined && !Array.isArray(declared)) {
    throw new ConfigurationError(
      `${self}: previousQualifiedNames must be an array of qualified names ("@package/name:ClassName").`,
      QUALIFIED_NAME_ALIAS_INVALID,
      { className: self, previousQualifiedNames: declared },
    );
  }
  const aliases = (declared as unknown[] | undefined) ?? [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (!isQualifiedNameAliasFormat(alias)) {
      throw new ConfigurationError(
        `${self}: previousQualifiedNames entry ${JSON.stringify(alias)} is not a qualified name ("@package/name:ClassName").`,
        QUALIFIED_NAME_ALIAS_INVALID,
        { className: self, alias },
      );
    }
    if (alias === self) {
      throw new ConfigurationError(
        `${self}: previousQualifiedNames lists the class's own current name "${alias}".`,
        QUALIFIED_NAME_ALIAS_INVALID,
        { className: self, alias },
      );
    }
    if (alias === registrationKey) {
      // Another package's manifest entry under the old name is being merged
      // into, or keyed onto, this class: the old name is still live.
      throw collision(
        `${self} declares previousQualifiedNames "${alias}", but a class is being registered under "${alias}". ` +
          'An alias may only name a class that no longer exists; remove the alias or the stale class/manifest.',
        { className: self, alias },
      );
    }
    if (seen.has(alias)) {
      throw new ConfigurationError(
        `${self}: previousQualifiedNames lists "${alias}" more than once.`,
        QUALIFIED_NAME_ALIAS_INVALID,
        { className: self, alias },
      );
    }
    seen.add(alias);
  }

  const classes = getClasses();
  // Identities a registration answers to: its qualified name, its key, and
  // `<packageName>:<name>` (a source registration can sit under a simple key
  // before its qualified promotion).
  const identities = (other: RegisteredClass, key: string): string[] => [
    ownName(other, key),
    key,
    ...(other.packageName ? [`${other.packageName}:${other.name}`] : []),
  ];
  const selfIdentities = new Set(identities(entry, registrationKey));

  for (const [key, other] of classes) {
    if (other === replacing || sameClass(other, entry)) continue;
    const otherName = ownName(other, key);
    for (const identity of identities(other, key)) {
      if (seen.has(identity)) {
        throw collision(
          `${self} declares previousQualifiedNames "${identity}", but "${identity}" is a live registered class. ` +
            'An alias may only name a class that no longer exists; remove the alias or the stale class/manifest.',
          { className: self, alias: identity, liveClass: otherName },
        );
      }
    }
    const otherAliases = readPreviousQualifiedNames(other.config);
    if (otherAliases.length === 0) continue;
    for (const alias of otherAliases) {
      if (seen.has(alias)) {
        throw collision(
          `previousQualifiedNames "${alias}" is declared by both ${self} and ${otherName}; ` +
            'an old name can resolve to only one class.',
          { className: self, alias, otherClass: otherName },
        );
      }
      if (selfIdentities.has(alias)) {
        throw collision(
          `${otherName} declares previousQualifiedNames "${alias}", but ${self} is registered under that name. ` +
            'An alias may only name a class that no longer exists; remove the alias or the stale class/manifest.',
          { className: self, alias, otherClass: otherName },
        );
      }
    }
  }

  // A competing claim in any manifest this process has loaded — an
  // installed package not registered yet — is the same collision (#3338).
  if (seen.size > 0) {
    assertNoCompetingManifestClaims(
      seen,
      collectManifestAliasInventory(loadedManifests()),
      entry.qualifiedName ?? self,
    );
  }
}

function collision(
  message: string,
  details: Record<string, unknown>,
): ConfigurationError {
  return new ConfigurationError(
    message,
    QUALIFIED_NAME_ALIAS_COLLISION,
    details,
  );
}

/** The current qualified name a manifest object registers under. */
function manifestObjectQualifiedName(
  manifest: SmartObjectManifest,
  key: string,
  objectDef: SmartObjectManifest['objects'][string],
): string | undefined {
  if (objectDef.qualifiedName) return objectDef.qualifiedName;
  if (key.includes(':')) return key;
  const packageName = objectDef.packageName ?? manifest.packageName;
  return packageName ? `${packageName}:${objectDef.className}` : undefined;
}

/**
 * What a set of manifests says about qualified names (#3338): which classes
 * claim each old name, and which qualified names the manifests DEFINE as
 * classes of their own (installed but possibly unregistered).
 */
export interface ManifestAliasInventory {
  /** Old name → distinct current names claiming it. */
  claims: Map<string, Set<string>>;
  /** Every qualified name a manifest defines as a class. */
  defined: Set<string>;
}

/**
 * Index `manifests` (one manifest may appear twice, e.g. cached and static;
 * the same class claiming twice is one claim). A re-exported constructor is
 * not a definition: manifests list only classes a package declares.
 */
export function collectManifestAliasInventory(
  manifests: Iterable<SmartObjectManifest | null | undefined>,
): ManifestAliasInventory {
  const claims = new Map<string, Set<string>>();
  const defined = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest?.objects) continue;
    for (const [key, objectDef] of Object.entries(manifest.objects)) {
      const current = manifestObjectQualifiedName(manifest, key, objectDef);
      if (!current) continue;
      defined.add(current);
      for (const alias of readPreviousQualifiedNames(
        objectDef?.decoratorConfig,
      )) {
        const owners = claims.get(alias) ?? new Set<string>();
        owners.add(current);
        claims.set(alias, owners);
      }
    }
  }
  return { claims, defined };
}

/**
 * THE manifest rule for old names (#3338). Throws when any of `aliases`:
 *
 * - is defined as a class by a manifest in `inventory` — an installed
 *   (possibly stale) package still ships the old class, so the old name is
 *   live, not deprecated;
 * - is claimed by a class other than `owner` (or, with no `owner`, by more
 *   than one class).
 *
 * @throws {ConfigurationError} `CONFIG_QUALIFIED_NAME_ALIAS_COLLISION`
 */
export function assertNoCompetingManifestClaims(
  aliases: Iterable<string>,
  inventory: ManifestAliasInventory,
  owner?: string,
): void {
  for (const alias of aliases) {
    if (inventory.defined.has(alias)) {
      const claimants = [...(inventory.claims.get(alias) ?? [])];
      if (owner && !claimants.includes(owner)) claimants.push(owner);
      throw collision(
        `previousQualifiedNames "${alias}" is still defined as a class by an installed manifest (claimed by ${claimants.sort().join(', ') || 'no class'}). ` +
          'An alias may only name a class that no longer exists; remove the stale package/manifest or the alias.',
        { alias, claimants: claimants.sort(), definedByManifest: true },
      );
    }
    const owners = new Set(inventory.claims.get(alias) ?? []);
    if (owner) owners.add(owner);
    if (owners.size > 1) {
      const sorted = [...owners].sort();
      throw collision(
        `previousQualifiedNames "${alias}" is declared by more than one class across installed manifests (${sorted.join(', ')}); ` +
          'an old name can resolve to only one class.',
        { alias, claimants: sorted },
      );
    }
  }
}

/** Every manifest this process has loaded (package, static, test caches). */
function loadedManifests(): Array<SmartObjectManifest | null | undefined> {
  return [
    ...getManifestCache().values(),
    getStaticManifestCache(),
    getTestManifestCache(),
    getLocalTestManifestCache(),
  ];
}

/**
 * The single current owner of `alias` in an inventory, or `undefined` —
 * also when a manifest defines `alias` as a class of its own.
 * Two distinct claimants are refused rather than resolved first-match: an
 * old name can resolve to only one class, on the lazy path as on the eager
 * one.
 *
 * @throws {ConfigurationError} `CONFIG_QUALIFIED_NAME_ALIAS_COLLISION`
 */
export function resolveManifestQualifiedNameAlias(
  inventory: ManifestAliasInventory,
  alias: string,
): string | undefined {
  // A name some manifest defines as a class is not an alias to follow.
  if (inventory.defined.has(alias)) return undefined;
  assertNoCompetingManifestClaims([alias], inventory);
  return [...(inventory.claims.get(alias) ?? [])][0];
}
