/**
 * A create through an STI base selects only subtypes whose own surface opens
 * create on that transport.
 *
 * The base's surface decides whether the base accepts creates; a subtype
 * closed on a transport (`api: false` / `mcp: false`, or an `include` list
 * without `create`) is not a `createType` target there. Runtime REST, the
 * in-process MCP generator, the emitted SvelteKit route and both emitted MCP
 * servers refuse it with a typed 400 and write nothing; the MCP create schema
 * does not offer it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import {
  assertCreateTargetSurface,
  CreateTargetError,
  isCreateOpenOnSurface,
} from '../create-target.js';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type EmittedProject,
  type EmittedToolResult,
  emitTransports,
} from './fixtures/emitted-transports.js';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get', 'create'] },
} as never)
class SurfaceProfile extends SmrtObject {
  @field({ type: 'text' })
  label = '';
}
class SurfaceProfileCollection extends SmrtCollection<SurfaceProfile> {
  static readonly _itemClass = SurfaceProfile;
}

/** Closed on every generated surface. */
@smrt({ api: false, mcp: false } as never)
class SurfaceServiceAccount extends SurfaceProfile {
  @field({ type: 'text' })
  privilege = '';
}

/** Read-only on REST and MCP. */
@smrt({
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
} as never)
class SurfaceReadOnly extends SurfaceProfile {
  @field({ type: 'text' })
  privilege = '';
}

/** Creatable on REST, closed on MCP. */
@smrt({ api: { include: ['list', 'get', 'create'] }, mcp: false } as never)
class SurfaceRestOnly extends SurfaceProfile {
  @field({ type: 'text' })
  privilege = '';
}

/** Creatable everywhere: the control. */
@smrt({
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get', 'create'] },
} as never)
class SurfaceMember extends SurfaceProfile {
  @field({ type: 'text' })
  privilege = '';
}

const MODELS = [
  'SurfaceProfile',
  'SurfaceServiceAccount',
  'SurfaceReadOnly',
  'SurfaceRestOnly',
  'SurfaceMember',
];

type Outcome = { created: boolean; status?: number; code?: string };
type Create = (body: Record<string, unknown>) => Promise<Outcome>;

const key = (name: string) => {
  const info = ObjectRegistry.getClass(name);
  if (!info) throw new Error(`fixture not registered: ${name}`);
  return info.qualifiedName || info.name;
};

function fromTool(result: EmittedToolResult): Outcome {
  const error = (
    result.structuredContent as { error?: { code?: string } } | undefined
  )?.error;
  return { created: !result.isError, code: error?.code };
}

function createTypeEnum(schema: unknown): string[] | undefined {
  return (
    schema as {
      properties?: { createType?: { enum?: string[] } };
    }
  )?.properties?.createType?.enum;
}

