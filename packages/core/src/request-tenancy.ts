/**
 * Request tenancy: the one place a request path decides tenancy (#5375).
 *
 * Every request-facing transport (runtime REST, the emitted SvelteKit routes,
 * both sync apply paths and both MCP surfaces) resolves the tenancy of the
 * model it serves once per request, with {@link resolveRequestTenancy}, from
 * three inputs: the model's strict registry key, the STI members the route
 * serves, and the request actor. The result is frozen and decides:
 *
 * - which rows a read may see ({@link readScope});
 * - whether a write may run ({@link writeGate});
 * - whether a custom action may run ({@link customActionScope});
 * - the read cache policy and validator ({@link cachePolicy},
 *   {@link etagDiscriminator}).
 *
 * The decision is then bound to the operation's execution scope
 * ({@link withResolvedTenancy}, {@link enterResolvedTenancy}). Inside it, a
 * collection interceptor this module installs enforces the same decision at
 * every collection operation the request makes, custom action bodies
 * included:
 *
 * - a row of the route's STI table is touched only when its stored type is
 *   one of the admitted types (positive membership: an unregistered or
 *   excluded type never matches);
 * - a read by a caller with no tenant of an optional-mode member sees only
 *   rows without an owner; a write by such a caller is refused, and so is a
 *   write under a cross-tenant read grant;
 * - code that enters a system context inside the request acts as the system
 *   (and code that enters a tenant context in a request with no tenant acts
 *   in that tenant), except under a read grant, which no context lifts;
 * - a member whose tenancy changed after the request was admitted refuses
 *   the operation ({@link TenantPolicyChangedError}, 403) instead of adopting
 *   the new policy.
 *
 * The tenancy interceptor (smrt-tenancy) remains the second layer: it filters
 * by the active tenant and reads the bound policy for every member.
 *
 * Core cannot import smrt-tenancy. The policy of a class, and the probes for
 * system, bypass and hierarchy contexts, come from a {@link TenantPolicySource}
 * smrt-tenancy installs when tenancy is enabled. Enabled tenancy without a
 * source refuses every scoped decision.
 */

import { resolveDispatchTenantScope } from './dispatch/tenant-resolver.js';
import { ValidationError } from './errors';
import { resolveReadCacheControl } from './generators/read-cache-control.js';
import {
  type CollectionInterceptor,
  GlobalInterceptors,
  type InterceptorContext,
  type ListOptions,
  resolveGetStringFilter,
} from './interceptors';
import type { SmrtObject } from './object.js';
import { ObjectRegistry } from './registry';
import { getRegistryGeneration } from './registry/generation';
import { getResolvedFieldsSync } from './registry/inheritance-resolver';
import {
  enterRequestTenantContext,
  getRequestTenantContext,
} from './request-tenant-context';
import { SmrtError } from './smrt-error.js';
import { type AsyncContext, createAsyncContext } from './utils/async-context';
import {
  effectiveWhereOperator,
  resolveWhereKey,
  whereColumnName,
} from './where-keys';

// ─── Policy source ─────────────────────────────────────────────────────────

/** A class's own tenancy policy, as smrt-tenancy resolves it. */
export interface TenantPolicyConfig {
  mode: 'required' | 'optional';
  /** Property that records a row's owner. */
  field: string;
  allowSuperAdminBypass: boolean;
  /** A save in a tenant context stamps the row's owner (default `true`). */
  autoPopulate?: boolean;
}

/**
 * The answer of a {@link TenantPolicySource} for one class: not scoped, a
 * policy, or a lookup that failed (never read as "not scoped").
 */
export type TenantPolicyLookup =
  | { kind: 'absent' }
  | { kind: 'resolved'; policy: TenantPolicyConfig }
  | { kind: 'failed'; reason: string };

/** A tenant context to run an operation in. */
export interface RequestTenancyContext {
  tenantId: string;
  userId?: string;
  permissions?: ReadonlySet<string>;
}

/** What smrt-tenancy lends core so request paths can decide tenancy. */
export interface TenantPolicySource {
  /**
   * The effective tenancy of a class by qualified key: runtime
   * registrations, STI inheritance, declared config. Must not throw; a
   * thrown error is treated as `failed`.
   */
  policyOf(key: string): TenantPolicyLookup;
  /** Whether an explicit system context is active. */
  systemContextActive(): boolean;
  /** Whether the super-admin bypass flag is active. */
  superAdminBypassActive(): boolean;
  /**
   * The classes a bounded hierarchy read scope allows, when one is active.
   * A bypass never applies inside such a scope.
   */
  hierarchyReadCollections(): readonly string[] | undefined;
  /**
   * A canonical key of the active bounded hierarchy read scope (its
   * collections, allowed tenants and whether rows without an owner are
   * included), when one is active: part of a read's validator.
   */
  hierarchyReadScopeKey?(): string | undefined;
  /** Run `fn` inside a tenant context, or a system context. */
  runInContext<T>(
    context: RequestTenancyContext | 'system',
    fn: () => Promise<T>,
  ): Promise<T>;
}

declare global {
  // eslint-disable-next-line no-var
  var __smrtTenantPolicySource: TenantPolicySource | undefined;
  // eslint-disable-next-line no-var
  var __smrtRequestTenancyScope: AsyncContext<RequestTenancy> | undefined;
  // eslint-disable-next-line no-var
  var __smrtMixedTenancyFamilies: Set<string> | undefined;
}

/**
 * Install (or, with `undefined`, remove) the tenancy policy source. Called by
 * smrt-tenancy's `enableTenancy()` / `disableTenancy()`.
 */
export function setTenantPolicySource(
  source: TenantPolicySource | undefined,
): void {
  globalThis.__smrtTenantPolicySource = source;
}

/** The installed tenancy policy source, if any. */
export function getTenantPolicySource(): TenantPolicySource | undefined {
  return globalThis.__smrtTenantPolicySource;
}

// ─── Typed refusals ────────────────────────────────────────────────────────

/**
 * A request tenancy refusal, rendered by every transport as its status. A
 * `SmrtError`, so it crosses `save()` and `delete()` unchanged.
 */
export class RequestTenancyError extends SmrtError {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, code: string, message: string) {
    super(message, code, 'runtime');
    this.name = 'RequestTenancyError';
    this.status = status;
    this.publicMessage = message;
  }
}

/** The tenancy of a model the request touches changed after admission. */
export class TenantPolicyChangedError extends RequestTenancyError {
  constructor() {
    super(
      403,
      'TENANT_POLICY_CHANGED',
      'The tenancy of this model changed while the request was served.',
    );
    this.name = 'TenantPolicyChangedError';
  }
}

const UNRESOLVED_MESSAGE = 'The tenancy of this model could not be resolved.';

// ─── Actor ─────────────────────────────────────────────────────────────────

/**
 * Who a request acts as, frozen once per request. See `request-actor.ts`
 * for how transports produce it.
 */
