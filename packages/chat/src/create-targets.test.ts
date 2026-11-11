/** One STI family through the real MCP, REST, CLI and assistant dispatchers. */
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../../cli/src/cli-generator.js';
import { generateOpenAPISpec } from '../../core/src/generators/swagger.js';
import { setRuntimeExposureGate } from '../../core/src/runtime-exposure.js';
import { snapshotObjectRegistryState } from '../../core/src/test-utils.js';
import {
  invokeManifestTool,
  type ManifestTool,
  manifestToolToAITool,
} from './tool-loop.js';

@smrt({
  packageName: '@happyvertical/smrt-chat',
  collection: 'create_targets',
  tableName: 'create_targets',
  tableStrategy: 'sti',
  api: { public: true, writable: ['name', 'type'] },
  mcp: { include: ['create'] },
  cli: true,
})
class CreateTargetRoot extends SmrtObject {
  name = '';
  type = ''; // Content-style business classification, independent of STI.
}
@smrt({
  packageName: '@happyvertical/smrt-chat',
  api: { writable: ['name', 'type', 'detail'] },
  ui: { label: 'Special records' },
})
class CreateTargetChild extends CreateTargetRoot {
  detail = '';
  @field({ readonly: true })
  locked = '';
}
@smrt({ packageName: '@happyvertical/smrt-chat' })
class CreateTargetGated extends CreateTargetRoot {}
@smrt({ packageName: '@happyvertical/smrt-chat', api: { public: true } })
class CreateTargetForeign extends SmrtObject {
  type = '';
}

const root = '@happyvertical/smrt-chat:CreateTargetRoot';
const child = '@happyvertical/smrt-chat:CreateTargetChild';
const gated = '@happyvertical/smrt-chat:CreateTargetGated';
const foreign = '@happyvertical/smrt-chat:CreateTargetForeign';
const app = '@fixture/create-app:CreateTargetRoot';
const tool: ManifestTool = {
  slug: 'create_targets.create',
  collection: 'create_targets',
  action: 'create',
  className: 'CreateTargetRoot',
  qualifiedName: root,
};

