/**
 * A write that names a field the caller may not write is refused only when
 * its value differs from what is stored (#5195).
 *
 * One suite, run on SQLite by `protected-field-writes.test.ts` and on
 * PostgreSQL by `protected-field-writes-postgres.optional.test.ts`, over every
 * write path that shares the rule: runtime REST, the emitted SvelteKit
 * routes, runtime sync apply and the emitted sync route. Records are read back
 * through runtime REST, exactly as a client fetches them, and sent back.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection.js';
import { field } from '../../decorators/index.js';
import { MCPGenerator } from '../../generators/mcp.js';
import { APIGenerator } from '../../generators/rest.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { type EmittedProject, emitTransports } from './emitted-transports.js';

const ISSUED = '2026-03-04T05:06:07.890Z';

@smrt({ api: { include: ['list', 'get', 'create', 'update'] } })
export class ProtectedWriteRecord extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', readonly: true })
  code: string = '';

  @field({ type: 'datetime', readonly: true })
  issuedAt: Date | null = null;

  @field({ type: 'decimal', readonly: true })
  rate: number = 0.0;

  @field({ type: 'json', readonly: true })
  facts: Record<string, unknown> = {};

  @field({ type: 'boolean', readonly: true })
  sealed: boolean = false;

  @field({ type: 'integer', readonly: true })
  revision: number = 0;
}
export class ProtectedWriteRecordCollection extends SmrtCollection<ProtectedWriteRecord> {
  static readonly _itemClass = ProtectedWriteRecord;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update'], writable: ['label'] },
})
export class ProtectedWriteListed extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text' })
  note: string = '';
}
export class ProtectedWriteListedCollection extends SmrtCollection<ProtectedWriteListed> {
  static readonly _itemClass = ProtectedWriteListed;
}

/** Protected fields the caller cannot read: a guess must not be confirmed. */
@smrt({ api: { include: ['list', 'get', 'create', 'update'] } })
export class ProtectedWriteSecret extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', readonly: true, sensitive: true })
  secretHash: string = '';

  @field({
    type: 'text',
    readonly: true,
    readPermission: 'protectedwritesecret.read_gated',
  })
  gated: string = '';

  /** Write-only aliases over the two hidden columns. */
  set token(value: string) {
    this.secretHash = value;
  }
  set gatedToken(value: string) {
    this.gated = value;
  }
}
export class ProtectedWriteSecretCollection extends SmrtCollection<ProtectedWriteSecret> {
  static readonly _itemClass = ProtectedWriteSecret;
}

export const PROTECTED_WRITE_CLASSES = [
  'ProtectedWriteRecord',
  'ProtectedWriteListed',
  'ProtectedWriteSecret',
];

/** What a transport answered to one write. */
interface Outcome {
  applied: boolean;
  status: number | string;
  code?: string;
  field?: string;
  text: string;
}

type Model = 'record' | 'listed' | 'secret';

interface Transport {
  name: string;
  update(model: Model, id: string, body: unknown): Promise<Outcome>;
  create(model: Model, body: Record<string, unknown>): Promise<Outcome>;
}

const TRANSPORTS = [
  'runtime REST',
  'emitted SvelteKit route',
  'runtime sync apply',
  'emitted sync route',
  'in-process MCP',
  'emitted MCP server',
  'emitted modular MCP server',
] as const;

/** Emitted MCP servers open their own SQLite file, so they run on SQLite only. */
const FILE_DATABASE_TRANSPORTS = new Set<string>([
  'emitted MCP server',
  'emitted modular MCP server',
]);

/**
 * Register the suite. `open` returns the database the suite writes to (its
 * schema for {@link PROTECTED_WRITE_CLASSES} prepared); `close` releases it.
 */