export interface RequestActor {
  /** The tenant the request acts in, or `null`. */
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly permissions: ReadonlySet<string> | undefined;
  /**
   * A system actor: an explicit system context (`'write'`), or a
   * cross-tenant grant for this operation. A read grant never writes.
   */
  readonly system: 'read' | 'write' | null;
  /**
   * The request was admitted under a cross-tenant read grant (a nested
   * resolution inherits it): no tenant-scoped row is written anywhere in
   * the request, whatever tenant or system context its code enters, and
   * even where a host-entered tenant context kept the request in one tenant.
   */
  readonly readGrant: boolean;
  /** The super-admin bypass flag is set for this request. */
  readonly bypass: boolean;
  /** Decides 401 (anonymous) or 403 for a refusal. */
  readonly authenticated: boolean;
}

// ─── Member policy ─────────────────────────────────────────────────────────

/** The tenancy of one model a request touches. */
export interface MemberTenancy {
  readonly key: string;
  /**
   * Not scoped, scoped under a resolved policy, or a lookup that failed
   * (every decision on a failed member refuses).
   */
  readonly state: 'unscoped' | 'scoped' | 'failed';
  readonly scoped: boolean;
  readonly mode: 'required' | 'optional' | null;
  /** The tenancy field (the property that records a row's owner). */
  readonly field: string | null;
  /** Every ownership property, the tenancy field first. */
  readonly fields: readonly string[];
  readonly allowSuperAdminBypass: boolean;
  /** A save in a tenant context stamps the owner (bound with the policy). */
  readonly autoPopulate: boolean;
  /**
   * Allowed by an active bounded hierarchy read scope (true when none). Part
   * of STI admission (a member must match the route model here too), not of
   * the policy: entering a hierarchy scope is not a policy change.
   */
  readonly hierarchyAllowed: boolean;
  /** Equality of two members' policies is equality of signatures. */
  readonly signature: string;
  /** Why the policy could not be resolved (set when `state` is `failed`). */
  readonly failed?: string;
}

/** The member's policy could not be resolved: every decision refuses. */
export function isFailedMember(member: MemberTenancy): boolean {
  return member.state === 'failed';
}

function tenancyEnforced(): boolean {
  return resolveDispatchTenantScope().enforced;
}

/** Ownership properties of a scoped class: the field, then runtime columns. */
function ownershipProperties(key: string, field: string): string[] {
  const byColumn = new Map<string, string>();
  const add = (property: string) => {
    const column = whereColumnName(property);
    if (!byColumn.has(column)) byColumn.set(column, property);
  };
  add(field);
  const runtimeColumns = ObjectRegistry.getRuntimeOwnershipColumns(key);
  if (runtimeColumns.size > 0) {
    const propertyByColumn = new Map<string, string>();
    const registered = ObjectRegistry.getClassByQualifiedName(key);
    const fields = registered
      ? getResolvedFieldsSync(registered)
      : ObjectRegistry.getFields(key);
    for (const name of [
      ...(registered?.fields.keys() ?? []),
      ...fields.keys(),
    ]) {
      const column = whereColumnName(name);
      if (!propertyByColumn.has(column)) propertyByColumn.set(column, name);
    }
    for (const column of runtimeColumns) {
      add(propertyByColumn.get(column) ?? column);
    }
  }
  return [...byColumn.values()];
}

const FAILED_REASON = 'policy lookup failed';

/** A failure's reason, never empty (an empty reason still fails). */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message || FAILED_REASON;
}

function failedMember(key: string, reason: string): MemberTenancy {
  const why = reason || FAILED_REASON;
  return Object.freeze({
    key,
    state: 'failed',
    scoped: true,
    mode: null,
    field: null,
    fields: Object.freeze([]),
    allowSuperAdminBypass: false,
    autoPopulate: false,
    hierarchyAllowed: false,
    signature: `failed:${why}`,
    failed: why,
  });
}

const UNSCOPED_SIGNATURE = JSON.stringify([false]);

function unscopedMember(key: string): MemberTenancy {
  return Object.freeze({
    key,
    state: 'unscoped',
    scoped: false,
    mode: null,
    field: null,
    fields: Object.freeze([]),
    allowSuperAdminBypass: false,
    autoPopulate: false,
    hierarchyAllowed: true,
    signature: UNSCOPED_SIGNATURE,
  });
}

/**
 * Why a resolved policy disagrees with the registry's declared tenancy, or
 * `undefined` when it agrees. A resolved policy may be stricter than the
 * declaration (required where it says optional, as a runtime override sets;
 * no bypass where it allows one), never looser or on another field.
 */
function declarationConflict(
  key: string,
  policy: TenantPolicyConfig,
): string | undefined {
  const declared = ObjectRegistry.getTenantScopedConfig(key);
  if (!declared) return undefined;
  if (
    whereColumnName(declared.field ?? 'tenantId') !==
    whereColumnName(policy.field)
  ) {
    return 'resolved tenancy field differs from the declared one';
  }
  if (
    (declared.mode ?? 'required') === 'required' &&
    policy.mode !== 'required'
  ) {
    return 'resolved tenancy mode is looser than the declared one';
  }
  if (
    declared.allowSuperAdminBypass !== true &&
    policy.allowSuperAdminBypass === true
  ) {
    return 'resolved tenancy allows a bypass the declaration does not';
  }
  return undefined;
}

/**
 * The live tenancy of one class by strict registry key, merged from the
 * installed policy source and the registry's declared config. A lookup that
 * fails, or a source that says "not scoped" for a class the registry
 * declares scoped, is `failed`.
 *
 * @param key - Registry key (qualified when the class has one)
 */
export function memberTenancyOf(key: string): MemberTenancy {
  if (!tenancyEnforced()) return unscopedMember(key);
  const source = getTenantPolicySource();
  if (!source) return failedMember(key, 'no tenancy policy source');
  let lookup: TenantPolicyLookup;
  let declared: boolean;
  let conflict: string | undefined;
  try {
    lookup = source.policyOf(key);
    declared =
      ObjectRegistry.isTenantScoped(key) ||
      !!ObjectRegistry.getConfig(key)?.tenantScoped;
    if (lookup?.kind === 'resolved') {
      conflict = declarationConflict(key, lookup.policy);
    }
  } catch (error) {
    return failedMember(key, reasonOf(error));
  }
  if (lookup?.kind === 'absent') {
    if (declared) {
      return failedMember(key, 'declared tenancy the policy source omits');
    }
    return unscopedMember(key);
  }
  if (lookup?.kind !== 'resolved') {
    // `failed`, or an answer that is none of the three.
    return failedMember(
      key,
      lookup?.kind === 'failed' ? lookup.reason : FAILED_REASON,
    );
  }
  if (conflict) return failedMember(key, conflict);
  const { policy } = lookup;
  if (
    (policy.mode !== 'required' && policy.mode !== 'optional') ||
    typeof policy.field !== 'string' ||
    policy.field === ''
  ) {
    return failedMember(key, 'resolved tenancy policy is incomplete');
  }
  let fields: string[];
  let hierarchy: readonly string[] | undefined;
  try {
    fields = ownershipProperties(key, policy.field);
    hierarchy = source.hierarchyReadCollections();
  } catch (error) {
    return failedMember(key, reasonOf(error));
  }
  const hierarchyAllowed = !hierarchy || hierarchy.includes(key);
  const columns = fields.map((property) => whereColumnName(property)).sort();
  return Object.freeze({
    key,
    state: 'scoped',
    scoped: true,
    mode: policy.mode,
    field: policy.field,
    fields: Object.freeze(fields),
    allowSuperAdminBypass: policy.allowSuperAdminBypass === true,
    autoPopulate: policy.autoPopulate !== false,
    hierarchyAllowed,
    signature: JSON.stringify([
      true,
      policy.mode,
      whereColumnName(policy.field),
      columns,
      policy.allowSuperAdminBypass === true,
    ]),
  });
}

