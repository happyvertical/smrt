// Who is calling the engine (#5188). A principal is plain frozen JSON: the
// tenant it acts in, who it is (a user, a guest, or the engine itself) and the
// permission slugs it holds. Trusted host code builds one (`enginePrincipal`);
// every call into an app worker carries one, and the handle and the worker both
// refuse a call without a valid principal or one for another tenant.
//
// The fields mirror core's `APIRequestPrincipal` (#5588), which the worker
// hands to the generated REST server (`APIConfig.resolvePrincipal`) so core
// enforces sign-in and `<collection>.<action>` permissions itself.
//
// `kind: 'system'` is the engine's own authority (change-queue work, boot).
// Only engine code mints it, through `mintSystemPrincipal`, which `index.ts`
// does not export; `invariants.test.ts` fails if anything under `src/lib` or
// `src/routes` imports it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { NoPrincipalError, PermissionDeniedError } from './errors.ts';

/** The tenant of a host that was given none (tests, the portable export). */
export const DESKTOP_TENANT = 'desktop';

/**
 * The tenant of a PostgreSQL app made without one (tests, a local server). A
 * PostgreSQL app's rows carry their tenant in a UUID column, so its tenant is
 * a UUID, never `DESKTOP_TENANT`.
 */
export const LOCAL_TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The tenant an app of this database kind runs in: `given`, or the default of
 * its kind. A PostgreSQL app's tenant must be a lower-case UUID (the column
 * type its row-level-security policies compare, #5189).
 */
export function tenantFor(
  given: string | undefined,
  databaseKind: 'sqlite' | 'postgres' | 'pglite' | undefined,
): string {
  if (databaseKind === undefined || databaseKind === 'sqlite')
    return given ?? DESKTOP_TENANT;
  const tenant = given ?? LOCAL_TENANT;
  if (!TENANT_UUID.test(tenant))
    throw new PermissionDeniedError(
      'a PostgreSQL app needs a tenant id that is a lower-case UUID',
    );
  return tenant;
}

export type PrincipalKind = 'user' | 'guest' | 'system';

export interface EnginePrincipal {
  readonly kind: PrincipalKind;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly authenticated: boolean;
  readonly permissions: readonly string[];
  readonly allowCrossTenant: false;
  readonly superAdminBypass: false;
}

/** Core's bounds (`request-principal.ts`): ids, slug count, slug shape. */
const MAX_ID = 256;
const MAX_PERMISSIONS = 4096;
const SLUG = /^[A-Za-z0-9_*][A-Za-z0-9_.:*/@-]{0,255}$/u;
const KINDS: readonly string[] = ['user', 'guest', 'system'];

/** Principals built on this thread by `enginePrincipal` / `mintSystemPrincipal`. */
const minted = new WeakSet<object>();
const permissionSets = new WeakMap<object, ReadonlySet<string>>();

function id(name: string, v: unknown, optional = false): string | null {
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v !== 'string' || !v || v.length > MAX_ID)
    throw new NoPrincipalError(
      `principal.${name} must be a non-empty string of at most ${MAX_ID} characters`,
    );
  return v;
}

function slugs(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (
    typeof v === 'string' ||
    typeof (v as Iterable<unknown>)[Symbol.iterator] !== 'function'
  )
    throw new NoPrincipalError('principal.permissions must be a list of slugs');
  const out: string[] = [];
  for (const s of v as Iterable<unknown>) {
    if (typeof s !== 'string' || !SLUG.test(s))
      throw new NoPrincipalError('principal.permissions must hold slugs');
    out.push(s);
    if (out.length > MAX_PERMISSIONS)
      throw new NoPrincipalError('principal.permissions holds too many slugs');
  }
  return out;
}

function build(
  kind: PrincipalKind,
  tenantId: unknown,
  userId: unknown,
  permissions: unknown,
): EnginePrincipal {
  const tenant = id('tenantId', tenantId) as string;
  const user = id('userId', userId, true);
  if (kind === 'user' && !user)
    throw new NoPrincipalError('a user principal needs a userId');
  return Object.freeze({
    kind,
    tenantId: tenant,
    userId: user,
    authenticated: kind !== 'guest',
    permissions: Object.freeze(slugs(permissions)),
    allowCrossTenant: false as const,
    superAdminBypass: false as const,
  });
}

