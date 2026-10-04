/**
 * A streamed assistant turn never keeps its request's RLS transaction
 * (#3414 review F1), proven on real PostgreSQL.
 *
 * Under `database-rls` the request runs in a transaction that commits when
 * the handler chain returns, which for a streamed turn is before the model
 * answers. These cases delay the AI until the handler has returned (or, for
 * the in-request fallback, until it is called) and assert that the reply and
 * the send's recorded outcome persist under the request's tenant, and that a
 * user message never dangles without a settled turn.
 *
 * The request transaction is opened exactly as the runtime's session step
 * opens it (`withPrincipalPermissionContext`/`withSessionPermissionContext`
 * share one transaction lifecycle), publishing the permissions live at the
 * request's start, and `runtime` is a structural stand-in for
 * `@happyvertical/smrt-app-runtime/sveltekit` built from the same smrt-users
 * calls its `databaseConfig()`/`runAsPrincipal()` make (chat does not depend
 * on app-runtime): `runAsPrincipal` resolves live permissions from the
 * membership rows, caps them to `scopes` when given (omitted = no cap), and
 * hands `fn` the bound principal with the effective scopes.
 *
 * The application connects as a NOSUPERUSER NOBYPASSRLS role and
 * `chat_messages` carries a FORCEd tenant policy, so a write outside a live
 * transaction publishing the right tenant fails. Committed DDL is confined to
 * a schema of its own, dropped on teardown (.github/CI.md). Runs under
 * `pnpm --filter @happyvertical/smrt-chat test:postgres`; skips without
 * `SMRT_TEST_POSTGRES_URL` (set by the wrapper from `CI_POSTGRES_BASE_URL`).
 */

import { randomUUID } from 'node:crypto';
import type {
  AIInterface,
  AIMessage,
  AIResponse,
  ChatOptions,
} from '@happyvertical/ai';
import type { PrincipalTool } from '@happyvertical/smrt-agents';
import { isFrameworkBaseClass, ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import {
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
  MembershipCollection,
  PermissionCollection,
  PermissionResolver,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  UserCollection,
  withPrincipalPermissionContext,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AssistantTurnEvent,
  readAssistantTurnStream,
} from './assistant-turn-events.js';
import {
  type AssistantMessageWire,
  type AssistantRouteEvent,
  type AssistantRouteRuntime,
  type AssistantRoutes,
  type MountAssistantRoutesOptions,
  mountAssistantRoutes,
} from './sveltekit.js';

const baseUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = baseUrl ? describe : describe.skip;
const SCHEMA = `chat_turn_rls_${randomUUID().replaceAll('-', '')}`;
const ORIGIN = 'http://app.test';
const PROBE = 'probe.tenant';
/** Granted through the actor's role at the start. */
const USE = 'probe.use';
/** Not granted at the start. */
const EXTRA = 'probe.extra';

function inSchema(url: string): string {
  const confined = new URL(url);
  confined.searchParams.set('options', `-c search_path=${SCHEMA}`);
  return confined.toString();
}

function rows(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

interface Actor {
  userId: string;
  profileId: string;
  tenantId: string;
}

let base: DatabaseInterface | undefined;
let admin: DatabaseInterface | undefined;
let roleName = '';
let roleUrl = '';
let tenantA = '';
let tenantB = '';
let actor: Actor;
let adminOptions: { db: { type: 'postgres'; url: string } };
let roleId = '';
const permissionIds: Record<string, string> = {};

/** The permissions the actor's memberships grant right now. */
async function livePermissions(userId: string, tenantId: string) {
  const resolver = await PermissionResolver.create({
    db: { type: 'postgres', url: roleUrl },
  });
  return [...(await resolver.resolvePermissions(userId, tenantId)).permissions];
}

/** Grant (or revoke) a permission on the actor's role. */
async function setGranted(slug: string, granted: boolean) {
  const grants = await RolePermissionCollection.create(adminOptions);
  if (granted) await grants.addPermission(roleId, permissionIds[slug]);
  else await grants.removePermission(roleId, permissionIds[slug]);
}

/** Run `fn` in a request transaction, as the runtime's session step does. */
async function inRequest<T>(who: Actor, fn: () => Promise<T>): Promise<T> {
  return withPrincipalPermissionContext(
    {
      db: { type: 'postgres', url: roleUrl },
      userId: who.userId,
      tenantId: who.tenantId,
      permissions: await livePermissions(who.userId, who.tenantId),
      postgresRls: true,
      enterTenantContext: true,
    },
    fn,
  );
}

/** What `createSmrtSvelteKitRuntime` does for these two calls. */
const runtime: AssistantRouteRuntime = {
  databaseConfig: () =>
    (getCurrentSessionPermissionContext()?.postgresRls === true
      ? getRequestScopedDatabase()
      : { type: 'postgres', url: roleUrl }) as never,
  runAsPrincipal: async (principal, fn) => {
    const cap = principal.scopes ? new Set(principal.scopes) : undefined;
    const effective = Object.freeze(
      (await livePermissions(principal.id, principal.tenantId)).filter(
        (permission) => !cap || cap.has(permission),
      ),
    );
    return withPrincipalPermissionContext(
      {
        db: { type: 'postgres', url: roleUrl },
        userId: principal.id,
        tenantId: principal.tenantId,
        permissions: [...effective],
        postgresRls: true,
        enterTenantContext: true,
      },
      () =>
        fn(
          Object.freeze({
            id: principal.id,
            tenantId: principal.tenantId,
            scopes: effective,
          }),
        ),
    );
  },
};

/** Rows of `chat_messages` for a thread, as `tenantId` sees them. */
function messagesAs(tenantId: string, threadId: string) {
  return inRequest({ ...actor, tenantId }, async () => {
    const db = getRequestScopedDatabase() as unknown as DatabaseInterface;
    return rows(
      await db.query(
        `SELECT id, role, CAST(tenant_id AS text) AS tenant_id,
                CAST(reply_to_message_id AS text) AS reply_to, metadata, content
           FROM chat_messages WHERE CAST(thread_id AS text) = $1
          ORDER BY created_at`,
        threadId,
      ),
    );
  });
}

/** A model whose first answer waits for `release()`. */
function delayedAI(rounds: Array<(options?: ChatOptions) => AIResponse>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let called!: () => void;
  const firstCall = new Promise<void>((resolve) => {
    called = resolve;
  });
  let call = 0;
  const ai = {
    async chat(_messages: AIMessage[], options?: ChatOptions) {
      called();
      await gate;
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      return round(options);
    },
  } as unknown as AIInterface;
  return { ai, release, firstCall };
}

const text =
  (content: string) =>
  (options?: ChatOptions): AIResponse => {
    options?.onProgress?.(content);
    return { content, finishReason: 'stop' } as AIResponse;
  };

const callProbe = (): AIResponse =>
  ({
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: 'call_probe',
        type: 'function',
        function: { name: 'probe-tenant', arguments: '{}' },
      },
    ],
  }) as AIResponse;