// ─── Identity ──────────────────────────────────────────────────────────────

/**
 * The strict registry key of a model name: a qualified name must be
 * registered under exactly that name; a simple name must belong to exactly
 * one registered class. Never the first of several matches.
 *
 * @returns The key, or `undefined` when the name is unknown or ambiguous
 */
export function resolveStrictModelKey(name: string): string | undefined {
  if (!name) return undefined;
  if (name.includes(':')) {
    const info = ObjectRegistry.getClassByQualifiedName(name);
    return info ? info.qualifiedName || name : undefined;
  }
  const matches = ObjectRegistry.findClassesByName(name);
  if (matches.length !== 1) return undefined;
  return matches[0].qualifiedName || matches[0].name;
}

// ─── Resolution ────────────────────────────────────────────────────────────

/** The tenancy one request resolved; see {@link resolveRequestTenancy}. */
export interface RequestTenancy {
  /** Strict registry key of the route model. */
  readonly model: string;
  /** Tenancy is enabled (a tenancy layer is installed). */
  readonly enforced: boolean;
  readonly actor: RequestActor;
  /** The route model's own tenancy. */
  readonly route: MemberTenancy;
  /** The route model and every STI member it serves, by registry key. */
  readonly members: ReadonlyMap<string, MemberTenancy>;
  /** The STI table owner when the route model is STI, else `null`. */
  readonly family: string | null;
  /**
   * The stored types this request may touch on the family table: the route
   * model and its served members of equal tenancy. `null` when the route
   * model is not STI.
   */
  readonly admitted: ReadonlySet<string> | null;
  /**
   * The types a create in this request may write on the family table: the
   * route model and its create targets of equal tenancy. `null` when the
   * request selects no create target (a new row is then held to
   * `admitted`). Reads and writes of stored rows always use `admitted`.
   */
  readonly creatable: ReadonlySet<string> | null;
  /** Served members left out because their tenancy differs. */
  readonly excluded: readonly string[];
  /** A digest of every member policy and the registry generation. */
  readonly fingerprint: string;
  /**
   * The bounded hierarchy read scope active at resolution (its key), or
   * `null`: the rows a read returns depend on it.
   */
  readonly hierarchy: string | null;
  /** Why resolution failed; every decision then refuses. */
  readonly failed?: string;
}

/** Inputs of {@link resolveRequestTenancy}. */
export interface ResolveRequestTenancyInput {
  /** The route model: a registry key or a name resolved strictly. */
  model: string;
  /**
   * Registry keys of the STI members the route serves for this operation
   * (surface, server model list, caller admission). Every STI descendant
   * when omitted.
   */
  served?: readonly string[];
  /**
   * Registry keys of the STI members a create through the route may select
   * (surface and server model list), when the request creates. Admitted as
   * create targets on the same equal-tenancy rule, and never read.
   */
  creatable?: readonly string[];
  actor: RequestActor;
}

function stiDescendants(model: string): string[] {
  return ObjectRegistry.getDescendants(model)
    .map((member) => {
      const info = ObjectRegistry.getClass(member);
      return info ? info.qualifiedName || info.name : member;
    })
    .filter((member) => ObjectRegistry.getTableStrategy(member) === 'sti');
}

/**
 * A map no caller can change after resolution: the bound decision is read
 * by every collection call of the request, so it never moves under it.
 */
class FrozenMap<K, V> extends Map<K, V> {
  constructor(entries: Iterable<readonly [K, V]>) {
    super();
    for (const [key, value] of entries) super.set(key, value);
    Object.freeze(this);
  }
  override set(): this {
    throw new TypeError('The resolved request tenancy is read-only');
  }
  override delete(): boolean {
    throw new TypeError('The resolved request tenancy is read-only');
  }
  override clear(): void {
    throw new TypeError('The resolved request tenancy is read-only');
  }
}

/** A set no caller can change after resolution (see {@link FrozenMap}). */
class FrozenSet<T> extends Set<T> {
  constructor(values: Iterable<T>) {
    super();
    for (const value of values) super.add(value);
    Object.freeze(this);
  }
  override add(): this {
    throw new TypeError('The resolved request tenancy is read-only');
  }
  override delete(): boolean {
    throw new TypeError('The resolved request tenancy is read-only');
  }
  override clear(): void {
    throw new TypeError('The resolved request tenancy is read-only');
  }
}

function fingerprintOf(members: Iterable<MemberTenancy>): string {
  const parts = [...members]
    .map((member) => `${member.key}=${member.signature}`)
    .sort();
  return `${getRegistryGeneration()}|${parts.join(';')}`;
}

/** The key of the active bounded hierarchy read scope, when tenancy is on. */
function hierarchyKeyOf(enforced: boolean): string | null {
  if (!enforced) return null;
  try {
    return getTenantPolicySource()?.hierarchyReadScopeKey?.() ?? null;
  } catch {
    // A key that cannot be read keys nothing reusable.
    return `unreadable:${Date.now()}:${Math.random()}`;
  }
}

/**
 * Resolve the tenancy of one request: the route model's policy, the policy
 * of every STI member it serves, the admitted types, and the frozen actor.
 * Never throws; a failure is recorded in `failed` and every decision
 * refuses.
 */
export function resolveRequestTenancy(
  input: ResolveRequestTenancyInput,
): RequestTenancy {
  const enforced = tenancyEnforced();
  const actor = Object.freeze({ ...input.actor });
  const model = resolveStrictModelKey(input.model);
  if (!model && !enforced) {
    // Tenancy is off and the name does not resolve to exactly one class:
    // nothing to decide, and no STI membership can be computed.
    const route = memberTenancyOf(input.model);
    return Object.freeze({
      model: input.model,
      enforced,
      actor,
      route,
      members: new FrozenMap([[input.model, route]]),
      family: null,
      admitted: null,
      creatable: null,
      excluded: Object.freeze([]),
      fingerprint: fingerprintOf([route]),
      hierarchy: null,
    });
  }
  if (!model) {
    const route = failedMember(input.model, 'unknown or ambiguous model');
    return Object.freeze({
      model: input.model,
      enforced,
      actor,
      route,
      members: new FrozenMap([[input.model, route]]),
      family: null,
      admitted: new FrozenSet<string>([]),
      creatable: null,
      excluded: Object.freeze([]),
      fingerprint: fingerprintOf([route]),
      hierarchy: hierarchyKeyOf(enforced),
      failed: route.failed,
    });
  }
  const route = memberTenancyOf(model);
  const members = new Map<string, MemberTenancy>([[model, route]]);
  const sti = ObjectRegistry.getTableStrategy(model) === 'sti';
  let admitted: Set<string> | null = null;
  let creatable: Set<string> | null = null;
  const excluded: string[] = [];
  let family: string | null = null;
  if (sti) {
    family = ObjectRegistry.getSTIBase(model);
    admitted = new Set([model]);
    const descendants = new Set(stiDescendants(model));
    const served = input.served
      ? input.served.filter((key) => descendants.has(key))
      : [...descendants];
    const equalToRoute = (key: string): boolean => {
      let member = members.get(key);
      if (!member) {
        member = memberTenancyOf(key);
        members.set(key, member);
      }
      const equal =
        !isFailedMember(member) &&
        member.signature === route.signature &&
        member.hierarchyAllowed === route.hierarchyAllowed;
      if (!equal && !excluded.includes(key)) excluded.push(key);
      return equal;
    };
    for (const key of served) {
      if (key !== model && equalToRoute(key)) admitted.add(key);
    }
    if (input.creatable) {
      creatable = new Set([model]);
      for (const key of input.creatable) {
        if (key === model || !descendants.has(key)) continue;
        if (equalToRoute(key)) creatable.add(key);
      }
    }
    if (excluded.length > 0 && family) noteMixedFamily(family, model, excluded);
  }
  return Object.freeze({
    model,
    enforced,
    actor,
    route,
    members: new FrozenMap(members),
    family,
    admitted: admitted ? new FrozenSet(admitted) : null,
    creatable: creatable ? new FrozenSet(creatable) : null,
    excluded: Object.freeze(excluded),
    fingerprint: fingerprintOf(members.values()),
    hierarchy: hierarchyKeyOf(enforced),
    ...(isFailedMember(route) ? { failed: route.failed } : {}),
  });
}

