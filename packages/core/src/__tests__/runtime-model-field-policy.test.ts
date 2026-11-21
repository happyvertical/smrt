/**
 * A run-time model keeps the confidentiality attributes of its fields.
 *
 * `registerRuntimeModel()` takes field definitions as data. A field declared
 * `sensitive` or with a `readPermission` is registered with that policy
 * whether or not the model also has a calculated field, so every surface
 * projects and filters it like a decorated field.
 *
 * Runtime REST, in-process MCP, the emitted SvelteKit route and both emitted
 * MCP servers are executed over a real SQLite file; nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import {
  createFieldFromManifest,
  mergeManifestField,
} from '../registry/manifest-field-merge.js';
import { ObjectRegistry } from '../registry.js';
import { planRuntimeModelDDL, registerRuntimeModel } from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type EmittedProject,
  emitTransports,
} from './fixtures/emitted-transports.js';

const NOTE = 'NOTE-NEVER-SERVED';
const SALARY = 153250;

/** The three ways a run-time model reaches the registry. */
const SHAPES = [
  ['RuntimePolicyPlain', { generated: false, refresh: false }],
  ['RuntimePolicyRefreshed', { generated: false, refresh: true }],
  ['RuntimePolicyCalculated', { generated: true, refresh: false }],
] as const;

describe('run-time model field policy', () => {
  let restoreRegistry: () => void;
  let dir: string;
  let db: DatabaseInterface;
  let emitted: EmittedProject;
  const models: Record<string, { key: string; id: string; segment: string }> =
    {};

  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    dir = mkdtempSync(join(tmpdir(), 'smrt-runtime-policy-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({ type: 'sqlite', url: dbUrl, classes: [] });

    for (const [name, { generated, refresh }] of SHAPES) {
      const key = registerRuntimeModel(
        {
          name,
          packageName: '@fixture/runtime-policy',
          fields: {
            title: { type: 'text' },
            internalNote: { type: 'text', sensitive: true },
            salary: { type: 'integer', readPermission: 'hr.salary' },
            ...(generated
              ? { titleCopy: { type: 'text', generated: { col: 'title' } } }
              : {}),
          },
        } as never,
        { refresh },
      );
      const statements = await planRuntimeModelDDL(key, 'sqlite', async (t) => {
        const columns = await db.query(
          'SELECT name FROM pragma_table_xinfo($1)',
          [t],
        );
        return columns.rows.length
          ? columns.rows.map((row) => String(row.name))
          : null;
      });
      for (const statement of statements) await db.query(statement);
      const collection = await ObjectRegistry.getCollection(key, { db });
      const row = await collection.create({
        title: 'alice',
        internalNote: NOTE,
        salary: SALARY,
      } as never);
      models[name] = {
        key,
        id: row.id as string,
        segment: ObjectRegistry.getClass(key)?.collection as string,
      };
    }

    emitted = await emitTransports(
      SHAPES.map(([name]) => models[name].key),
      { db, dbUrl },
    );
  });

  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
    restoreRegistry();
  });

  describe('registration', () => {
    it('records every policy attribute a definition states at the top level', () => {
      const definition = {
        type: 'text' as const,
        sensitive: true,
        readonly: true,
        readPermission: 'read.secret',
        transient: true,
      };
      const policy = {
        sensitive: true,
        readonly: true,
        readPermission: 'read.secret',
        transient: true,
      };
      expect(createFieldFromManifest(definition)._meta).toEqual(policy);
      expect(
        mergeManifestField({ type: 'text', _meta: {} }, definition)._meta,
      ).toEqual(policy);
      // A definition that states none registers none.
      expect(createFieldFromManifest({ type: 'text' })._meta).toEqual({});
    });

    it.each(SHAPES)('%s registers its fields with their policy', (name) => {
      const fields = ObjectRegistry.getFields(models[name].key);
      expect(fields.get('internalNote')?._meta?.sensitive).toBe(true);
      expect(fields.get('salary')?._meta?.readPermission).toBe('hr.salary');
      expect(fields.get('title')?._meta?.sensitive).toBeUndefined();
    });
  });

  describe.each(SHAPES)('%s', (name) => {
    const tool = (action: string) => `${name.toLowerCase()}_${action}`;
    const restFor = (permissions: string[]) => {
      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req: Request) => req },
        { db, permissions },
      );
      return api.generateHandler();
    };
    const expectProjected = (text: string, holder: boolean) => {
      expect(text).toContain('alice');
      expect(text).not.toContain(NOTE);
      if (holder) expect(text).toContain(String(SALARY));
      else expect(text).not.toContain(String(SALARY));
    };

    it.each([
      ['without the read permission', [] as string[], false],
      ['with the read permission', ['hr.salary'], true],
    ])('runtime REST projects get and list %s', async (_label, permissions, holder) => {
      const { segment, id } = models[name];
      const handler = restFor(permissions);
      for (const path of [`${segment}/${id}`, segment]) {
        const response = await handler(new Request(`http://local/api/${path}`));
        expect(response.status).toBe(200);
        expectProjected(await response.text(), holder);
      }
    });

    it('runtime REST refuses a filter on the protected fields', async () => {
      const { segment } = models[name];
      for (const query of ['salary[gte]=1', 'internalNote[like]=NOTE%25']) {
        const response = await restFor([])(
          new Request(`http://local/api/${segment}/count?${query}`),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: 'QUERY_FIELD_NOT_ALLOWED' },
        });
      }
    });

    it.each([
      ['without the read permission', [] as string[], false],
      ['with the read permission', ['hr.salary'], true],
    ])('in-process MCP projects get and list %s', async (_label, permissions, holder) => {
      const generator = new MCPGenerator(
        { classNames: [models[name].key] },
        { db, user: { id: 'user-1' }, permissions },
      );
      for (const [action, args] of [
        ['get', { id: models[name].id }],
        ['list', {}],
      ] as const) {
        const result = await generator.handleToolCall({
          method: 'tools/call',
          params: { name: tool(action), arguments: args },
        });
        expect(result.isError).not.toBe(true);
        expectProjected(JSON.stringify(result), holder);
      }
    });

    it('the emitted SvelteKit routes project get and list', async () => {
      const { segment, id } = models[name];
      for (const [permissions, holder] of [
        [[], false],
        [['hr.salary'], true],
      ] as const) {
        const locals = { user: { id: 'user-1' }, permissions };
        const item = await emitted.http(`${segment}/[id]/+server.ts`, 'GET', {
          params: { id },
          locals,
        });
        expect(item.status).toBe(200);
        expectProjected(JSON.stringify(item.body), holder);
        const list = await emitted.http(`${segment}/+server.ts`, 'GET', {
          url: `http://emitted.local/api/${segment}`,
          locals,
        });
        expect(list.status).toBe(200);
        expectProjected(JSON.stringify(list.body), holder);
      }
    });

    it.each([
      false,
      true,
    ])('the emitted MCP server projects get and list (modular=%s)', async (modular) => {
      for (const [permissions, holder] of [
        ['', false],
        ['hr.salary', true],
      ] as const) {
        const server = await emitted.mcp({
          modular,
          env: { SMRT_MCP_PERMISSIONS: permissions },
        });
        for (const [action, args] of [
          ['get', { id: models[name].id }],
          ['list', {}],
        ] as const) {
          const result = await server.call(tool(action), args);
          expect(result.isError).not.toBe(true);
          expectProjected(JSON.stringify(result), holder);
        }
      }
    });
  });
});
