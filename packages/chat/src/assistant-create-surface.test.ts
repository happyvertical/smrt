/**
 * The assistant creates an STI subtype through its base only when the
 * subtype's own `api` surface opens create: the closed subtypes are neither
 * offered as `createType` choices nor created when named anyway.
 */
import {
  CreateTargetError,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotObjectRegistryState } from '../../core/src/test-utils.js';
import {
  invokeManifestTool,
  type ManifestTool,
  manifestToolToAITool,
} from './tool-loop.js';

@smrt({
  packageName: '@happyvertical/smrt-chat',
  collection: 'assistant_surface_profiles',
  tableName: 'assistant_surface_profiles',
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create'] },
})
class AssistantSurfaceProfile extends SmrtObject {
  name = '';
}
/** Closed on the generated CRUD surface. */
@smrt({ packageName: '@happyvertical/smrt-chat', api: false })
class AssistantSurfaceService extends AssistantSurfaceProfile {
  privilege = '';
}
/** Read-only on the generated CRUD surface. */
@smrt({
  packageName: '@happyvertical/smrt-chat',
  api: { include: ['list', 'get'] },
})
class AssistantSurfaceReadOnly extends AssistantSurfaceProfile {
  privilege = '';
}
/** Creatable: the control. */
@smrt({
  packageName: '@happyvertical/smrt-chat',
  api: { include: ['list', 'get', 'create'] },
})
class AssistantSurfaceMember extends AssistantSurfaceProfile {
  privilege = '';
}

const base = '@happyvertical/smrt-chat:AssistantSurfaceProfile';
const service = '@happyvertical/smrt-chat:AssistantSurfaceService';
const readOnly = '@happyvertical/smrt-chat:AssistantSurfaceReadOnly';
const member = '@happyvertical/smrt-chat:AssistantSurfaceMember';
const tool: ManifestTool = {
  slug: 'assistant_surface_profiles.create',
  collection: 'assistant_surface_profiles',
  action: 'create',
  className: 'AssistantSurfaceProfile',
  qualifiedName: base,
};

describe('assistant STI create targets', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  const run = () =>
    ({
      context: { database: db, tenantId: 'tenant-a' },
      assertToolAllowed: vi.fn(),
      assertOperation: vi.fn(),
    }) as unknown as Parameters<typeof invokeManifestTool>[0];
  const rows = async () =>
    (
      await db.query(
        'SELECT name, _meta_type FROM assistant_surface_profiles ORDER BY name',
      )
    ).rows.map((row) => `${row.name}:${row._meta_type}`);

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    db = await getTestDatabase({
      classes: [base, service, readOnly, member],
    });
  });
  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  it('offers only subtypes whose own surface opens create', () => {
    const parameters = manifestToolToAITool(tool, 'tenant-a').function
      .parameters as { properties: Record<string, { enum?: string[] }> };
    expect(parameters.properties.createType.enum).toEqual([base, member]);
  });

  it.each([
    ['a subtype closed on the surface', service],
    ['a read-only subtype', readOnly],
  ])('refuses %s and writes nothing', async (_label, subtype) => {
    for (const selector of ['createType', '_meta_type']) {
      await expect(
        invokeManifestTool(run(), tool, {
          name: `via-${selector}`,
          privilege: 'root',
          [selector]: subtype,
        }),
      ).rejects.toBeInstanceOf(CreateTargetError);
    }
    expect(await rows()).toEqual([]);
  });

  it('creates the base and an open subtype', async () => {
    await invokeManifestTool(run(), tool, { name: 'a-base' });
    await invokeManifestTool(run(), tool, {
      name: 'b-member',
      createType: member,
    });
    expect(await rows()).toEqual([`a-base:${base}`, `b-member:${member}`]);
    const collection = await ObjectRegistry.getCollection(base, { db });
    const [created] = await collection.list({ where: { name: 'b-member' } });
    expect(created).toBeInstanceOf(AssistantSurfaceMember);
    expect(AssistantSurfaceService).toBeDefined();
    expect(AssistantSurfaceReadOnly).toBeDefined();
  });
});