// ─── Mixed families ────────────────────────────────────────────────────────

/**
 * Warn once per STI family whose served members' tenancy differs from the
 * route model's: their rows are not served through that route.
 */
function noteMixedFamily(
  family: string,
  route: string,
  excluded: readonly string[],
): void {
  globalThis.__smrtMixedTenancyFamilies ??= new Set();
  const warned = globalThis.__smrtMixedTenancyFamilies;
  if (warned.has(family)) return;
  warned.add(family);
  if (typeof process === 'undefined') return;
  process.emitWarning(
    `[smrt] STI family ${family}: ${excluded.join(', ')} ` +
      `${excluded.length === 1 ? 'has' : 'have'} a tenancy that differs from ${route}, ` +
      `so ${route}'s routes do not serve ${excluded.length === 1 ? 'its' : 'their'} rows. ` +
      'Give the subtype its own route or sync segment, or align its tenancy.',
    { code: 'SMRT_MIXED_TENANCY_FAMILY' },
  );
}

/** One STI family whose members do not all share the base's tenancy. */
export interface MixedTenancyFamily {
  /** The STI table owner. */
  family: string;
  /** Members whose tenancy differs from the owner's. */
  excluded: string[];
}

/**
 * Every registered STI family whose members' tenancy differs from the
 * table owner's, as `smrt doctor` lists them. Members whose policy cannot
 * be resolved are listed too.
 */
export function listMixedTenancyFamilies(): MixedTenancyFamily[] {
  const families: MixedTenancyFamily[] = [];
  const seen = new Set<string>();
  for (const [key, info] of ObjectRegistry.getAllClasses()) {
    const registryKey = info.qualifiedName || key;
    if (seen.has(registryKey)) continue;
    seen.add(registryKey);
    if (ObjectRegistry.getTableStrategy(registryKey) !== 'sti') continue;
    if (ObjectRegistry.getSTIBase(registryKey) !== registryKey) continue;
    const owner = memberTenancyOf(registryKey);
    const excluded = stiDescendants(registryKey).filter((member) => {
      const policy = memberTenancyOf(member);
      return isFailedMember(policy) || policy.signature !== owner.signature;
    });
    if (excluded.length > 0) {
      families.push({ family: registryKey, excluded: excluded.sort() });
    }
  }
  return families.sort((a, b) => a.family.localeCompare(b.family));
}

// ─── Decisions ─────────────────────────────────────────────────────────────

/** A refusal: the status a transport answers with. */
export interface TenancyRefusal {
  kind: 'refuse';
  status: 401 | 403;
  code: string;
  message: string;
}

/**
 * How a read of one member is scoped:
 *
 * - `open`: the member is not tenant-scoped (or tenancy is off);
 * - `context`: the tenancy interceptor filters by the active tenant;
 * - `all`: a system actor, or a bypass on a member that opts in;
 * - `global-only`: no tenant, optional mode: rows without an owner only;
 * - `refuse`.
 */
export type ReadDecision =
  | { kind: 'open' }
  | { kind: 'context' }
  | { kind: 'all' }
  | { kind: 'global-only'; scope: Record<string, null> }
  | TenancyRefusal;

function refusal(
  status: 401 | 403,
  code: string,
  message: string,
): TenancyRefusal {
  return { kind: 'refuse', status, code, message };
}

function unresolved(): TenancyRefusal {
  return refusal(403, 'TENANT_POLICY_UNRESOLVED', UNRESOLVED_MESSAGE);
}

function contextRequired(actor: RequestActor): TenancyRefusal {
  return refusal(
    actor.authenticated ? 403 : 401,
    'TENANT_CONTEXT_REQUIRED',
    'Tenant context required.',
  );
}

function bypassApplies(t: RequestTenancy, member: MemberTenancy): boolean {
  return (
    t.actor.bypass &&
    member.allowSuperAdminBypass &&
    getTenantPolicySource()?.hierarchyReadCollections() === undefined
  );
}

/** How a read of `member` (the route model by default) is scoped. */
export function readScope(
  t: RequestTenancy,
  member: MemberTenancy = t.route,
): ReadDecision {
  if (t.failed !== undefined || isFailedMember(member)) return unresolved();
  if (!t.enforced || !member.scoped) return { kind: 'open' };
  if (t.actor.system) return { kind: 'all' };
  if (bypassApplies(t, member)) return { kind: 'all' };
  if (t.actor.tenantId) return { kind: 'context' };
  if (member.mode === 'required') return contextRequired(t.actor);
  return {
    kind: 'global-only',
    scope: Object.fromEntries(member.fields.map((field) => [field, null])),
  };
}

/**
 * Whether a write to `member` (the route model by default) may run: a
 * tenant actor (the interceptor checks ownership), a system actor with a
 * write grant, or a bypass on a member that opts in. A caller with no
 * tenant never writes a tenant-scoped row, rows without an owner included,
 * and neither does a request admitted under a read grant.
 *
 * @returns The refusal, or `undefined`
 */
export function writeGate(
  t: RequestTenancy,
  member: MemberTenancy = t.route,
): TenancyRefusal | undefined {
  if (t.failed !== undefined || isFailedMember(member)) return unresolved();
  if (!t.enforced || !member.scoped) return undefined;
  if (t.actor.readGrant || t.actor.system === 'read') {
    return refusal(
      403,
      'TENANT_WRITE_REFUSED',
      'A cross-tenant read grant does not authorize a write.',
    );
  }
  if (t.actor.system === 'write') return undefined;
  if (t.actor.tenantId) return undefined;
  if (bypassApplies(t, member)) return undefined;
  return contextRequired(t.actor);
}

/** What the transport knows about a custom action it dispatches. */
export interface CustomActionShape {
  /** The action may write (any verb but GET). */
  mutating: boolean;
  /**
   * The action receives the request's scope (an options bag, or
   * parameters named after every ownership property).
   */
  receivesScope: boolean;
}

