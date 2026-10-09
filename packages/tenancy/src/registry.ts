/**
 * Tenant-Scoped Class Registry
 *
 * Tracks which classes are tenant-scoped and their configuration.
 * Used by the interceptor to determine how to handle operations.
 *
 * This registry supports two patterns:
 * 1. @TenantScoped() decorator + tenantId field (original pattern)
 * 2. @smrt({ tenantScoped: true }) in smrt-core (Issue #688 pattern)
 *
 * Both patterns are automatically recognized by the interceptor.
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 * @see https://github.com/happyvertical/smrt/issues/688
 */

import { createLogger } from '@happyvertical/logger';
import { ObjectRegistry, toSnakeCase } from '@happyvertical/smrt-core';

const logger = createLogger({ level: 'info' });

/**
 * Resolved tenancy configuration for a single class, as stored in the registry.
 *
 * Every field has a concrete (non-optional) value — defaults are applied by
 * `registerTenantScopedClass()` when the class is registered via `@TenantScoped()`.
 *
 * @see TenantScopedOptions
 * @see registerTenantScopedClass
 */
export interface TenantScopedConfig {
  /**
   * Tenancy mode for this class
   * - 'required': Must have tenant context for all operations
   * - 'optional': Works with or without tenant context
   * @default 'required'
   */
  mode: 'required' | 'optional';

  /**
   * Field name containing tenant ID
   * @default 'tenantId'
   */
  field: string;

  /**
   * Auto-filter all queries by tenant
   * @default true
   */
  autoFilter: boolean;

  /**
   * Auto-populate tenant ID from context on create
   * @default true
   */
  autoPopulate: boolean;

  /**
   * Allow super admin bypass for this class
   * @default false
   */
  allowSuperAdminBypass: boolean;
}

const DEFAULT_CONFIG: TenantScopedConfig = {
  mode: 'required',
  field: 'tenantId',
  autoFilter: true,
  autoPopulate: true,
  allowSuperAdminBypass: false,
};

// Registry snapshot exposed by getAllTenantScopedClasses().
const tenantScopedClasses = new Map<string, TenantScopedConfig>();

// Direct callers select a class by string. Keep simple and qualified selectors
// separate: a simple selector may be bound only after core proves that exactly
// one constructor owns that name.
const directSimpleRegistrations = new Map<string, TenantScopedConfig>();
const directQualifiedRegistrations = new Map<string, TenantScopedConfig>();
const directSimpleBindings = new Map<
  string,
  { qualifiedName: string; constructor: Function }
>();

// Decorators retain a simple mirror only until core has registered their
// authoritative qualified policy. Qualified runtime resolution always defers
// to core, preserving manifest and explicit-@smrt precedence.
const unregisteredDecoratorRegistrations = new Map<
  string,
  TenantScopedConfig
>();

// Selectors already audited (and warned about) since their last registration.
const auditedSelectors = new Set<string>();

function isQualifiedClassName(className: string): boolean {
  return className.includes(':');
}

function isCurrentDirectSimpleBinding(binding: {
  qualifiedName: string;
  constructor: Function;
}): boolean {
  return (
    ObjectRegistry.getClassByQualifiedName(binding.qualifiedName)
      ?.constructor === binding.constructor
  );
}

function bindDirectSimpleRegistration(className: string): void {
  const config = directSimpleRegistrations.get(className);
  if (!config || directSimpleBindings.has(className)) return;

  const matches = ObjectRegistry.findClassesByName(className);
  if (matches.length !== 1 || !matches[0].qualifiedName) return;

  directSimpleBindings.set(className, {
    qualifiedName: matches[0].qualifiedName,
    constructor: matches[0].constructor,
  });
  warnOnRegistrationMismatch(className);
}

