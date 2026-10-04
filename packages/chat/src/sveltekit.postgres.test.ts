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
 * share one transaction lifecycle), and `runtime` is a structural stand-in
 * for `@happyvertical/smrt-app-runtime/sveltekit` built from the same
 * smrt-users calls its `databaseConfig()`/`runAsPrincipal()` make (chat does
 * not depend on app-runtime).
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

/** Run `fn` in a request transaction, as the runtime's session step does. */
function inRequest<T>(who: Actor, fn: () => Promise<T>): Promise<T> {
  return withPrincipalPermissionContext(
    {
      db: { type: 'postgres', url: roleUrl },
      userId: who.userId,
      tenantId: who.tenantId,
      permissions: [],
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
  runAsPrincipal: (principal, fn) =>
    withPrincipalPermissionContext(
      {
        db: { type: 'postgres', url: roleUrl },
        userId: principal.id,
        tenantId: principal.tenantId,
        permissions: [...(principal.scopes ?? [])],
        postgresRls: true,
        enterTenantContext: true,
      },
      () => fn(),
    ),
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

/** Reports the tenant and user the tool's database session publishes. */
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
                  current_setting('smrt.user_id', true) AS "user"`,
        ),
      );
      seen.push(row ?? {});
      return row ?? {};
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

    tenantA = randomUUID();
    tenantB = randomUUID();
    const options = { db: { type: 'postgres' as const, url: adminUrl } };
    const types = await ProfileTypeCollection.create(options);
    const person = await types.getOrCreateBySlug('person', { name: 'Person' });
    const profiles = await ProfileCollection.create(options);
    const profile = await profiles.create({
      tenantId: tenantA,
      typeId: person.id as string,
      name: 'Owner',
    });
    await profile.save();
    actor = {
      userId: randomUUID(),
      profileId: profile.id as string,
      tenantId: tenantA,
    };

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
    expect(probes).toEqual([{ tenant: tenantA, user: actor.userId }]);

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
        withPrincipalPermissionContext(
          {
            db: { type: 'postgres', url: roleUrl },
            userId: principal.id,
            tenantId: principal.tenantId,
            permissions: [],
            postgresRls: true,
            enterTenantContext: true,
          },
          async () => {
            const result = await fn();
            if (failNext) {
              failNext = false;
              throw new Error('turn transaction failed');
            }
            return result;
          },
        ),
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