/**
 * Whether a custom action may run. A mutating action needs the write gate.
 * A read by a caller with no tenant runs only when the action receives the
 * scope; collection reads inside it are then held to rows without an owner
 * by the bound interceptor, whatever the action does with its options.
 *
 * @returns The refusal, or `undefined`
 */
export function customActionScope(
  t: RequestTenancy,
  action: CustomActionShape,
): TenancyRefusal | undefined {
  if (action.mutating) return writeGate(t);
  const read = readScope(t);
  if (read.kind === 'refuse') return read;
  if (read.kind === 'global-only' && !action.receivesScope) {
    return contextRequired(t.actor);
  }
  return undefined;
}

/**
 * The ownership properties a custom read's options are scoped under: the
 * route model's ownership fields when its reads are filtered by tenant or
 * held to rows without an owner; none otherwise (tenancy off, not scoped, a
 * system actor or an applicable bypass).
 */
export function scopedOptionProperties(t: RequestTenancy): string[] {
  const read = readScope(t);
  return read.kind === 'context' || read.kind === 'global-only'
    ? [...t.route.fields]
    : [];
}

/**
 * The options a custom read action receives, with the caller's say over
 * ownership taken away: every entry naming an ownership column (`tenant_id`
 * in any spelling, and each ownership field) is removed, and the scope is
 * set under each ownership property: the actor's tenant, or `null` (rows
 * without an owner). Unchanged when {@link scopedOptionProperties} is empty.
 */
export function scopeActionOptions<T>(t: RequestTenancy, options: T): T {
  const properties = scopedOptionProperties(t);
  if (properties.length === 0) return options;
  if (options !== undefined && options !== null && typeof options !== 'object')
    return options;
  if (Array.isArray(options)) return options;
  const owned = new Set<string>([
    'tenant_id',
    ...properties.map((property) => whereColumnName(property)),
  ]);
  const scoped: Record<string, unknown> = {
    ...((options ?? {}) as Record<string, unknown>),
  };
  for (const key of Object.keys(scoped)) {
    if (owned.has(resolveWhereKey(key).column)) delete scoped[key];
  }
  const value = readScope(t).kind === 'context' ? t.actor.tenantId : null;
  for (const property of properties) scoped[property] = value;
  return scoped as T;
}

/** Whether any member a read may return is tenant-scoped. */
/** The registry declares tenancy for `key` (a failed lookup counts as yes). */
function declaresTenancy(key: string): boolean {
  try {
    return (
      ObjectRegistry.isTenantScoped(key) ||
      !!ObjectRegistry.getConfig(key)?.tenantScoped
    );
  } catch {
    return true;
  }
}

/**
 * Whether a read under `t` may return tenant-scoped rows, so it must never
 * get a shared-cache copy: a failed resolution, any admitted member that is
 * scoped, or, with tenancy off, any member that declares tenancy.
 */
export function servesTenantScopedRows(t: RequestTenancy): boolean {
  if (t.failed !== undefined) return true;
  if (!t.enforced) {
    // Tenancy is off, so nothing is filtered, but a model that declares
    // tenancy never gets a shared-cache copy: one issued now would outlive
    // the moment tenancy is turned on.
    for (const key of t.members.keys()) {
      if (declaresTenancy(key)) return true;
    }
    return false;
  }
  if (t.route.scoped) return true;
  for (const key of t.admitted ?? []) {
    if (t.members.get(key)?.scoped) return true;
  }
  return false;
}

// Lives here, not in generators/: the Vite plugin imports the generators, and
// it must not pull this module (registry, interceptors) into its graph.
/**
 * The `Cache-Control` of a read under a request's resolved tenancy (#5375):
 * shared caching only when the model opts in, no admitted member is
 * tenant-scoped (or, with tenancy off, declares tenancy), and every admitted
 * family member is publicly readable (a member admitted for this caller only
 * makes the rows depend on who calls).
 *
 * @param apiConfig - The route model's `api` config
 * @param permissionScoped - The body varies with the caller's permissions
 */
export function cachePolicy(
  t: RequestTenancy,
  apiConfig: unknown,
  permissionScoped = false,
): string {
  return resolveReadCacheControl(apiConfig, {
    tenantScoped: servesTenantScopedRows(t),
    permissionScoped: permissionScoped || servesCallerDependentRows(t),
  });
}

/** Whether a model's `api` config makes its reads public. */
function readsArePublic(key: string): boolean {
  let api: unknown;
  try {
    api = ObjectRegistry.getConfig(key)?.api;
  } catch {
    return false;
  }
  const access =
    api && typeof api === 'object'
      ? (api as { public?: unknown }).public
      : undefined;
  return access === true || access === 'read';
}

/**
 * Whether the rows a read under `t` returns depend on who calls: an admitted
 * family member (other than the route model) whose reads are not public was
 * admitted for this caller, and another caller may not be served it. Such a
 * read never gets a shared-cache copy, with tenancy on or off.
 */
export function servesCallerDependentRows(t: RequestTenancy): boolean {
  for (const key of t.admitted ?? []) {
    if (key !== t.model && !readsArePublic(key)) return true;
  }
  return false;
}

/**
 * The tenancy part of a read validator: the actor's scope, the admitted
 * types and the policy fingerprint, so a validator issued before a
 * registration changed any member's policy never revalidates. With tenancy
 * off, a family read still keys its validator on the admitted types (which
 * depend on the caller), and any other read keeps its plain validator.
 */
export function etagDiscriminator(t: RequestTenancy): string | undefined {
  if (!t.enforced) {
    return t.admitted && stiDescendants(t.model).length > 0
      ? `a:${[...t.admitted].sort().join(',')}`
      : undefined;
  }
  const actor = t.actor.system
    ? `s:${t.actor.system}`
    : t.actor.tenantId
      ? `t:${t.actor.tenantId}${t.actor.bypass ? ':bypass' : ''}`
      : 't:global';
  const admitted = t.admitted ? [...t.admitted].sort().join(',') : '';
  const hierarchy = t.hierarchy === null ? '' : `|h:${t.hierarchy}`;
  return `${actor}|${admitted}|${t.fingerprint}${hierarchy}`;
}

/**
 * Throw the typed error for a refusal (a no-op for `undefined` or a
 * decision that is not a refusal).
 */
export function throwIfRefused(
  decision: ReadDecision | TenancyRefusal | undefined,
): void {
  if (decision && decision.kind === 'refuse') {
    throw new RequestTenancyError(
      decision.status,
      decision.code,
      decision.message,
    );
  }
}

// ─── Execution scope ───────────────────────────────────────────────────────

function scopeContext(): AsyncContext<RequestTenancy> {
  globalThis.__smrtRequestTenancyScope ??= createAsyncContext<RequestTenancy>();
  return globalThis.__smrtRequestTenancyScope;
}

/** The request tenancy bound to the current execution scope, if any. */
export function getResolvedTenancy(): RequestTenancy | undefined {
  return scopeContext().getStore();
}

function assertBindable(t: RequestTenancy): void {
  ensureRequestTenancyInterceptor();
  if (t.enforced && !scopeContext().propagatesAcrossAwait) {
    throw new RequestTenancyError(
      403,
      'TENANT_POLICY_UNRESOLVED',
      UNRESOLVED_MESSAGE,
    );
  }
}

