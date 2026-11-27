/**
 * Route parity (#5195): the runtime REST handler and the generated SvelteKit
 * routes answer the same request from the same caller identically.
 *
 * Every case below is sent twice, over the same models and the same SQLite
 * rows: once to `APIGenerator.generateHandler()` with the caller from
 * `resolvePrincipal`, once to the emitted `+server.ts` modules with the same
 * caller on `event.locals`. The two answers must agree on status, error code,
 * error message, the body and the CORS headers. A change to either path that
 * moves one answer without the other fails here.
 *
 * Where the paths cannot agree today the difference is named in
 * {@link DIVERGENCES}, with the reason. The list is closed in both directions:
 * a case it covers must still differ (so a fixed divergence cannot linger as a
 * stale entry), and a difference it does not cover fails the case.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  type Outcome,
  PARITY_PACKAGE,
  ParityFixture,
  type ParityPrincipal,
  type ParityRequest,
  SEED,
  TENANT_A,
  TENANT_B,
} from '../__tests__/fixtures/route-parity-harness.js';
import {
  installTestTenancySource,
  removeTestTenancySource,
} from '../__tests__/fixtures/test-tenancy-source.js';
import { setDispatchTenantResolver } from '../dispatch/index.js';
import { configureRouteLimits } from './route-limits.js';

// The routes import the app's own modules by names that are not packages
// (`$lib/...`, the models' package). They are answered by the temporary
// project the fixture scans and generates; core and SvelteKit are packages in
// that project (see the harness).
const projectModule = async (file: string) =>
  (
    await import('../__tests__/fixtures/route-parity-harness.js')
  ).importFromProject(file);
vi.mock('@fixture/parity-app', () => projectModule('src/objects.ts'));
vi.mock('$lib/server/smrt', () => projectModule('src/lib/server/smrt.ts'));
vi.mock('$lib/server/smrt-register', () =>
  projectModule('src/lib/server/smrt-register.ts'),
);

/** The STI selector of the private subtype (its registry key). */
const TRUCK = `${PARITY_PACKAGE}:ParityTruck`;

const ALLOWED_ORIGIN = 'https://app.example.com';
const OTHER_ORIGIN = 'https://evil.example.net';

let fx: ParityFixture;
/** Route segment of each model's collection. */
let segment: Record<
  'note' | 'bypass' | 'readable' | 'open' | 'vehicle' | 'truck',
  string
>;

beforeAll(async () => {
  fx = await ParityFixture.create({
    allowedOrigins: [ALLOWED_ORIGIN],
    allowCredentials: true,
  });
  installTestTenancySource();
  setDispatchTenantResolver(() => undefined);
  // The generated registration, run as an app's server start would.
  await projectModule('src/lib/server/smrt-register.ts');
  segment = {
    note: fx.collectionSegment('ParityNote'),
    bypass: fx.collectionSegment('ParityBypass'),
    readable: fx.collectionSegment('ParityReadable'),
    open: fx.collectionSegment('ParityOpen'),
    vehicle: fx.collectionSegment('ParityVehicle'),
    truck: fx.collectionSegment('ParityTruck'),
  };
}, 60_000);

afterAll(() => {
  fx?.dispose();
  removeTestTenancySource();
  setDispatchTenantResolver(undefined);
});

// ─── Principals ─────────────────────────────────────────────────────────────

const writes = (
  s: typeof segment,
  models: Array<keyof typeof segment> = ['note', 'bypass', 'readable', 'open'],
): string[] =>
  models.flatMap((model) =>
    ['create', 'update', 'delete'].map((action) => `${s[model]}.${action}`),
  );

/** A signed-in caller in tenant A, in both spellings. */
function signedIn(
  permissions: string[] | undefined,
  locals: Record<string, unknown> = {},
  rest: Partial<ParityPrincipal['rest']> = {},
): ParityPrincipal {
  return {
    rest: {
      tenantId: TENANT_A,
      allowCrossTenant: false,
      authenticated: true,
      userId: 'user-a',
      ...(permissions ? { permissions } : {}),
      ...rest,
    },
    locals: {
      user: { id: 'user-a', tenantId: TENANT_A },
      ...(permissions ? { permissions } : {}),
      ...locals,
    },
  };
}