for (const replace of [false, true]) {
  describe(`shared create targets (${replace ? 'app replacement' : 'provider base'})`, () => {
    let restore: () => void;
    let db: Awaited<ReturnType<typeof getTestDatabase>>;
    beforeEach(async () => {
      restore = snapshotObjectRegistryState();
      if (replace) {
        const Parent = CreateTargetRoot;
        ObjectRegistry.register(class CreateTargetRoot extends Parent {}, {
          packageName: '@fixture/create-app',
        });
      }
      db = await getTestDatabase({ classes: [root, child, gated, foreign] });
      setRuntimeExposureGate({
        isEnabled: (model) => model.qualifiedName !== gated,
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(async () => {
      setRuntimeExposureGate(undefined);
      await db?.close?.();
      restore();
      vi.restoreAllMocks();
    });

    async function create(path: string, input: Record<string, unknown>) {
      if (path === 'MCP') {
        const result = await new MCPGenerator(
          { classNames: [root] },
          { db, user: { id: 'owner' }, tenantId: 'tenant-a' },
        ).handleToolCall({
          method: 'tools/call',
          params: { name: 'createtargetroot_create', arguments: input },
        });
        if (result.isError) throw new Error(JSON.stringify(result));
      } else if (path === 'REST') {
        const handler = new APIGenerator(
          {
            basePath: '/api',
            authMiddleware: () => async (request) => request,
          },
          { db, tenantId: 'tenant-a' },
        ).generateHandler();
        const result = await handler(
          new Request('http://localhost/api/create_targets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }),
        );
        if (result.status !== 201) throw new Error(await result.text());
      } else if (path === 'CLI') {
        const cli = new CLIGenerator(
          { colors: false },
          { db, tenantId: 'tenant-a' },
        ) as unknown as {
          handleCreate(
            name: string,
            options: Record<string, unknown>,
          ): Promise<void>;
        };
        await cli.handleCreate(root, { ...input, quiet: true });
      } else {
        const run = {
          context: { database: db, tenantId: 'tenant-a' },
          assertToolAllowed: vi.fn(),
          assertOperation: vi.fn(),
        } as unknown as Parameters<typeof invokeManifestTool>[0];
        await invokeManifestTool(run, tool, input);
        expect(run.assertToolAllowed).toHaveBeenCalledWith(tool.slug);
        expect(run.assertOperation).toHaveBeenCalledWith(
          tool.collection,
          'create',
        );
      }
    }

    it('offers the same effective identities and labels, excluding gated children', async () => {
      const catalog = ObjectRegistry.getCreateTargets(root, {
        surface: 'assistant',
        tenantId: 'tenant-a',
      });
      expect(catalog.base.name).toBe(replace ? app : root);
      expect(catalog.subtypes).toEqual([
        { name: child, label: 'Special records' },
      ]);
      const ai = manifestToolToAITool(tool, 'tenant-a').function.parameters as {
        properties: Record<string, { enum?: string[] }>;
      };
      expect(ai.properties.createType.enum).toEqual([catalog.base.name, child]);
      expect(ai.properties.type).toBeDefined();
      expect(ai.properties.type.enum).toBeUndefined();
      expect(ai.properties.detail).toBeDefined();
      expect(ai.properties.locked).toBeUndefined();
      const [mcp] = await new MCPGenerator(
        { classNames: [root] },
        { tenantId: 'tenant-a' },
      ).generateTools();
      expect(mcp.inputSchema.properties?.createType).toMatchObject({
        enum: [catalog.base.name, child],
      });
      const typeProperty = mcp.inputSchema.properties?.type as {
        $ref?: string;
      };
      const definitions = mcp.inputSchema.$defs as
        | Record<string, unknown>
        | undefined;
      const businessTypeSchema = typeProperty.$ref
        ? definitions?.[typeProperty.$ref.split('/').at(-1)!]
        : typeProperty;
      expect(businessTypeSchema).toMatchObject({ type: 'string' });
      expect(businessTypeSchema).not.toHaveProperty('enum');
      expect(JSON.stringify(mcp.inputSchema)).not.toContain('"type":{"const":');
      const spec = generateOpenAPISpec({
        exposureContext: { surface: 'rest', tenantId: 'tenant-a' },
      });
      const restSchema = JSON.stringify(spec.paths);
      expect(restSchema).toContain(child);
      expect(restSchema).toContain('Special records');
      // Other family members have their own routes; inspect this base's POST schema.
      const paths = spec.paths as Record<
        string,
        { post?: { requestBody: unknown } }
      >;
      const basePost = paths['/api/v1/createtargetroots'].post;
      expect(JSON.stringify(basePost?.requestBody)).not.toContain(gated);
      expect(basePost?.requestBody).toMatchObject({
        content: {
          'application/json': {
            schema: {
              allOf: [
                expect.anything(),
                {
                  properties: {
                    createType: { enum: [catalog.base.name, child] },
                  },
                },
              ],
            },
          },
        },
      });
      expect(JSON.stringify(basePost?.requestBody)).not.toContain('"type":{"');
      const cli = new CLIGenerator({}, { tenantId: 'tenant-a' }) as unknown as {
        generateObjectCommands(
          name: string,
          info: NonNullable<ReturnType<typeof ObjectRegistry.getClass>>,
        ): Promise<
          Array<{
            name: string;
            options: Record<string, { description: string }>;
          }>
        >;
      };
      const commands = await cli.generateObjectCommands(
        root,
        ObjectRegistry.getClass(root)!,
      );
      const createCommand = commands.find((command) =>
        command.name.endsWith(':create'),
      )!;
      const description = createCommand.options.createType.description;
      expect(description).toContain(child);
      expect(description).toContain('Special records');
      expect(description).not.toContain(gated);
      expect(createCommand.options.type.description).not.toContain(child);
      expect(createCommand.options.type.description).not.toContain(
        'createType',
      );
    });

    for (const path of ['MCP', 'REST', 'CLI', 'assistant']) {
      it(`${path}: business type with no selector creates the effective base`, async () => {
        await create(path, { name: 'default', type: 'article' });
        const { rows } = await db.query(
          'SELECT _meta_type, type FROM create_targets WHERE name = ?',
          ['default'],
        );
        expect(rows).toEqual([
          { _meta_type: replace ? app : root, type: 'article' },
        ]);
      });
      it(`${path}: createType selects a subtype and preserves business type`, async () => {
        await create(path, {
          name: 'selected',
          createType: child,
          type: 'article',
          detail: 'child field',
          locked: 'must not write',
        });
        const collection = await ObjectRegistry.getCollection(root, { db });
        const [item] = await collection.list({ where: { name: 'selected' } });
        expect(item).toBeInstanceOf(CreateTargetChild);
        expect(item.toJSON()).toMatchObject({
          _meta_type: child,
          detail: 'child field',
          type: 'article',
          locked: '',
        });
      });
      it.each([
        foreign,
        '@fixture/missing:Unknown',
        gated,
        42,
        '',
        null,
      ])(`${path}: rejects %s before writing`, async (createType) => {
        await expect(
          create(path, { name: 'rejected', createType, type: 'article' }),
        ).rejects.toThrow();
        const { rows } = await db.query(
          'SELECT id FROM create_targets WHERE name = ?',
          ['rejected'],
        );
        expect(rows).toHaveLength(0);
      });
    }

    it('refreshes cached CLI choices when runtime exposure changes', async () => {
      const cli = new CLIGenerator({}, { tenantId: 'tenant-a' }) as unknown as {
        getObjectCommandsLazy(name: string): Promise<
          Array<{
            name: string;
            options: Record<string, { description: string }>;
          }>
        >;
      };
      const description = async () =>
        (await cli.getObjectCommandsLazy('CreateTargetRoot')).find((command) =>
          command.name.endsWith(':create'),
        )?.options.createType.description;
      expect(await description()).not.toContain(gated);
      setRuntimeExposureGate({ isEnabled: () => true });
      expect(await description()).toContain(gated);
      setRuntimeExposureGate({
        isEnabled: (model) => model.qualifiedName !== gated,
      });
      expect(await description()).not.toContain(gated);
    });

    it('preserves custom collection receivers for default and explicit base creates', async () => {
      const receiver = '@fixture/receiver:CreateTargetCollection';
      class CreateTargetCollection extends SmrtCollection<CreateTargetRoot> {
        static readonly _itemClass = CreateTargetRoot;
      }
      ObjectRegistry.registerCollection(receiver, CreateTargetCollection);
      const catalog = ObjectRegistry.getCreateTargets(receiver);
      expect(catalog.base.name).toBe(replace ? app : root);
      for (const input of [{}, { createType: catalog.base.name }]) {
        expect(
          ObjectRegistry.resolveCreateTarget(receiver, input, {
            surface: 'assistant',
          }).collectionName,
        ).toBe(receiver);
      }
      expect(
        ObjectRegistry.resolveCreateTarget(
          receiver,
          { createType: child },
          { surface: 'assistant' },
        ).collectionName,
      ).toBe(child);
    });

    it('validates legacy aliases, conflicts and child-family boundaries', () => {
      const context = { surface: 'assistant' as const };
      expect(
        ObjectRegistry.resolveCreateTarget(
          root,
          { _meta_type: child, name: 'legacy' },
          context,
        ),
      ).toMatchObject({ name: child, data: { name: 'legacy' } });
      expect(() =>
        ObjectRegistry.resolveCreateTarget(
          root,
          { createType: child, _meta_type: root },
          context,
        ),
      ).toThrow('Conflicting');
      expect(() =>
        ObjectRegistry.resolveCreateTarget(
          child,
          { createType: root },
          context,
        ),
      ).toThrow();
      expect(
        ObjectRegistry.resolveCreateTarget(
          foreign,
          { type: 'ordinary field' },
          context,
        ).data,
      ).toEqual({ type: 'ordinary field' });
    });
  });
}
