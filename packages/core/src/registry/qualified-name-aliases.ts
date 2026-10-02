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
 * two classes. Called immediately before a class is stored in `classes`.
 *
 * - every alias is a `<package>:<ClassName>` string, distinct from the
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
    if (sameClass(other, entry)) continue;
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

/**
 * Every object in `manifest` that declares `alias` in its
 * `decoratorConfig.previousQualifiedNames`, as current qualified names. This
 * is the lazy path's alias index: the NEW owner's manifest carries the old
 * name, so an old package identity resolves even when that package's
 * manifest no longer lists (or no longer ships) the class.
 */
export function findQualifiedNameAliasClaimantsInManifest(
  manifest: SmartObjectManifest | null | undefined,
  alias: string,
): string[] {
  if (!manifest?.objects) return [];
  const claimants: string[] = [];
  for (const [key, objectDef] of Object.entries(manifest.objects)) {
    if (
      !readPreviousQualifiedNames(objectDef?.decoratorConfig).includes(alias)
    ) {
      continue;
    }
    const packageName = objectDef.packageName ?? manifest.packageName;
    const current =
      objectDef.qualifiedName ??
      (key.includes(':')
        ? key
        : packageName
          ? `${packageName}:${objectDef.className}`
          : undefined);
    if (current) claimants.push(current);
  }
  return claimants;
}

/**
 * The single current owner of `alias` across `manifests`, or `undefined`.
 * Two distinct claimants are refused rather than resolved first-match: an
 * old name can resolve to only one class, on the lazy path as on the eager
 * one.
 *
 * @throws {ConfigurationError} `CONFIG_QUALIFIED_NAME_ALIAS_COLLISION`
 */
export function resolveManifestQualifiedNameAlias(
  manifests: Iterable<SmartObjectManifest | null | undefined>,
  alias: string,
): string | undefined {
  const claimants = new Set<string>();
  for (const manifest of manifests) {
    for (const current of findQualifiedNameAliasClaimantsInManifest(
      manifest,
      alias,
    )) {
      claimants.add(current);
    }
  }
  if (claimants.size > 1) {
    const owners = [...claimants].sort();
    throw collision(
      `previousQualifiedNames "${alias}" is declared by more than one installed manifest (${owners.join(', ')}); ` +
        'an old name can resolve to only one class.',
      { alias, claimants: owners },
    );
  }
  return [...claimants][0];
}
