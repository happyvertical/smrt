/**
 * The live request principal record (#5195).
 *
 * A REST request that acts for a principal its host resolved
 * (`APIConfig.resolvePrincipal`) has one record: the principal snapshot, a
 * lifecycle state, and the operation frames REST opened for it. The record is
 * bound in an async context for the whole request; nothing the request runs
 * can replace it, and it refuses every use once the request ended.
 *
 * Each frame carries the request tenancy REST resolved for one operation
 * (the route, one sync item, a nested dispatch) and the membership ceiling of
 * that operation: per family, the stored types it admits and may create and
 * the policy signature of each member. A frame's ceiling is its own
 * resolution intersected with every enclosing frame's, and ends with the
 * frame, so a nested or later operation never broadens an outer one and
 * sibling items share nothing.
 *
 * Request code that binds a tenancy decision itself (`withResolvedTenancy`,
 * `enterResolvedTenancy`, an in-process tool call) goes through
 * {@link enterNonWidening}: inside a principal request the decision binds
 * only when its actor equals the request's, field by field, and, for every
 * family the request has a ceiling for, its admitted and creatable types are
 * subsets of the ceiling and its member signatures equal the ceiling's. A
 * bind can narrow, never widen.
 *
 * Sharing across core copies: the first copy to evaluate defines, under
 * `globalThis.__smrtRequestPrincipalScope`, one frozen, non-writable,
 * non-configurable object `{ version, read, enterNonWidening, recordOf }`
 * whose async context lives in that copy's closure. Later copies adopt it
 * when its `version` is one they support, so a collection of any copy reads
 * the same record. It carries no function that enters or runs a record:
 * only the copy that created it binds records ({@link runInPrincipalRecord}).
 * The released slot `__smrtRequestTenancyScope` keeps its shape and meaning
 * for requests without a principal; the shared object records the slot it
 * created, so a slot an older core created first is detected
 * ({@link assertPrincipalScopeUsable}). An older core that loads later and
 * adopts the existing slot leaves no trace: one core version per process is
 * a deployment prerequisite.
 *
 * This is an API-level mechanism, not isolation inside a shared runtime:
 * code in the same realm can patch modules or define the global first.
 */

import type { RequestPrincipal } from './generators/request-principal';
import type { RequestActor, RequestTenancy } from './request-tenancy';
import { SmrtError } from './smrt-error.js';
import { type AsyncContext, createAsyncContext } from './utils/async-context';

/** The shared-object versions this copy reads and binds through. */
export const PRINCIPAL_SCOPE_VERSION = 1;

const SHARED_KEY = '__smrtRequestPrincipalScope';
const BRAND = Symbol.for('smrt:request-principal-scope');

/** The membership a frame admits for one family (or a non-STI route model). */
export interface FamilyCeiling {
  /** Stored types the operation may touch; `null` when the model is not STI. */
  readonly admitted: ReadonlySet<string> | null;
  /** Types a create may write; `null` when it selects no create target. */
  readonly creatable: ReadonlySet<string> | null;
  /** Policy signature of each member, by registry key. */
  readonly signatures: ReadonlyMap<string, string>;
}

/** One operation frame of a principal request. */
export interface PrincipalFrame {
  readonly record: PrincipalRecord;
  /** The tenancy bound for this frame; `undefined` before any operation. */
  readonly tenancy: RequestTenancy | undefined;
  /** Ceilings by family key, intersected with every enclosing frame's. */
  readonly ceilings: ReadonlyMap<string, FamilyCeiling>;
}

/** Lifecycle of a request record. */
export type PrincipalRecordState = 'open' | 'closing' | 'ended';

/**
 * A refusal of the principal scope: a widening bind, a use after the
 * request ended, an unusable shared object. A `SmrtError` with a status, so
 * every transport renders it.
 */
export class RequestPrincipalScopeError extends SmrtError {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, code: string, message: string) {
    super(message, code, 'runtime');
    this.name = 'RequestPrincipalScopeError';
    this.status = status;
    this.publicMessage = message;
  }
}