/**
 * A principal for a signed-in user or a guest, built by trusted host code from
 * a verified session. `system` cannot be requested here.
 */
export function enginePrincipal(input: {
  kind: 'user' | 'guest';
  tenantId: string;
  userId?: string | null;
  permissions?: Iterable<string>;
}): EnginePrincipal {
  if (input.kind !== 'user' && input.kind !== 'guest')
    throw new NoPrincipalError('only the engine can act as the system');
  const p = build(input.kind, input.tenantId, input.userId, input.permissions);
  minted.add(p);
  return p;
}

/** Engine code only (not exported from `index.ts`): the engine's own authority in a tenant. */
export function mintSystemPrincipal(tenantId: string): EnginePrincipal {
  const p = build('system', tenantId, null, []);
  minted.add(p);
  return p;
}

/** Built on this thread by this module and still frozen: not a look-alike. */
export function isEnginePrincipal(v: unknown): v is EnginePrincipal {
  return !!v && typeof v === 'object' && minted.has(v) && Object.isFrozen(v);
}

/**
 * Host side: the principal a call carries, or a refusal. It must have been
 * minted here and belong to `tenantId`.
 */
export function requirePrincipal(
  v: unknown,
  tenantId: string,
): EnginePrincipal {
  if (!isEnginePrincipal(v))
    throw new NoPrincipalError(
      'this call needs a principal built by enginePrincipal()',
    );
  if (v.tenantId !== tenantId)
    throw new PermissionDeniedError('this principal belongs to another tenant');
  return v;
}

/**
 * The one slug that marks an app's owner. It is independent of the app's
 * definition (which grows as the change queue runs, while a principal is
 * frozen), and granted only where trusted shell code builds an owner principal
 * (`principalFor`). `holds()` is true of it for the system.
 */
export const OWNER_SLUG = '_engine.owner';

/**
 * Host side, change-queue entry points (`execute`, `forkDraft`, `publishDraft`,
 * `restoreSnapshot`): `requirePrincipal`, and the principal must be the app's
 * owner or the engine itself. A guest or an ordinary member of the tenant is
 * refused, as is a missing, copied or foreign principal. The work inside runs
 * as the system principal on the owner lane, as before.
 */
export function requireOwnerPrincipal(
  v: unknown,
  tenantId: string,
): EnginePrincipal {
  const p = requirePrincipal(v, tenantId);
  if (p.kind === 'guest')
    throw new PermissionDeniedError('a guest cannot change the app');
  if (!holds(p, OWNER_SLUG))
    throw new PermissionDeniedError('only the app owner can change the app');
  return p;
}

/**
 * Worker side: read what arrived over the port. Structure and bounds are
 * checked and the tenant must be the app's; the result is a fresh frozen copy.
 */
export function readPrincipal(v: unknown, tenantId: string): EnginePrincipal {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new NoPrincipalError();
  const r = v as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind))
    throw new NoPrincipalError('principal.kind is not valid');
  const p = build(r.kind as PrincipalKind, r.tenantId, r.userId, r.permissions);
  if (r.allowCrossTenant !== false || r.superAdminBypass !== false)
    throw new NoPrincipalError('principal carries a cross-tenant grant');
  if (p.tenantId !== tenantId)
    throw new PermissionDeniedError('this principal belongs to another tenant');
  return p;
}

const permissionSet = (p: EnginePrincipal) => {
  const known = permissionSets.get(p);
  if (known) return known;
  const s = new Set(p.permissions);
  permissionSets.set(p, s);
  return s;
};

/** Whether `p` holds `slug`. The system holds every one. */
export function holds(p: EnginePrincipal, slug: string): boolean {
  return p.kind === 'system' || permissionSet(p).has(slug);
}

// ---------- the worker's op scope ----------

/** The principal of the operation the worker is running (set by the handler). */
const opScope = new AsyncLocalStorage<EnginePrincipal>();

export const runAsPrincipal = <T>(p: EnginePrincipal, fn: () => T): T =>
  opScope.run(p, fn);

/** The principal of the running operation, or a refusal outside one. */
export function currentOpPrincipal(): EnginePrincipal {
  const p = opScope.getStore();
  if (!p) throw new NoPrincipalError('no operation is running for a caller');
  return p;
}
