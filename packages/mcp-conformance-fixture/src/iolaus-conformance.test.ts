import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSurfaceServerActionRequest } from '@happyvertical/smrt-agents/server';
import { SqlDataSurfaceActionStateStore } from '@happyvertical/smrt-agents/server';
import { createMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  McpTaskStore,
  TaskRunner,
  type TaskRunnerConfig,
} from '@happyvertical/smrt-jobs';
import { resolveOpenAiNavigationTarget } from '@happyvertical/smrt-mcp-openai';
import {
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  registerPermissionDefinitions,
  SessionCollection,
  SessionService,
  TenantService,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  copyRuntimeProfileReference,
  generateReferenceFixtureManifest,
  initializeReferenceFixture,
  prepareReferenceFixtureDatabase,
  seedReferenceFixture,
} from '../../template-sveltekit/fixtures/runtime-profile-reference/index.js';
import { inspectIolausInBrowser } from './iolaus-browser.js';
import { initializeIolausSelfHosted } from './iolaus-deployed.js';
import { createIolausHumanReview } from './iolaus-human-review.js';
import { buildIolausResource } from './iolaus-resource.js';
import { createIolausServer } from './iolaus-server.js';
import {
  IOLAUS_RESOURCE,
  IolausApplicationCollection,
} from './iolaus-workload.js';

