/** Generated create dispatch uses the collection owner, not an STI sibling. */
import { randomUUID } from 'node:crypto';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  Bot,
  Profile,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildManifestToolCatalog,
  invokeManifestTool,
} from '../../../chat/src/tool-loop';
import { CLIGenerator } from '../../../cli/src/cli-generator';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils';

@smrt({
  collection: 'createdispatchroots',
  tableName: 'createdispatchroots',
  tableStrategy: 'sti',
  api: { public: true },
  cli: true,
  mcp: true,
})
class CreateDispatchRoot extends SmrtObject {
  name = '';
}
@smrt()
class CreateDispatchChild extends CreateDispatchRoot {}

const families = [
  { model: Profile, child: Bot, collection: 'profiles', replace: false },
  {
    model: CreateDispatchRoot,
    child: CreateDispatchChild,
    collection: 'createdispatchroots',
    replace: false,
  },
  {
    model: CreateDispatchRoot,
    child: CreateDispatchChild,
    collection: 'createdispatchroots',
    replace: true,
  },
];

describe('STI generated create paths', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let typeId: string;
  beforeAll(async () => {
    db = await getTestDatabase();
    const types = await ProfileTypeCollection.create({ db });
    typeId = (
      await withSystemContext(() =>
        types.getOrCreateGlobalBySlug('person', { name: 'Person' }),
      )
    ).id!;
    for (const { model } of families) {
      const key = ObjectRegistry.getClassByConstructor(model)!.qualifiedName!;
      await ObjectRegistry.getCollection(key, { db });
    }
  });
  afterAll(async () => {
    await db?.close?.();
  });

  for (const { model, child, collection, replace } of families) {
    it.each([
      'REST',
      'MCP',
      'CLI',
      'assistant',
    ])(`%s creates the ${replace ? 'app replacement' : 'base'} ${model.name}`, async (path) => {
      const restore = snapshotObjectRegistryState();
      if (replace) {
        const Base = CreateDispatchRoot;
        const AppRoot = class CreateDispatchRoot extends Base {};
        ObjectRegistry.register(AppRoot, {
          packageName: '@fixture/create-app',
        });
      }
      const key = ObjectRegistry.getClassByConstructor(model)!.qualifiedName!;
      await ObjectRegistry.getCollection(key, { db });
      const data = {
        name: `${path}-${randomUUID()}`,
        ...(model === Profile ? { typeId } : {}),
      };
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        if (path === 'REST') {
          const api = new APIGenerator(
            { basePath: '/api', authMiddleware: () => async (req) => req },
            {
              db,
              user: { id: 'test' },
              permissions: [`${collection}.create`],
            },
          ).generateHandler();
          const response = await api(
            new Request(`http://localhost/api/${collection}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(data),
            }),
          );
          expect(response.status, await response.text()).toBe(201);
        } else if (path === 'MCP') {
          const response = await new MCPGenerator(
            { classNames: [key] },
            { db, user: { id: 'test' } },
          ).handleToolCall({
            method: 'tools/call',
            params: {
              name: `${model.name.toLowerCase()}_create`,
              arguments: data,
            },
          });
          expect(response.isError, JSON.stringify(response)).not.toBe(true);
        } else if (path === 'CLI') {
          const cli = new CLIGenerator({ colors: false }, { db });
          // Exercise the generated command's create handler without project discovery.
          await (
            cli as unknown as {
              handleCreate(
                name: string,
                options: Record<string, unknown>,
              ): Promise<void>;
            }
          ).handleCreate(key, { ...data, quiet: true });
        } else {
          const [tool] = buildManifestToolCatalog({
            allowedTools: [`${collection}.create`],
          });
          expect(tool.qualifiedName).toBe(key);
          const run = {
            context: { database: db },
            assertToolAllowed: vi.fn(),
            assertOperation: vi.fn(),
          } as unknown as Parameters<typeof invokeManifestTool>[0];
          await invokeManifestTool(run, tool, data, { db });
          expect(run.assertOperation).toHaveBeenCalledWith(
            collection,
            'create',
          );
        }
        const { rows } = await db.query(
          `SELECT _meta_type FROM "${collection}" WHERE name = ?`,
          [data.name],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]._meta_type).toBe(key);
        expect(rows[0]._meta_type).not.toBe(
          ObjectRegistry.getClassByConstructor(child)!.qualifiedName,
        );
      } finally {
        log.mockRestore();
        restore();
      }
    });
  }
});