/**
 * Run an operation inside the resolved tenancy: in the actor's tenant or
 * system context, with the decision bound for the collection interceptor.
 * Nested calls bind their own (for example one per sync item).
 *
 * @param options.refreshPrincipal - The actor is a complete principal: an
 *   active context of the same tenant runs with the actor's permission
 *   snapshot, never a broader one it already carried
 */
export async function withResolvedTenancy<T>(
  t: RequestTenancy,
  fn: () => Promise<T>,
  options: { refreshPrincipal?: boolean } = {},
): Promise<T> {
  assertBindable(t);
  const bound = () => scopeContext().run(t, fn);
  if (!t.enforced) return bound();
  const source = getTenantPolicySource();
  if (!source) return bound();
  if (t.actor.system && !source.systemContextActive()) {
    return source.runInContext('system', bound);
  }
  const active = getRequestTenantContext();
  if (!t.actor.system && t.actor.tenantId) {
    if (active?.tenantId !== t.actor.tenantId) {
      return source.runInContext(
        {
          tenantId: t.actor.tenantId,
          ...(t.actor.userId ? { userId: t.actor.userId } : {}),
          ...(t.actor.permissions ? { permissions: t.actor.permissions } : {}),
        },
        bound,
      );
    }
    if (options.refreshPrincipal && t.actor.permissions) {
      // Keep the rest of the active context (its database, metadata), with
      // the authority the request was admitted with.
      return source.runInContext(
        {
          ...(active as Record<string, unknown>),
          tenantId: t.actor.tenantId,
          ...(t.actor.userId ? { userId: t.actor.userId } : {}),
          permissions: t.actor.permissions,
        } as RequestTenancyContext,
        bound,
      );
    }
  }
  return bound();
}

/**
 * Bind the resolved tenancy for the rest of the current request, entering
 * the actor's tenant context when none is active (the emitted SvelteKit
 * routes, whose handlers run in their own request scope). A system actor
 * here always comes from an active system context.
 */
export function enterResolvedTenancy(
  t: RequestTenancy,
  options: { refreshPrincipal?: boolean } = {},
): void {
  assertBindable(t);
  const active = getRequestTenantContext();
  if (
    t.enforced &&
    !t.actor.system &&
    t.actor.tenantId &&
    active?.tenantId !== t.actor.tenantId
  ) {
    enterRequestTenantContext({
      tenantId: t.actor.tenantId,
      ...(t.actor.userId ? { userId: t.actor.userId } : {}),
      ...(t.actor.permissions ? { permissions: t.actor.permissions } : {}),
    });
  } else if (
    options.refreshPrincipal &&
    active &&
    t.actor.tenantId &&
    active.tenantId === t.actor.tenantId
  ) {
    // A complete principal refreshes the active context's authority to the
    // request's permission snapshot, keeping the rest of that context.
    enterRequestTenantContext({
      ...(active as Record<string, unknown>),
      tenantId: t.actor.tenantId,
      ...(t.actor.userId ? { userId: t.actor.userId } : {}),
      ...(t.actor.permissions ? { permissions: t.actor.permissions } : {}),
    } as Parameters<typeof enterRequestTenantContext>[0]);
  }
  scopeContext().enter(t);
}

/**
 * The bound tenancy's member policy for a class key, when the request
 * resolved one for it (the route model or a served STI member).
 */
export function boundMemberTenancy(key: string): MemberTenancy | undefined {
  return getResolvedTenancy()?.members.get(key);
}

// ─── Collection enforcement ────────────────────────────────────────────────

const INTERCEPTOR_NAME = 'smrt-request-tenancy';

function identityOf(className: string, context: InterceptorContext): string {
  return context.qualifiedClassName ?? className;
}

/**
 * The bound tenancy as one collection call acts under it. Code that enters a
 * system context inside the request acts as the system, and code that enters
 * a tenant context in a request with no tenant acts in that tenant, as each
 * does outside a request. A request admitted under a read grant (or already
 * acting as the system or a tenant) keeps its admitted actor: no context its
 * code enters lifts the read grant's write refusal. Membership and the bound
 * policies are the request's either way.
 */
function actingTenancy(t: RequestTenancy): RequestTenancy {
  if (!t.enforced || t.actor.readGrant || t.actor.system) return t;
  const source = getTenantPolicySource();
  if (!source) return t;
  let actor: RequestActor | undefined;
  if (source.systemContextActive()) {
    actor = { ...t.actor, tenantId: null, system: 'write', bypass: false };
  } else if (!t.actor.tenantId) {
    const entered = getRequestTenantContext()?.tenantId;
    if (typeof entered === 'string' && entered.length > 0) {
      actor = {
        ...t.actor,
        tenantId: entered,
        bypass: source.superAdminBypassActive() === true,
      };
    }
  }
  return actor ? Object.freeze({ ...t, actor: Object.freeze(actor) }) : t;
}

/** The bound tenancy as the current collection call acts under it. */
function actingAtCall(): RequestTenancy | undefined {
  const t = getResolvedTenancy();
  return t ? actingTenancy(t) : undefined;
}

function inFamily(t: RequestTenancy, key: string): boolean {
  if (!t.admitted || !t.family) return false;
  return (
    ObjectRegistry.getTableStrategy(key) === 'sti' &&
    ObjectRegistry.getSTIBase(key) === t.family
  );
}

/**
 * The tenancy whose admitted types restrict an operation on `key`'s table:
 * the bound request's when `key` is in the route's family; for an STI model
 * of another family that has members, that family's tenancy resolved for
 * the same actor (its members of equal tenancy to `key`), so a read through
 * an unrelated base never serves rows of a member whose tenancy differs, as
 * that family's own routes would not. A system actor reads every type, as
 * it does every tenant. `undefined` when no membership applies. Reads only:
 * a write to another family is not restricted by membership.
 */
function familyTenancyOf(
  t: RequestTenancy,
  key: string,
): RequestTenancy | undefined {
  if (inFamily(t, key)) return t;
  if (!t.enforced || t.actor.system) return undefined;
  if (ObjectRegistry.getTableStrategy(key) !== 'sti') return undefined;
  if (stiDescendants(key).length === 0) return undefined;
  const other = resolveRequestTenancy({ model: key, actor: t.actor });
  if (other.failed !== undefined) throwIfRefused(unresolved());
  return other;
}

/**
 * Refuse an operation whose tenancy moved since admission: tenancy turned on
 * or off, or a policy of any model in `keys` the request resolved changed.
 */
function assertFresh(t: RequestTenancy, keys: Iterable<string>): void {
  if (tenancyEnforced() !== t.enforced) throw new TenantPolicyChangedError();
  if (!t.enforced) return;
  for (const key of keys) {
    const bound = t.members.get(key);
    if (!bound) continue;
    if (isFailedMember(bound)) throwIfRefused(unresolved());
    if (memberTenancyOf(key).signature !== bound.signature) {
      throw new TenantPolicyChangedError();
    }
  }
}

/**
 * The policy an operation on `key` is held to inside a bound request: the
 * bound member when the request resolved one (refusing a change since
 * admission, of that member or of any admitted type the operation reads on
 * the family table), else the class's live policy, so a model the route did
 * not resolve is held to the same actor rules (a caller with no tenant reads
 * only rows without an owner and writes none; a read grant writes none).
 * `undefined` when tenancy is off.
 */
