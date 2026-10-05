import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, AuditWriter } from '../audit.js';
import { withAuditContext } from '../audit-context.js';
import { buildCascadePlan } from '../cascade.js';
import { SmrtCollection } from '../collection.js';
import { field, foreignKey } from '../decorators/index.js';
import { createGeneratedCollectionAccess } from '../generated-collection-access.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { normalizeTypedHttpError } from '../generators/typed-http-error.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { getTestDatabase } from '../testing/database.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator.js';

@smrt({ tableName: 'issue_3460_records', audit: true })
class Issue3460Record extends SmrtObject {
  title: string = '';
  @field({ sensitive: true })
  secret: string = '';
  @field({ readPermission: 'record.private' })
  privateNote: string = '';
  @field({ readonly: true })
  locked: string = 'fixed';
}
class Issue3460Records extends SmrtCollection<Issue3460Record> {
  static readonly _itemClass = Issue3460Record;
}
@smrt({
  tableName: 'issue_3460_custom_owner',
  audit: true,
  tenantScoped: { field: 'organizationId' },
})
class Issue3460CustomOwner extends SmrtObject {
  organizationId: string = '';
  title: string = '';
}
class Issue3460CustomOwners extends SmrtCollection<Issue3460CustomOwner> {
  static readonly _itemClass = Issue3460CustomOwner;
}
@smrt({ tableName: 'issue_3460_audit_entries' })
class Issue3460Entry extends SmrtObject {
  entry: Record<string, unknown> = {};
}
@smrt({ tableName: 'issue_3460_children' })
class Issue3460Child extends SmrtObject {
  @foreignKey(Issue3460Record, {
    onDelete: 'CASCADE',
    constraint: { engines: ['sqlite', 'postgres'] },
  })
  recordId: string = '';
}
@smrt({ tableName: 'issue_3460_plain' })
class Issue3460Plain extends SmrtObject {
  title: string = '';
}
class Issue3460Plains extends SmrtCollection<Issue3460Plain> {
  static readonly _itemClass = Issue3460Plain;
}

