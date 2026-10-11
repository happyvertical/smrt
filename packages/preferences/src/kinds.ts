/**
 * The preference kind registry (#3727).
 *
 * A kind is one family of user-interface preference (`overview`,
 * `shell-layout`, ...). It owns the validation of its payload and names the
 * permission pair for its two tiers. The store refuses a kind that is not
 * registered, so nothing reaches the table that no code can validate.
 */
import { splitPermissionSlug } from './permissions.js';

/** The two tiers a stored preference can belong to. */
export const PREFERENCE_SCOPES = ['tenant', 'user'] as const;
export type PreferenceScope = (typeof PREFERENCE_SCOPES)[number];

/** Kind ids: lowercase kebab, e.g. `shell-layout`. */
export const PREFERENCE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

/** Surface ids: a page id, a shell key (`events.home`, `admin`). */
export const PREFERENCE_SURFACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

/** One dropped or rejected part of a payload, and why. */
export interface PreferenceIssue {
  /** Where in the payload (a widget id, a dotted path), or `null`. */
  path: string | null;
  /** Kind-defined code (`malformed`, `future_version`, `invalid_options`, ...). */
  code: string;
  /** Developer-facing detail; not localized. */
  message: string;
  /** The kind's own issue object, for kind-specific callers. */
  detail?: unknown;
}

/**
 * What a kind's `validate` returns. `canonical` is the payload to store (on
 * save) or use (on load) with every invalid part removed; `null` means "no
 * preference" (the tier below applies). `ok` is false whenever something was
 * removed or refused. The store refuses a save that is not `ok` and stores
 * only `canonical`; on load it uses `canonical` and reports `issues`.
 */
export interface PreferenceValidation {
  ok: boolean;
  canonical: unknown | null;
  issues: PreferenceIssue[];
}

export interface PreferenceValidateContext {
  kind: string;
  surfaceId: string;
  scope: PreferenceScope;
  /** `save` (strict) or `load` (lenient). */
  phase: 'save' | 'load';
  /** The format version the payload was written at (the kind's on save). */
  formatVersion: number;
  /**
   * The tenant tier's canonical payload when validating the user tier
   * (`null` when the tenant has none); absent for the tenant tier.
   */
  tenant?: unknown | null;
  /** Host-supplied, kind-specific inputs (e.g. the overview definition). */
  options?: unknown;
}

export interface PreferenceKindDefinition {
  kind: string;
  /** Current payload format version (a positive integer). */
  formatVersion: number;
  /** Slugs that authorize writing each tier (`collection.action`). */
  permissions: { tenant: string; user: string };
  validate(
    payload: unknown,
    ctx: PreferenceValidateContext,
  ): PreferenceValidation;
}

/** A store call named a kind no code registered. */
export class UnknownPreferenceKindError extends Error {
  readonly code = 'unknown_preference_kind';
  readonly status = 400;

  constructor(kind: string) {
    super(`Preference kind "${kind}" is not registered`);
    this.name = 'UnknownPreferenceKindError';
  }
}

const kinds = new Map<string, PreferenceKindDefinition>();

/**
 * Register a preference kind. Registering a kind twice throws unless
 * `{ replace: true }`; returns a disposer that removes this registration.
 */
export function registerPreferenceKind(
  definition: PreferenceKindDefinition,
  options: { replace?: boolean } = {},
): () => void {
  if (!PREFERENCE_KIND_PATTERN.test(definition.kind)) {
    throw new Error(`Invalid preference kind "${definition.kind}"`);
  }
  if (
    !Number.isSafeInteger(definition.formatVersion) ||
    definition.formatVersion < 1
  ) {
    throw new Error(
      `Preference kind "${definition.kind}" needs a positive formatVersion`,
    );
  }
  splitPermissionSlug(definition.permissions.tenant);
  splitPermissionSlug(definition.permissions.user);
  if (typeof definition.validate !== 'function') {
    throw new Error(`Preference kind "${definition.kind}" needs validate()`);
  }
  if (kinds.has(definition.kind) && !options.replace) {
    throw new Error(
      `Preference kind "${definition.kind}" is already registered`,
    );
  }
  const frozen = Object.freeze({
    ...definition,
    permissions: Object.freeze({ ...definition.permissions }),
  });
  kinds.set(definition.kind, frozen);
  return () => {
    if (kinds.get(definition.kind) === frozen) kinds.delete(definition.kind);
  };
}

/** The registered kind, or `undefined`. */
export function getPreferenceKind(
  kind: string,
): PreferenceKindDefinition | undefined {
  return kinds.get(kind);
}

/** The registered kind; throws {@link UnknownPreferenceKindError} otherwise. */
export function requirePreferenceKind(kind: string): PreferenceKindDefinition {
  const definition = kinds.get(kind);
  if (!definition) throw new UnknownPreferenceKindError(kind);
  return definition;
}

/** Registered kind ids in registration order. */
export function listPreferenceKinds(): string[] {
  return [...kinds.keys()];
}