function memberFor(
  t: RequestTenancy,
  key: string,
  family: boolean,
): MemberTenancy | undefined {
  assertFresh(t, family ? [key, ...(t.admitted ?? [])] : [key]);
  if (!t.enforced) return undefined;
  const bound = t.members.get(key);
  if (bound) return bound;
  const live = memberTenancyOf(key);
  if (isFailedMember(live)) throwIfRefused(unresolved());
  return live;
}

function dnfOf(where: ListOptions['where']): Record<string, unknown>[][] {
  if (Array.isArray(where)) {
    if (where.length === 0 || where.some((group) => group.length === 0)) {
      throw new Error(
        'Invalid DNF where clause: every OR branch must contain at least one condition',
      );
    }
    return where;
  }
  return [[where ?? {}]];
}

/** The discriminator set on an instance (`_meta_type`). */
function instanceTypeOf(instance: SmrtObject): unknown {
  return (instance as unknown as Record<string, unknown>)._meta_type;
}

/**
 * The registry key a stored or instance discriminator names, read for a
 * write of `key`: `key` for its own type (registry key, qualified name, or
 * the simple name a legacy row may carry), the strict key of another
 * registered type, or `undefined` for a type this process cannot resolve
 * (a NULL discriminator included).
 */
function rowTypeKey(key: string, type: unknown): string | undefined {
  if (typeof type !== 'string' || type === '') return undefined;
  if (type === key) return key;
  const own = ObjectRegistry.getClass(key);
  if (type === own?.qualifiedName || type === own?.name) return key;
  return resolveStrictModelKey(type);
}

/**
 * The stored row a write of `key` would change or delete, read by the
 * instance's id. Looked up in an enforced request for an STI table whose
 * family has members, where the row an id names can be of a type whose
 * tenancy differs from the class written through, or of another owner than
 * the instance carries. `undefined` when not looked up or when no row has
 * that id.
 */
async function storedRowOf(
  t: RequestTenancy,
  key: string,
  instance: SmrtObject,
): Promise<Record<string, unknown> | undefined> {
  if (!t.enforced || t.actor.system === 'write') return undefined;
  const id = (instance as unknown as { id?: unknown }).id;
  if (typeof id !== 'string' || id === '') return undefined;
  if (ObjectRegistry.getTableStrategy(key) !== 'sti') return undefined;
  if (stiDescendants(ObjectRegistry.getSTIBase(key) ?? key).length === 0) {
    return undefined;
  }
  // The canonical persisted-row read, as hydration and ownership use it, so
  // a UUID owner column compares as the tenant's id on every adapter (a raw
  // read of native DuckDB returns `{ hugeint }`).
  const row = await (
    instance as unknown as {
      getCanonicalPersistedRow(
        filter: Record<string, unknown>,
      ): Promise<Record<string, unknown> | null>;
    }
  ).getCanonicalPersistedRow({ id });
  return row ?? undefined;
}

/**
 * Hold a write of `key` to the policy of a row type it touches (the stored
 * row's, or the one set on the instance): the type's own write gate, and,
 * when its tenancy differs from `key`'s, a refusal. A save stamps and
 * checks the owner under `key`'s policy, so a row of a type with another
 * policy is written only through a model of that policy. A system actor
 * writes every type.
 */
function assertRowTypeWritable(
  t: RequestTenancy,
  key: string,
  member: MemberTenancy,
  type: unknown,
): void {
  if (t.actor.system === 'write') return;
  const typeKey = rowTypeKey(key, type);
  if (typeKey === key) return;
  if (typeKey === undefined) {
    throw new RequestTenancyError(
      403,
      'TENANT_MEMBER_EXCLUDED',
      'The tenancy of that row type could not be resolved.',
    );
  }
  const typed = memberFor(t, typeKey, inFamily(t, typeKey));
  if (!typed) return;
  throwIfRefused(writeGate(t, typed));
  if (typed.signature !== member.signature) {
    throw new RequestTenancyError(
      403,
      'TENANT_MEMBER_EXCLUDED',
      'A row of that type is written only through a model of its tenancy.',
    );
  }
}

/** Refusals that mean this request may not write a row type. */
const ROW_TYPE_REFUSALS = new Set([
  'TENANT_MEMBER_EXCLUDED',
  'TENANT_WRITE_REFUSED',
  'TENANT_CONTEXT_REQUIRED',
]);

/**
 * Whether the stored row's owner lets the acting tenant write it under
 * `member`'s policy: every ownership column is empty or names the tenant
 * the call acts in. The tenant interceptor checks the owner the instance
 * carries; this checks the one stored, so an instance that names a row by
 * id without its owner does not reach another tenant's row.
 */
function storedOwnerWritable(
  t: RequestTenancy,
  member: MemberTenancy,
  row: Record<string, unknown>,
): boolean {
  if (!member.scoped || t.actor.system === 'write') return true;
  if (bypassApplies(t, member)) return true;
  const tenant = getRequestTenantContext()?.tenantId ?? t.actor.tenantId;
  for (const field of member.fields) {
    const owner = row[whereColumnName(field)];
    if (owner === null || owner === undefined) continue;
    if (typeof tenant !== 'string' || String(owner) !== tenant) return false;
  }
  return true;
}

/**
 * Whether a write of `key` may change the stored row its id names: within
 * the route's own family, a row of a type the route reads; a type that
 * passes {@link assertRowTypeWritable}; and an owner the acting tenant may
 * write. A policy that changed or could not be resolved still refuses as
 * such.
 */
function storedRowWritable(
  t: RequestTenancy,
  key: string,
  member: MemberTenancy | undefined,
  row: Record<string, unknown>,
): boolean {
  const type = row._meta_type;
  if (inFamily(t, key)) {
    const typeKey = rowTypeKey(key, type);
    if (typeKey === undefined || !t.admitted?.has(typeKey)) return false;
  }
  if (!member) return true;
  try {
    assertRowTypeWritable(t, key, member, type);
    return storedOwnerWritable(t, member, row);
  } catch (error) {
    if (
      error instanceof RequestTenancyError &&
      ROW_TYPE_REFUSALS.has(error.code)
    ) {
      return false;
    }
    throw error;
  }
}

async function assertWritable(
  t: RequestTenancy,
  key: string,
  instance: SmrtObject,
  operation: 'save' | 'delete',
): Promise<void> {
  const family = inFamily(t, key);
  const member = memberFor(t, key, family);
  const typed = instanceTypeOf(instance);
  // The route's own family restricts writes to its admitted types; a write
  // to another family is decided by the policies below and the tenant
  // interceptor.
  if (family) {
    // A new row is held to the create targets when the request selects
    // them; a stored row (an update, a delete) to the types the route reads.
    const types =
      !instance.isPersisted && t.creatable ? t.creatable : t.admitted;
    if (
      !types?.has(key) ||
      (typeof typed === 'string' &&
        typed &&
        !types.has(rowTypeKey(key, typed) ?? typed))
    ) {
      throw new RequestTenancyError(
        403,
        'TENANT_MEMBER_EXCLUDED',
        'This route does not serve that type.',
      );
    }
  }
  if (member) throwIfRefused(writeGate(t, member));
  // Every write and delete is decided under the policy of the type the row
  // is stored as and of the type set on the instance, not only of the
  // class it is written through, and against the owner stored.
  const stored = await storedRowOf(t, key, instance);
  if (stored && !storedRowWritable(t, key, member, stored)) {
    if (operation === 'save' && !instance.isPersisted) {
      // A new row cannot take the id of a stored row this write may not
      // change: answered as the insert would be, whatever that row's type
      // or owner.
      throw ValidationError.uniqueConstraint(
        'id',
        (instance as unknown as { id?: unknown }).id,
      );
    }
    throw new RequestTenancyError(
      403,
      'TENANT_MEMBER_EXCLUDED',
      'This request may not change that row.',
    );
  }
  if (member && typeof typed === 'string' && typed) {
    assertRowTypeWritable(t, key, member, typed);
  }
}