export function describeProtectedFieldWrites(
  engine: string,
  open: () => Promise<{ db: DatabaseInterface; dbUrl: string }>,
  close: (db: DatabaseInterface) => Promise<void>,
): void {
  describe(`protected field writes (${engine})`, () => {
    let db: DatabaseInterface;
    let records: ProtectedWriteRecordCollection;
    let listed: ProtectedWriteListedCollection;
    let secrets: ProtectedWriteSecretCollection;
    let rest: (req: Request) => Promise<Response>;
    let emitted: EmittedProject;
    const segment = {} as Record<Model, string>;
    const transports = new Map<string, Transport>();

    beforeAll(async () => {
      ObjectRegistry.registerCollection(
        'ProtectedWriteRecord',
        ProtectedWriteRecordCollection as never,
      );
      ObjectRegistry.registerCollection(
        'ProtectedWriteListed',
        ProtectedWriteListedCollection as never,
      );
      ObjectRegistry.registerCollection(
        'ProtectedWriteSecret',
        ProtectedWriteSecretCollection as never,
      );
      const opened = await open();
      db = opened.db;
      records = await ProtectedWriteRecordCollection.create({ db });
      listed = await ProtectedWriteListedCollection.create({ db });
      secrets = await ProtectedWriteSecretCollection.create({ db });
      for (const [model, name] of [
        ['record', 'ProtectedWriteRecord'],
        ['listed', 'ProtectedWriteListed'],
        ['secret', 'ProtectedWriteSecret'],
      ] as const) {
        const info = ObjectRegistry.getClass(name);
        if (!info) throw new Error(`${name} is not registered`);
        segment[model] = info.collection as string;
      }

      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req: Request) => req },
        { db },
      );
      api.registerCollection(segment.record, records as never);
      api.registerCollection(segment.listed, listed as never);
      api.registerCollection(segment.secret, secrets as never);
      rest = api.generateHandler();
      emitted = await emitTransports(PROTECTED_WRITE_CLASSES, {
        db,
        dbUrl: opened.dbUrl,
      });

      // The caller's own tenant: a create body naming any other tenant is
      // refused (403 TENANT_MISMATCH, #5195), so the "server-managed keys are
      // left out" control below names the caller's tenant, not a foreign one.
      const principal = (model: Model) => ({
        user: { id: 'user-1', tenantId: 'other-tenant' },
        permissions: [`${segment[model]}.create`, `${segment[model]}.update`],
      });
      const fromHttp = (status: number, body: unknown): Outcome => {
        const error = (
          body as {
            error?: { code?: string; details?: { field?: string } };
          } | null
        )?.error;
        return {
          applied: status === 200 || status === 201,
          status,
          code: error?.code,
          field: error?.details?.field,
          text: `${status} ${JSON.stringify(body)}`,
        };
      };
      const fromSync = (body: unknown): Outcome => {
        const [result] = (body as { results: SyncResult[] }).results;
        return {
          applied: result.status === 'applied',
          status: result.status,
          code: result.details?.code ?? result.reason,
          field: result.details?.field,
          text: JSON.stringify(body),
        };
      };
      const restCall = async (
        method: string,
        path: string,
        body: unknown,
      ): Promise<Outcome> => {
        const response = await rest(
          new Request(`http://local/api/${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
        const text = await response.text();
        return fromHttp(response.status, text ? JSON.parse(text) : null);
      };
      const item = (
        model: Model,
        op: 'create' | 'update',
        id: string,
        payload: unknown,
      ) => ({
        items: [{ itemId: 'item-1', object: segment[model], op, id, payload }],
      });

      transports.set('runtime REST', {
        name: 'runtime REST',
        update: (model, id, body) =>
          restCall('PATCH', `${segment[model]}/${id}`, body),
        create: (model, body) => restCall('POST', segment[model], body),
      });
      transports.set('emitted SvelteKit route', {
        name: 'emitted SvelteKit route',
        update: async (model, id, body) => {
          const result = await emitted.http(
            `${segment[model]}/[id]/+server.ts`,
            'PUT',
            { body, params: { id }, locals: principal(model) },
          );
          return fromHttp(result.status, result.body);
        },
        create: async (model, body) => {
          const result = await emitted.http(
            `${segment[model]}/+server.ts`,
            'POST',
            { body, locals: principal(model) },
          );
          return fromHttp(result.status, result.body);
        },
      });
      const runtimeSync = async (batch: unknown) => {
        const response = await rest(
          new Request('http://local/api/sync/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch),
          }),
        );
        return (await response.json()) as { results: SyncResult[] };
      };
      const emittedSync = async (batch: unknown, model: Model = 'record') => {
        const result = await emitted.http('sync/apply/+server.ts', 'POST', {
          body: batch,
          locals: principal(model),
        });
        return result.body as { results: SyncResult[] };
      };
      syncBatch.set('runtime sync apply', runtimeSync);
      syncBatch.set('emitted sync route', (batch) => emittedSync(batch));
      transports.set('runtime sync apply', {
        name: 'runtime sync apply',
        update: async (model, id, body) =>
          fromSync(await runtimeSync(item(model, 'update', id, body))),
        create: async (model, body) =>
          fromSync(
            await runtimeSync(item(model, 'create', crypto.randomUUID(), body)),
          ),
      });
      transports.set('emitted sync route', {
        name: 'emitted sync route',
        update: async (model, id, body) =>
          fromSync(await emittedSync(item(model, 'update', id, body), model)),
        create: async (model, body) =>
          fromSync(
            await emittedSync(
              item(model, 'create', crypto.randomUUID(), body),
              model,
            ),
          ),
      });
      // MCP tools answer with an error result, not a status: the code is the
      // one the tool reports and the field is named in its message.
      const fromTool = (result: {
        isError?: boolean;
        structuredContent?: unknown;
      }): Outcome => {
        const error = (
          result.structuredContent as
            | { error?: { code?: string; message?: string } }
            | undefined
        )?.error;
        return {
          applied: result.isError !== true,
          status: result.isError === true ? 'error' : 'ok',
          code: error?.code,
          field: error?.message?.match(/^Field '(.+)' cannot be written/)?.[1],
          text: JSON.stringify(result),
        };
      };
      const toolOf = (model: Model, verb: 'create' | 'update') =>
        `${{ record: 'protectedwriterecord', listed: 'protectedwritelisted', secret: 'protectedwritesecret' }[model]}_${verb}`;
      const toolTransport = (
        name: string,
        call: (tool: string, args: unknown) => Promise<never>,
      ): Transport => ({
        name,
        update: async (model, id, body) =>
          fromTool(
            await call(toolOf(model, 'update'), {
              ...(body as Record<string, unknown>),
              id,
            }),
          ),
        create: async (model, body) =>
          fromTool(await call(toolOf(model, 'create'), body)),
      });
      const inProcess = new MCPGenerator({}, { db, user: { id: 'user-1' } });
      transports.set(
        'in-process MCP',
        toolTransport(
          'in-process MCP',
          (tool, args) =>
            inProcess.handleToolCall({
              method: 'tools/call',
              params: {
                name: tool,
                arguments: args as Record<string, unknown>,
              },
            } as never) as never,
        ),
      );
      if (engine === 'SQLite') {
        for (const [name, modular] of [
          ['emitted MCP server', false],
          ['emitted modular MCP server', true],
        ] as const) {
          const server = await emitted.mcp({ modular });
          transports.set(
            name,
            toolTransport(
              name,
              (tool, args) => server.call(tool, args) as never,
            ),
          );
        }
      }
    });
    const syncBatch = new Map<
      string,
      (batch: unknown) => Promise<{ results: SyncResult[] }>
    >();

    afterAll(async () => {
      emitted?.dispose();
      if (db) await close(db);
    });

    const transport = (name: string): Transport => {
      const found = transports.get(name);
      if (!found) throw new Error(`No transport ${name}`);
      return found;
    };

    async function seedRecord(label: string): Promise<ProtectedWriteRecord> {
      return records.create({
        label,
        code: 'C-1',
        issuedAt: new Date(ISSUED),
        rate: 2.5,
        facts: { b: 1, a: [1, 2], nested: { y: true, x: 'v' } },
        sealed: true,
        revision: 3,
      } as never);
    }

    async function fetchRecord(
      model: Model,
      id: string,
    ): Promise<Record<string, unknown>> {
      const response = await rest(
        new Request(`http://local/api/${segment[model]}/${id}`),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    }

    async function stored(id: string) {
      const row = await records.get(id, { cache: false } as never);
      if (!row) throw new Error(`record ${id} is gone`);
      return {
        label: row.label,
        code: row.code,
        issuedAt:
          row.issuedAt instanceof Date
            ? row.issuedAt.toISOString()
            : row.issuedAt,
        rate: Number(row.rate),
        facts: row.facts,
        sealed: row.sealed,
        revision: Number(row.revision),
      };
    }

    describe.each(
      TRANSPORTS.filter(
        (name) => engine === 'SQLite' || !FILE_DATABASE_TRANSPORTS.has(name),
      ),
    )('%s', (name) => {
      it('accepts a fetched record sent back with a writable change', async () => {
        const record = await seedRecord(`${name}: round trip`);
        const body = await fetchRecord('record', record.id as string);
        const before = await stored(record.id as string);
        const outcome = await transport(name).update(
          'record',
          record.id as string,
          {
            ...body,
            label: `${name}: round trip, edited`,
          },
        );
        expect(outcome.applied, outcome.text).toBe(true);
        expect(await stored(record.id as string)).toEqual({
          ...before,
          label: `${name}: round trip, edited`,
        });
      });

      it('refuses a changed read-only field and names it, changing nothing', async () => {
        const record = await seedRecord(`${name}: read-only change`);
        const body = await fetchRecord('record', record.id as string);
        const before = await stored(record.id as string);
        const outcome = await transport(name).update(
          'record',
          record.id as string,
          {
            ...body,
            label: 'not applied',
            code: 'C-2',
          },
        );
        expect(outcome.applied, outcome.text).toBe(false);
        expect(outcome.code).toBe('VALIDATION_FIELD_NOT_WRITABLE');
        expect(outcome.field).toBe('code');
        if (typeof outcome.status === 'number')
          expect(outcome.status).toBe(400);
        else if (name.includes('sync'))
          expect(outcome.text).toContain('invalid_payload');
        expect(await stored(record.id as string)).toEqual(before);
      });

      it('refuses a changed field outside api.writable, and accepts it unchanged', async () => {
        const created = await listed.create({
          label: `${name}: listed`,
          note: 'kept',
        } as never);
        const id = created.id as string;
        const body = await fetchRecord('listed', id);
        expect(body.note).toBe('kept');

        const unchanged = await transport(name).update('listed', id, {
          ...body,
          label: `${name}: listed, edited`,
        });
        expect(unchanged.applied, unchanged.text).toBe(true);

        const changed = await transport(name).update('listed', id, {
          ...body,
          note: 'replaced',
        });
        expect(changed.applied, changed.text).toBe(false);
        expect(changed.code).toBe('VALIDATION_FIELD_NOT_WRITABLE');
        expect(changed.field).toBe('note');
        const row = await listed.get(id, { cache: false } as never);
        expect(row?.note).toBe('kept');
        expect(row?.label).toBe(`${name}: listed, edited`);
      });

      it('refuses an underscore key the row does not hold', async () => {
        const record = await seedRecord(`${name}: control key`);
        const outcome = await transport(name).update(
          'record',
          record.id as string,
          {
            label: 'not applied',
            _insertOnly: true,
          },
        );
        expect(outcome.applied, outcome.text).toBe(false);
        expect(outcome.field).toBe('_insertOnly');
      });

      it('ignores a concurrent updatedAt change in a fetched record', async () => {
        const record = await seedRecord(`${name}: concurrent`);
        const body = await fetchRecord('record', record.id as string);
        // Another writer saves the row after the fetch: its timestamps move.
        await new Promise((resolve) => setTimeout(resolve, 15));
        const other = await records.get(
          record.id as string,
          {
            cache: false,
          } as never,
        );
        if (!other) throw new Error('row missing');
        other.label = `${name}: concurrent, other writer`;
        await other.save();
        const after = await fetchRecord('record', record.id as string);
        expect(after.updated_at).not.toEqual(body.updated_at);

        const outcome = await transport(name).update(
          'record',
          record.id as string,
          {
            ...body,
            label: `${name}: concurrent, mine`,
          },
        );
        expect(outcome.applied, outcome.text).toBe(true);
        expect((await stored(record.id as string)).label).toBe(
          `${name}: concurrent, mine`,
        );

        // Negative control: the same stale body still refuses a changed
        // read-only field.
        const refused = await transport(name).update(
          'record',
          record.id as string,
          {
            ...body,
            code: 'C-9',
          },
        );
        expect(refused.applied, refused.text).toBe(false);
        expect(refused.field).toBe('code');
      });

      it('compares dates, decimals, JSON, booleans and integers after normalisation', async () => {
        const record = await seedRecord(`${name}: normalised`);
        const id = record.id as string;
        const before = await stored(id);
        const equal = await transport(name).update('record', id, {
          label: `${name}: normalised, edited`,
          code: 'C-1',
          issuedAt: '2026-03-04T05:06:07.890+00:00',
          rate: '2.50',
          facts: { nested: { x: 'v', y: true }, a: [1, 2], b: 1 },
          sealed: 1,
          revision: '3',
        });
        expect(equal.applied, equal.text).toBe(true);
        expect(await stored(id)).toEqual({
          ...before,
          label: `${name}: normalised, edited`,
        });

        for (const [key, value] of [
          ['issuedAt', '2026-03-04T05:06:07.891Z'],
          ['rate', 2.51],
          ['facts', { b: 1, a: [2, 1], nested: { y: true, x: 'v' } }],
          ['sealed', false],
          ['revision', 4],
        ] as const) {
          const outcome = await transport(name).update('record', id, {
            [key]: value,
          });
          expect(outcome.applied, `${key}: ${outcome.text}`).toBe(false);
          expect(outcome.field).toBe(key);
        }
        expect(await stored(id)).toEqual({
          ...before,
          label: `${name}: normalised, edited`,
        });
      });

      it('refuses a create that names a protected field with a value', async () => {
        const label = `${name}: refused create`;
        for (const [model, body, refused] of [
          ['record', { label, code: 'C-7' }, 'code'],
          ['record', { label, _insertOnly: true }, '_insertOnly'],
          ['listed', { label, note: 'set' }, 'note'],
        ] as const) {
          const outcome = await transport(name).create(model, body);
          expect(outcome.applied, outcome.text).toBe(false);
          expect(outcome.code).toBe('VALIDATION_FIELD_NOT_WRITABLE');
          expect(outcome.field).toBe(refused);
        }
        expect(await records.list({ where: { label } })).toHaveLength(0);
        expect(await listed.list({ where: { label } })).toHaveLength(0);

        // Negative control: null protected fields and server-managed keys
        // are left out, and the create succeeds with the defaults.
        const okLabel = `${name}: accepted create`;
        const outcome = await transport(name).create('record', {
          label: okLabel,
          code: null,
          revision: null,
          createdAt: '2001-01-01T00:00:00.000Z',
          updated_at: '2001-01-01T00:00:00.000Z',
          tenantId: 'other-tenant',
        });
        expect(outcome.applied, outcome.text).toBe(true);
        const [created] = await records.list({ where: { label: okLabel } });
        expect(created?.code).toBe('');
        expect(Number(created?.revision)).toBe(0);
      });
    });

    describe.each(
      TRANSPORTS.filter(
        (name) => engine === 'SQLite' || !FILE_DATABASE_TRANSPORTS.has(name),
      ),
    )('%s: protected fields the caller cannot read', (name) => {
      const GUESS = 'guess-that-is-wrong';
      const CORRECT = 'hash-that-is-correct';
      const GATED = 'gated-value';

      async function seedSecret(label: string) {
        const row = await secrets.create({
          label,
          secretHash: CORRECT,
          gated: GATED,
        } as never);
        return row.id as string;
      }
      const snapshot = async (id: string) => {
        const row = await secrets.get(id, { cache: false } as never);
        return {
          label: row?.label,
          secretHash: row?.secretHash,
          gated: row?.gated,
        };
      };

      it('refuses a correct and a wrong guess identically, comparing nothing', async () => {
        const id = await seedSecret(`${name}: oracle`);
        const before = await snapshot(id);
        for (const key of ['secretHash', 'gated'] as const) {
          const correct = await transport(name).update('secret', id, {
            label: 'not applied',
            [key]: key === 'secretHash' ? CORRECT : GATED,
          });
          const wrong = await transport(name).update('secret', id, {
            label: 'not applied',
            [key]: GUESS,
          });
          expect(correct.applied, correct.text).toBe(false);
          expect(wrong.applied, wrong.text).toBe(false);
          expect(correct.code).toBe('VALIDATION_FIELD_NOT_WRITABLE');
          expect(correct.field).toBe(key);
          // The same answer: nothing about the stored value is revealed.
          expect(correct).toEqual({ ...wrong, text: correct.text });
          expect(correct.text.replace(CORRECT, '').replace(GATED, '')).toBe(
            wrong.text.replace(GUESS, ''),
          );
          expect(correct.text).not.toContain(
            key === 'secretHash' ? GATED : CORRECT,
          );
        }
        expect(await snapshot(id)).toEqual(before);
      });

      it('answers an accessor over a hidden field the same for any value', async () => {
        const id = await seedSecret(`${name}: accessor oracle`);
        const before = await snapshot(id);
        for (const [alias, hidden, stored] of [
          ['token', 'secretHash', CORRECT],
          ['gatedToken', 'gated', GATED],
        ] as const) {
          const correct = await transport(name).update('secret', id, {
            [alias]: stored,
          });
          const wrong = await transport(name).update('secret', id, {
            [alias]: GUESS,
          });
          expect(correct.applied, correct.text).toBe(false);
          expect(wrong.applied, wrong.text).toBe(false);
          expect(correct.code).toBe('VALIDATION_FIELD_NOT_WRITABLE');
          // The same answer, naming the alias and never the hidden field.
          expect(correct.field).toBe(alias);
          expect({ ...correct, text: '' }).toEqual({ ...wrong, text: '' });
          expect(correct.text.replace(stored, '')).toBe(
            wrong.text.replace(GUESS, ''),
          );
          expect(correct.text).not.toMatch(new RegExp(`\\b${hidden}\\b`));
        }
        expect(await snapshot(id)).toEqual(before);
      });

      it('still accepts the record the caller read sent back', async () => {
        const id = await seedSecret(`${name}: visible round trip`);
        const body = await fetchRecord('secret', id);
        expect(body).not.toHaveProperty('secretHash');
        expect(body).not.toHaveProperty('gated');
        const outcome = await transport(name).update('secret', id, {
          ...body,
          label: `${name}: visible round trip, edited`,
        });
        expect(outcome.applied, outcome.text).toBe(true);
        expect(await snapshot(id)).toEqual({
          label: `${name}: visible round trip, edited`,
          secretHash: CORRECT,
          gated: GATED,
        });
      });
    });

    describe.each([
      'runtime sync apply',
      'emitted sync route',
    ] as const)('%s batch', (name) => {
      it('refuses only the item that changes a protected field', async () => {
        const kept = await seedRecord(`${name}: batch ok`);
        const guarded = await seedRecord(`${name}: batch refused`);
        const keptBody = await fetchRecord('record', kept.id as string);
        const guardedBefore = await stored(guarded.id as string);
        const createId = crypto.randomUUID();
        const okCreateId = crypto.randomUUID();
        const send = syncBatch.get(name);
        if (!send) throw new Error(`No sync transport ${name}`);
        const { results } = await send({
          items: [
            {
              itemId: 'ok-update',
              object: segment.record,
              op: 'update',
              id: kept.id,
              payload: { ...keptBody, label: `${name}: batch ok, edited` },
            },
            {
              itemId: 'refused-update',
              object: segment.record,
              op: 'update',
              id: guarded.id,
              payload: { label: 'not applied', code: 'C-5' },
            },
            {
              itemId: 'refused-create',
              object: segment.record,
              op: 'create',
              id: createId,
              payload: { label: `${name}: batch refused create`, rate: 9.5 },
            },
            {
              itemId: 'ok-create',
              object: segment.record,
              op: 'create',
              id: okCreateId,
              payload: { label: `${name}: batch ok create` },
            },
          ],
        });
        expect(results.map((result) => result.status)).toEqual([
          'applied',
          'rejected',
          'rejected',
          'applied',
        ]);
        expect(results[1]).toMatchObject({
          reason: 'invalid_payload',
          details: { code: 'VALIDATION_FIELD_NOT_WRITABLE', field: 'code' },
        });
        expect(results[2]).toMatchObject({
          reason: 'invalid_payload',
          details: { code: 'VALIDATION_FIELD_NOT_WRITABLE', field: 'rate' },
        });
        expect(results[0].details).toBeUndefined();
        expect((await stored(kept.id as string)).label).toBe(
          `${name}: batch ok, edited`,
        );
        expect(await stored(guarded.id as string)).toEqual(guardedBefore);
        expect(await records.get(createId)).toBeNull();
        expect(await records.get(okCreateId)).not.toBeNull();
      });
    });
  });
}

interface SyncResult {
  status: string;
  reason?: string;
  details?: { code: string; field: string };
}