for (const type of ['sqlite', 'duckdb', 'postgres'] as const) {
  const suite =
    type === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL
      ? describe.skip
      : describe;
  suite(`collection audit on ${type}`, () => {
    let db: DatabaseInterface;
    let records: Issue3460Records;
    let entries: AuditEntry[];
    let fail = false;
    const writer: AuditWriter = async (entry, tx) => {
      expect(tx).not.toBe(db);
      const log = new Issue3460Entry({ db: tx, entry });
      await log.initialize();
      await log.save();
      if (fail) throw new Error('audit store unavailable');
      entries.push(entry);
    };
    beforeEach(async () => {
      entries = [];
      fail = false;
      db = await getTestDatabase({
        type,
        url:
          type === 'postgres' ? process.env.SMRT_TEST_POSTGRES_URL : undefined,
        classes: [
          'Issue3460Record',
          'Issue3460Entry',
          'Issue3460Plain',
          'Issue3460Child',
          'Issue3460CustomOwner',
        ],
      });
      if (type === 'postgres') {
        for (const table of [
          'issue_3460_custom_owner',
          'issue_3460_children',
          'issue_3460_records',
          'issue_3460_audit_entries',
          'issue_3460_plain',
        ])
          await db.query(`DELETE FROM ${table}`);
      }
      records = await Issue3460Records.create({
        db,
        auditTrail: { actorId: 'actor-1', writer },
      });
    });
    afterEach(async () => {
      await db?.close?.();
    });

    it('records CRUD actor/reason/public diffs and keeps sensitive values absent', async () => {
      const record = await records.create(
        { title: 'Before', secret: 'never-log', privateNote: 'private' },
        { actorId: 'actor-2', reason: 'Initial import' },
      );
      expect(entries[0]).toMatchObject({
        actorId: 'actor-2',
        action: 'created',
        reason: 'Initial import',
        resourceId: record.id,
      });
      expect(entries[0].changes.title).toEqual({
        before: null,
        after: 'Before',
      });
      await records.update(
        record.id as string,
        { title: 'After', secret: 'never-log-either' },
        { actorId: 'actor-1', reason: 'Correction' },
      );
      expect(entries[1].changes.title).toEqual({
        before: 'Before',
        after: 'After',
      });
      expect(entries[1]).toMatchObject({
        action: 'updated',
        reason: 'Correction',
      });
      await records.delete(record.id as string);
      expect(entries[2].changes.title).toEqual({
        before: 'After',
        after: null,
      });
      expect(entries[2].action).toBe('deleted');
      expect(JSON.stringify(entries)).not.toContain('never-log');
      expect(JSON.stringify(entries)).not.toContain('privateNote');
      expect(
        await records.get(record.id as string, { cache: false }),
      ).toBeNull();
      expect(await records.delete(record.id as string)).toBe(false);
      expect(
        await records.update(record.id as string, { title: 'missing' }),
      ).toBeNull();
    });

    it('rolls back create, update, delete and audit entry when writer fails', async () => {
      fail = true;
      await expect(records.create({ title: 'Failed' })).rejects.toThrow(
        'audit store unavailable',
      );
      expect(await records.count()).toBe(0);
      expect((await db.list('issue_3460_audit_entries', {})).length).toBe(0);
      fail = false;
      const record = await records.create({ title: 'Before' });
      fail = true;
      await expect(
        records.update(record.id as string, { title: 'Failed update' }),
      ).rejects.toThrow('audit store unavailable');
      expect(
        (await records.get(record.id as string, { cache: false }))?.title,
      ).toBe('Before');
      await expect(records.delete(record.id as string)).rejects.toThrow(
        'audit store unavailable',
      );
      expect(await records.count()).toBe(1);
      expect((await db.list('issue_3460_audit_entries', {})).length).toBe(1);
    });

    it('rolls back referenced child cascades with the audit writer and commits both on success', async () => {
      const row = await records.create({ title: 'Parent' });
      const target = ObjectRegistry.getClassByConstructor(Issue3460Record)
        ?.qualifiedName as string;
      const childName = ObjectRegistry.getClassByConstructor(Issue3460Child)
        ?.qualifiedName as string;
      const plan = buildCascadePlan(ObjectRegistry, target);
      expect(
        plan.references.map((reference) => reference.tableName),
        JSON.stringify({
          target,
          childName,
          relationships: ObjectRegistry.getRelationships(childName),
        }),
      ).toContain('issue_3460_children');
      const child = new Issue3460Child({ db, recordId: row.id });
      await child.initialize();
      await child.save();
      fail = true;
      await expect(records.delete(row.id as string)).rejects.toThrow(
        'audit store unavailable',
      );
      expect(await records.count()).toBe(1);
      expect((await db.list('issue_3460_children', {})).length).toBe(1);
      expect((await db.list('issue_3460_audit_entries', {})).length).toBe(1);
      fail = false;
      expect(await records.delete(row.id as string)).toBe(true);
      expect(await records.count()).toBe(0);
      expect((await db.list('issue_3460_children', {})).length).toBe(0);
      expect(entries.map((entry) => entry.action)).toEqual([
        'created',
        'deleted',
      ]);
    });

    it('fails closed without trusted audit setup and refuses protected update fields', async () => {
      const unconfigured = await Issue3460Records.create({ db });
      await expect(unconfigured.create({ title: 'No actor' })).rejects.toThrow(
        'authenticated actorId',
      );
      const record = await records.create({ title: 'Valid' });
      await expect(
        records.update(record.id as string, { id: 'different' }),
      ).rejects.toThrow('cannot assign');
      await expect(
        unconfigured.update(record.id as string, { title: 'No actor' }),
      ).rejects.toThrow('authenticated actorId');
      await expect(unconfigured.delete(record.id as string)).rejects.toThrow(
        'authenticated actorId',
      );
      expect(await records.count()).toBe(1);
    });

    it('refuses natural-key create overwrite and audits getOrUpsert updates', async () => {
      const record = await records.create({ slug: 'same', title: 'Before' });
      await expect(
        records.create({ slug: 'same', title: 'Overwrite' }),
      ).rejects.toThrow();
      expect(
        (await records.get(record.id as string, { cache: false }))?.title,
      ).toBe('Before');
      await records.getOrUpsert({ id: record.id, title: 'After' });
      expect(entries.map((entry) => entry.action)).toEqual([
        'created',
        'updated',
      ]);
    });

    it('rejects a disappeared upsert target without returning null or creating an audit entry', async () => {
      const record = await records.create({ title: 'Before' });
      const update = records.update.bind(records);
      const racedUpdate = vi
        .spyOn(records, 'update')
        .mockImplementationOnce(async (id, values, context) => {
          await db.query('DELETE FROM issue_3460_records WHERE id = $1', id);
          return await update(id, values, context);
        });
      try {
        await expect(
          records.getOrUpsert({ id: record.id, title: 'After' }),
        ).rejects.toThrow('Record disappeared before getOrUpsert update');
        expect(await records.count()).toBe(0);
        expect(entries.map((entry) => entry.action)).toEqual(['created']);
      } finally {
        racedUpdate.mockRestore();
      }
    });

    it('leaves ordinary models usable without an audit writer', async () => {
      const plain = await Issue3460Plains.create({ db });
      const row = await plain.create({ title: 'Before' });
      await plain.update(row.id as string, { title: 'After' });
      await plain.delete(row.id as string);
      expect(entries).toHaveLength(0);
    });

    it('records the configured custom owner for every mutation rather than assuming tenantId', async () => {
      const custom = await Issue3460CustomOwners.create({
        db,
        auditTrail: { actorId: 'actor-1', writer },
      });
      const owner = '00000000-0000-4000-8000-0000000000a1';
      const row = await custom.create({
        organizationId: owner,
        title: 'Before',
      });
      await custom.update(row.id as string, { title: 'After' });
      await custom.delete(row.id as string);
      expect(entries.map((entry) => entry.action)).toEqual([
        'created',
        'updated',
        'deleted',
      ]);
      expect(entries.every((entry) => entry.tenantId === owner)).toBe(true);
    });

    it('isolates async request principals and restores context after each request', async () => {
      const shared = await Issue3460Records.create({ db });
      await Promise.all([
        withAuditContext({ actorId: 'request-a', writer }, async () => {
          await Promise.resolve();
          await shared.create({ title: 'Request A' });
        }),
        withAuditContext({ actorId: 'request-b', writer }, async () => {
          await Promise.resolve();
          await shared.create({ title: 'Request B' });
        }),
      ]);
      expect(
        entries.find((entry) => entry.changes.title.after === 'Request A')
          ?.actorId,
      ).toBe('request-a');
      expect(
        entries.find((entry) => entry.changes.title.after === 'Request B')
          ?.actorId,
      ).toBe('request-b');
      await expect(shared.create({ title: 'Outside request' })).rejects.toThrow(
        'authenticated actorId',
      );
    });

    it('audits runtime REST CRUD and rolls back a generated update when the writer fails', async () => {
      const api = new APIGenerator(
        { authMiddleware: () => async (request) => request },
        { db },
      );
      api.registerCollection('issue3460records', records);
      const request = (
        method: string,
        suffix: string,
        body?: Record<string, unknown>,
      ) =>
        new Request(`http://localhost/api/v1/issue3460records${suffix}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const handler = api.generateHandler();
      const created = await handler(request('POST', '', { title: 'Rest' }));
      expect(created.status).toBe(201);
      const row = (await created.json()) as { id: string };
      fail = true;
      expect(
        (await handler(request('PUT', `/${row.id}`, { title: 'Failed' })))
          .status,
      ).toBe(500);
      expect((await records.get(row.id, { cache: false }))?.title).toBe('Rest');
      fail = false;
      expect(
        (await handler(request('PUT', `/${row.id}`, { title: 'Changed' })))
          .status,
      ).toBe(200);
      expect((await handler(request('DELETE', `/${row.id}`))).status).toBe(204);
      expect(entries.map((entry) => entry.action)).toEqual([
        'created',
        'updated',
        'deleted',
      ]);
    });

    it('records offline sync changes once on replay and rolls back a failed audited update', async () => {
      const api = new APIGenerator(
        { authMiddleware: () => async (request) => request },
        { db },
      );
      api.registerCollection('issue3460records', records);
      const handler = api.generateHandler();
      const id = crypto.randomUUID();
      const apply = async (
        op: 'create' | 'update' | 'delete',
        title?: string,
      ) => {
        const response = await handler(
          new Request('http://localhost/api/v1/sync/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: [
                {
                  itemId: `${op}-1`,
                  object: 'issue3460records',
                  id,
                  op,
                  payload: title ? { title } : {},
                },
              ],
            }),
          }),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          results: Array<{ status: string }>;
        };
      };
      await apply('create', 'Initial');
      await apply('create', 'Initial');
      expect(entries).toHaveLength(1);
      fail = true;
      const denied = await apply('update', 'Failed');
      expect(denied.results[0].status).toBe('rejected');
      expect((await records.get(id, { cache: false }))?.title).toBe('Initial');
      fail = false;
      await apply('update', 'Changed');
      await apply('update', 'Changed');
      await apply('delete');
      await apply('delete');
      expect(entries.map((entry) => entry.action)).toEqual([
        'created',
        'updated',
        'deleted',
      ]);
      expect((await db.list('issue_3460_audit_entries', {})).length).toBe(3);
    });

    it('executes emitted SvelteKit update/delete with readonly guards and atomic audit', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'smrt-audit-route-'));
      const key = Symbol.for('smrt.issue3460.generated-route');
      const shared = globalThis as unknown as Record<symbol, unknown>;
      const previous = shared[key];
      const row = await records.create({
        title: 'Initial',
        secret: 'secret-before',
      });
      shared[key] = {
        records,
        createGeneratedCollectionAccess,
        normalizeTypedHttpError,
      };
      try {
        await generateSvelteKitRoutes(
          directory,
          {
            version: '1',
            timestamp: 0,
            objects: {
              Issue3460Record: {
                className: 'Issue3460Record',
                qualifiedName: '@happyvertical/smrt-core:Issue3460Record',
                collection: 'issue3460records',
                fields: {
                  title: { type: 'text' },
                  secret: { type: 'text', sensitive: true },
                  privateNote: {
                    type: 'text',
                    readPermission: 'record.private',
                  },
                  locked: { type: 'text', readonly: true },
                },
                methods: {},
                decoratorConfig: {
                  audit: true,
                  api: { include: ['get', 'update', 'delete'], public: true },
                },
              },
            },
          } as unknown as SmartObjectManifest,
          {
            enabled: true,
            routesDir: 'src/routes/api',
            objectsDir: 'src/lib/objects',
          },
        );
        const route = readFileSync(
          join(directory, 'src/routes/api/issue3460records/[id]/+server.ts'),
          'utf8',
        );
        const bundled = await build({
          stdin: {
            contents: route,
            loader: 'ts',
            sourcefile: 'generated-audit-route.ts',
            resolveDir: directory,
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
          plugins: [
            {
              name: 'audit-route-host',
              setup(builder) {
                builder.onResolve(
                  {
                    filter:
                      /^(@sveltejs\/kit|@happyvertical\/smrt-core|\$lib\/server\/smrt(?:-register)?)$/,
                  },
                  (args) => ({ path: args.path, namespace: 'audit-host' }),
                );
                builder.onLoad(
                  { filter: /.*/, namespace: 'audit-host' },
                  (args) => {
                    if (args.path === '@sveltejs/kit')
                      return {
                        contents:
                          'export const json = (data, options = {}) => new Response(JSON.stringify(data), { status: options.status ?? 200 }); export const error = (status, message) => Object.assign(new Error(message), { status });',
                        loader: 'js',
                      };
                    if (args.path === '@happyvertical/smrt-core')
                      return {
                        contents:
                          'const host = globalThis[Symbol.for("smrt.issue3460.generated-route")]; export const createGeneratedCollectionAccess = host.createGeneratedCollectionAccess; export const normalizeTypedHttpError = host.normalizeTypedHttpError;',
                        loader: 'js',
                      };
                    if (args.path.endsWith('smrt-register'))
                      return { contents: '', loader: 'js' };
                    return {
                      contents:
                        'export const runtime = { getCollection: async () => globalThis[Symbol.for("smrt.issue3460.generated-route")].records, classOptions: () => ({}) };',
                      loader: 'js',
                    };
                  },
                );
              },
            },
          ],
        });
        const output = bundled.outputFiles?.[0];
        if (!output)
          throw new Error('Generated audit route produced no output');
        const emitted = (await import(
          `data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}#${crypto.randomUUID()}`
        )) as {
          GET(event: {
            locals: object;
            params: { id: string };
            request: Request;
          }): Promise<Response>;
          PUT(event: {
            locals: object;
            params: { id: string };
            request: Request;
          }): Promise<Response>;
          DELETE(event: {
            locals: object;
            params: { id: string };
          }): Promise<Response>;
        };
        const event = () => ({
          locals: {},
          params: { id: row.id as string },
          request: new Request('http://localhost/api/record', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: 'Changed',
              locked: 'overwrite',
              secret: 'secret-after',
            }),
          }),
        });
        const readEvent = (etag?: string) => ({
          locals: {},
          params: { id: row.id as string },
          request: new Request('http://localhost/api/record', {
            headers: etag ? { 'if-none-match': etag } : {},
          }),
        });
        const originalRead = await emitted.GET(readEvent());
        const originalEtag = originalRead.headers.get('etag');
        expect(originalRead.status).toBe(200);
        expect(originalEtag).toBeTruthy();
        expect(
          (await emitted.GET(readEvent(originalEtag as string))).status,
        ).toBe(304);
        fail = true;
        expect((await emitted.PUT(event())).status).toBe(500);
        expect(
          (await emitted.GET(readEvent(originalEtag as string))).status,
        ).toBe(304);
        expect(
          (await records.get(row.id as string, { cache: false }))?.title,
        ).toBe('Initial');
        fail = false;
        const response = await emitted.PUT(event());
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          title: 'Changed',
          locked: 'fixed',
        });
        const changedRead = await emitted.GET(
          readEvent(originalEtag as string),
        );
        expect(changedRead.status).toBe(200);
        expect(changedRead.headers.get('etag')).not.toBe(originalEtag);
        expect(JSON.stringify(entries)).not.toContain('secret-before');
        expect(JSON.stringify(entries)).not.toContain('secret-after');
        expect(
          (
            await emitted.DELETE({
              locals: {},
              params: { id: row.id as string },
            })
          ).status,
        ).toBe(200);
        expect(entries.map((entry) => entry.action)).toEqual([
          'created',
          'updated',
          'deleted',
        ]);
      } finally {
        if (previous === undefined) delete shared[key];
        else shared[key] = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    });
    it('audits generated MCP tool calls under trusted request context and rolls back writer failure', async () => {
      const mcp = new MCPGenerator(
        { name: 'issue-3460-audit', version: '1.0.0' },
        { db, user: { id: 'actor-1' } },
      );
      const call = (action: string, args: Record<string, unknown>) =>
        withAuditContext({ actorId: 'actor-1', writer, source: 'mcp' }, () =>
          mcp.handleToolCall({
            method: 'tools/call',
            params: { name: `issue3460record_${action}`, arguments: args },
          }),
        );
      const created = await call('create', {
        title: 'MCP initial',
        secret: 'mcp-secret',
      });
      expect(created.isError).not.toBe(true);
      const row = (await records.list())[0];
      expect(row.title).toBe('MCP initial');
      fail = true;
      expect(
        (await call('update', { id: row.id, title: 'Failed' })).isError,
      ).toBe(true);
      expect(
        (await records.get(row.id as string, { cache: false }))?.title,
      ).toBe('MCP initial');
      fail = false;
      expect(
        (
          await call('update', {
            id: row.id,
            title: 'MCP updated',
            locked: 'overwrite',
          })
        ).isError,
      ).not.toBe(true);
      expect(
        (await records.get(row.id as string, { cache: false }))?.locked,
      ).toBe('fixed');
      expect((await call('delete', { id: row.id })).isError).not.toBe(true);
      expect(entries.map((entry) => [entry.action, entry.source])).toEqual([
        ['created', 'mcp'],
        ['updated', 'mcp'],
        ['deleted', 'mcp'],
      ]);
      expect(JSON.stringify(entries)).not.toContain('mcp-secret');
    });
  });
}

describe('JSON automatic audit boundary', () => {
  it('refuses before mutating JSON export persistence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-audit-json-'));
    const db = await getTestDatabase({
      type: 'json',
      url: directory,
      classes: ['Issue3460Record'],
    });
    try {
      let writes = 0;
      const records = await Issue3460Records.create({
        db,
        auditTrail: {
          actorId: 'actor',
          writer: async () => {
            writes += 1;
          },
        },
      });
      await expect(records.create({ title: 'Blocked' })).rejects.toThrow(
        'JSON export adapters are unsupported',
      );
      expect(await records.count()).toBe(0);
      const existing = new Issue3460Record({ db, title: 'Before' });
      await existing.initialize();
      await existing.save();
      await expect(
        records.update(existing.id as string, { title: 'After' }),
      ).rejects.toThrow('JSON export adapters are unsupported');
      await expect(records.delete(existing.id as string)).rejects.toThrow(
        'JSON export adapters are unsupported',
      );
      expect(
        (await records.get(existing.id as string, { cache: false }))?.title,
      ).toBe('Before');
      expect(writes).toBe(0);
    } finally {
      await db.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