describe('STI create targets respect the subtype surface', () => {
  let dir: string;
  let db: DatabaseInterface;
  let profiles: SurfaceProfileCollection;
  let emitted: EmittedProject;
  let segment: string;
  const rest: Record<string, Create> = {};
  const mcp: Record<string, Create> = {};
  const schemas: Record<string, () => Promise<string[] | undefined>> = {};

  const rows = async () =>
    (
      await db.query(
        `SELECT label, _meta_type FROM ${profiles.tableName} ORDER BY label`,
      )
    ).rows.map((row) => `${row.label}:${row._meta_type}`);

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'SurfaceProfile',
      SurfaceProfileCollection,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-create-target-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({ type: 'sqlite', url: dbUrl, classes: MODELS });
    profiles = await SurfaceProfileCollection.create({ db });
    segment = ObjectRegistry.getClass('SurfaceProfile')?.collection as string;
    emitted = await emitTransports(['SurfaceProfile'], { db, dbUrl });

    const handler = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db },
    ).generateHandler();
    rest['runtime REST'] = async (body) => {
      const response = await handler(
        new Request(`http://local/api/${segment}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const payload = (await response.json()) as {
        error?: { code?: string };
      };
      return {
        created: response.status === 201,
        status: response.status,
        code: payload.error?.code,
      };
    };
    rest['emitted SvelteKit route'] = async (body) => {
      const result = await emitted.http(`${segment}/+server.ts`, 'POST', {
        body,
        locals: { user: { id: 'user-1' }, permissions: [`${segment}.create`] },
      });
      return {
        created: result.status === 201,
        status: result.status,
        code: (result.body as { error?: { code?: string } } | null)?.error
          ?.code,
      };
    };

    const inProcess = new MCPGenerator({}, { db, user: { id: 'user-1' } });
    const tool = 'surfaceprofile_create';
    mcp['in-process MCP'] = async (body) =>
      fromTool(
        (await inProcess.handleToolCall({
          method: 'tools/call',
          params: { name: tool, arguments: body },
        })) as EmittedToolResult,
      );
    schemas['in-process MCP'] = async () =>
      createTypeEnum(
        (await inProcess.generateTools()).find((entry) => entry.name === tool)
          ?.inputSchema,
      );
    for (const [name, modular] of [
      ['emitted MCP server (single file)', false],
      ['emitted MCP server (modular)', true],
    ] as const) {
      const server = await emitted.mcp({ modular });
      mcp[name] = async (body) => fromTool(await server.call(tool, body));
      schemas[name] = async () =>
        createTypeEnum(
          (await server.tools()).find((entry) => entry.name === tool)
            ?.inputSchema,
        );
    }
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM ${profiles.tableName}`);
  });

  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the rule', () => {
    it('opens create for a subtype only when its own surface does', () => {
      expect(isCreateOpenOnSurface(key('SurfaceMember'), 'api')).toBe(true);
      expect(isCreateOpenOnSurface(key('SurfaceMember'), 'mcp')).toBe(true);
      expect(isCreateOpenOnSurface(key('SurfaceRestOnly'), 'api')).toBe(true);
      expect(isCreateOpenOnSurface(key('SurfaceRestOnly'), 'mcp')).toBe(false);
      for (const closed of ['SurfaceServiceAccount', 'SurfaceReadOnly']) {
        expect(isCreateOpenOnSurface(key(closed), 'api')).toBe(false);
        expect(isCreateOpenOnSurface(key(closed), 'mcp')).toBe(false);
      }
    });

    it('refuses a closed target with a typed 400 and admits the base itself', () => {
      const base = key('SurfaceProfile');
      expect(() =>
        assertCreateTargetSurface(
          base,
          { name: base, collectionName: base },
          'api',
        ),
      ).not.toThrow();
      const closed = key('SurfaceServiceAccount');
      let failure: unknown;
      try {
        assertCreateTargetSurface(
          base,
          { name: closed, collectionName: closed },
          'api',
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CreateTargetError);
      expect(failure).toMatchObject({
        status: 400,
        code: 'CREATE_TARGET_UNAVAILABLE',
      });
    });
  });

  describe.each([
    'runtime REST',
    'emitted SvelteKit route',
  ])('%s', (transport) => {
    const create: Create = (body) => rest[transport](body);

    it.each([
      ['SurfaceServiceAccount'],
      ['SurfaceReadOnly'],
    ])('refuses createType %s and writes nothing', async (subtype) => {
      for (const selector of ['createType', '_meta_type']) {
        const outcome = await create({
          label: `via-${selector}`,
          privilege: 'root',
          [selector]: key(subtype),
        });
        expect(outcome).toMatchObject({ created: false, status: 400 });
      }
      expect(await rows()).toEqual([]);
    });

    it('creates the base, an open subtype and a REST-only subtype', async () => {
      expect((await create({ label: 'a-base' })).created).toBe(true);
      expect(
        (
          await create({
            label: 'b-member',
            privilege: 'user',
            createType: key('SurfaceMember'),
          })
        ).created,
      ).toBe(true);
      expect(
        (
          await create({
            label: 'c-rest-only',
            privilege: 'user',
            createType: key('SurfaceRestOnly'),
          })
        ).created,
      ).toBe(true);
      expect((await rows()).map((row) => row.split(':')[0])).toEqual([
        'a-base',
        'b-member',
        'c-rest-only',
      ]);
    });
  });

  describe.each([
    'in-process MCP',
    'emitted MCP server (single file)',
    'emitted MCP server (modular)',
  ])('%s', (transport) => {
    const create: Create = (body) => mcp[transport](body);

    it('offers only subtypes whose MCP surface opens create', async () => {
      const offered = await schemas[transport]();
      expect(offered).toEqual(
        expect.arrayContaining([key('SurfaceProfile'), key('SurfaceMember')]),
      );
      for (const closed of [
        'SurfaceServiceAccount',
        'SurfaceReadOnly',
        'SurfaceRestOnly',
      ]) {
        expect(offered).not.toContain(key(closed));
      }
    });

    it.each([
      ['SurfaceServiceAccount'],
      ['SurfaceReadOnly'],
      ['SurfaceRestOnly'],
    ])('refuses createType %s and writes nothing', async (subtype) => {
      for (const selector of ['createType', '_meta_type']) {
        const outcome = await create({
          label: `via-${selector}`,
          privilege: 'root',
          [selector]: key(subtype),
        });
        expect(outcome.created).toBe(false);
      }
      expect(await rows()).toEqual([]);
    });

    it('creates the base and an open subtype', async () => {
      expect((await create({ label: 'a-base' })).created).toBe(true);
      expect(
        (
          await create({
            label: 'b-member',
            privilege: 'user',
            createType: key('SurfaceMember'),
          })
        ).created,
      ).toBe(true);
      expect((await rows()).map((row) => row.split(':')[0])).toEqual([
        'a-base',
        'b-member',
      ]);
    });
  });
});