/**
 * Refuse a natural-key save that would adopt a stored row of a type the
 * bound request does not admit. The save's own type was admitted when it
 * began (`beforeSave`), but a key shared across the family's types can
 * match a row of another type, read directly from the table: that row is
 * held to the types the request reads, like any stored row it writes.
 *
 * @param key - Registry key of the class being saved
 * @param stored - The stored row the save would adopt
 */
export function assertAdoptableStoredRow(
  key: string,
  stored: Record<string, unknown>,
): void {
  const t = getResolvedTenancy();
  if (!t || !inFamily(t, key)) return;
  const type = stored._meta_type;
  if (typeof type !== 'string' || !t.admitted?.has(type)) {
    throw new RequestTenancyError(
      403,
      'TENANT_MEMBER_EXCLUDED',
      'This route does not serve that type.',
    );
  }
}

/**
 * The membership predicate of a point read on the family table. A child
 * collection replaces any `_meta_type in` list with its own subtree (an
 * owned key), so the registered family members that are not admitted are
 * also named in `_meta_type not in`: the subtree of registered types minus
 * those is exactly the admitted set, and a stored type that is not
 * registered is outside both the admitted list and any subtree.
 */
function familyPointFilter(
  t: RequestTenancy,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const admitted = t.admitted ?? new Set<string>();
  const outside = new Set(
    [t.family as string, ...stiDescendants(t.family as string)].filter(
      (type) => !admitted.has(type),
    ),
  );
  // The caller's own type conditions are kept as a conjunction: its `in`
  // list is intersected with the admitted types (an empty intersection
  // selects nothing: every type it names is also excluded), its `not in`
  // list is added to the exclusions. Matched by resolved column, so any
  // spelling of `_meta_type` counts.
  const filter: Record<string, unknown> = {};
  let callerIn: unknown[] | undefined;
  for (const [key, value] of Object.entries(base)) {
    const resolved = resolveWhereKey(key);
    const operator = effectiveWhereOperator(
      resolved.operator.toLowerCase(),
      value,
    );
    if (resolved.column === '_meta_type' && Array.isArray(value)) {
      if (operator === 'in') {
        callerIn = callerIn
          ? callerIn.filter((type) => value.includes(type))
          : [...value];
        continue;
      }
      if (operator === 'not in') {
        for (const type of value) outside.add(type as string);
        continue;
      }
    }
    filter[key] = value;
  }
  let types: unknown[] = [...admitted];
  if (callerIn) {
    const both = callerIn.filter((type) => admitted.has(type as string));
    if (both.length > 0) {
      types = both;
    } else if (callerIn.length > 0) {
      types = callerIn;
      for (const type of callerIn) outside.add(type as string);
    } else {
      // An empty caller list matches no type.
      types = [t.family as string];
      outside.add(t.family as string);
    }
  }
  return {
    ...filter,
    '_meta_type in': types,
    ...(outside.size > 0 ? { '_meta_type not in': [...outside] } : {}),
  };
}

function createRequestTenancyInterceptor(): CollectionInterceptor {
  return {
    name: INTERCEPTOR_NAME,
    // Before the tenancy interceptor (100): membership and the actor rules
    // are applied first, then the tenant filter.
    priority: 110,
    bulkMutation: { compatible: () => true },

    beforeList(className, options, context) {
      const t = actingAtCall();
      if (!t) return;
      const key = identityOf(className, context);
      const family = inFamily(t, key);
      const member = memberFor(t, key, family);
      let scope: Record<string, null> | undefined;
      if (member) {
        const read = readScope(t, member);
        throwIfRefused(read);
        if (read.kind === 'global-only') scope = read.scope;
      }
      const owner = familyTenancyOf(t, key);
      if (!owner && !scope) return;
      const admitted = owner ? [...(owner.admitted ?? [])] : undefined;
      return {
        ...options,
        where: dnfOf(options.where).map((group) => [
          ...group,
          ...(admitted ? [{ '_meta_type in': admitted }] : []),
          ...(scope ? [scope] : []),
        ]),
      };
    },

    beforeGet(className, filter, context) {
      const t = actingAtCall();
      if (!t) return;
      const key = identityOf(className, context);
      const family = inFamily(t, key);
      const member = memberFor(t, key, family);
      let scope: Record<string, null> | undefined;
      if (member) {
        const read = readScope(t, member);
        throwIfRefused(read);
        if (read.kind === 'global-only') scope = read.scope;
      }
      const owner = familyTenancyOf(t, key);
      if (!owner && !scope) return;
      const base: Record<string, unknown> =
        typeof filter === 'string'
          ? resolveGetStringFilter(filter)
          : { ...filter };
      return {
        ...(owner ? familyPointFilter(owner, base) : base),
        ...(scope ?? {}),
      };
    },

    async beforeSave(instance, context) {
      const t = actingAtCall();
      if (!t) return;
      await assertWritable(
        t,
        identityOf(context.className, context),
        instance,
        'save',
      );
    },

    async beforeDelete(instance, context) {
      const t = actingAtCall();
      if (!t) return;
      await assertWritable(
        t,
        identityOf(context.className, context),
        instance,
        'delete',
      );
    },
  };
}

/**
 * Install the request tenancy interceptor if it is not registered (a test
 * may clear the global interceptor list). Called whenever a decision is
 * bound, so enforcement never depends on module load order.
 */
export function ensureRequestTenancyInterceptor(): void {
  if (
    GlobalInterceptors.getAll().some(
      (interceptor) => interceptor.name === INTERCEPTOR_NAME,
    )
  ) {
    return;
  }
  GlobalInterceptors.register(createRequestTenancyInterceptor());
}

// ─── Emitted-route conveniences ────────────────────────────────────────────

/**
 * Whether the bound request tenancy serves tenant-scoped rows, or family
 * members admitted for this caller only, so a read must not be
 * shared-cached (used by emitted routes after
 * `enterRequestTenancy`). With nothing bound no decision was made, and the
 * answer is the private one.
 */
export function boundTenancyCacheScoped(): boolean {
  const t = getResolvedTenancy();
  return t ? servesTenantScopedRows(t) || servesCallerDependentRows(t) : true;
}

/** The validator discriminator of the bound request tenancy. */
export function boundTenancyEtagDiscriminator(): string | undefined {
  const t = getResolvedTenancy();
  return t ? etagDiscriminator(t) : undefined;
}
