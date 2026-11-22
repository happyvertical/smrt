/**
 * A caller filters and sorts a list only by fields it may read.
 *
 * A filter is a comparison, so filtering on a field answers questions about
 * its value. Every request-facing list and count checks the caller's filter
 * with `assertQueryAccess` against the permissions it projects rows with:
 * a `readPermission` field is a filter key for a caller who holds the slug, a
 * `sensitive` field for nobody, and the whole `_meta_data` column is neither
 * a filter nor a sort key. Refusals are one typed 400 with one text.
 *
 * Every transport is executed: runtime REST list and count, in-process MCP,
 * the emitted SvelteKit list route and both emitted MCP servers. The check
 * runs before the collection and does not depend on the database engine.
 * Real SQLite file; nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field, meta } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { assertQueryAccess, QueryFieldError } from '../query-access.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type EmittedProject,
  emitTransports,
} from './fixtures/emitted-transports.js';

@smrt({ api: { include: ['list', 'get'] }, mcp: { include: ['list', 'get'] } })
class QueryFieldEmployee extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'integer' })
  level: number = 0;

  @field({ type: 'integer', readPermission: 'hr.salary' })
  salary: number = 0;

  @field({ type: 'text', readPermission: 'hr.ssn' })
  ssn: string = '';

  @field({ type: 'text', sensitive: true })
  apiSecret: string = '';
}
class QueryFieldEmployeeCollection extends SmrtCollection<QueryFieldEmployee> {
  static readonly _itemClass = QueryFieldEmployee;
}

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
class QueryFieldIntegration extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}
@smrt({ api: { include: ['list', 'get'] }, mcp: { include: ['list', 'get'] } })
class QueryFieldSlack extends QueryFieldIntegration {
  @meta({ sensitive: true })
  apiKey: string = '';

  @meta()
  channel: string = '';
}
class QueryFieldIntegrationCollection extends SmrtCollection<QueryFieldIntegration> {
  static readonly _itemClass = QueryFieldIntegration;
}
class QueryFieldSlackCollection extends SmrtCollection<QueryFieldSlack> {
  static readonly _itemClass = QueryFieldSlack;
}

const CLASSES = [
  'QueryFieldEmployee',
  'QueryFieldIntegration',
  'QueryFieldSlack',
];

type Model = 'employee' | 'integration' | 'slack';
/** One filter: a field, an operator (`=` when omitted) and a value. */
type Filter = [field: string, operator: string, value: string | number];

/** What one transport answered to a list. */
interface Listing {
  ok: boolean;
  code?: string;
  message?: string;
  /** Names of the rows served, sorted. */
  names: string[];
  /** Total the transport reported for the filter. */
  total?: number;
  text: string;
}

interface Transport {
  name: string;
  list(
    model: Model,
    query: { filters?: Filter[]; orderBy?: string },
    permissions?: string[],
  ): Promise<Listing>;
}

const REST_OPERATORS: Record<string, string> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  '!=': 'ne',
  like: 'like',
};

function toSearch(query: { filters?: Filter[]; orderBy?: string }): string {
  const params = new URLSearchParams();
  for (const [name, operator, value] of query.filters ?? []) {
    params.set(
      operator === '=' ? name : `${name}[${REST_OPERATORS[operator]}]`,
      String(value),
    );
  }
  if (query.orderBy) params.set('orderBy', query.orderBy);
  const text = params.toString();
  return text ? `?${text}` : '';
}

function toWhere(filters: Filter[] = []): Record<string, unknown> {
  return Object.fromEntries(
    filters.map(([name, operator, value]) => [
      operator === '=' ? name : `${name} ${operator}`,
      value,
    ]),
  );
}

const TRANSPORTS = [
  'runtime REST list',
  'runtime REST count',
  'in-process MCP',
  'emitted SvelteKit route',
  'emitted MCP server (single file)',
  'emitted MCP server (modular)',
];