function principals(): Record<string, ParityPrincipal> {
  const all = [
    ...writes(segment),
    ...writes(segment, ['vehicle', 'truck']),
    `${segment.note}.archive`,
    `${segment.note}.touch`,
  ];
  return {
    anonymous: {
      rest: { tenantId: null, allowCrossTenant: false, authenticated: false },
      locals: {},
    },
    // Signed in, holding nothing: the case the issue's acceptance names.
    signedInNoPermissions: signedIn([]),
    // Signed in, the host supplied no permission set at all.
    signedInNoPermissionSet: signedIn(undefined),
    writer: signedIn(all),
    createOnly: signedIn([`${segment.note}.create`]),
    // May write the STI base, not its private subtype.
    baseOnlyWriter: signedIn(writes(segment, ['vehicle'])),
    // A verified super-admin: no permission slugs, bypass on opt-in models.
    superAdmin: signedIn(
      [],
      {
        tenantContext: { tenantId: TENANT_A, superAdminBypass: true },
      },
      { superAdminBypass: true },
    ),
    // The same permissions, supplied through each other `locals` source.
    writerViaPermissionSet: signedIn(all, {
      permissions: undefined,
      permissionSet: all,
    }),
    writerViaSmrtPermissions: signedIn(all, {
      permissions: undefined,
      smrtPermissions: all,
    }),
    writerViaTenantContext: signedIn(all, {
      permissions: undefined,
      tenantContext: { tenantId: TENANT_A, permissions: all },
    }),
    // An operator the host marks cross-tenant. Only REST can be told: `locals`
    // has no cross-tenant marker, so the generated routes see a plain caller.
    operator: {
      rest: {
        tenantId: null,
        allowCrossTenant: true,
        authenticated: true,
        userId: 'operator',
        permissions: all,
      },
      locals: { user: { id: 'operator' }, permissions: all },
    },
    // An empty list is a defined source: it wins over a later one and grants
    // nothing, the way REST's single `permissions` does.
    emptyListBeatsLaterSources: signedIn([], {
      permissionSet: all,
      smrtPermissions: all,
    }),
  };
}

/** Every principal above, by name (the matrix is declared before they exist). */
const PRINCIPAL_NAMES = [
  'anonymous',
  'signedInNoPermissions',
  'signedInNoPermissionSet',
  'writer',
  'createOnly',
  'baseOnlyWriter',
  'superAdmin',
  'writerViaPermissionSet',
  'writerViaSmrtPermissions',
  'writerViaTenantContext',
  'emptyListBeatsLaterSources',
];

// ─── Comparison ─────────────────────────────────────────────────────────────