/** The request has ended: detached work that kept its context is refused. */
export function requestEnded(): RequestPrincipalScopeError {
  return new RequestPrincipalScopeError(
    403,
    'REQUEST_ENDED',
    'The request this work belonged to has ended.',
  );
}

/** One REST request's principal record. */
export class PrincipalRecord {
  readonly snapshot: RequestPrincipal;
  #state: PrincipalRecordState = 'open';

  constructor(snapshot: RequestPrincipal) {
    this.snapshot = snapshot;
    Object.freeze(this);
  }

  get state(): PrincipalRecordState {
    return this.#state;
  }

  /** The request stops accepting work (scope mode drains before commit). */
  close(): void {
    if (this.#state === 'open') this.#state = 'closing';
  }

  /** The request is over: every later use refuses. */
  end(): void {
    this.#state = 'ended';
  }
}

/** What the shared object exposes; see the module documentation. */
interface SharedPrincipalScope {
  readonly version: number;
  read(): PrincipalFrame | undefined;
  enterNonWidening<T>(t: RequestTenancy, fn: () => T): T;
  recordOf(handle: object): PrincipalRecord | undefined;
}

interface OwnedScope {
  shared: SharedPrincipalScope;
  frames: AsyncContext<PrincipalFrame>;
  handles: WeakMap<object, PrincipalRecord>;
  releasedSlot: unknown;
  releasedSlotForeign: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __smrtRequestPrincipalScope: SharedPrincipalScope | undefined;
}

function sameSet(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Whether two actors are the same, field by field. */
export function sameActor(a: RequestActor, b: RequestActor): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.userId === b.userId &&
    a.system === b.system &&
    a.readGrant === b.readGrant &&
    a.bypass === b.bypass &&
    a.authenticated === b.authenticated &&
    sameSet(a.permissions, b.permissions)
  );
}

function subsetOf(
  inner: ReadonlySet<string> | null,
  outer: ReadonlySet<string> | null,
): boolean {
  if (outer === null) return inner === null;
  if (inner === null) return true;
  for (const value of inner) if (!outer.has(value)) return false;
  return true;
}

function familyKey(t: RequestTenancy): string {
  return t.family ?? t.model;
}

function ceilingOf(t: RequestTenancy): FamilyCeiling {
  const signatures = new Map<string, string>();
  for (const [key, member] of t.members) signatures.set(key, member.signature);
  return Object.freeze({
    admitted: t.admitted,
    creatable: t.creatable,
    signatures,
  });
}

function intersect(
  own: FamilyCeiling,
  outer: FamilyCeiling | undefined,
): FamilyCeiling {
  if (!outer) return own;
  const keep = (
    set: ReadonlySet<string> | null,
    bound: ReadonlySet<string> | null,
  ): ReadonlySet<string> | null => {
    if (set === null) return bound;
    if (bound === null) return set;
    return new Set([...set].filter((value) => bound.has(value)));
  };
  const signatures = new Map<string, string>();
  for (const [key, signature] of own.signatures) {
    const outerSignature = outer.signatures.get(key);
    if (outerSignature === undefined || outerSignature === signature) {
      signatures.set(key, signature);
    }
  }
  return Object.freeze({
    admitted: keep(own.admitted, outer.admitted),
    creatable: keep(own.creatable, outer.creatable),
    signatures,
  });
}

