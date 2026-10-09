import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import type {
  ReferenceReviewHost,
  ReviewSession,
} from '../../reference/review-host.js';

export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  plugins: [
    svelte(),
    {
      name: 'authenticated-ingestion-review-fixture',
      async configureServer(server) {
        const sessions = new Map<
          string,
          { scope: ReviewSession; csrf: string }
        >();
        // Provision the fixture schema before installing any request handler.
        const module = await server.ssrLoadModule('/reference/review-host.ts');
        const app: ReferenceReviewHost =
          await module.ReferenceReviewHost.provision(
            await mkdtemp(join(tmpdir(), 'review-')),
          );
        const host = async () => app;
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/api/')) return next();
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          const respond = (status: number, value: unknown) => {
            res.statusCode = status;
            res.end(JSON.stringify(value));
          };
          try {
            const url = new URL(req.url, 'http://127.0.0.1:5595');
            const readOnly =
              ['/api/list', '/api/load', '/api/result'].includes(
                url.pathname,
              ) || url.pathname.startsWith('/api/original/');
            if (
              (readOnly && req.method !== 'GET') ||
              (!readOnly &&
                url.pathname !== '/api/session' &&
                req.method !== 'POST') ||
              (url.pathname === '/api/session' &&
                !['GET', 'POST'].includes(req.method ?? ''))
            ) {
              respond(405, { error: 'Method not allowed' });
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const chunk of req) {
              length += chunk.length;
              if (length > 1100000) {
                respond(413, { error: 'Request too large' });
                return;
              }
              chunks.push(Buffer.from(chunk));
            }
            const body = Buffer.concat(chunks);
            if (url.pathname === '/api/session' && req.method === 'POST') {
              const credentials = JSON.parse(body.toString());
              if (
                credentials.password !== 'review-fixture' ||
                !['owner', 'reviewer', 'foreign'].includes(credentials.username)
              ) {
                respond(401, { error: 'Authentication required' });
                return;
              }
              const token = randomUUID(),
                csrf = randomUUID();
              sessions.set(token, {
                scope: {
                  actorId: credentials.username,
                  tenantId:
                    credentials.username === 'foreign'
                      ? '22222222-2222-4222-8222-222222222222'
                      : '11111111-1111-4111-8111-111111111111',
                  confidentialScopeId: 'private',
                },
                csrf,
              });
              res.setHeader(
                'Set-Cookie',
                `review_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
              );
              respond(200, { csrf });
              return;
            }
            const token = req.headers.cookie
              ?.split('; ')
              .find((value) => value.startsWith('review_session='))
              ?.slice(15);
            const session = token ? sessions.get(token) : undefined;
            if (!session) {
              respond(401, { error: 'Authentication required' });
              return;
            }
            if (
              req.method !== 'GET' &&
              req.headers['x-review-csrf'] !== session.csrf
            ) {
              respond(403, { error: 'Request denied' });
              return;
            }
            if (url.pathname === '/api/session') {
              respond(200, { csrf: session.csrf });
              return;
            }
            const app = await host(),
              scope = session.scope;
            if (url.pathname.startsWith('/api/original/')) {
              const [, , , itemId, evidenceId] = url.pathname.split('/');
              const { service } = await app.service(scope);
              const evidence = (await service.getEvidence(itemId)).find(
                (e) => e.id === evidenceId,
              );
              if (!evidence) throw new Error('Unavailable');
              const bytes = await service.readEvidence(itemId, evidenceId);
              res.setHeader('Content-Type', evidence.mediaType);
              res.setHeader(
                'Content-Security-Policy',
                "sandbox; default-src 'none'",
              );
              res.end(Buffer.from(bytes));
              return;
            }
            if (url.pathname === '/api/upload') {
              const request = new Request('http://127.0.0.1:5595/intake', {
                method: 'POST',
                headers: {
                  'content-type': req.headers['content-type'] ?? '',
                  'idempotency-key': String(
                    req.headers['idempotency-key'] ?? '',
                  ),
                },
                body,
              });
              respond(200, await app.upload(scope, request));
              return;
            }
            if (url.pathname === '/api/list') {
              respond(
                200,
                await app.list(scope, {
                  state: (url.searchParams.get('state') as never) || undefined,
                  assigneeId: url.searchParams.get('assigneeId') ?? undefined,
                  cursor: url.searchParams.get('cursor') ?? undefined,
                }),
              );
              return;
            }
            if (url.pathname === '/api/load') {
              respond(
                200,
                await app.load(
                  scope,
                  url.searchParams.get('itemId') ?? '',
                  url.searchParams.get('cursor') ?? undefined,
                ),
              );
              return;
            }
            if (url.pathname === '/api/result') {
              respond(
                200,
                await app.result(scope, url.searchParams.get('id') ?? ''),
              );
              return;
            }
            const input = body.length ? JSON.parse(body.toString()) : {};
            const allowed: Record<string, string[]> = {
              preview: ['itemId', 'attemptId', 'index', 'requestId'],
              decide: [
                'actionId',
                'expectedRevision',
                'expectedReviewVersion',
                'bindingHash',
                'requestId',
                'decision',
                'reason',
                'correctedArgs',
              ],
              apply: ['actionId'],
              assign: ['itemId', 'expectedVersion', 'assigneeId', 'requestId'],
              split: [
                'itemId',
                'attemptId',
                'expectedRevision',
                'evidenceId',
                'groups',
                'requestId',
              ],
              candidates: ['itemId', 'handlerId', 'handlerVersion', 'query'],
              editAction: [
                'itemId',
                'actionId',
                'attemptId',
                'expectedRevision',
                'requestId',
                'handlerId',
                'handlerVersion',
                'args',
                'dependencies',
              ],
              editPlan: [
                'itemId',
                'attemptId',
                'planKey',
                'expectedRevision',
                'requestId',
                'handlerId',
                'handlerVersion',
                'args',
              ],
              revoke: [],
            };
            const operation = url.pathname.slice('/api/'.length);
            if (
              !allowed[operation] ||
              !input ||
              typeof input !== 'object' ||
              Array.isArray(input) ||
              Object.keys(input).some(
                (key) => !allowed[operation].includes(key),
              )
            )
              throw new Error('Invalid request');
            const { service } = await app.service(scope);
            let result: unknown;
            switch (operation) {
              case 'preview':
                result = await app.preview(scope, input);
                break;
              case 'decide':
                result = await app.decide(scope, input);
                break;
              case 'apply':
                result = await service.applyAction(input.actionId);
                break;
              case 'assign':
                result = await app.assign(scope, input);
                break;
              case 'split':
                result = await app.split(scope, input);
                break;
              case 'candidates':
                result = await service.findCandidates(input);
                break;
              case 'editPlan':
                result = await service.previewPlan(input);
                break;
              case 'editAction':
                result = await service.previewProposal(input);
                break;
              case 'revoke':
                await app.revoke(scope.actorId);
                result = {};
                break;
            }
            respond(200, result ?? {});
          } catch {
            respond(409, {
              error: 'Review unavailable; refresh current state',
            });
          }
        });
        server.httpServer?.once('close', () => {
          void app.db.close?.();
        });
      },
    },
  ],
  ssr: { noExternal: ['@happyvertical/smrt-ui'] },
  server: { fs: { allow: ['../..'] } },
});
