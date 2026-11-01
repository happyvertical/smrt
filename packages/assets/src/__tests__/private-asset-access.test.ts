/**
 * Private Asset records are guarded at the owning collection boundary.  These
 * tests use the real SQLite collection and generated REST/MCP transports so a
 * new surface cannot accidentally bypass the interceptor.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GlobalInterceptors,
  type SmrtCollection,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withSuperAdminBypass,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Asset } from '../asset';
import { type AssetRuntime, createAssetRuntime } from '../asset-runtime';
import { AssetCollection } from '../assets';
import { withPrivateAssetAccess } from '../private-asset-access';

const TENANT_ID = '00000000-0000-4000-8000-000000000101';
const OTHER_TENANT_ID = '00000000-0000-4000-8000-000000000102';
const ACTOR_ID = '00000000-0000-4000-8000-000000000201';
const OTHER_ACTOR_ID = '00000000-0000-4000-8000-000000000202';
const OWNER_ID = '00000000-0000-4000-8000-000000000301';
const OTHER_OWNER_ID = '00000000-0000-4000-8000-000000000302';
const PUBLIC_ID = '00000000-0000-4000-8000-000000000401';
const SECOND_PUBLIC_ID = '00000000-0000-4000-8000-000000000402';
const PRIVATE_ID = '00000000-0000-4000-8000-000000000403';
const OTHER_PRIVATE_ID = '00000000-0000-4000-8000-000000000404';

describe('private Asset access capability', () => {
  let db: DatabaseInterface;
  let assets: AssetCollection;
  let rest: (request: Request) => Promise<Response>;
  let mcp: MCPGenerator;

  const asActor = <T>(callback: () => Promise<T>) =>
    withTenant({ tenantId: TENANT_ID, userId: ACTOR_ID }, callback);
  const withPrivate = <T>(
    assetIds: readonly string[],
    callback: () => Promise<T>,
    ownerProfileId = OWNER_ID,
  ) =>
    withPrivateAssetAccess(
      { tenantId: TENANT_ID, actorUserId: ACTOR_ID, ownerProfileId, assetIds },
      callback,
    );

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    assets = await AssetCollection.create({ db });

    await asActor(async () => {
      await assets.create({
        id: PUBLIC_ID,
        name: 'public asset',
        tenantId: TENANT_ID,
        ownerProfileId: OWNER_ID,
        sourceUri: 'file:///public.bin',
      });
      await assets.create({
        id: SECOND_PUBLIC_ID,
        name: 'second public asset',
        tenantId: TENANT_ID,
        ownerProfileId: OWNER_ID,
        sourceUri: 'file:///second-public.bin',
      });
      await withPrivate([PRIVATE_ID], () =>
        assets.create({
          id: PRIVATE_ID,
          accessMode: 'private',
          name: 'private asset',
          mimeType: 'application/pdf',
          description: 'secret sidecar',
          tenantId: TENANT_ID,
          ownerProfileId: OWNER_ID,
          sourceUri: 'file:///private.bin',
        }),
      );
      await withPrivate(
        [OTHER_PRIVATE_ID],
        () =>
          assets.create({
            id: OTHER_PRIVATE_ID,
            accessMode: 'private',
            name: 'other private asset',
            tenantId: TENANT_ID,
            ownerProfileId: OTHER_OWNER_ID,
            sourceUri: 'file:///other-private.bin',
          }),
        OTHER_OWNER_ID,
      );
    });

    const api = new APIGenerator(
      {
        basePath: '/api/v1',
        authMiddleware: () => async (request) => request,
      },
      { db },
    );
    api.registerCollection(
      'assets',
      assets as unknown as SmrtCollection<SmrtObject>,
    );
    rest = api.generateHandler();
    mcp = new MCPGenerator(
      { classNames: ['Asset'] },
      { db, tenantId: TENANT_ID, user: { id: ACTOR_ID } },
    );
  });

  afterEach(async () => {
    disableTenancy();
    await db?.close?.();
  });

  it('keeps ordinary collection reads public-only, including projection/count before limit', async () => {
    await asActor(async () => {
      const projected = await assets.list({
        select: ['id'],
        limit: 1,
        orderBy: 'id ASC',
      });
      expect(projected).toHaveLength(1);
      expect(projected[0]?.id).toBe(PUBLIC_ID);
      expect(await assets.count({})).toBe(2);
      expect(await assets.get(PRIVATE_ID)).toBeNull();
    });
  });

  it('allows only the exact private records inside the trusted capability', async () => {
    await asActor(() =>
      withPrivate([PRIVATE_ID], async () => {
        expect((await assets.list({})).map((asset) => asset.id)).toEqual([
          PRIVATE_ID,
        ]);
        expect(await assets.count({})).toBe(1);
        expect((await assets.get(PRIVATE_ID))?.name).toBe('private asset');
        expect(await assets.get(OTHER_PRIVATE_ID)).toBeNull();
      }),
    );
  });

  it('blocks raw collection queries because their SQL cannot carry the capability predicate', async () => {
    await asActor(() =>
      expect(
        assets.query('SELECT * FROM assets', [], {
          allowRawOnTenantScoped: true,
        }),
      ).rejects.toThrow(/cannot enforce private record access/i),
    );
  });

  it('blocks parent Asset hydration without a capability', async () => {
    await asActor(async () => {
      const asset = new Asset({ db, id: PRIVATE_ID });
      await asset.initialize();
      expect(asset.name).toBe('');
    });
  });

  it('keeps private Assets hidden from system and super-admin default reads', async () => {
    await withSystemContext(async () => {
      expect((await assets.list({})).map((asset) => asset.id).sort()).toEqual([
        PUBLIC_ID,
        SECOND_PUBLIC_ID,
      ]);
      expect(await assets.get(PRIVATE_ID)).toBeNull();
    });
    await asActor(() =>
      withSuperAdminBypass(async () => {
        expect((await assets.list({})).map((asset) => asset.id).sort()).toEqual(
          [PUBLIC_ID, SECOND_PUBLIC_ID],
        );
        expect(await assets.get(PRIVATE_ID)).toBeNull();
      }),
    );
  });

  it('rejects malformed capabilities and unknown private access modes', async () => {
    await asActor(async () => {
      await expect(
        withPrivateAssetAccess(
          {
            tenantId: TENANT_ID,
            actorUserId: ACTOR_ID,
            ownerProfileId: OWNER_ID,
            assetIds: [],
          },
          async () => {},
        ),
      ).rejects.toThrow(/exact authenticated actor and asset IDs/i);
      await expect(
        withPrivateAssetAccess(
          {
            tenantId: TENANT_ID,
            actorUserId: ACTOR_ID,
            ownerProfileId: OWNER_ID,
            assetIds: [''],
          },
          async () => {},
        ),
      ).rejects.toThrow(/exact authenticated actor and asset IDs/i);
      await expect(
        withPrivateAssetAccess(
          {
            tenantId: TENANT_ID,
            actorUserId: ACTOR_ID,
            ownerProfileId: '',
            assetIds: [PRIVATE_ID],
          },
          async () => {},
        ),
      ).rejects.toThrow(/exact authenticated actor and asset IDs/i);
      await expect(
        assets.create({
          id: '00000000-0000-4000-8000-000000000406',
          accessMode: 'internal' as 'public',
          name: 'invalid access mode',
          tenantId: TENANT_ID,
          ownerProfileId: OWNER_ID,
          sourceUri: 'file:///invalid.bin',
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringMatching(/invalid asset access mode/i),
        }),
      });
      expect(
        await db.get('assets', {
          id: '00000000-0000-4000-8000-000000000406',
        }),
      ).toBeNull();
    });
  });

  it('rejects forged writes, downgrades, and deletes of a private row', async () => {
    await asActor(async () => {
      const forged = new Asset({
        db,
        id: PRIVATE_ID,
        accessMode: 'public',
        name: 'forged downgrade',
        tenantId: TENANT_ID,
        ownerProfileId: OWNER_ID,
        sourceUri: 'file:///private.bin',
      });
      await forged.initialize();
      await expect(forged.save()).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringMatching(/private asset access denied/i),
        }),
      });
      await expect(forged.delete()).rejects.toThrow(
        /private asset access denied/i,
      );
      expect((await assets.get(PUBLIC_ID))?.name).toBe('public asset');
    });
  });

  it('rejects a private HTTP locator before writing it', async () => {
    const id = '00000000-0000-4000-8000-000000000405';
    await asActor(() =>
      withPrivate([id], () =>
        expect(
          assets.create({
            id,
            accessMode: 'private',
            name: 'bad locator',
            tenantId: TENANT_ID,
            ownerProfileId: OWNER_ID,
            sourceUri: 'https://example.test/private.bin',
          }),
        ).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: expect.stringMatching(/non-public storage/i),
          }),
        }),
      ),
    );
  });

  it('narrows nested capabilities, rejects actor changes, and restores ordinary visibility afterwards', async () => {
    let escapedRead: (() => Promise<Asset | null>) | undefined;
    await asActor(() =>
      withPrivate([PRIVATE_ID, OTHER_PRIVATE_ID], async () => {
        await withPrivate([PRIVATE_ID], async () => {
          expect((await assets.list({})).map((asset) => asset.id)).toEqual([
            PRIVATE_ID,
          ]);
        });
        await expect(
          withPrivate(['00000000-0000-4000-8000-000000000499'], async () => {}),
        ).rejects.toThrow(/cannot widen/i);
        await expect(
          withTenant({ tenantId: TENANT_ID, userId: OTHER_ACTOR_ID }, () =>
            assets.get(PRIVATE_ID),
          ),
        ).rejects.toThrow(/actor identity changed/i);
        escapedRead = () => assets.get(PRIVATE_ID);
      }),
    );

    await asActor(async () => {
      expect(await escapedRead?.()).toBeNull();
      expect((await assets.list({})).map((asset) => asset.id).sort()).toEqual([
        PUBLIC_ID,
        SECOND_PUBLIC_ID,
      ]);
    });
  });

  describe('getPrivateAssetMetadata', () => {
    let runtime: AssetRuntime;
    let storageDir: string;
    const request = (assetId: string, overrides = {}) => ({
      tenantId: TENANT_ID,
      actorUserId: ACTOR_ID,
      assetId,
      ...overrides,
    });

    beforeEach(async () => {
      storageDir = mkdtempSync(join(tmpdir(), 'private-meta-'));
      runtime = await createAssetRuntime({
        db,
        storage: storageDir,
        collection: assets,
      });
    });
    afterEach(() => rmSync(storageDir, { recursive: true, force: true }));

    it('returns only the allowlisted metadata of an own-tenant private asset', async () => {
      const meta = await asActor(() =>
        runtime.getPrivateAssetMetadata(request(PRIVATE_ID)),
      );
      expect(meta).toMatchObject({
        id: PRIVATE_ID,
        tenantId: TENANT_ID,
        name: 'private asset',
        mimeType: 'application/pdf',
        version: 1,
      });
      expect(Object.keys(meta ?? {}).sort()).toEqual([
        'createdAt',
        'id',
        'mimeType',
        'name',
        'statusSlug',
        'tenantId',
        'typeSlug',
        'updatedAt',
        'version',
      ]);
      expect(JSON.stringify(meta)).not.toMatch(/private\.bin|secret sidecar/);
    });

    it('returns null for public, missing and other-tenant assets alike', async () => {
      await asActor(async () => {
        expect(
          await runtime.getPrivateAssetMetadata(request(PUBLIC_ID)),
        ).toBeNull();
        expect(
          await runtime.getPrivateAssetMetadata(
            request('00000000-0000-4000-8000-000000000499'),
          ),
        ).toBeNull();
      });
      await withTenant(
        { tenantId: OTHER_TENANT_ID, userId: ACTOR_ID },
        async () => {
          expect(
            await runtime.getPrivateAssetMetadata(
              request(PRIVATE_ID, { tenantId: OTHER_TENANT_ID }),
            ),
          ).toBeNull();
        },
      );
    });

    it('requires a matching ambient actor and non-empty ids', async () => {
      await expect(
        runtime.getPrivateAssetMetadata(request(PRIVATE_ID)),
      ).rejects.toThrow(/exact authenticated actor/i);
      await asActor(async () => {
        await expect(
          runtime.getPrivateAssetMetadata(
            request(PRIVATE_ID, { actorUserId: OTHER_ACTOR_ID }),
          ),
        ).rejects.toThrow(/exact authenticated actor/i);
        await expect(
          runtime.getPrivateAssetMetadata(
            request(PRIVATE_ID, { tenantId: OTHER_TENANT_ID }),
          ),
        ).rejects.toThrow(/exact authenticated actor/i);
        for (const empty of [
          { assetId: '' },
          { tenantId: '' },
          { actorUserId: '' },
        ])
          await expect(
            runtime.getPrivateAssetMetadata(request(PRIVATE_ID, empty)),
          ).rejects.toThrow(/exact authenticated actor/i);
      });
    });

    it('leaves no active capability behind', async () => {
      await asActor(async () => {
        await runtime.getPrivateAssetMetadata(request(PRIVATE_ID));
        expect(await assets.get(PRIVATE_ID)).toBeNull();
        expect((await assets.list({})).map((a) => a.id).sort()).toEqual([
          PUBLIC_ID,
          SECOND_PUBLIC_ID,
        ]);
      });
    });

    it('works inside a covering scope without widening it', async () => {
      await asActor(() =>
        withPrivate([PRIVATE_ID, SECOND_PUBLIC_ID], async () => {
          const meta = await runtime.getPrivateAssetMetadata(
            request(PRIVATE_ID),
          );
          expect(meta?.id).toBe(PRIVATE_ID);
          // Parent scope is still intact and still not widened.
          expect(await assets.get(PRIVATE_ID)).not.toBeNull();
          expect(await assets.get(OTHER_PRIVATE_ID)).toBeNull();
          expect(await assets.get(PUBLIC_ID)).toBeNull();
        }),
      );
    });

    it('cannot be used to widen a narrower parent scope', async () => {
      await asActor(() =>
        withPrivate([PRIVATE_ID], async () => {
          await expect(
            runtime.getPrivateAssetMetadata(request(OTHER_PRIVATE_ID)),
          ).rejects.toThrow(/cannot widen/i);
        }),
      );
    });
  });

  it('preserves ordinary public REST and MCP reads and updates', async () => {
    await asActor(async () => {
      const restList = await rest(new Request('http://local/api/v1/assets'));
      expect(restList.status).toBe(200);
      expect(
        ((await restList.json()) as Array<{ id: string }>)
          .map((row) => row.id)
          .sort(),
      ).toEqual([PUBLIC_ID, SECOND_PUBLIC_ID]);

      const restUpdate = await rest(
        new Request(`http://local/api/v1/assets/${PUBLIC_ID}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'public asset updated' }),
        }),
      );
      expect(restUpdate.status).toBe(200);

      const mcpList = await mcp.handleToolCall({
        method: 'tools/call',
        params: { name: 'asset_list', arguments: {} },
      });
      expect(mcpList.isError).not.toBe(true);
      expect(
        (mcpList.structuredContent as { data: Array<{ id: string }> }).data
          .map((row) => row.id)
          .sort(),
      ).toEqual([PUBLIC_ID, SECOND_PUBLIC_ID]);

      const mcpUpdate = await mcp.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'asset_update',
          arguments: { id: SECOND_PUBLIC_ID, name: 'second public updated' },
        },
      });
      expect(mcpUpdate.isError).not.toBe(true);
    });
  });

  it('denies private REST/MCP list, get, and update without the exact capability', async () => {
    await asActor(async () => {
      const restList = await rest(new Request('http://local/api/v1/assets'));
      expect(await restList.text()).not.toContain('private asset');
      expect(
        (await rest(new Request(`http://local/api/v1/assets/${PRIVATE_ID}`)))
          .status,
      ).toBe(404);
      expect(
        (
          await rest(
            new Request(`http://local/api/v1/assets/${PRIVATE_ID}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: 'blocked' }),
            }),
          )
        ).status,
      ).toBe(404);

      for (const [name, arguments_] of [
        ['asset_list', {}],
        ['asset_get', { id: PRIVATE_ID }],
        ['asset_update', { id: PRIVATE_ID, name: 'blocked' }],
      ] as const) {
        const response = await mcp.handleToolCall({
          method: 'tools/call',
          params: { name, arguments: arguments_ },
        });
        if (name === 'asset_list') {
          expect(response.isError).not.toBe(true);
          expect(JSON.stringify(response.structuredContent)).not.toContain(
            'private asset',
          );
        } else {
          expect(response.isError).toBe(true);
          expect(response.content[0]?.text).toMatch(/object not found/i);
        }
      }
    });
  });

  it('allows private REST/MCP list, get, and update only inside its exact scope', async () => {
    await asActor(() =>
      withPrivate([PRIVATE_ID], async () => {
        const restList = await rest(new Request('http://local/api/v1/assets'));
        expect(
          ((await restList.json()) as Array<{ id: string }>).map(
            (row) => row.id,
          ),
        ).toEqual([PRIVATE_ID]);
        expect(
          (await rest(new Request(`http://local/api/v1/assets/${PRIVATE_ID}`)))
            .status,
        ).toBe(200);
        expect(
          (
            await rest(
              new Request(`http://local/api/v1/assets/${PRIVATE_ID}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'private via REST' }),
              }),
            )
          ).status,
        ).toBe(200);

        const list = await mcp.handleToolCall({
          method: 'tools/call',
          params: { name: 'asset_list', arguments: {} },
        });
        expect(
          (list.structuredContent as { data: Array<{ id: string }> }).data,
        ).toEqual([expect.objectContaining({ id: PRIVATE_ID })]);
        const get = await mcp.handleToolCall({
          method: 'tools/call',
          params: { name: 'asset_get', arguments: { id: PRIVATE_ID } },
        });
        expect(get.isError).not.toBe(true);
        const update = await mcp.handleToolCall({
          method: 'tools/call',
          params: {
            name: 'asset_update',
            arguments: { id: PRIVATE_ID, name: 'private via MCP' },
          },
        });
        expect(update.isError).not.toBe(true);
      }),
    );
  });

  it('unguarded prior-behavior positive control: generated REST and MCP would expose a private Asset without its owning interceptor', async () => {
    const interceptor = GlobalInterceptors.getAll().find(
      (candidate) => candidate.name === 'asset-private-records',
    );
    if (!interceptor)
      throw new Error('Asset private-record interceptor missing');
    GlobalInterceptors.unregister(interceptor);
    try {
      await asActor(async () => {
        const restGet = await rest(
          new Request(`http://local/api/v1/assets/${PRIVATE_ID}`),
        );
        expect(restGet.status).toBe(200);
        expect(await restGet.json()).toMatchObject({
          id: PRIVATE_ID,
          sourceUri: 'file:///private.bin',
        });

        const mcpGet = await mcp.handleToolCall({
          method: 'tools/call',
          params: { name: 'asset_get', arguments: { id: PRIVATE_ID } },
        });
        expect(mcpGet.isError).not.toBe(true);
        expect(JSON.stringify(mcpGet.structuredContent)).toContain(
          'file:///private.bin',
        );
      });
    } finally {
      GlobalInterceptors.register(interceptor);
    }
  });
});