/** Whether a decision stays within the frame's actor and ceilings. */
function withinFrame(frame: PrincipalFrame, t: RequestTenancy): boolean {
  const reference = frame.tenancy?.actor;
  if (reference) {
    if (!sameActor(t.actor, reference)) return false;
  } else {
    // Before any operation, the snapshot is the reference.
    const snapshot = frame.record.snapshot;
    if (
      t.actor.userId !== snapshot.userId ||
      t.actor.bypass ||
      t.actor.system !== null ||
      t.actor.tenantId !== snapshot.tenantId ||
      !sameSet(t.actor.permissions, snapshot.permissions)
    ) {
      return false;
    }
  }
  const ceiling = frame.ceilings.get(familyKey(t));
  if (!ceiling) return true;
  if (!subsetOf(t.admitted, ceiling.admitted)) return false;
  if (
    !subsetOf(t.creatable ?? t.admitted, ceiling.creatable ?? ceiling.admitted)
  ) {
    return false;
  }
  for (const [key, member] of t.members) {
    const signature = ceiling.signatures.get(key);
    if (signature !== undefined && signature !== member.signature) return false;
  }
  return true;
}

function widening(): RequestPrincipalScopeError {
  return new RequestPrincipalScopeError(
    403,
    'TENANT_CONTEXT_CONFLICT',
    'A request may not bind another actor or a wider membership.',
  );
}

function createOwnedScope(): OwnedScope {
  const frames = createAsyncContext<PrincipalFrame>();
  const handles = new WeakMap<object, PrincipalRecord>();
  // The released slot: an older core created it first when it already
  // exists now, since every copy of this version defines the shared object
  // before anything creates the slot.
  const existing = globalThis.__smrtRequestTenancyScope;
  const releasedSlotForeign = existing !== undefined;
  globalThis.__smrtRequestTenancyScope ??= createAsyncContext();
  const releasedSlot = globalThis.__smrtRequestTenancyScope;
  const shared: SharedPrincipalScope = {
    version: PRINCIPAL_SCOPE_VERSION,
    read: () => frames.getStore(),
    enterNonWidening<T>(t: RequestTenancy, fn: () => T): T {
      const frame = frames.getStore();
      if (!frame) return fn();
      if (frame.record.state === 'ended') throw requestEnded();
      if (!withinFrame(frame, t)) throw widening();
      return frames.run(
        Object.freeze({
          record: frame.record,
          tenancy: t,
          ceilings: frame.ceilings,
        }),
        fn,
      );
    },
    recordOf: (handle: object) => handles.get(handle),
  };
  // The brand is a registered symbol, so every copy recognises the object.
  Object.defineProperty(shared, BRAND, { value: true });
  Object.freeze(shared);
  return { shared, frames, handles, releasedSlot, releasedSlotForeign };
}