const SEEDED_IDS = new Set<string>([
  TENANT_A,
  TENANT_B,
  ...Object.values(SEED).flatMap((rows) => Object.values(rows)),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOLATILE = new Set([
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
]);

/** A body without what differs per run: timestamps, and the ids a create mints. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) {
    const rows = value.map(scrub);
    // Rows created in one millisecond have no defined order on either path, so
    // a list of rows is compared by id.
    return rows.every((row) => row && typeof row === 'object' && 'id' in row)
      ? [...rows].sort((a, b) =>
          String((a as { id: unknown }).id).localeCompare(
            String((b as { id: unknown }).id),
          ),
        )
      : rows;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE.has(key)) continue;
      out[key] = scrub(entry);
    }
    return out;
  }
  if (typeof value === 'string' && UUID.test(value) && !SEEDED_IDS.has(value)) {
    return '<minted-id>';
  }
  return value;
}

/**
 * What an answer is compared on: the status, the error code, the whole scrubbed
 * body (a refusal's `details`, `ok` and `status` included), and the CORS
 * headers. Only a listed divergence may reduce the body first.
 */
function project(outcome: Outcome): unknown {
  const refused = outcome.status >= 400;
  return {
    status: outcome.status,
    ...(refused ? { code: outcome.code ?? null } : {}),
    body: scrub(outcome.body),
    ...(outcome.retryAfter ? { retryAfter: 'present' } : {}),
    cors: Object.fromEntries(
      Object.entries(outcome.cors).filter(([, header]) => header !== null),
    ),
  };
}

interface Case {
  /** What the case does, for the failure message. */
  label: string;
  /** The operation, for divergences: `list`, `delete`, ... */
  op: string;
  principal: string;
  request: ParityRequest;
}

interface Divergence {
  id: string;
  /** Why the two paths cannot agree here today. */
  reason: string;
  /** Whether this divergence is expected for the case and its two answers. */
  applies(c: Case, rest: Outcome, kit: Outcome): boolean;
  /**
   * Reduce both answers to what they must still share (the same envelope with
   * the known difference removed); the reduced answers must then be equal.
   */
  normalize?(outcome: Outcome): Outcome;
  /** Or state what the two answers must still share, when they differ wholly. */
  shared?(rest: Outcome, kit: Outcome, c: Case): boolean;
}

/** Callers holding every write permission, `<collection>.touch` included. */
const HOLDS_ALL = new Set([
  'writer',
  'writerViaPermissionSet',
  'writerViaSmrtPermissions',
  'writerViaTenantContext',
  'operator',
]);

/**
 * A route only the generated paths serve still decides as the shared rule
 * does: unsigned 401 `AUTHENTICATION_REQUIRED`; a write without
 * `<collection>.<action>` 403 `PERMISSION_DENIED` (a read needs only
 * sign-in); otherwise served (200).
 */
function servedLikeAction(kit: Outcome, c: Case): boolean {
  const write = c.request.method !== 'GET';
  if (c.principal === 'anonymous') {
    return kit.status === 401 && kit.code === 'AUTHENTICATION_REQUIRED';
  }
  if (write && !HOLDS_ALL.has(c.principal)) {
    return kit.status === 403 && kit.code === 'PERMISSION_DENIED';
  }
  return kit.status === 200;
}

/**
 * Every place the two paths legitimately differ. A divergence is expected, and
 * required, wherever `applies` says so: the case fails if the answers have
 * become identical (the entry is stale), and fails if they differ in more than
 * `normalize` accounts for (a new divergence).
 */
const DIVERGENCES: Divergence[] = [
  {
    id: 'list-envelope',
    reason:
      'REST answers a list with the bare array; the generated route wraps it as { items, count, limit, offset }. Both are published contracts of their paths.',
    applies: (c, rest, kit) =>
      c.op === 'list' && rest.status === 200 && kit.status === 200,
    normalize: (outcome) => ({
      ...outcome,
      body: Array.isArray(outcome.body)
        ? outcome.body
        : (outcome.body as { items: unknown }).items,
    }),
  },
  {
    id: 'delete-success',
    reason:
      'REST answers a delete with 204 and no body; the generated route with 200 { success: true }. Both are published contracts of their paths.',
    applies: (c, rest, kit) =>
      c.op === 'delete' && rest.status === 204 && kit.status === 200,
    normalize: (outcome) => ({ ...outcome, status: 204, body: null }),
  },
  {
    id: 'cross-tenant-filter',
    reason:
      'A principal marked allowCrossTenant reads across tenants on REST and may select one with a query filter. `event.locals` has no cross-tenant marker, so the generated routes cannot be told: they see a user with no tenant, who reads global rows only, and strip the filter.',
    applies: (c, rest, kit) =>
      c.op === 'cross-tenant-list' && rest.status === 200 && kit.status === 200,
    normalize: (outcome) => ({ ...outcome, body: null }),
  },
  {
    id: 'thrown-error-envelope',
    reason:
      'A refusal the generated route throws with SvelteKit error() is the body { message, code }; REST answers { error: { code, message, ok, status } }. They carry the same code and message; a typed error either path returns (validation, with details) is the same envelope on both and is compared whole.',
    applies: (_c, rest, kit) => {
      const body = kit.body as Record<string, unknown> | null;
      return (
        rest.status >= 400 &&
        kit.status >= 400 &&
        !!rest.code &&
        !!body &&
        typeof body === 'object' &&
        !('error' in body)
      );
    },
    normalize: (outcome) => {
      const body = outcome.body as Record<string, unknown>;
      const inner = (body.error ?? body) as Record<string, unknown>;
      return {
        ...outcome,
        body: { code: inner.code ?? null, message: inner.message ?? null },
      };
    },
  },
  {
    id: 'item-scope-action',
    reason:
      'REST has no item-scope custom actions: /<collection>/<id>/<action> is not a route there (404, and never the shorter route). The generated routes serve it, deciding by the same permission rule.',
    applies: (c) => c.op === 'item-scope',
    shared: (rest, kit, c) => rest.status === 404 && servedLikeAction(kit, c),
  },
  {
    id: 'multi-segment-action',
    reason:
      'REST has no multi-segment custom action paths: /<collection>/reports/monthly is not a route there (404). The generated routes serve it.',
    applies: (c) => c.op === 'multi-segment',
    shared: (rest, kit, c) => rest.status === 404 && servedLikeAction(kit, c),
  },
  {
    id: 'not-found-message',
    reason:
      'A missing row is 404 with no code on both paths, but the message differs: REST says "Object not found", the generated route names the model.',
    applies: (_c, rest, kit) =>
      rest.status === 404 && kit.status === 404 && !rest.code && !kit.code,
    normalize: (outcome) => ({ ...outcome, body: { message: 'not found' } }),
  },
];

async function compare(
  c: Case,
  mismatches: Map<string, number>,
): Promise<string | undefined> {
  const principal = principals()[c.principal];
  const rest = await fx.run('rest', principal, c.request);
  const kit = await fx.run('kit', principal, c.request);
  const restView = project(rest);
  const kitView = project(kit);
  const divergence = DIVERGENCES.find((d) => d.applies(c, rest, kit));
  const where = `${c.principal}: ${c.label}`;
  const show = (value: unknown) => JSON.stringify(value);
  if (!divergence) {
    return JSON.stringify(restView) === JSON.stringify(kitView)
      ? undefined
      : `${where}\n  rest ${show(restView)} ${show(rest.body).slice(0, 160)}\n  kit  ${show(kitView)} ${show(kit.body).slice(0, 160)}`;
  }
  mismatches.set(divergence.id, (mismatches.get(divergence.id) ?? 0) + 1);
  if (JSON.stringify(restView) === JSON.stringify(kitView)) {
    return `${where}: divergence "${divergence.id}" is listed but the answers agree; remove it`;
  }
  if (divergence.shared) {
    return divergence.shared(rest, kit, c)
      ? undefined
      : `${where}: differs beyond "${divergence.id}"\n  rest ${show(restView)}\n  kit  ${show(kitView)}`;
  }
  const normalize = divergence.normalize ?? ((outcome: Outcome) => outcome);
  const a = JSON.stringify(project(normalize(rest)));
  const b = JSON.stringify(project(normalize(kit)));
  return a === b
    ? undefined
    : `${where}: differs beyond "${divergence.id}"\n  rest ${a}\n  kit  ${b}`;
}

async function expectParity(cases: Case[]): Promise<void> {
  const failures: string[] = [];
  for (const c of cases) {
    const failure = await compare(c, new Map());
    if (failure) failures.push(failure);
  }
  expect(failures).toEqual([]);
}

// ─── Requests ───────────────────────────────────────────────────────────────

const ids = {
  note: SEED.note,
  bypass: SEED.bypass,
} as const;

/** CRUD against one model, for one principal. */
function crud(
  principal: string,
  model: 'note' | 'bypass' | 'readable' | 'open',
): Case[] {
  const s = segment[model];
  const own =
    model === 'note'
      ? SEED.note.own
      : model === 'bypass'
        ? SEED.bypass.own
        : model === 'readable'
          ? SEED.readable.row
          : SEED.open.row;
  const tenanted = model === 'note' || model === 'bypass';
  const other = model === 'note' ? SEED.note.other : SEED.bypass.other;
  const mk = (op: string, label: string, request: ParityRequest): Case => ({
    op,
    label: `${model} ${label}`,
    principal,
    request,
  });
  return [
    mk('list', 'list', { method: 'GET', path: s }),
    mk('get', 'get', { method: 'GET', path: `${s}/${own}` }),
    mk('create', 'create', {
      method: 'POST',
      path: s,
      body: { title: 'created' },
    }),
    mk('update', 'update', {
      method: 'PUT',
      path: `${s}/${own}`,
      body: { title: 'updated' },
    }),
    mk('delete', 'delete', { method: 'DELETE', path: `${s}/${own}` }),
    mk('get', 'get unknown id', {
      method: 'GET',
      path: `${s}/c0000000-0000-4000-8000-0000000000ff`,
    }),
    ...(tenanted
      ? [
          mk('get', "get another tenant's row", {
            method: 'GET',
            path: `${s}/${other}`,
          }),
          mk('update', "update another tenant's row", {
            method: 'PUT',
            path: `${s}/${other}`,
            body: { title: 'taken' },
          }),
          mk('delete', "delete another tenant's row", {
            method: 'DELETE',
            path: `${s}/${other}`,
          }),
          mk('create', 'create naming another tenant', {
            method: 'POST',
            path: s,
            body: { title: 'x', tenantId: TENANT_B },
          }),
          mk('create', 'create naming its own tenant', {
            method: 'POST',
            path: s,
            body: { title: 'x', tenantId: TENANT_A },
          }),
          mk('update', 'update naming another tenant', {
            method: 'PUT',
            path: `${s}/${own}`,
            body: { title: 'x', tenantId: TENANT_B },
          }),
          mk('list', 'list filtered to another tenant', {
            method: 'GET',
            path: `${s}?tenantId=${TENANT_B}`,
          }),
          mk('list', 'list filtered to another tenant (column spelling)', {
            method: 'GET',
            path: `${s}?tenant_id=${TENANT_B}`,
          }),
        ]
      : []),
  ];
}

// ─── The matrix ─────────────────────────────────────────────────────────────

describe('route parity: CRUD', () => {
  const models = ['note', 'bypass', 'readable', 'open'] as const;
  for (const model of models) {
    it.each(PRINCIPAL_NAMES)(`${model}: %s`, (principal) =>
      expectParity(crud(principal, model)));
  }
});

describe('route parity: an STI subtype through its base (#5195)', () => {
  const v = () => segment.vehicle;
  const cases = (principal: string): Case[] => [
    {
      op: 'create',
      label: 'create the base through the base',
      principal,
      request: { method: 'POST', path: v(), body: { title: 'car' } },
    },
    {
      op: 'create',
      label: 'create the subtype through the base',
      principal,
      request: {
        method: 'POST',
        path: v(),
        body: { title: 'lorry', createType: TRUCK },
      },
    },
    {
      op: 'create',
      label: 'create the subtype through the base, naming another tenant',
      principal,
      request: {
        method: 'POST',
        path: v(),
        body: {
          title: 'lorry',
          createType: TRUCK,
          tenantId: TENANT_B,
        },
      },
    },
    {
      op: 'update',
      label: "update a subtype's row through the base",
      principal,
      request: {
        method: 'PUT',
        path: `${v()}/${SEED.vehicle.truck}`,
        body: { title: 'moved' },
      },
    },
    {
      op: 'update',
      label: "update a subtype's row through the base, naming another tenant",
      principal,
      request: {
        method: 'PUT',
        path: `${v()}/${SEED.vehicle.truck}`,
        body: { title: 'moved', tenantId: TENANT_B },
      },
    },
    {
      op: 'update',
      label: "update the base's row through the base",
      principal,
      request: {
        method: 'PUT',
        path: `${v()}/${SEED.vehicle.own}`,
        body: { title: 'moved' },
      },
    },
    {
      op: 'delete',
      label: "delete a subtype's row through the base",
      principal,
      request: { method: 'DELETE', path: `${v()}/${SEED.vehicle.truck}` },
    },
    {
      op: 'delete',
      label: "delete the base's row through the base",
      principal,
      request: { method: 'DELETE', path: `${v()}/${SEED.vehicle.own}` },
    },
  ];
  it.each(PRINCIPAL_NAMES)('%s', (principal) => expectParity(cases(principal)));

  // Both paths could agree on a wrong answer, so the subtype's own policy is
  // pinned: the base is public, the subtype is not, and a permission for the
  // base is not a permission for the subtype.
  it('decides a write under the subtype, not the base', async () => {
    const answers = async (principal: string, request: ParityRequest) => {
      const p = principals()[principal];
      return {
        rest: await fx.run('rest', p, request),
        kit: await fx.run('kit', p, request),
      };
    };
    const createTruck: ParityRequest = {
      method: 'POST',
      path: v(),
      body: { title: 'lorry', createType: TRUCK },
    };
    const deleteTruck: ParityRequest = {
      method: 'DELETE',
      path: `${v()}/${SEED.vehicle.truck}`,
    };
    const updateTruck: ParityRequest = {
      method: 'PUT',
      path: `${v()}/${SEED.vehicle.truck}`,
      body: { title: 'moved' },
    };
    const updateTruckForeignTenant: ParityRequest = {
      method: 'PUT',
      path: `${v()}/${SEED.vehicle.truck}`,
      body: { title: 'moved', tenantId: TENANT_B },
    };
    const createCar: ParityRequest = {
      method: 'POST',
      path: v(),
      body: { title: 'car' },
    };
    for (const transport of ['rest', 'kit'] as const) {
      // The base is public: a signed-in caller holding nothing may create it.
      const car = await answers('signedInNoPermissions', createCar);
      expect(car[transport].status, `${transport}: public base`).toBe(201);
      // The subtype is not: the same caller is refused its own permission.
      const truck = await answers('signedInNoPermissions', createTruck);
      expect(truck[transport].status, `${transport}: private subtype`).toBe(
        403,
      );
      expect(truck[transport].code).toBe('PERMISSION_DENIED');
      const anonymous = await answers('anonymous', createTruck);
      expect(anonymous[transport].status, `${transport}: anonymous`).toBe(401);
      // The base's update/delete grants are not the subtype's: the row's own
      // model decides, so a row of the subtype read through the base is 403.
      for (const request of [createTruck, deleteTruck, updateTruck]) {
        const baseOnly = await answers('baseOnlyWriter', request);
        expect(baseOnly[transport].status, `${transport}: base-only`).toBe(403);
        expect(baseOnly[transport].code).toBe('PERMISSION_DENIED');
        const writer = await answers('writer', request);
        expect([200, 201, 204], `${transport}: writer`).toContain(
          writer[transport].status,
        );
      }
    }
    for (const transport of ['rest', 'kit'] as const) {
      const mismatch = await answers('writer', updateTruckForeignTenant);
      expect(mismatch[transport].status, `${transport}: foreign tenant`).toBe(
        403,
      );
      expect(mismatch[transport].code).toBe('TENANT_MISMATCH');
    }
  });
});

describe('route parity: a cross-tenant principal', () => {
  it('the principal list is complete', () => {
    expect(Object.keys(principals()).sort()).toEqual(
      [...PRINCIPAL_NAMES, 'operator'].sort(),
    );
  });

  const cases = (model: 'note' | 'bypass'): Case[] =>
    [`tenantId=${TENANT_B}`, `tenant_id=${TENANT_B}`, ''].map((query) => ({
      op: 'cross-tenant-list',
      label: `${model} list ${query || 'unfiltered'}`,
      principal: 'operator',
      request: {
        method: 'GET',
        path: `${segment[model]}${query ? `?${query}` : ''}`,
      },
    }));
  it.each(['note', 'bypass'] as const)('%s', (model) =>
    expectParity(cases(model)));
});

describe('route parity: custom actions', () => {
  const s = () => segment.note;
  const actions = (principal: string): Case[] => [
    {
      op: 'archive',
      label: 'collection-scope POST action',
      principal,
      request: { method: 'POST', path: `${s()}/archive`, body: {} },
    },
    {
      op: 'tally',
      label: 'collection-scope GET action',
      principal,
      request: { method: 'GET', path: `${s()}/tally` },
    },
  ];
  it.each(PRINCIPAL_NAMES)('%s', (principal) =>
    expectParity(actions(principal)));

  // Only the generated routes serve these (see DIVERGENCES): the permitted
  // caller gets the action there, and REST answers 404 to everyone.
  const generatedOnly = (principal: string): Case[] => [
    {
      op: 'item-scope',
      label: 'item-scope POST action',
      principal,
      request: {
        method: 'POST',
        path: `${s()}/${SEED.note.own}/touch`,
        body: {},
      },
    },
    {
      op: 'multi-segment',
      label: 'multi-segment GET action path',
      principal,
      request: { method: 'GET', path: `${s()}/reports/monthly` },
    },
  ];
  it.each(PRINCIPAL_NAMES)('generated-only actions: %s', (principal) =>
    expectParity(generatedOnly(principal)));
  it('the generated routes serve a permitted caller what REST does not', async () => {
    const writer = principals().writer;
    for (const c of generatedOnly('writer')) {
      expect((await fx.run('kit', writer, c.request)).status, c.label).toBe(
        200,
      );
      expect((await fx.run('rest', writer, c.request)).status, c.label).toBe(
        404,
      );
    }
  });
});

describe('route parity: protected fields (#5604)', () => {
  const s = () => segment.note;
  const cases = (principal: string): Case[] => [
    {
      op: 'update',
      label: 'update a field outside api.writable',
      principal,
      request: {
        method: 'PUT',
        path: `${s()}/${SEED.note.own}`,
        body: { title: 'new', secret: 'changed' },
      },
    },
    {
      op: 'update',
      label: 'send a protected field back unchanged',
      principal,
      request: {
        method: 'PUT',
        path: `${s()}/${SEED.note.own}`,
        body: { title: 'new', secret: 's-own' },
      },
    },
    {
      op: 'update',
      label: 'update a server-managed field',
      principal,
      request: {
        method: 'PUT',
        path: `${s()}/${SEED.note.own}`,
        body: { title: 'new', id: 'c0000000-0000-4000-8000-0000000000aa' },
      },
    },
    {
      op: 'update',
      label: 'update an underscore-prefixed field',
      principal,
      request: {
        method: 'PUT',
        path: `${s()}/${SEED.note.own}`,
        body: { title: 'new', _meta_type: 'forged' },
      },
    },
    {
      op: 'create',
      label: 'create with a protected field',
      principal,
      request: {
        method: 'POST',
        path: s(),
        body: { title: 'new', secret: 'planted' },
      },
    },
    {
      op: 'create',
      label: 'create with an undeclared field',
      principal,
      request: { method: 'POST', path: s(), body: { title: 'x', bogus: 1 } },
    },
  ];
  // A caller who may write refuses the field; one who may not is refused first.
  it.each([
    'writer',
    'signedInNoPermissions',
    'anonymous',
    'superAdmin',
  ])('%s', (principal) => expectParity(cases(principal)));
});

describe('route parity: a protected-field refusal names the field on both paths', () => {
  it.each(['update', 'create'] as const)('%s', async (op) => {
    const request: ParityRequest =
      op === 'update'
        ? {
            method: 'PUT',
            path: `${segment.note}/${SEED.note.own}`,
            body: { secret: 'changed' },
          }
        : {
            method: 'POST',
            path: segment.note,
            body: { title: 'x', secret: 'planted' },
          };
    for (const transport of ['rest', 'kit'] as const) {
      const answer = await fx.run(transport, principals().writer, request);
      expect(answer.status, transport).toBe(400);
      expect(
        (answer.body as { error: { details: unknown } }).error.details,
        transport,
      ).toEqual({ field: 'secret' });
    }
  });
});

describe('route parity: the feed routes (#5195)', () => {
  const origin = (value: string): Record<string, string> => ({ origin: value });
  // The feeds are never public, so an unsigned read is refused before anything
  // is read; `_events` is a live stream, so nothing it would stream is
  // compared. Signed-in callers are compared on the preflight alone.
  const cases = (principal: string): Case[] =>
    (
      [
        ['an allowed origin', origin(ALLOWED_ORIGIN)],
        ['a disallowed origin', origin(OTHER_ORIGIN)],
        ['no origin', {}],
      ] as const
    ).flatMap(([name, headers]) => [
      ...(principal === 'anonymous'
        ? (['_events', '_changes'] as const).map((path) => ({
            op: 'feed-read',
            label: `${path} read from ${name}`,
            principal,
            request: { method: 'GET', path, headers: { ...headers } },
          }))
        : []),
      ...(['_events', '_changes'] as const).map((path) => ({
        op: 'preflight',
        label: `${path} preflight from ${name}`,
        principal,
        request: {
          method: 'OPTIONS',
          path,
          headers: {
            ...headers,
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'last-event-id',
          },
        },
      })),
    ]) as Case[];
  it.each(['anonymous', 'signedInNoPermissions', 'writer'])('%s', (principal) =>
    expectParity(cases(principal)));

  it('answers an unsigned caller 401 AUTHENTICATION_REQUIRED, with CORS headers', async () => {
    for (const path of ['_events', '_changes']) {
      for (const transport of ['rest', 'kit'] as const) {
        const answer = await fx.run(transport, principals().anonymous, {
          method: 'GET',
          path,
          headers: origin(ALLOWED_ORIGIN),
        });
        expect(answer.status, `${transport} ${path}`).toBe(401);
        expect(answer.code, `${transport} ${path}`).toBe(
          'AUTHENTICATION_REQUIRED',
        );
        expect(answer.cors['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
        expect(answer.cors.vary).toBe('Origin');
      }
    }
  });
});

describe('route parity: sync/apply', () => {
  const batch = (): ParityRequest => ({
    method: 'POST',
    path: 'sync/apply',
    body: {
      items: [
        {
          itemId: 'create-note',
          object: segment.note,
          op: 'create',
          id: 'c0000000-0000-4000-8000-0000000000a1',
          payload: { title: 'synced' },
        },
        {
          itemId: 'update-note',
          object: segment.note,
          op: 'update',
          id: SEED.note.own,
          payload: { title: 'synced update' },
        },
        {
          itemId: 'delete-note',
          object: segment.note,
          op: 'delete',
          id: SEED.note.own,
        },
        {
          itemId: 'create-note-other-tenant',
          object: segment.note,
          op: 'create',
          id: 'c0000000-0000-4000-8000-0000000000a2',
          payload: { title: 'x', tenantId: TENANT_B },
        },
        {
          itemId: 'create-bypass',
          object: segment.bypass,
          op: 'create',
          id: 'd0000000-0000-4000-8000-0000000000a1',
          payload: { title: 'x' },
        },
        {
          itemId: 'create-readable',
          object: segment.readable,
          op: 'create',
          id: 'e0000000-0000-4000-8000-0000000000a1',
          payload: { title: 'x' },
        },
        {
          itemId: 'create-open',
          object: segment.open,
          op: 'create',
          id: 'f0000000-0000-4000-8000-0000000000a1',
          payload: { title: 'x' },
        },
        {
          itemId: 'protected-field',
          object: segment.note,
          op: 'create',
          id: 'c0000000-0000-4000-8000-0000000000a3',
          payload: { title: 'x', secret: 'planted' },
        },
        {
          itemId: 'unknown-object',
          object: 'nonesuch',
          op: 'create',
          id: 'c0000000-0000-4000-8000-0000000000a4',
          payload: {},
        },
      ],
    },
  });
  it.each(PRINCIPAL_NAMES)('%s', (principal) =>
    expectParity([
      {
        op: 'sync',
        label: 'a batch of permitted and forbidden items',
        principal,
        request: batch(),
      },
      {
        op: 'sync',
        label: 'a batch of one forbidden item',
        principal,
        request: {
          method: 'POST',
          path: 'sync/apply',
          body: {
            items: [
              {
                itemId: 'only',
                object: segment.note,
                op: 'delete',
                id: SEED.note.own,
              },
            ],
          },
        },
      },
    ]));
});

describe('route parity: CORS', () => {
  const origin = (value: string): Record<string, string> => ({ origin: value });
  const cases = (principal: string): Case[] =>
    [
      ['an allowed origin', origin(ALLOWED_ORIGIN)],
      ['a disallowed origin', origin(OTHER_ORIGIN)],
      ['no origin', {}],
    ].flatMap(([name, headers]) => [
      {
        op: 'list',
        label: `open list from ${name as string}`,
        principal,
        request: {
          method: 'GET',
          path: segment.open,
          headers: headers as Record<string, string>,
        },
      },
      {
        op: 'list',
        label: `private list from ${name as string}`,
        principal,
        request: {
          method: 'GET',
          path: segment.note,
          headers: headers as Record<string, string>,
        },
      },
      {
        op: 'create',
        label: `create from ${name as string}`,
        principal,
        request: {
          method: 'POST',
          path: segment.note,
          headers: headers as Record<string, string>,
          body: { title: 'x' },
        },
      },
      {
        op: 'preflight',
        label: `preflight from ${name as string}`,
        principal,
        request: {
          method: 'OPTIONS',
          path: segment.note,
          headers: {
            ...(headers as Record<string, string>),
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
          },
        },
      },
      {
        op: 'preflight',
        label: `item preflight from ${name as string}`,
        principal,
        request: {
          method: 'OPTIONS',
          path: `${segment.note}/${SEED.note.own}`,
          headers: {
            ...(headers as Record<string, string>),
            'access-control-request-method': 'DELETE',
          },
        },
      },
    ]) as Case[];
  it.each(['anonymous', 'signedInNoPermissions', 'writer'])('%s', (principal) =>
    expectParity(cases(principal)));

  it('echoes only the allowed origin, with credentials', async () => {
    const rest = await fx.run('rest', principals().writer, {
      method: 'GET',
      path: segment.open,
      headers: origin(ALLOWED_ORIGIN),
    });
    expect(rest.cors['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(rest.cors['access-control-allow-credentials']).toBe('true');
    const refused = await fx.run('rest', principals().writer, {
      method: 'GET',
      path: segment.open,
      headers: origin(OTHER_ORIGIN),
    });
    expect(refused.cors['access-control-allow-origin']).toBeNull();
  });
});

describe('route parity: route limits (#5198)', () => {
  afterEach(() => configureRouteLimits(undefined));

  const LIST = (): ParityRequest => ({ method: 'GET', path: segment.note });
  const limits = (maxEvents: number, tenantMaxEvents?: number) => ({
    client: { maxEvents, windowMs: 60_000 },
    ...(tenantMaxEvents
      ? { tenant: { maxEvents: tenantMaxEvents, windowMs: 60_000 } }
      : {}),
  });

  /** The answers of `n` requests, in order, over a fresh limiter. */
  async function drive(
    transport: 'rest' | 'kit',
    who: ParityPrincipal[],
    request: ParityRequest,
    config: ReturnType<typeof limits>,
  ): Promise<Outcome[]> {
    configureRouteLimits(config);
    const answers: Outcome[] = [];
    for (const principal of who) {
      answers.push(await fx.run(transport, principal, request));
    }
    return answers;
  }

  /** Both paths answer the same sequence the same way; returns it. */
  async function expectSameSequence(
    who: ParityPrincipal[],
    request: ParityRequest,
    config: ReturnType<typeof limits>,
  ): Promise<Outcome[]> {
    const rest = await drive('rest', who, request, config);
    const kit = await drive('kit', who, request, config);
    // A list answers in its own envelope; the limit's answer is the contract.
    const limited = (answers: Outcome[]) =>
      answers.map((answer) =>
        answer.status === 429 ? project(answer) : answer.status,
      );
    expect(limited(kit)).toEqual(limited(rest));
    return rest;
  }

  it('answers 429 with Retry-After once a caller is over its limit', async () => {
    const writer = principals().writer;
    const answers = await expectSameSequence(
      [writer, writer, writer],
      LIST(),
      limits(2),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 429]);
    expect(answers[2].code).toBe('too_many_requests');
    expect(Number(answers[2].retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(answers[2].retryAfter)).toBeLessThanOrEqual(60);
  });

  it('refuses before authorization: an unsigned caller over its limit is 429, not 401', async () => {
    const anonymous = principals().anonymous;
    const answers = await expectSameSequence(
      [anonymous, anonymous, anonymous],
      { method: 'POST', path: segment.note, body: { name: 'x' } },
      limits(2),
    );
    expect(answers.map((a) => a.status)).toEqual([401, 401, 429]);
  });

  it('counts per tenant and per caller', async () => {
    const a1 = principals().writer;
    const a2 = signedIn(
      a1.rest.permissions as string[],
      { user: { id: 'user-a2', tenantId: TENANT_A } },
      { userId: 'user-a2' },
    );
    const b = signedIn(
      a1.rest.permissions as string[],
      { user: { id: 'user-b', tenantId: TENANT_B } },
      { userId: 'user-b', tenantId: TENANT_B },
    );
    // Two callers of tenant A fill its tenant-wide limit of 3; tenant B has
    // its own, and a caller's own limit (2) is counted apart from the tenant's.
    const answers = await expectSameSequence(
      [a1, a1, a2, a2, b],
      LIST(),
      limits(2, 3),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 429, 200]);
  });

  it('accepts a guest caller kind by its table entry, not a branch', async () => {
    const guest = (kind: string): ParityPrincipal => {
      const w = principals().writer;
      return {
        rest: { ...w.rest, callerKind: kind },
        locals: { ...w.locals, callerKind: kind },
      };
    };
    // A guest gets a quarter of the base limit; an unlisted kind the whole.
    const guests = await expectSameSequence(
      [guest('guest'), guest('guest')],
      LIST(),
      limits(4),
    );
    expect(guests.map((a) => a.status)).toEqual([200, 429]);
    const others = await expectSameSequence(
      [guest('agent'), guest('agent')],
      LIST(),
      limits(4),
    );
    expect(others.map((a) => a.status)).toEqual([200, 200]);
  });

  it('limits the feed routes too', async () => {
    const anonymous = principals().anonymous;
    for (const path of ['_changes', '_events']) {
      const answers = await expectSameSequence(
        [anonymous, anonymous],
        { method: 'GET', path },
        limits(1),
      );
      expect(answers.map((a) => a.status)).toEqual([401, 429]);
    }
  });
});

describe('route parity: the divergence list', () => {
  it('every listed divergence is exercised and is still real', async () => {
    // Self-contained: it sends its own case for each divergence, so it does
    // not depend on the matrix above having run (a filtered run skips that),
    // and it fails when a divergence is never exercised.
    const exercised = new Map<string, number>();
    const notes = segment.note;
    const sample: Case[] = [
      ...crud('writer', 'note'),
      {
        op: 'cross-tenant-list',
        label: 'note list filtered to another tenant',
        principal: 'operator',
        request: { method: 'GET', path: `${notes}?tenantId=${TENANT_B}` },
      },
      {
        op: 'item-scope',
        label: 'item-scope POST action',
        principal: 'writer',
        request: {
          method: 'POST',
          path: `${notes}/${SEED.note.own}/touch`,
          body: {},
        },
      },
      {
        op: 'multi-segment',
        label: 'multi-segment GET action path',
        principal: 'writer',
        request: { method: 'GET', path: `${notes}/reports/monthly` },
      },
    ];
    const failures: string[] = [];
    for (const c of sample) {
      const failure = await compare(c, exercised);
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
    for (const divergence of DIVERGENCES) {
      expect(
        exercised.get(divergence.id) ?? 0,
        `${divergence.id} was never exercised: ${divergence.reason}`,
      ).toBeGreaterThan(0);
    }
  });
});