function getDirectSimpleRegistration(
  className: string,
): TenantScopedConfig | undefined {
  const config = directSimpleRegistrations.get(className);
  if (!config) return undefined;

  const binding = directSimpleBindings.get(className);
  if (binding && !isCurrentDirectSimpleBinding(binding)) {
    throw new Error(
      `Stale tenant-scoped class registration '${className}'; ` +
        'unregister and register it again for the current constructor.',
    );
  }

  const matches = ObjectRegistry.findClassesByName(className);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous tenant-scoped class registration '${className}'; ` +
        'register an explicit qualified class name instead.',
    );
  }

  return config;
}

/** @internal Used by TenantScoped; direct callers must use the string API. */
export function registerTenantScopedConstructor(
  target: Function,
  config: Partial<TenantScopedConfig> = {},
): void {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  unregisteredDecoratorRegistrations.set(target.name, resolved);
  tenantScopedClasses.set(target.name, resolved);
}

/**
 * Register a class as tenant-scoped with the given configuration.
 *
 * Call this directly when you cannot use decorators (e.g., third-party classes
 * or plain objects in tests). Defaults from `DEFAULT_CONFIG` are merged over
 * any omitted options. `@TenantScoped()` has its own constructor-aware mirror
 * and reconciles its authoritative policy in core.
 *
 * A simple selector binds to its exact core constructor when one owner is
 * uniquely resolvable, including when registration happens before core. Once
 * bound it remains attached to that constructor if a same-name peer appears.
 * If core clears that constructor and reuses its qualified name, the selector
 * fails closed until the caller explicitly unregisters and re-registers it.
 * If ownership is ambiguous before binding, interception fails closed until a
 * caller registers an explicit qualified selector. Calling this again for the
 * same selector overwrites that selector's previous entry.
 *
 * @param className - A simple class name (e.g., `'Document'`) or exact core
 * qualified name (e.g., `'@package/name:Document'`).
 * @param config - Partial tenancy configuration; omitted fields receive defaults.
 *
 * @example
 * ```typescript
 * // Manually register a class (e.g., for testing)
 * registerTenantScopedClass('Document', { mode: 'optional' });
 * ```
 *
 * @see TenantScoped
 * @see unregisterTenantScopedClass
 */
export function registerTenantScopedClass(
  className: string,
  config: Partial<TenantScopedConfig> = {},
): void {
  const resolved = {
    ...DEFAULT_CONFIG,
    ...config,
  };
  tenantScopedClasses.set(className, resolved);

  auditedSelectors.delete(className);
  if (isQualifiedClassName(className)) {
    directQualifiedRegistrations.set(className, resolved);
    warnOnRegistrationMismatch(className);
    return;
  }

  directSimpleRegistrations.set(className, resolved);
  const existingBinding = directSimpleBindings.get(className);
  if (existingBinding && !isCurrentDirectSimpleBinding(existingBinding)) {
    directSimpleBindings.delete(className);
  }
  bindDirectSimpleRegistration(className);
  warnOnRegistrationMismatch(className);
}

/**
 * Remove a class from the tenant-scoped registry.
 *
 * Primarily intended for test teardown — use `clearTenantScopedRegistry()` to
 * reset the entire registry at once.
 *
 * @param className - The class name to remove (e.g., `'Document'`).
 *
 * @see clearTenantScopedRegistry
 * @see registerTenantScopedClass
 */
export function unregisterTenantScopedClass(className: string): void {
  auditedSelectors.delete(className);
  tenantScopedClasses.delete(className);
  if (isQualifiedClassName(className)) {
    directQualifiedRegistrations.delete(className);
    return;
  }

  directSimpleRegistrations.delete(className);
  directSimpleBindings.delete(className);
  unregisteredDecoratorRegistrations.delete(className);
}

/**
 * Return a shallow copy of a config so callers can never mutate the stored
 * registration. The same backing object is shared by the base and every
 * inheriting descendant, so handing out the reference would let an accidental
 * caller mutation silently corrupt the base (and all children). (#1598 review)
 */
function cloneConfig(config: TenantScopedConfig): TenantScopedConfig {
  return { ...config };
}

/**
 * Resolve a class's OWN tenancy configuration — no STI inheritance, EXACT name
 * match only.
 *
 * Checks the registration mechanisms in order: an explicit direct selector,
 * then core's declared policy. `@TenantScoped()` reconciles its policy in core;
 * its simple-name mirror is used only for unregistered test doubles.
 *
 * Lookups are by exact name only — no simple-name fallback — so a qualified
 * lookup (e.g. `@happyvertical/smrt-affiliates:Payout`, explicitly not scoped)
 * can never strip its namespace and match a same-simple-name scoped class in
 * another package (e.g. `@happyvertical/smrt-commerce:Payout`). (#1598 review)
 */
function getDirectTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  const direct = getDeclaredTenantScopedConfig(className);
  const qualifiedName = ObjectRegistry.getClass(className)?.qualifiedName;
  if (
    direct &&
    qualifiedName &&
    ObjectRegistry.getRuntimeOverride(qualifiedName)?.tenancy
  ) {
    return { ...direct, mode: 'required' };
  }
  return direct;
}

function getDeclaredTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  // Core marks caught silent-manifest/runtime-decorator conflicts invalid.
  // Check before the simple-name decorator mirror so every identity path
  // fails closed rather than falling through to an unscoped operation.
  ObjectRegistry.assertTenantScopedRegistrationValid(className);
  // 1. Explicit direct qualified selector.
  const directQualified = directQualifiedRegistrations.get(className);
  if (directQualified) {
    // A qualified selector registered before core learned the class is
    // audited on first use instead.
    if (!auditedSelectors.has(className)) warnOnRegistrationMismatch(className);
    return cloneConfig(directQualified);
  }

  const registered = isQualifiedClassName(className)
    ? ObjectRegistry.getClassByQualifiedName(className)
    : ObjectRegistry.getClass(className);

  // A direct simple selector can bind lazily after registration-before-core.
  // It is never inferred from a qualified name when more than one core class
  // owns that simple name.
  if (registered) {
    const simple = registered.name;
    const bound = directSimpleBindings.get(simple);
    if (bound) {
      if (
        bound.qualifiedName === className &&
        bound.constructor === registered.constructor
      ) {
        return cloneConfig(directSimpleRegistrations.get(simple)!);
      }
      // Core can clear and re-register a qualified name with a different
      // constructor. Never transfer the old selector binding to it: the caller
      // must explicitly unregister/re-register after that lifecycle reset.
      if (!isCurrentDirectSimpleBinding(bound)) {
        throw new Error(
          `Stale tenant-scoped class registration '${simple}'; ` +
            'unregister and register it again for the current constructor.',
        );
      }
    }
    if (!bound && directSimpleRegistrations.has(simple)) {
      const matches = ObjectRegistry.findClassesByName(simple);
      if (matches.length > 1) {
        throw new Error(
          `Ambiguous tenant-scoped class registration '${simple}'; ` +
            'register an explicit qualified class name instead.',
        );
      }
      bindDirectSimpleRegistration(simple);
      const rebound = directSimpleBindings.get(simple);
      if (
        rebound?.qualifiedName === className &&
        rebound.constructor === registered.constructor
      ) {
        return cloneConfig(directSimpleRegistrations.get(simple)!);
      }
    }
  }

  if (!isQualifiedClassName(className)) {
    // Explicit direct selectors retain their established precedence. For
    // plain-object/test-double paths this is the historical simple-selector
    // fallback, subject to the existing ambiguity checks.
    const directSimple = getDirectSimpleRegistration(className);
    if (directSimple) return cloneConfig(directSimple);
  }

  // 2. Core registry (@smrt({ tenantScoped: true }) pattern - Issue #688).
  // findClass() resolves qualified names package-safely, so this branch is
  // already disambiguated.
  const coreConfig = ObjectRegistry.getTenantScopedConfig(className);
  if (coreConfig) {
    // Convert core config to TenantScopedConfig format
    return {
      mode: coreConfig.mode,
      field: coreConfig.field,
      autoFilter: coreConfig.autoFilter,
      autoPopulate: coreConfig.autoPopulate,
      allowSuperAdminBypass: coreConfig.allowSuperAdminBypass,
    };
  }

  // A decorator mirror is only authoritative when core has no registration.
  // A registered unqualified consumer still has a canonical simple identity.
  if (!registered && !isQualifiedClassName(className)) {
    const decoratorConfig = unregisteredDecoratorRegistrations.get(className);
    if (decoratorConfig) return cloneConfig(decoratorConfig);
  }

  return undefined;
}

/**
 * Resolve tenancy configuration inherited from an STI/ancestor class.
 *
 * `@TenantScoped` (and `@smrt({ tenantScoped })`) register ONLY the exact class
 * decorated — recognition does NOT propagate to subclasses. Before #1596 this
 * meant an STI child with its own collection (the child is the collection's
 * `_itemClass`) was treated as non-tenant-scoped at runtime: the interceptor
 * skipped tenant filtering on its `list()`/`get()` (cross-tenant reads), skipped
 * tenant population in `beforeSave`, and skipped the raw-SQL policy. Manual
 * re-declaration on every child was the fragile pattern that already bit images
 * (#1407) and messages.
 *
 * We now walk the STI inheritance chain so any descendant of a tenant-scoped
 * base is recognized automatically and inherits the base's config. A subclass
 * of a tenant-scoped class is always itself tenant-scoped — there is no safe
 * reason for it to opt out — so the walk intentionally covers any inheritance
 * (the motivating leak is STI child collections, but this is correct for CTI
 * hierarchies too).
 *
 * Ancestors are walked from nearest-to-self toward the root, returning the
 * first tenant-scoped ancestor's config so a closer ancestor wins. The class's
 * OWN declaration is resolved by the direct lookup in `getTenantScopedConfig`
 * and always takes precedence over anything inherited here.
 */
function getInheritedTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  // getInheritanceChain returns [root, ..., self] (qualified names where the
  // class has package context). It is cached by core and only reached here when
  // the direct lookup misses, so the per-call cost on non-tenant classes is a
  // cache hit plus this short loop. Returns [] for unregistered classes.
  const chain = ObjectRegistry.getInheritanceChain(className);
  // chain[length - 1] is the class itself (already covered by the direct
  // lookup); walk its ancestors from nearest to root.
  for (let i = chain.length - 2; i >= 0; i--) {
    const ancestor = chain[i];

    // Exact, package-safe match first — covers `@smrt({ tenantScoped })` bases
    // (resolved through the core registry by qualified name) and any class
    // whose @TenantScoped key matches the chain entry verbatim.
    const direct = getDirectTenantScopedConfig(ancestor);
    if (direct) {
      return direct;
    }

    // Do not bridge a qualified ancestor back to a simple registration here.
    // The exact lookup above reaches the core declaration reconciled by the
    // decorator. Stripping would let an unrelated same-name peer lend its
    // direct or decorator policy to this inheritance chain.
  }
  return undefined;
}

/**
 * Retrieve the resolved tenancy configuration for a class.
 *
 * Resolution order:
 * 1. The class's OWN declaration — local `@TenantScoped()` registry first, then
 *    the core `@smrt({ tenantScoped: true })` registry.
 * 2. STI inheritance — the nearest tenant-scoped ancestor's config (#1596).
 *
 * A class that declares its own tenancy never reaches step 2, so an explicit
 * child `@TenantScoped` always overrides the inherited base config.
 *
 * @param className - The class name to look up.
 * @returns The `TenantScopedConfig` if the class is tenant-scoped directly or
 *   by inheritance, or `undefined` if it is not.
 *
 * @see isTenantScopedClass
 * @see getAllTenantScopedClasses
 */
export function getTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  // A class's own @TenantScoped / @smrt({ tenantScoped }) declaration wins.
  const direct = getDirectTenantScopedConfig(className);
  if (direct) return direct;
  // Otherwise inherit recognition from a tenant-scoped STI ancestor (#1596).
  return getInheritedTenantScopedConfig(className);
}

/**
 * Tell core which column records a row's owner for every tenant-scoped class,
 * including runtime registrations on a custom field
 * (`registerTenantScopedClass('Team', { field: 'organizationId' })`) that the
 * manifest knows nothing about. Core's natural-key save guard compares these
 * columns, so a save whose key collides with another organization's row is
 * refused (`TENANT_ISOLATION_VIOLATION`) instead of adopting it. Resolved on
 * every lookup, so selectors that bind later or are unregistered are honoured.
 */
ObjectRegistry.registerOwnershipColumnSource((qualifiedName) => {
  const config = getTenantScopedConfig(qualifiedName);
  return config ? [toSnakeCase(config.field)] : undefined;
});

/**
 * Return `true` if the named class is tenant-scoped — directly (via
 * `@TenantScoped()` / `@smrt({ tenantScoped: true })`) or by inheriting from a
 * tenant-scoped STI ancestor (#1596).
 *
 * @param className - The class name to look up (e.g., `'Document'`).
 * @returns `true` if the class is tenant-scoped by any mechanism.
 *
 * @see getTenantScopedConfig
 * @see registerTenantScopedClass
 */
export function isTenantScopedClass(className: string): boolean {
  return getTenantScopedConfig(className) !== undefined;
}

/**
 * Return a snapshot of all classes registered via `@TenantScoped()`.
 *
 * Returns a new `Map` so mutations to the returned value do not affect the
 * internal registry.  Note that classes registered only through the core
 * `ObjectRegistry` (`@smrt({ tenantScoped: true })`) are **not** included in
 * this map.
 *
 * @returns A copy of the local tenant-scoped class registry, keyed by class name.
 *
 * @see isTenantScopedClass
 * @see getTenantScopedConfig
 */
export function getAllTenantScopedClasses(): Map<string, TenantScopedConfig> {
  return new Map(tenantScopedClasses);
}

/**
 * Remove all entries from the local tenant-scoped class registry.
 *
 * Intended for test teardown via `resetTenancy()`.  Does not affect
 * registrations held by the core `ObjectRegistry`.
 *
 * @see resetTenancy
 * @see unregisterTenantScopedClass
 */
export function clearTenantScopedRegistry(): void {
  auditedSelectors.clear();
  tenantScopedClasses.clear();
  directSimpleRegistrations.clear();
  directQualifiedRegistrations.clear();
  directSimpleBindings.clear();
  unregisteredDecoratorRegistrations.clear();
}

/**
 * One finding from {@link auditTenantScopedRegistrations}.
 *
 * - `missing_tenant_field` (`error`): the class has no field named by the
 *   registration, so the interceptor filters and populates a column that does
 *   not exist in the model's manifest/schema.
 * - `natural_key_not_tenant_scoped` (`warning`): the class's upsert conflict
 *   target (and so its unique index) omits the tenant column — its natural key
 *   is unique ACROSS tenants. The interceptor hides other tenants' rows from
 *   lookups, so a second tenant's same-key save collides with a row it cannot
 *   see; core refuses that save (`TENANT_ISOLATION_VIOLATION`) instead of
 *   overwriting the other tenant's row, but the second tenant still cannot
 *   store the key.
 * - `undeclared_tenant_scope` (`info`): tenant scope exists only as this
 *   runtime registration; the model's manifest declares no tenancy. Its
 *   default natural key is still tenant-led when it has a `tenantId` field,
 *   but generated surfaces, knowledge, and schema contracts cannot see the
 *   read policy. Declaring `@smrt({ tenantScoped })` makes it visible.
 */
export interface TenantRegistrationFinding {
  /** The selector passed to `registerTenantScopedClass()`. */
  selector: string;
  /** The core class it resolved to (qualified name when known). */
  className: string;
  kind:
    | 'missing_tenant_field'
    | 'natural_key_not_tenant_scoped'
    | 'undeclared_tenant_scope';
  severity: 'error' | 'warning' | 'info';
  message: string;
}

function resolveSelectorClass(selector: string) {
  if (isQualifiedClassName(selector)) {
    return ObjectRegistry.getClassByQualifiedName(selector);
  }
  const bound = directSimpleBindings.get(selector);
  if (bound) return ObjectRegistry.getClassByQualifiedName(bound.qualifiedName);
  const matches = ObjectRegistry.findClassesByName(selector);
  return matches.length === 1 ? matches[0] : undefined;
}

type RegisteredSmrtClass = NonNullable<ReturnType<typeof resolveSelectorClass>>;

/**
 * Whether the class or one of its registered ancestors declares `fieldName`.
 *
 * A class's own field map holds only its own decorator fields until its
 * manifest entry loads; an STI child registered first (a bundled server) has
 * its inherited tenant field on the registered parent only (#3623). Walk the
 * constructor's prototype chain through public registry lookups — read-only,
 * unlike `getInheritanceChain()`, which caches whatever partial chain exists
 * at registration time.
 */
function declaresFieldInChain(
  registered: RegisteredSmrtClass,
  fieldName: string,
): boolean {
  if (registered.fields.has(fieldName)) return true;
  if (registered.inheritedFields?.has(fieldName)) return true;
  const visited = new Set<unknown>([registered.constructor]);
  let ctor: unknown = Object.getPrototypeOf(registered.constructor);
  while (typeof ctor === 'function' && !visited.has(ctor)) {
    visited.add(ctor);
    const ancestor = ObjectRegistry.getClassByConstructor(
      ctor as RegisteredSmrtClass['constructor'],
    );
    if (ancestor?.fields.has(fieldName)) return true;
    ctor = Object.getPrototypeOf(ctor);
  }
  return false;
}

function auditSelector(
  selector: string,
  config: TenantScopedConfig,
): TenantRegistrationFinding[] {
  const registered = resolveSelectorClass(selector);
  if (!registered) return [];
  const className = registered.qualifiedName || registered.name;
  const findings: TenantRegistrationFinding[] = [];

  if (!declaresFieldInChain(registered, config.field)) {
    findings.push({
      selector,
      className,
      kind: 'missing_tenant_field',
      severity: 'error',
      message:
        `${className} is registered tenant-scoped on field '${config.field}', ` +
        'but the model declares no such field. Tenant filtering and population ' +
        'target a column its manifest and schema do not have. Add the field ' +
        '(or declare `@smrt({ tenantScoped })`) and regenerate the manifest.',
    });
    return findings;
  }

  if (!ObjectRegistry.getTenantScopedConfig(className)) {
    findings.push({
      selector,
      className,
      kind: 'undeclared_tenant_scope',
      severity: 'info',
      message:
        `${className} is tenant-scoped only by runtime registration; its ` +
        'manifest declares no tenancy. Declare `@smrt({ tenantScoped })` so ' +
        'schema, generated surfaces and knowledge agree with the read policy.',
    });
  }

  const tenantColumn = toSnakeCase(config.field);
  const conflictColumns = ObjectRegistry.getConflictColumns(className);
  const keyedOnPrimaryKey =
    conflictColumns.length === 1 && conflictColumns[0] === 'id';
  if (!keyedOnPrimaryKey && !conflictColumns.includes(tenantColumn)) {
    findings.push({
      selector,
      className,
      kind: 'natural_key_not_tenant_scoped',
      severity: 'warning',
      message:
        `${className} is registered tenant-scoped, but its natural key ` +
        `(${conflictColumns.join(', ')}) omits '${tenantColumn}', so it is ` +
        'unique across tenants: a second tenant cannot store a key another ' +
        'tenant already uses. A new object saved on such a key is refused ' +
        '(TENANT_ISOLATION_VIOLATION) when the row it collides with has a ' +
        `different '${tenantColumn}'; one whose slug was derived from its ` +
        'name moves to a free slug instead. ' +
        `Include '${tenantColumn}' in the conflict columns (or drop the ` +
        'explicit conflictColumns) and run `smrt db:migrate`.',
    });
  }
  return findings;
}

/**
 * Audit every string-selector registration (`registerTenantScopedClass()`)
 * against the core model it resolves to. Selectors whose class core has not
 * registered yet are skipped (they are audited when they bind).
 *
 * Registration also runs this per selector and logs `error`/`warning`
 * findings once, so a mismatch surfaces at startup; call this directly for a
 * complete report (for example from a health check or a test).
 */
export function auditTenantScopedRegistrations(): TenantRegistrationFinding[] {
  const findings: TenantRegistrationFinding[] = [];
  for (const [selector, config] of directQualifiedRegistrations) {
    findings.push(...auditSelector(selector, config));
  }
  for (const [selector, config] of directSimpleRegistrations) {
    findings.push(...auditSelector(selector, config));
  }
  return findings;
}

function warnOnRegistrationMismatch(selector: string): void {
  if (auditedSelectors.has(selector)) return;
  const config =
    directQualifiedRegistrations.get(selector) ??
    directSimpleRegistrations.get(selector);
  if (!config) return;
  let findings: TenantRegistrationFinding[];
  try {
    findings = auditSelector(selector, config);
  } catch {
    // Ambiguous or stale identities fail closed on use; the audit stays quiet.
    return;
  }
  if (!resolveSelectorClass(selector)) return; // not in core yet; retry later
  auditedSelectors.add(selector);
  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    logger.warn(`[smrt-tenancy] ${finding.message}`);
  }
}
