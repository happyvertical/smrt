/** Generated create dispatch uses the collection owner, not an STI sibling. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
class CreateDispatchSibling extends CreateDispatchRoot {}
@smrt({ collection: 'createdispatchbranches' })
class CreateDispatchChild extends CreateDispatchRoot {}
@smrt({ collection: 'createdispatchbranches' })
class CreateDispatchGrandchild extends CreateDispatchChild {}

const families = [
  {
    model: CreateDispatchChild,
    child: CreateDispatchGrandchild,
    collection: 'createdispatchbranches',
    replace: false,
  },
  { model: Profile, child: Bot, collection: 'profiles', replace: false },
  {
    model: CreateDispatchRoot,
    child: CreateDispatchSibling,
    collection: 'createdispatchroots',
    replace: false,
  },
  {
    model: CreateDispatchRoot,
    child: CreateDispatchSibling,
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
    for (const { model, child } of families) {
      for (const modelClass of [model, child]) {
        const key =
          ObjectRegistry.getClassByConstructor(modelClass)!.qualifiedName!;
        await ObjectRegistry.getCollection(key, { db });
      }
    }
  });
  afterAll(async () => {
    await db?.close?.();
  });

  it('validates explicit CLI file discriminators before creating a row', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-sti-cli-'));
    const file = join(directory, 'create.json');
    const root =
      ObjectRegistry.getClassByConstructor(CreateDispatchRoot)!.qualifiedName!;
    const child = ObjectRegistry.getClassByConstructor(CreateDispatchSibling)!
      .qualifiedName!;
    const cli = new CLIGenerator({ colors: false }, { db }) as unknown as {
      handleCreate(
        name: string,
        options: Record<string, unknown>,
      ): Promise<void>;
    };
    const name = `explicit-${randomUUID()}`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(file, JSON.stringify({ name, _meta_type: child }));
      await cli.handleCreate(root, { 'from-file': file, quiet: true });
      const { rows } = await db.query(
        'SELECT _meta_type FROM createdispatchroots WHERE name = ?',
        [name],
      );
      expect(rows).toEqual([{ _meta_type: child }]);
      for (const { discriminator, message } of [
        {
          discriminator:
            ObjectRegistry.getClassByConstructor(Profile)!.qualifiedName!,
          message: /not a subtype/,
        },
        {
          discriminator: '@fixture/missing:Model',
          message: /is not registered/,
        },
      ]) {
        writeFileSync(
          file,
          JSON.stringify({
            name: `${name}-invalid`,
            typeId,
            _meta_type: discriminator,
          }),
        );
        await expect(
          cli.handleCreate(root, { 'from-file': file, quiet: true }),
        ).rejects.toThrow(message);
      }
      const { rows: invalid } = await db.query(
        'SELECT id FROM profiles WHERE name = ?',
        [`${name}-invalid`],
      );
      expect(invalid).toHaveLength(0);
    } finally {
      log.mockRestore();
      error.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
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
      const registrations = ObjectRegistry.getAllClasses();
      const order = vi
        .spyOn(ObjectRegistry, 'getAllClasses')
        .mockReturnValue(
          new Map(
            [...registrations].sort((left, right) =>
              path === 'REST'
                ? Number(right[1].constructor === child) -
                  Number(left[1].constructor === child)
                : 0,
            ),
          ),
        );
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
          `SELECT _meta_type FROM "${ObjectRegistry.getTableName(key)}" WHERE name = ?`,
          [data.name],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]._meta_type).toBe(key);
        expect(rows[0]._meta_type).not.toBe(
          ObjectRegistry.getClassByConstructor(child)!.qualifiedName,
        );
      } finally {
        log.mockRestore();
        order.mockRestore();
        restore();
      }
    });
  }
});