/**
 * Reports the tenant, user and permissions the tool's principal run and its
 * database session publish.
 */
function probeTool(seen: Array<Record<string, unknown>>): PrincipalTool {
  return {
    slug: PROBE,
    aiTool: {
      type: 'function',
      function: {
        name: 'probe-tenant',
        description: 'Report the database principal.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async execute({ run }) {
      run.assertToolAllowed(PROBE);
      const db = run.context.database as unknown as DatabaseInterface;
      const [row] = rows(
        await db.query(
          `SELECT current_setting('smrt.tenant_id', true) AS tenant,
                  current_setting('smrt.user_id', true) AS "user",
                  current_setting('smrt.permissions', true) AS published`,
        ),
      );
      const report = {
        tenant: row?.tenant,
        user: row?.user,
        permissions: [...run.permissions].sort(),
        published: JSON.parse(String(row?.published || '[]')).sort(),
      };
      seen.push(report);
      return report;
    },
  };
}

function routeEvent(
  method: string,
  path: string,
  who: Actor,
  body?: unknown,
): AssistantRouteEvent {
  const url = new URL(`${ORIGIN}/api/assistant/${path}`);
  return {
    request: new Request(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { origin: ORIGIN } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    url,
    params: { path },
    locals: {
      user: { id: who.userId, profileId: who.profileId },
      tenantId: who.tenantId,
    },
  };
}

async function createThread(routes: AssistantRoutes): Promise<string> {
  const response = await inRequest(actor, () =>
    routes.POST(routeEvent('POST', 'threads', actor, { title: 'Plans' })),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { thread: { id: string } }).thread.id;
}

/** Every event, including an in-band `error` (which the reader throws). */
async function readEvents(response: Response) {
  const seen: AssistantTurnEvent<AssistantMessageWire>[] = [];
  try {
    await readAssistantTurnStream<AssistantMessageWire>(response, (event) => {
      seen.push(event);
    });
  } catch {
    // The error event is already in `seen`.
  }
  return seen;
}

function mount(overrides: Partial<MountAssistantRoutesOptions>) {
  const errors: unknown[] = [];
  const routes = mountAssistantRoutes({
    audit: () => {},
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { routes, errors };
}

postgresDescribe('streamed assistant turn under database-rls', () => {
  let autoSchema: string | undefined;

  beforeAll(async () => {
    // The fixture provisions its schema itself; the application role's own
    // connections (opened inside smrt) must not be auto-prepared either: it
    // owns nothing and may not alter the tables.
    autoSchema = process.env.SMRT_VITEST_AUTO_SCHEMA;
    process.env.SMRT_VITEST_AUTO_SCHEMA = '0';
    const postgresUrl = baseUrl as string;
    base = await getDatabase({ type: 'postgres', url: postgresUrl });
    await base.query(`CREATE SCHEMA "${SCHEMA}"`);
    const adminUrl = inSchema(postgresUrl);
    // Provisioned here, explicitly: smrt-vitest must not prepare it.
    admin = await getDatabase({
      type: 'postgres',
      url: adminUrl,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    const packages = new Set([
      '@happyvertical/smrt-users',
      '@happyvertical/smrt-profiles',
    ]);
    await getTestDatabase({
      db: admin,
      type: 'postgres',
      classes: [
        ...ObjectRegistry.getQualifiedClassNames().filter((className) => {
          const registered = ObjectRegistry.getClass(className);
          return (
            packages.has(registered?.packageName ?? '') &&
            !isFrameworkBaseClass(registered?.name, registered?.packageName)
          );
        }),
        '@happyvertical/smrt-chat:ChatRoom',
        '@happyvertical/smrt-chat:ChatMessage',
        '@happyvertical/smrt-chat:ChatParticipant',
        '@happyvertical/smrt-chat:ChatThread',
        '@happyvertical/smrt-chat:ChatReaction',
        '@happyvertical/smrt-chat:AgentSession',
        '@happyvertical/smrt-chat:VoiceSession',
      ],
    });

    const options = { db: { type: 'postgres' as const, url: adminUrl } };
    adminOptions = options;
    const save = async <T extends { save(): Promise<unknown> }>(value: T) => {
      await value.save();
      return value as T & { id: string };
    };
    const tenants = await TenantCollection.create(options);
    tenantA = (await save(await tenants.create({ name: 'Tenant A' }))).id;
    tenantB = (await save(await tenants.create({ name: 'Tenant B' }))).id;
    const types = await ProfileTypeCollection.create(options);
    const person = await types.getOrCreateBySlug('person', { name: 'Person' });
    const profiles = await ProfileCollection.create(options);
    const profile = await save(
      await profiles.create({
        tenantId: tenantA,
        typeId: person.id as string,
        name: 'Owner',
      }),
    );
    const users = await UserCollection.create(options);
    const user = await save(
      await users.create({
        email: `owner-${randomUUID()}@example.test`,
        profileId: profile.id,
      }),
    );
    const roles = await RoleCollection.create(options);
    roleId = (await save(await roles.create({ name: `Owner ${randomUUID()}` })))
      .id;
    const permissions = await PermissionCollection.create(options);
    for (const slug of [USE, EXTRA]) {
      permissionIds[slug] = (
        await save(await permissions.create({ slug, name: slug }))
      ).id;
    }
    await setGranted(USE, true);
    const memberships = await MembershipCollection.create(options);
    await save(
      await memberships.create({ userId: user.id, tenantId: tenantA, roleId }),
    );
    actor = { userId: user.id, profileId: profile.id, tenantId: tenantA };

    // FORCE binds the owning role too: every chat_messages read and write
    // needs a live transaction publishing the row's tenant.
    for (const statement of [
      `CREATE OR REPLACE FUNCTION smrt_current_tenant_id() RETURNS text LANGUAGE sql STABLE AS $$
         SELECT NULLIF(current_setting('smrt.tenant_id', true), '') $$`,
      'ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY',
      `CREATE POLICY chat_messages_tenant ON chat_messages FOR ALL
         USING (CAST(tenant_id AS text) = smrt_current_tenant_id())
         WITH CHECK (CAST(tenant_id AS text) = smrt_current_tenant_id())`,
    ]) {
      await admin.query(statement);
    }

    roleName = `smrt_chat_rls_${randomUUID().replaceAll('-', '_')}`;
    await admin.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD 'rls-test' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${roleName}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${SCHEMA}" TO "${roleName}"`,
    );
    await admin.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${SCHEMA}" TO "${roleName}"`,
    );
    const url = new URL(adminUrl);
    url.username = roleName;
    url.password = 'rls-test';
    roleUrl = url.toString();
  });

  afterAll(async () => {
    if (!base) return;
    await admin?.close?.();
    const app = await getDatabase({ type: 'postgres', url: roleUrl }).catch(
      () => undefined,
    );
    await app?.close?.();
    await base.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    if (roleName) await base.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await base.close?.();
    if (autoSchema === undefined) delete process.env.SMRT_VITEST_AUTO_SCHEMA;
    else process.env.SMRT_VITEST_AUTO_SCHEMA = autoSchema;
  });

  it('connects as a NOSUPERUSER NOBYPASSRLS role that the policy binds', async () => {
    const [role] = await inRequest(actor, async () => {
      const db = getRequestScopedDatabase() as unknown as DatabaseInterface;
      return rows(
        await db.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        ),
      );
    });
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('runs a turn answered after the handler returned in its own tenant transaction', async () => {
    const model = delayedAI([callProbe, text('Delayed reply.')]);
    const probes: Array<Record<string, unknown>> = [];
    const { routes, errors } = mount({
      ai: model.ai,
      runtime,
      // The documented #3414 wiring, explicit: the same as the default.
      db: () => runtime.databaseConfig(),
      allowedTools: [PROBE],
      extraTools: [probeTool(probes)],
    });
    const threadId = await createThread(routes);

    let requestDb: { isActive?: () => boolean } | undefined;
    const response = await inRequest(actor, async () => {
      requestDb = getRequestScopedDatabase() as never;
      return routes.POST(
        routeEvent('POST', `threads/${threadId}/messages`, actor, {
          content: 'Hello?',
          clientRequestId: 'send-1',
        }),
      );
    });
    // The handler has returned and its transaction has ended; only now does
    // the model answer.
    expect(response.status).toBe(200);
    expect(requestDb?.isActive?.()).toBe(false);
    model.release();

    const events = await readEvents(response);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    const done = events.find((event) => event.type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      message: { role: 'assistant', content: 'Delayed reply.' },
    });
    expect(errors).toEqual([]);
    // The tool ran after the request ended, in a transaction publishing the
    // request's principal.
    expect(probes).toEqual([
      {
        tenant: tenantA,
        user: actor.userId,
        permissions: [USE],
        published: [USE],
      },
    ]);

    // Committed under tenant A: the send, its linked reply, its outcome.
    const stored = await messagesAs(tenantA, threadId);
    expect(stored.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(stored.every((row) => row.tenant_id === tenantA)).toBe(true);
    const [send, reply] = stored;
    expect(reply.reply_to).toBe(send.id);
    expect(reply.content).toBe('Delayed reply.');
    expect(JSON.parse(String(send.metadata))).toMatchObject({
      clientRequestId: 'send-1',
      turnOutcome: 'completed',
    });
    // Invisible to another tenant.
    expect(await messagesAs(tenantB, threadId)).toEqual([]);

    // The route reads the same, and a retry of the send is told it completed.
    const listed = await inRequest(actor, () =>
      routes.GET(routeEvent('GET', `threads/${threadId}/messages`, actor)),
    );
    const items = ((await listed.json()) as { items: AssistantMessageWire[] })
      .items;
    expect(items.map((item) => item.role)).toEqual(['user', 'assistant']);
    const retry = await inRequest(actor, () =>
      routes.POST(
        routeEvent('POST', `threads/${threadId}/messages`, actor, {
          content: 'Hello?',
          clientRequestId: 'send-1',
        }),
      ),
    );
    expect(await retry.json()).toMatchObject({
      duplicate: true,
      outcome: 'completed',
      assistantMessage: { content: 'Delayed reply.' },
    });
  });

  /**
   * Send, then change the actor's grants after the request has committed
   * and before the turn binds its principal (the runtime runs `handoff`
   * first), then let the model call the probe. Returns what the probe saw.
   */
  async function probeAcrossHandoff(
    clientRequestId: string,
    handoff: () => Promise<void>,
    overrides: Partial<MountAssistantRoutesOptions> = {},
  ) {
    const model = delayedAI([callProbe, text('Probed.')]);
    const probes: Array<Record<string, unknown>> = [];
    let handedOff = false;
    const handingOff: AssistantRouteRuntime = {
      databaseConfig: runtime.databaseConfig,
      runAsPrincipal: async (principal, fn) => {
        if (!handedOff) {
          handedOff = true;
          await handoff();
        }
        return runtime.runAsPrincipal(principal, fn);
      },
    };
    const { routes, errors } = mount({
      ai: model.ai,
      runtime: handingOff,
      allowedTools: [PROBE],
      extraTools: [probeTool(probes)],
      ...overrides,
    });
    const threadId = await createThread(routes);
    const response = await inRequest(actor, () =>
      routes.POST(
        routeEvent('POST', `threads/${threadId}/messages`, actor, {
          content: 'Probe',
          clientRequestId,
        }),
      ),
    );
    model.release();
    const events = await readEvents(response);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(errors).toEqual([]);
    expect(handedOff).toBe(true);
    expect(probes).toHaveLength(1);
    return probes[0];
  }

  it('never regains a snapshotted permission revoked before the turn binds', async () => {
    try {
      // The host's resolver snapshots USE; it is revoked during the handoff.
      const seen = await probeAcrossHandoff(
        'send-revoked',
        () => setGranted(USE, false),
        {
          resolvePrincipal: (event) => {
            const locals = event.locals as {
              user: { id: string; profileId: string };
              tenantId: string;
            };
            return {
              userId: locals.user.id,
              profileId: locals.user.profileId,
              tenantId: locals.tenantId,
              permissions: [USE],
            };
          },
        },
      );
      expect(seen).toMatchObject({ permissions: [], published: [] });
    } finally {
      await setGranted(USE, true);
    }
  });

  it('never acquires a permission granted after the send was accepted', async () => {
    try {
      const seen = await probeAcrossHandoff('send-granted', () =>
        setGranted(EXTRA, true),
      );
      expect(seen).toMatchObject({ permissions: [USE], published: [USE] });
    } finally {
      await setGranted(EXTRA, false);
    }
  });

  it('keeps an empty request permission set empty across the handoff', async () => {
    await setGranted(USE, false);
    try {
      const seen = await probeAcrossHandoff('send-empty', () =>
        setGranted(USE, true),
      );
      expect(seen).toMatchObject({ permissions: [], published: [] });
    } finally {
      await setGranted(USE, true);
    }
  });

  it('records a turn the client left after the handler returned as cancelled', async () => {
    const model = delayedAI([
      () => {
        throw new Error('aborted');
      },
    ]);
    const { routes } = mount({ ai: model.ai, runtime });
    const threadId = await createThread(routes);
    const client = new AbortController();
    const response = await inRequest(actor, () => {
      const event = routeEvent('POST', `threads/${threadId}/messages`, actor, {
        content: 'Stop me',
        clientRequestId: 'send-stop',
      });
      return routes.POST({
        ...event,
        request: new Request(event.request, { signal: client.signal }),
      });
    });
    client.abort();
    model.release();
    const events = await readEvents(response);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      stoppedReason: 'cancelled',
    });
    const stored = await messagesAs(tenantA, threadId);
    expect(stored.map((row) => row.role)).toEqual(['user']);
    expect(JSON.parse(String(stored[0].metadata))).toMatchObject({
      clientRequestId: 'send-stop',
      turnOutcome: 'cancelled',
    });
  });

  it('settles the send as failed, and never reports done, when the turn transaction rolls back', async () => {
    const model = delayedAI([text('Rolled back.')]);
    let failNext = true;
    // The turn's own transaction fails after the turn ran (as a failed
    // commit would): everything it wrote rolls back.
    const failing: AssistantRouteRuntime = {
      databaseConfig: runtime.databaseConfig,
      runAsPrincipal: (principal, fn) =>
        runtime.runAsPrincipal(principal, async (bound) => {
          const result = await fn(bound);
          if (failNext) {
            failNext = false;
            throw new Error('turn transaction failed');
          }
          return result;
        }),
    };
    const { routes, errors } = mount({ ai: model.ai, runtime: failing });
    const threadId = await createThread(routes);
    const response = await inRequest(actor, () =>
      routes.POST(
        routeEvent('POST', `threads/${threadId}/messages`, actor, {
          content: 'Hello?',
          clientRequestId: 'send-fail',
        }),
      ),
    );
    model.release();
    const events = await readEvents(response);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events.map((event) => event.type)).toContain('error');
    expect(errors.map(String).join('\n')).toMatch(/turn transaction failed/);
    const stored = await messagesAs(tenantA, threadId);
    expect(stored.map((row) => row.role)).toEqual(['user']);
    expect(JSON.parse(String(stored[0].metadata))).toMatchObject({
      turnOutcome: 'failed',
    });
  });

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** Poll until `check` holds (bounded). */
  async function eventually(check: () => Promise<boolean>) {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition never held');
      await sleep(50);
    }
  }

  it('settles a send whose request committed after the turn start timed out', async () => {
    const model = delayedAI([text('Never asked.')]);
    let asked = false;
    void model.firstCall.then(() => {
      asked = true;
    });
    const { routes, errors } = mount({
      ai: model.ai,
      runtime,
      turnStartTimeoutMs: 50,
    });
    const threadId = await createThread(routes);
    const response = await inRequest(actor, async () => {
      const answer = await routes.POST(
        routeEvent('POST', `threads/${threadId}/messages`, actor, {
          content: 'Hello?',
          clientRequestId: 'send-late',
        }),
      );
      // The request's transaction outlives the turn's start deadline.
      await sleep(400);
      return answer;
    });
    const events = await readEvents(response);
    expect(events.map((event) => event.type)).toContain('error');
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(errors.map(String).join('\n')).toMatch(/did not end/);
    // Once the request committed, its send is settled, not left running.
    await eventually(async () => {
      const [send] = await messagesAs(tenantA, threadId);
      return (
        JSON.parse(String(send?.metadata ?? '{}')).turnOutcome === 'failed'
      );
    });
    expect(asked).toBe(false);
    expect(
      (await messagesAs(tenantA, threadId)).map((row) => row.role),
    ).toEqual(['user']);
  });

  it('stores and settles nothing when that late request rolls back', async () => {
    const model = delayedAI([text('Never asked.')]);
    const { routes, errors } = mount({
      ai: model.ai,
      runtime,
      turnStartTimeoutMs: 50,
    });
    const threadId = await createThread(routes);
    let response: Response | undefined;
    await expect(
      inRequest(actor, async () => {
        response = await routes.POST(
          routeEvent('POST', `threads/${threadId}/messages`, actor, {
            content: 'Hello?',
            clientRequestId: 'send-late-rollback',
          }),
        );
        await sleep(400);
        throw new Error('downstream failure');
      }),
    ).rejects.toThrow('downstream failure');
    const events = await readEvents(response as Response);
    expect(events.map((event) => event.type)).toContain('error');
    await sleep(300);
    expect(await messagesAs(tenantA, threadId)).toEqual([]);
    expect(errors.map(String).join('\n')).not.toMatch(/never ended/);
  });

  it('runs no turn for a send whose request transaction rolled back', async () => {
    const model = delayedAI([text('Never stored.')]);
    const { routes, errors } = mount({ ai: model.ai, runtime });
    const threadId = await createThread(routes);
    let response: Response | undefined;
    await expect(
      inRequest(actor, async () => {
        response = await routes.POST(
          routeEvent('POST', `threads/${threadId}/messages`, actor, {
            content: 'Hello?',
            clientRequestId: 'send-rollback',
          }),
        );
        // A later step of the request fails: its transaction rolls back.
        throw new Error('downstream failure');
      }),
    ).rejects.toThrow('downstream failure');
    model.release();
    const events = await readEvents(response as Response);
    expect(events.map((event) => event.type)).toContain('error');
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(await messagesAs(tenantA, threadId)).toEqual([]);
    expect(errors.map(String).join('\n')).toMatch(/send was not stored/);
  });

  it('without a runtime, runs the whole turn inside the request transaction', async () => {
    const model = delayedAI([text('Inline reply.')]);
    // Answer as soon as asked: the handler waits for the turn.
    void model.firstCall.then(() => model.release());
    const { routes, errors } = mount({
      ai: model.ai,
      db: () => runtime.databaseConfig(),
    });
    const threadId = await createThread(routes);
    const response = await inRequest(actor, () =>
      routes.POST(
        routeEvent('POST', `threads/${threadId}/messages`, actor, {
          content: 'Hello?',
          clientRequestId: 'send-inline',
        }),
      ),
    );
    const events = await readEvents(response);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      message: { content: 'Inline reply.' },
    });
    expect(errors).toEqual([]);
    const stored = await messagesAs(tenantA, threadId);
    expect(stored.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(JSON.parse(String(stored[0].metadata))).toMatchObject({
      turnOutcome: 'completed',
    });
  });
});