function adopt(): { owned?: OwnedScope; shared?: SharedPrincipalScope } {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, SHARED_KEY);
  if (descriptor) {
    return { shared: descriptor.value as SharedPrincipalScope };
  }
  const owned = createOwnedScope();
  Object.defineProperty(globalThis, SHARED_KEY, {
    value: owned.shared,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return { owned, shared: owned.shared };
}

const adopted = adopt();

function sharedScope(): SharedPrincipalScope | undefined {
  const shared = adopted.shared;
  if (
    !shared ||
    typeof shared !== 'object' ||
    (shared as unknown as Record<symbol, unknown>)[BRAND] !== true ||
    shared.version !== PRINCIPAL_SCOPE_VERSION ||
    typeof shared.read !== 'function'
  ) {
    return undefined;
  }
  return shared;
}

/**
 * Throw unless this process can bind principal requests: the shared object
 * is one this copy supports, this copy created it (only the creating copy
 * binds records), and the released slot is the one it recorded. Called when
 * a server is constructed with `resolvePrincipal` and again per request.
 */
export function assertPrincipalScopeUsable(): void {
  const shared = sharedScope();
  if (!shared) {
    throw new RequestPrincipalScopeError(
      500,
      'REQUEST_PRINCIPAL_SCOPE_UNSUPPORTED',
      'The request principal scope of this process is not one this core supports.',
    );
  }
  const owned = adopted.owned;
  if (!owned) {
    throw new RequestPrincipalScopeError(
      500,
      'REQUEST_PRINCIPAL_SCOPE_UNSUPPORTED',
      'Serve principal requests from the core copy that loaded first.',
    );
  }
  if (
    owned.releasedSlotForeign ||
    globalThis.__smrtRequestTenancyScope !== owned.releasedSlot
  ) {
    throw new RequestPrincipalScopeError(
      500,
      'REQUEST_PRINCIPAL_SCOPE_UNSUPPORTED',
      'Another core copy created the request tenancy scope of this process.',
    );
  }
}

/** The principal frame of the current async context, of any core copy. */
export function currentPrincipalFrame(): PrincipalFrame | undefined {
  return sharedScope()?.read();
}

/** The live (not ended) principal record of the current context, if any. */
export function livePrincipalRecord(): PrincipalRecord | undefined {
  const record = currentPrincipalFrame()?.record;
  return record && record.state !== 'ended' ? record : undefined;
}

/**
 * The principal of the REST request this code runs in: its one frozen
 * snapshot (tenant, user, sign-in, caller kind, grant, bypass, whether it is
 * request-scoped, and read-only permissions). `undefined` outside a request
 * whose host resolves principals, after that request ended, and in another
 * thread.
 */
export function getRequestPrincipal(): RequestPrincipal | undefined {
  return livePrincipalRecord()?.snapshot;
}

/**
 * Run a REST request inside its record. Internal to the REST server; only
 * the core copy that created the shared object binds records.
 */
export function runInPrincipalRecord<T>(
  record: PrincipalRecord,
  fn: () => T,
): T {
  const owned = adopted.owned;
  if (!owned) {
    throw new RequestPrincipalScopeError(
      500,
      'REQUEST_PRINCIPAL_SCOPE_UNSUPPORTED',
      'Serve principal requests from the core copy that loaded first.',
    );
  }
  return owned.frames.run(
    Object.freeze({ record, tenancy: undefined, ceilings: new Map() }),
    fn,
  );
}

/**
 * Run one operation REST resolved itself (the route, a sync item, a nested
 * dispatch) in a new frame of the current record: its tenancy is bound and
 * its ceiling is its own resolution intersected with the enclosing frame's.
 * Internal: request code binds through {@link enterNonWidening}.
 */
export function runPrincipalOperationFrame<T>(
  t: RequestTenancy,
  fn: () => T,
): T {
  const owned = adopted.owned;
  const frame = owned?.frames.getStore();
  if (!owned || !frame) return fn();
  if (frame.record.state === 'ended') throw requestEnded();
  const key = familyKey(t);
  const ceilings = new Map(frame.ceilings);
  ceilings.set(key, intersect(ceilingOf(t), frame.ceilings.get(key)));
  return owned.frames.run(
    Object.freeze({ record: frame.record, tenancy: t, ceilings }),
    fn,
  );
}

/**
 * Bind `t` for `fn` inside a principal request without widening it (see the
 * module documentation); outside one, `undefined` (the caller binds as it
 * would without a principal).
 */
export function enterNonWidening<T>(
  t: RequestTenancy,
  fn: () => T,
): { result: T } | undefined {
  const shared = sharedScope();
  if (!shared?.read()) return undefined;
  return { result: shared.enterNonWidening(t, fn) };
}

/**
 * Enter `t` for the rest of the current principal request, after the same
 * check as {@link enterNonWidening}. Returns `false` outside one.
 */
export function enterNonWideningForRest(t: RequestTenancy): boolean {
  const owned = adopted.owned;
  const frame = currentPrincipalFrame();
  if (!frame) return false;
  if (frame.record.state === 'ended') throw requestEnded();
  if (!withinFrame(frame, t)) throw widening();
  if (!owned) {
    throw new RequestPrincipalScopeError(
      500,
      'REQUEST_PRINCIPAL_SCOPE_UNSUPPORTED',
      'Serve principal requests from the core copy that loaded first.',
    );
  }
  owned.frames.enter(
    Object.freeze({
      record: frame.record,
      tenancy: t,
      ceilings: frame.ceilings,
    }),
  );
  return true;
}