describe('request query fields', () => {
  let dir: string;
  let dbUrl: string;
  let db: DatabaseInterface;
  let employees: QueryFieldEmployeeCollection;
  let integrations: QueryFieldIntegrationCollection;
  let slacks: QueryFieldSlackCollection;
  let emitted: EmittedProject;
  const segment = {} as Record<Model, string>;
  const transports: Transport[] = [];

  const transport = (name: string) => {
    const found = transports.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`No transport named ${name}`);
    return found;
  };

  beforeAll(async () => {
    for (const [name, collection] of [
      ['QueryFieldEmployee', QueryFieldEmployeeCollection],
      ['QueryFieldIntegration', QueryFieldIntegrationCollection],
      ['QueryFieldSlack', QueryFieldSlackCollection],
    ] as const) {
      ObjectRegistry.registerCollection(name, collection as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-query-fields-'));
    dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: CLASSES,
    });
    employees = await QueryFieldEmployeeCollection.create({ db });
    integrations = await QueryFieldIntegrationCollection.create({ db });
    slacks = await QueryFieldSlackCollection.create({ db });

    await employees.create({
      name: 'alice',
      level: 3,
      salary: 153250,
      ssn: '123-45-6789',
      apiSecret: 'sk-alice',
    });
    await employees.create({
      name: 'bob',
      level: 5,
      salary: 90000,
      ssn: '987-65-4321',
      apiSecret: 'sk-bob',
    });
    await slacks.create({
      name: 'slack',
      apiKey: 'sk-abc123',
      channel: 'general',
    });
    await integrations.create({ name: 'plain' });

    const collection = (name: string) =>
      ObjectRegistry.getClass(name)?.collection as string;
    segment.employee = collection('QueryFieldEmployee');
    segment.integration = collection('QueryFieldIntegration');
    segment.slack = collection('QueryFieldSlack');

    const restFor = (permissions: string[]) => {
      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req: Request) => req },
        { db, permissions },
      );
      api.registerCollection(segment.employee, employees as never);
      api.registerCollection(segment.integration, integrations as never);
      api.registerCollection(segment.slack, slacks as never);
      return api.generateHandler();
    };
    const tool = (model: Model) =>
      `${
        {
          employee: 'queryfieldemployee',
          integration: 'queryfieldintegration',
          slack: 'queryfieldslack',
        }[model]
      }_list`;
    const namesOf = (rows: unknown) =>
      (rows as Array<{ name: string }>).map((row) => row.name).sort();
    const failure = (
      text: string,
      error: { code?: string; message?: string } | undefined,
    ): Listing => ({
      ok: false,
      code: error?.code,
      message: error?.message,
      names: [],
      text,
    });
    const fromTool = (result: {
      isError?: boolean;
      structuredContent?: unknown;
    }): Listing => {
      const text = JSON.stringify(result);
      if (result.isError) {
        return failure(
          text,
          (
            result.structuredContent as
              | { error?: { code?: string; message?: string } }
              | undefined
          )?.error,
        );
      }
      const content = result.structuredContent as {
        data: unknown[];
        meta: { total: number };
      };
      return {
        ok: true,
        names: namesOf(content.data),
        total: content.meta.total,
        text,
      };
    };

    emitted = await emitTransports(CLASSES, { db, dbUrl });

    transports.push(
      {
        name: 'runtime REST list',
        list: async (model, query, permissions = []) => {
          const response = await restFor(permissions)(
            new Request(`http://local/api/${segment[model]}${toSearch(query)}`),
          );
          const text = await response.text();
          const body = JSON.parse(text);
          return response.status === 200
            ? { ok: true, names: namesOf(body), text }
            : failure(`${response.status} ${text}`, body.error);
        },
      },
      {
        name: 'runtime REST count',
        list: async (model, query, permissions = []) => {
          const response = await restFor(permissions)(
            new Request(
              `http://local/api/${segment[model]}/count${toSearch({ filters: query.filters })}`,
            ),
          );
          const text = await response.text();
          const body = JSON.parse(text);
          return response.status === 200
            ? { ok: true, names: [], total: body.count, text }
            : failure(`${response.status} ${text}`, body.error);
        },
      },
      {
        name: 'in-process MCP',
        list: async (model, query, permissions = []) =>
          fromTool(
            await new MCPGenerator(
              {},
              { db, user: { id: 'user-1' }, permissions },
            ).handleToolCall({
              method: 'tools/call',
              params: {
                name: tool(model),
                arguments: {
                  where: toWhere(query.filters),
                  ...(query.orderBy ? { orderBy: query.orderBy } : {}),
                },
              },
            }),
          ),
      },
      {
        name: 'emitted SvelteKit route',
        list: async (model, query, permissions = []) => {
          const result = await emitted.http(
            `${segment[model]}/+server.ts`,
            'GET',
            {
              url: `http://emitted.local/api/${segment[model]}${toSearch(query)}`,
              locals: { user: { id: 'user-1' }, permissions },
            },
          );
          const text = `${result.status} ${JSON.stringify(result.body)}`;
          if (result.status !== 200) {
            // The list route's SvelteKit error body carries the message and
            // the refusal's code.
            return failure(
              text,
              (result.body as { message?: string; code?: string } | null) ??
                undefined,
            );
          }
          const body = result.body as { items: unknown[]; count: number };
          return {
            ok: true,
            names: namesOf(body.items),
            total: body.count,
            text,
          };
        },
      },
      ...[false, true].map(
        (modular): Transport => ({
          name: `emitted MCP server (${modular ? 'modular' : 'single file'})`,
          list: async (model, query, permissions = []) => {
            // The emitted server reads its permissions from the environment
            // once, when it starts.
            const server = await emitted.mcp({
              modular,
              env: { SMRT_MCP_PERMISSIONS: permissions.join(',') },
            });
            return fromTool(
              await server.call(tool(model), {
                where: toWhere(query.filters),
                // The modular server's list takes no ordering.
                ...(query.orderBy && !modular
                  ? { orderBy: query.orderBy }
                  : {}),
              }),
            );
          },
        }),
      ),
    );
  });

  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A refusal: one status, one code where the transport carries codes. */
  const expectRefused = (name: string, listing: Listing, fieldName: string) => {
    expect(listing.ok).toBe(false);
    expect(listing.message).toBe(`Invalid filter field: '${fieldName}'.`);
    if (name.startsWith('runtime REST')) {
      expect(listing.text.startsWith('400 ')).toBe(true);
    }
    if (name === 'emitted SvelteKit route') {
      expect(listing.text.startsWith('400 ')).toBe(true);
    }
    expect(listing.code).toBe('QUERY_FIELD_NOT_ALLOWED');
    expect(listing.text).not.toContain('alice');
    expect(listing.text).not.toContain('153250');
  };

  describe('the rule', () => {
    const model = () =>
      ObjectRegistry.getClass('QueryFieldEmployee')?.qualifiedName as string;

    it('answers unknown, unreadable and never-readable fields alike', () => {
      const refusal = (where: Record<string, unknown>) => {
        try {
          assertQueryAccess(model(), { where });
        } catch (error) {
          return error as QueryFieldError;
        }
        throw new Error('expected a refusal');
      };
      const unknown = refusal({ noSuchField: 1 });
      const gated = refusal({ 'salary >=': 1 });
      const secret = refusal({ apiSecret: 'x' });
      for (const error of [unknown, gated, secret]) {
        expect(error).toBeInstanceOf(QueryFieldError);
        expect(error).toMatchObject({
          status: 400,
          code: 'QUERY_FIELD_NOT_ALLOWED',
        });
      }
      expect(gated.publicMessage.replace('salary', 'X')).toBe(
        unknown.publicMessage.replace('noSuchField', 'X'),
      );
      expect(secret.publicMessage.replace('apiSecret', 'X')).toBe(
        unknown.publicMessage.replace('noSuchField', 'X'),
      );
    });

    it('reads a key by the column it resolves to', () => {
      for (const key of ['salary', 'Salary', 'salary >=', 'salary in']) {
        expect(() =>
          assertQueryAccess(model(), { where: { [key]: 1 } }),
        ).toThrow(QueryFieldError);
        expect(() =>
          assertQueryAccess(
            model(),
            { where: { [key]: 1 } },
            { permissions: ['hr.salary'] },
          ),
        ).not.toThrow();
      }
      expect(() =>
        assertQueryAccess(
          model(),
          { where: { api_secret: 'x' } },
          { permissions: new Set(['hr.salary', 'hr.ssn']) },
        ),
      ).toThrow(QueryFieldError);
    });

    it('checks every record of the DNF form and refuses a non-object filter', () => {
      expect(() =>
        assertQueryAccess(model(), {
          where: [[{ name: 'alice' }], [{ level: 3 }, { 'salary >': 1 }]],
        }),
      ).toThrow(QueryFieldError);
      expect(() =>
        assertQueryAccess(model(), {
          where: [[{ name: 'alice' }], [{ level: 3 }]],
        }),
      ).not.toThrow();
      for (const where of [42, 'name', true]) {
        expect(() => assertQueryAccess(model(), { where })).toThrow(
          expect.objectContaining({
            status: 400,
            code: 'INVALID_WHERE_CLAUSE',
          }),
        );
      }
      expect(() => assertQueryAccess(model(), {})).not.toThrow();
      expect(() =>
        assertQueryAccess(undefined, { where: { x: 1 } }),
      ).not.toThrow();
    });
  });

  describe.each(TRANSPORTS)('%s', (name) => {
    const counts = name !== 'runtime REST list';
    const lists = name !== 'runtime REST count';

    it('filters on fields every caller reads', async () => {
      const listing = await transport(name).list('employee', {
        filters: [['level', '>=', 4]],
      });
      expect(listing.ok).toBe(true);
      if (lists) expect(listing.names).toEqual(['bob']);
      if (counts) expect(listing.total).toBe(1);
    });

    it.each<[string, Filter]>([
      ['equality', ['salary', '=', 153250]],
      ['a range', ['salary', '>=', 150000]],
      ['a pattern', ['ssn', 'like', '123%']],
      ['another spelling of the key', ['Salary', '<', 1]],
    ])('refuses a filter on a field the caller may not read: %s', async (_label, filter) => {
      const listing = await transport(name).list('employee', {
        filters: [['name', '=', 'alice'], filter],
      });
      expectRefused(name, listing, filter[0]);
    });

    it('serves that filter to a caller who may read the field', async () => {
      const held = await transport(name).list(
        'employee',
        { filters: [['salary', '>=', 150000]] },
        ['hr.salary'],
      );
      expect(held.ok).toBe(true);
      if (lists) expect(held.names).toEqual(['alice']);
      if (counts) expect(held.total).toBe(1);

      // One permission reads one field.
      const other = await transport(name).list(
        'employee',
        { filters: [['ssn', 'like', '123%']] },
        ['hr.salary'],
      );
      expectRefused(name, other, 'ssn');
    });

    it('refuses a sensitive field and an unknown field the same way', async () => {
      const everything = ['hr.salary', 'hr.ssn'];
      const secret = await transport(name).list(
        'employee',
        { filters: [['apiSecret', 'like', 'sk-a%']] },
        everything,
      );
      expectRefused(name, secret, 'apiSecret');
      const unknown = await transport(name).list(
        'employee',
        { filters: [['noSuchField', '=', 1]] },
        everything,
      );
      expectRefused(name, unknown, 'noSuchField');
      expect(secret.code).toBe(unknown.code);
      expect(secret.message?.replace('apiSecret', 'X')).toBe(
        unknown.message?.replace('noSuchField', 'X'),
      );
    });

    it.each([
      '_meta_data',
      '_metaData',
      'meta_data',
    ])('refuses the metadata column as a filter: %s', async (key) => {
      for (const model of ['slack', 'integration'] as const) {
        const listing = await transport(name).list(model, {
          filters: [[key, 'like', '%"apiKey":"sk-a%']],
        });
        expectRefused(name, listing, key);
        expect(listing.text).not.toContain('sk-abc123');
      }
    });

    it('still filters a shared table by its type column', async () => {
      const type = ObjectRegistry.getClass('QueryFieldSlack')
        ?.qualifiedName as string;
      const listing = await transport(name).list('integration', {
        filters: [['_meta_type', '=', type]],
      });
      expect(listing.ok).toBe(true);
      if (lists) expect(listing.names).toEqual(['slack']);
      if (counts) expect(listing.total).toBe(1);
      expect(listing.text).not.toContain('sk-abc123');
    });
  });

  describe.each(
    TRANSPORTS.filter(
      (name) =>
        // A count takes no ordering, and the modular server's list takes none.
        name !== 'runtime REST count' && !name.includes('modular'),
    ),
  )('%s ordering', (name) => {
    it.each([
      '_meta_data',
      '_metaData DESC',
      'name, meta_data',
    ])('refuses the metadata column as a sort key: %s', async (orderBy) => {
      const listing = await transport(name).list('integration', { orderBy });
      expect(listing.ok).toBe(false);
      expect(listing.message).toMatch(
        /^Invalid orderBy field: '_?meta_?[dD]ata'\.$/,
      );
      if (name !== 'emitted SvelteKit route') {
        expect(listing.code).toBe('INVALID_ORDER_BY_UNKNOWN_FIELD');
      }
      expect(listing.text).not.toContain('sk-abc123');
    });

    it('answers a sort by a sensitive, a permission-gated or an unknown field alike', async () => {
      for (const permissions of [[], ['hr.salary']]) {
        const answers: Array<{ code?: string; message?: string }> = [];
        for (const field of ['apiSecret', 'salary', 'noSuchField']) {
          const listing = await transport(name).list(
            'employee',
            { orderBy: `${field} DESC` },
            permissions,
          );
          expect(listing.ok).toBe(false);
          answers.push({
            code: listing.code,
            message: listing.message?.replace(field, '<field>'),
          });
        }
        expect(answers[0]).toEqual({
          code:
            name === 'emitted SvelteKit route'
              ? answers[0].code
              : 'INVALID_ORDER_BY_UNKNOWN_FIELD',
          message: "Invalid orderBy field: '<field>'.",
        });
        expect(answers[1]).toEqual(answers[0]);
        expect(answers[2]).toEqual(answers[0]);
      }
    });

    it('still sorts by a readable field', async () => {
      const listing = await transport(name).list('employee', {
        orderBy: 'name DESC',
      });
      expect(listing.ok).toBe(true);
      expect(listing.names).toEqual(['alice', 'bob']);
    });
  });

  describe('in-process MCP', () => {
    const call = (where: unknown) =>
      new MCPGenerator(
        {},
        { db, user: { id: 'user-1' }, permissions: [] },
      ).handleToolCall({
        method: 'tools/call',
        params: { name: 'queryfieldemployee_list', arguments: { where } },
      });

    it('checks every branch of a DNF filter', async () => {
      const refused = await call([[{ name: 'alice' }], [{ 'salary >': 1 }]]);
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        error: { code: 'QUERY_FIELD_NOT_ALLOWED' },
      });
      const served = await call([[{ name: 'alice' }], [{ level: 5 }]]);
      expect(served.isError).not.toBe(true);
      expect(
        (served.structuredContent as { meta: { total: number } }).meta.total,
      ).toBe(2);
    });

    it('refuses an ordering that is not a string or a list of strings', async () => {
      for (const orderBy of [
        [['salary']],
        [{ salary: 'DESC' }],
        { salary: 1 },
        42,
      ]) {
        const refused = await new MCPGenerator(
          {},
          { db, user: { id: 'user-1' }, permissions: [] },
        ).handleToolCall({
          method: 'tools/call',
          params: { name: 'queryfieldemployee_list', arguments: { orderBy } },
        });
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({
          error: { code: 'INVALID_ORDER_BY' },
        });
      }
    });

    it('refuses a filter that is not an object of conditions', async () => {
      for (const where of [42, 'name']) {
        const refused = await call(where);
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({
          error: { code: 'INVALID_WHERE_CLAUSE' },
        });
      }
    });
  });

  describe('server code', () => {
    it('filters a collection on any column it holds', async () => {
      expect(
        (await employees.list({ where: { 'salary >=': 150000 } })).map(
          (row) => row.name,
        ),
      ).toEqual(['alice']);
      expect(await employees.count({ where: { 'ssn like': '987%' } })).toBe(1);
      expect(
        await integrations.count({
          where: { '_meta_data like': '%"channel":"general"%' },
        }),
      ).toBe(1);
      // The collection itself still refuses a sensitive field.
      await expect(
        employees.list({ where: { apiSecret: 'sk-alice' } }),
      ).rejects.toThrow(/sensitive/);
    });
  });
});