for (const dialect of ['sqlite', 'postgres'] as const) {
  const suite =
    dialect === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL
      ? describe.skip
      : describe;
  suite(
    `${dialect === 'sqlite' ? 'local' : 'self-hosted'} synthetic Iolaus MCP Apps`,
    () => {
      it('runs the same verified SDK-v2 workflow, isolates owners/tenants and rechecks revoked durable work', async () => {
        const root = await mkdtemp(
          join(await realpath(tmpdir()), 'smrt-iolaus-'),
        );
        let db: DatabaseInterface | undefined;
        let runner: TaskRunner | undefined;
        let workerDb: DatabaseInterface | undefined;
        let deployed:
          | Awaited<ReturnType<typeof initializeIolausSelfHosted>>
          | undefined;
        let preparePostgres:
          | ((db: DatabaseInterface) => Promise<void>)
          | undefined;
        const clients: Client[] = [];
        const server = createServer();
        try {
          if (dialect === 'sqlite') {
            const fixture = await initializeReferenceFixture(
              join(root, 'app'),
              join(root, 'data'),
            );
            await seedReferenceFixture(fixture);
            db = fixture.runtime.db;
          } else {
            const fixture = copyRuntimeProfileReference(join(root, 'app'));
            const manifest = await generateReferenceFixtureManifest(fixture);
            db = await getDatabase({
              type: 'postgres',
              url: process.env.SMRT_TEST_POSTGRES_URL,
            });
            preparePostgres = (connection) =>
              prepareReferenceFixtureDatabase(connection, manifest, 'postgres');
            await preparePostgres(db);
          }
          await getTestDatabase({
            db,
            type: dialect,
            classes: [
              'IolausApplication',
              'SmrtJob',
              'SmrtJobEvent',
              'SmrtWorker',
            ],
          });
          const users = await UserCollection.create({ db });
          const memberships = await MembershipCollection.create({ db });
          const roles = await RoleCollection.create({ db });
          await roles.seedSystemRoles({ seedPermissions: true });
          const tenants = new TenantService(
            { db },
            { mode: 'required', maxTenants: 10 },
          );
          await tenants.initialize();
          const actors = [];
          for (const label of ['a', 'b']) {
            const user = await users.create({
              email: `synthetic-${label}-${randomUUID()}@example.test`,
              status: UserStatus.ACTIVE,
            });
            const { tenant, membership } =
              await tenants.createTenantWithOwnership(
                String(user.id),
                `Synthetic ${label}`,
                { slug: `iolaus-${randomUUID()}` },
              );
            actors.push({
              id: String(user.id),
              tenantId: String(tenant.id),
              membership,
            });
          }
          const [alice, bob] = actors;
          const sessions = await SessionCollection.create({ db });
          const humanSessions = await Promise.all(
            actors.map((actor) =>
              sessions.createSession({
                userId: actor.id,
                tenantId: actor.tenantId,
                ttl: 600,
              }),
            ),
          );
          const sessionService = new SessionService({ db });
          await sessionService.initialize();
          const activeTenants = new Map(
            actors.map((actor) => [actor.id, actor.tenantId]),
          );
          async function authorize(
            principal: { id?: string; tenantId?: string } | null,
          ) {
            if (!principal?.id || !principal.tenantId) return false;
            const user = await users.get(principal.id);
            const membership = await memberships.findByUserAndTenant(
              principal.id,
              principal.tenantId,
            );
            return (
              user?.status === UserStatus.ACTIVE &&
              membership?.status === MembershipStatus.ACTIVE
            );
          }
          const applications = await IolausApplicationCollection.create({ db });
          const rows = await Promise.all(
            actors.map((actor) =>
              applications.create({
                ownerId: actor.id,
                tenantId: actor.tenantId,
              }),
            ),
          );
          const app = createIolausServer(
            db,
            authorize,
            await buildIolausResource(),
          );
          const route = mountMcpRoute(app);
          const pair = await generateKeyPair('RS256');
          const jwk = {
            ...(await exportJWK(pair.publicKey)),
            kid: 'synthetic',
            alg: 'RS256',
            use: 'sig',
          };
          await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
          );
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('No HTTP address');
          const origin = `http://127.0.0.1:${address.port}`;
          const auth = createMcpResourceAuth({
            profile: 'local',
            issuer: origin,
            resource: `${origin}/mcp`,
            jwksUri: `${origin}/jwks`,
            algorithms: ['RS256'],
            scopes: ['workflow'],
            resolvePrincipal: async ({ subject }) => {
              const principal = {
                id: subject,
                tenantId: activeTenants.get(subject),
              };
              return (await authorize(principal)) ? principal : null;
            },
          });
          server.on('request', async (req, res) => {
            try {
              if (req.url === '/ui') {
                res.setHeader('content-type', 'text/html');
                res.end(
                  '<!doctype html><title>Synthetic Iolaus bridge</title>',
                );
                return;
              }
              if (req.url === '/jwks') {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ keys: [jwk] }));
                return;
              }
              if (req.url?.startsWith('/review/')) {
                const sessionId = /(?:^|; )iolaus-human=([^;]+)/.exec(
                  req.headers.cookie ?? '',
                )?.[1];
                const session = sessionId
                  ? await sessionService.loadSessionContext(sessionId)
                  : null;
                if (!session) {
                  res.writeHead(401);
                  res.end('Human session required');
                  return;
                }
                const row = await applications.get(
                  req.url.slice('/review/'.length),
                );
                if (
                  !row?.materials ||
                  row.ownerId !== session.user.id ||
                  row.tenantId !== session.tenantId ||
                  !(await authorize({
                    id: String(session.user.id),
                    tenantId: session.tenantId ?? undefined,
                  }))
                ) {
                  res.writeHead(403);
                  res.end('Review unavailable');
                  return;
                }
                const escapeHtml = (value: string) =>
                  value
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;');
                res.setHeader('content-type', 'text/html');
                res.setHeader('cache-control', 'no-store');
                res.setHeader(
                  'content-security-policy',
                  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
                );
                res.end(
                  `<!doctype html><title>Dedicated human review</title><h1>Review synthetic materials</h1><p>Nothing submitted.</p><pre>${escapeHtml(row.materials)}</pre><code>${row.materialsDigest}</code>`,
                );
                return;
              }
              const chunks: Buffer[] = [];
              for await (const chunk of req) chunks.push(Buffer.from(chunk));
              const request = new Request(`${origin}${req.url}`, {
                method: req.method,
                headers: req.headers as Record<string, string>,
                ...(req.method === 'POST'
                  ? { body: Buffer.concat(chunks).toString() }
                  : {}),
              });
              const verified = await auth.authenticate(request);
              const response = verified.ok
                ? await route({
                    request,
                    url: new URL(request.url),
                    locals: { user: verified.principal },
                  })
                : verified.response;
              res.writeHead(
                response.status,
                Object.fromEntries(response.headers),
              );
              res.end(Buffer.from(await response.arrayBuffer()));
            } catch {
              res.writeHead(500);
              res.end('Synthetic fixture failed');
            }
          });
          const bearer = async (id: string) =>
            new SignJWT({ scope: 'workflow' })
              .setProtectedHeader({
                alg: 'RS256',
                kid: 'synthetic',
                typ: 'at+jwt',
              })
              .setSubject(id)
              .setIssuer(origin)
              .setAudience(`${origin}/mcp`)
              .setExpirationTime('10m')
              .sign(pair.privateKey);
          const aliceToken = await bearer(alice.id);
          if (dialect === 'postgres') {
            deployed = await initializeIolausSelfHosted({
              root,
              authenticate: async () =>
                (
                  await auth.authenticate(
                    new Request(`${origin}/mcp`, {
                      headers: { authorization: `Bearer ${aliceToken}` },
                    }),
                  )
                ).ok,
              prepareDatabase: preparePostgres!,
            });
            expect(deployed.runtime.health().status).toBe('healthy');
            expect((await deployed.runtime.readiness()).status).toBe('ready');
            expect(deployed.runtime.diagnostics()).toMatchObject({
              secretValuesIncluded: false,
              tenancy: {
                mode: 'multi-tenant',
                context: 'required',
                rootTenantFallback: 'disabled',
              },
              workers: { topology: 'external', taskProcess: 'separate' },
            });
            await chmod(deployed.secretPath, 0o644);
            expect(
              (await deployed.runtime.readiness()).components.secrets.status,
            ).toBe('not-ready');
            await chmod(deployed.secretPath, 0o600);
            expect((await deployed.runtime.readiness()).status).toBe('ready');
          }
          const connect = async (token: string) => {
            const client = new Client(
              { name: 'iolaus-conformance', version: '1' },
              { versionNegotiation: { mode: { pin: '2026-07-28' } } },
            );
            clients.push(client);
            await client.connect(
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
              }),
            );
            return client;
          };
          const client = await connect(aliceToken);
          const other = await connect(await bearer(bob.id));
          expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
          const call = (name: string, args: Record<string, unknown> = {}) =>
            client.callTool({ name, arguments: args });
          const catalog = await client.listTools();
          expect(catalog.tools.map((tool) => tool.name)).not.toContain(
            'iolausapplication_prepare',
          );
          expect(
            catalog.tools.find((tool) => tool.name === 'iolaus_browse')
              ?._meta?.['openai/ui'],
          ).toEqual({ entrypoints: [{ type: 'global' }] });
          const browsed = await call('iolaus_browse');
          expect(browsed.structuredContent).toEqual({
            applications: [
              { id: rows[0].id, opportunity: rows[0].opportunity },
            ],
          });
          expect(
            (await other.callTool({ name: 'iolaus_browse', arguments: {} }))
              .structuredContent,
          ).toEqual({
            applications: [
              { id: rows[1].id, opportunity: rows[1].opportunity },
            ],
          });
          const fit = await call('iolaus_inspect_fit', { id: rows[0].id });
          expect(fit.structuredContent).toMatchObject({
            candidateEvidence: rows[0].candidateEvidence,
            revision: 1,
          });
          expect(
            (await client.readResource({ uri: IOLAUS_RESOURCE })).contents[0],
          ).toMatchObject({
            uri: IOLAUS_RESOURCE,
            mimeType: 'text/html;profile=mcp-app',
          });
          await expect(
            other.callTool({
              name: 'iolaus_inspect_materials',
              arguments: { id: rows[0].id },
            }),
          ).rejects.toThrow();
          await expect(
            call('iolausapplication_prepare', { id: rows[0].id, options: {} }),
          ).rejects.toThrow();
          await expect(
            call('iolaus_decide', {
              id: rows[0].id,
              revision: 1,
              decision: 'transmit',
            }),
          ).resolves.toMatchObject({
            isError: true,
            content: [{ type: 'text', text: 'Workflow execution failed.' }],
            structuredContent: {
              error: { message: 'Workflow execution failed.' },
            },
          });
          expect((await applications.get(String(rows[0].id)))?.decision).toBe(
            'undecided',
          );
          expect(
            (
              await fetch(`${origin}/mcp`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
              })
            ).status,
          ).toBe(401);
          activeTenants.set(alice.id, bob.tenantId);
          await expect(call('iolaus_browse')).rejects.toThrow();
          await expect(
            client.readResource({ uri: IOLAUS_RESOURCE }),
          ).rejects.toThrow();
          activeTenants.set(alice.id, alice.tenantId);
          await call('iolaus_decide', {
            id: rows[0].id,
            revision: 1,
            decision: 'prepare',
          });
          const prepared = await call('iolaus_prepare', {
            id: rows[0].id,
            revision: 1,
          });
          const taskId = String(prepared.structuredContent?.taskId);
          const taskRequest = async (
            method: string,
            params: Record<string, unknown>,
            token = aliceToken,
          ) => {
            const response = await fetch(`${origin}/mcp`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'mcp-method': method,
                'mcp-protocol-version': '2026-07-28',
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params: {
                  ...params,
                  _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': {
                      name: 'iolaus',
                      version: '1',
                    },
                    'io.modelcontextprotocol/clientCapabilities': {
                      extensions: { 'io.modelcontextprotocol/tasks': {} },
                    },
                  },
                },
              }),
            });
            return response.json();
          };
          expect(
            (await taskRequest('tasks/get', { taskId }, await bearer(bob.id)))
              .error,
          ).toBeDefined();
          const start = async () => {
            workerDb = deployed?.runtime.db ?? db;
            const config: TaskRunnerConfig = {
              queues: ['mcp-tasks'],
              pollInterval: 10,
              retention: false,
              authorizeMcpTask: async (authority) => {
                const [tenantId, id] = JSON.parse(authority.ownerId);
                const row = await applications.get(authority.objectId);
                return (
                  row?.ownerId === id &&
                  row?.tenantId === tenantId &&
                  tenantId === authority.tenantId &&
                  (await authorize({ id, tenantId }))
                );
              },
            };
            runner = deployed
              ? await deployed.runtime.createTaskWorker(config)
              : new TaskRunner(config);
            if (!deployed) await runner.initialize(workerDb!);
            await runner.start();
          };
          const wait = async (id: string, status: string) => {
            for (let n = 0; n < 300; n++) {
              const value = await taskRequest('tasks/get', { taskId: id });
              if (value.result?.status === status) return value.result;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(`Task did not reach ${status}`);
          };
          await start();
          await wait(taskId, 'completed');
          await runner!.stop();
          runner = undefined;
          const materials = await call('iolaus_inspect_materials', {
            id: rows[0].id,
          });
          expect(materials.structuredContent).toMatchObject({
            submitted: false,
            revision: 1,
          });
          expect(String(materials.structuredContent?.sha256)).toMatch(
            /^[a-f0-9]{64}$/,
          );
          const frozenDecision = (await applications.get(String(rows[0].id)))
            ?.decision;
          expect(frozenDecision).toBe('prepare');
          await expect(
            call('iolaus_decide', {
              id: rows[0].id,
              revision: 1,
              decision: 'pass',
            }),
          ).resolves.toMatchObject({
            isError: true,
            content: [{ type: 'text', text: 'Workflow execution failed.' }],
            structuredContent: {
              error: { message: 'Workflow execution failed.' },
            },
          });
          expect((await applications.get(String(rows[0].id)))?.decision).toBe(
            frozenDecision,
          );
          expect(
            (
              await resolveOpenAiNavigationTarget({
                server: app,
                tool: 'iolaus_review_navigation',
                url: `/review/${rows[0].id}`,
                principal: alice,
              })
            ).structuredContent,
          ).toEqual(materials.structuredContent);
          await expect(
            resolveOpenAiNavigationTarget({
              server: app,
              tool: 'iolaus_review_navigation',
              url: `/review/${rows[0].id}`,
              principal: bob,
            }),
          ).rejects.toThrow();
          await expect(
            client.readResource({ uri: 'ui://iolaus/v1/unknown.html' }),
          ).rejects.toThrow();
          const reviewUrl = `${origin}/review/${rows[0].id}`;
          expect(
            (
              await fetch(reviewUrl, {
                headers: { authorization: `Bearer ${aliceToken}` },
              })
            ).status,
          ).toBe(401);
          expect(
            (
              await fetch(reviewUrl, {
                headers: { cookie: `iolaus-human=${humanSessions[1].id}` },
              })
            ).status,
          ).toBe(403);
          const humanPage = await fetch(reviewUrl, {
            headers: { cookie: `iolaus-human=${humanSessions[0].id}` },
          });
          expect(humanPage.status).toBe(200);
          expect(await humanPage.text()).toContain(
            String(materials.structuredContent?.sha256),
          );
          const awaiting = await call('iolaus_prepare', {
            id: rows[0].id,
            revision: 1,
            awaitInput: true,
          });
          const awaitingId = String(awaiting.structuredContent?.taskId);
          await start();
          await wait(awaitingId, 'input_required');
          await runner!.stop();
          runner = undefined;
          expect(
            (
              await taskRequest(
                'tasks/update',
                {
                  taskId: awaitingId,
                  inputResponses: { notes: 'generic host confirmation' },
                },
                await bearer(bob.id),
              )
            ).error,
          ).toBeDefined();
          await taskRequest('tasks/update', {
            taskId: awaitingId,
            inputResponses: { notes: 'generic host confirmation' },
          });
          await start();
          await wait(awaitingId, 'completed');
          await runner!.stop();
          runner = undefined;
          expect(
            (await applications.get(String(rows[0].id)))?.humanReviewOpened,
          ).toBe(false);
          const unregister = registerPermissionDefinitions([
            { slug: 'iolaus_applications.update' },
          ]);
          try {
            const review = createIolausHumanReview(db, authorize);
            const request: DataSurfaceServerActionRequest = {
              version: 1,
              requestId: 'human-preview',
              identity: {
                surfaceId: 'iolaus',
                kind: 'table',
                subject: { type: 'tenant', id: alice.tenantId },
              },
              actionId: 'open_review',
              phase: 'preview',
              selection: {
                scope: 'explicit-ids',
                rowIds: [String(rows[0].id)],
              },
              expectedRevision: 1,
              payload: { sha256: String(materials.structuredContent?.sha256) },
            };
            const preview = await review.preview(request, alice);
            expect(preview.ok).toBe(true);
            expect(preview.confirmationToken).toBeTypeOf('string');
            const tokenRecord = await review.state.getToken(
              String(preview.confirmationToken),
            );
            if (!tokenRecord || !db.transaction)
              throw new Error('Missing transactional review state');
            await review.state.putToken('rollback-only', tokenRecord);
            if (dialect === 'sqlite')
              await db.query(
                "CREATE TRIGGER iolaus_abort BEFORE INSERT ON _smrt_data_surface_action_idempotency BEGIN SELECT RAISE(ABORT, 'synthetic transaction abort'); END",
              );
            else {
              await db.query(
                "CREATE OR REPLACE FUNCTION pg_temp.iolaus_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transaction abort'; END $$",
              );
              await db.query(
                'CREATE TRIGGER iolaus_abort BEFORE INSERT ON _smrt_data_surface_action_idempotency FOR EACH ROW EXECUTE FUNCTION pg_temp.iolaus_abort()',
              );
            }
            try {
              await expect(
                review.state.consumeTokenAndReserveIdempotency(
                  'rollback-only',
                  'rollback-apply',
                  'rollback-scope',
                  {
                    requestFingerprint: 'rollback',
                    ownerToken: 'rollback-owner',
                    reservedAt: Date.now(),
                  },
                ),
              ).rejects.toThrow('synthetic transaction abort');
            } finally {
              await db.query(
                dialect === 'sqlite'
                  ? 'DROP TRIGGER iolaus_abort'
                  : 'DROP TRIGGER iolaus_abort ON _smrt_data_surface_action_idempotency',
              );
            }
            expect(
              await review.state.getToken('rollback-only'),
            ).not.toHaveProperty('consumedBy');
            expect(
              await review.state.getIdempotency('rollback-scope'),
            ).toBeUndefined();
            await review.state.reserveIdempotency('unknown-outcome', {
              requestFingerprint: 'unknown',
              ownerToken: 'lost-worker',
              reservedAt: 100,
            });
            expect(
              await new SqlDataSurfaceActionStateStore({
                db,
              }).reserveIdempotency('unknown-outcome', {
                requestFingerprint: 'unknown',
                ownerToken: 'retry-worker',
                reservedAt: 200,
              }),
            ).toMatchObject({
              status: 'reserved',
              ownerToken: '',
              reservedAt: 100,
            });

            expect(
              (await applications.get(String(rows[0].id)))?.humanReviewOpened,
            ).toBe(false);
            const apply = {
              ...request,
              phase: 'apply' as const,
              requestId: 'human-apply',
              idempotencyKey: 'review-once',
              confirmationToken: preview.confirmationToken,
            };
            expect(
              (
                await review.apply(
                  { ...apply, confirmationToken: 'host-confirmed' },
                  alice,
                )
              ).ok,
            ).toBe(false);
            expect(
              (
                await review.apply(
                  { ...apply, payload: { sha256: '0'.repeat(64) } },
                  alice,
                )
              ).ok,
            ).toBe(false);
            expect((await review.apply(apply, bob)).ok).toBe(false);
            const outcomes = await Promise.all([
              review.apply(apply, alice),
              createIolausHumanReview(db, authorize).apply(apply, alice),
            ]);
            expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
            expect(
              (await applications.get(String(rows[0].id)))?.humanReviewOpened,
            ).toBe(true);
            expect((await review.apply(apply, alice)).ok).toBe(true);
            expect(
              (await applications.get(String(rows[0].id)))?.reviewCount,
            ).toBe(1);
            expect(
              (await call('iolaus_inspect_materials', { id: rows[0].id }))
                .structuredContent,
            ).toEqual(materials.structuredContent);
          } finally {
            unregister();
          }
          if (process.env.SMRT_MCP_APPS_BROWSER === '1') {
            const browserResult = await inspectIolausInBrowser(
              origin,
              String(
                (await client.readResource({ uri: IOLAUS_RESOURCE }))
                  .contents[0].text,
              ),
              call,
            );
            expect(browserResult.structuredContent).toEqual(
              materials.structuredContent,
            );
          }
          const pending = await call('iolaus_prepare', {
            id: rows[0].id,
            revision: 1,
          });
          await taskRequest('tasks/cancel', {
            taskId: pending.structuredContent?.taskId,
          });
          expect(
            (
              await taskRequest('tasks/get', {
                taskId: pending.structuredContent?.taskId,
              })
            ).result.status,
          ).toBe('cancelled');
          const transferred = await call('iolaus_prepare', {
            id: rows[0].id,
            revision: 1,
          });
          const transferredRow = await applications.get(String(rows[0].id));
          if (!transferredRow) throw new Error('Missing application');
          transferredRow.ownerId = bob.id;
          await transferredRow.save();
          await start();
          await wait(String(transferred.structuredContent?.taskId), 'failed');
          await runner!.stop();
          runner = undefined;
          transferredRow.ownerId = alice.id;
          await transferredRow.save();
          const revoked = await call('iolaus_prepare', {
            id: rows[0].id,
            revision: 1,
            awaitInput: true,
          });
          await start();
          await wait(
            String(revoked.structuredContent?.taskId),
            'input_required',
          );
          await runner!.stop();
          runner = undefined;
          await taskRequest('tasks/update', {
            taskId: revoked.structuredContent?.taskId,
            inputResponses: { notes: 'authorized before revocation' },
          });
          alice.membership.status = MembershipStatus.SUSPENDED;
          await alice.membership.save();
          if (deployed)
            expect(
              (await deployed.runtime.readiness()).components.authentication
                .status,
            ).toBe('not-ready');
          await start();
          // Revocation denies HTTP task inspection as well as worker execution.
          expect(
            (
              await fetch(`${origin}/mcp`, {
                headers: { authorization: `Bearer ${aliceToken}` },
              })
            ).status,
          ).toBe(401);
          const inspection = await McpTaskStore.create(db, {
            ownerId: JSON.stringify([alice.tenantId, alice.id]),
            tenantId: alice.tenantId,
            requireAuthorization: true,
          });
          for (let attempt = 0; attempt < 300; attempt++) {
            if (
              (
                await inspection.getTask(
                  String(revoked.structuredContent?.taskId),
                )
              ).status === 'failed'
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(
            (
              await inspection.getTask(
                String(revoked.structuredContent?.taskId),
              )
            ).status,
          ).toBe('failed');
          alice.membership.status = MembershipStatus.ACTIVE;
          await alice.membership.save();
          await wait(String(revoked.structuredContent?.taskId), 'failed');
          expect(
            (await call('iolaus_inspect_materials', { id: rows[0].id }))
              .structuredContent,
          ).toEqual(materials.structuredContent);
        } finally {
          await runner?.stop();
          for (const client of clients) await client.close();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          if (deployed) {
            await deployed.runtime.close();
            expect(deployed.runtime.health().status).toBe('stopped');
            expect((await deployed.runtime.readiness()).status).toBe(
              'not-ready',
            );
            await expect(
              deployed.runtime.createTaskWorker(),
            ).rejects.toMatchObject({ code: 'runtime_stopped' });
          }
          await db?.close?.();
          await rm(root, { recursive: true, force: true });
        }
      });
    },
  );
}
