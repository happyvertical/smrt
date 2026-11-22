/**
 * An assistant tool result never carries a field the principal may not read,
 * however deep a model sits in it: a custom action that returns models inside
 * an envelope or a list has each one serialised by its own public projection.
 */
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotObjectRegistryState } from '../../core/src/test-utils.js';
import { invokeManifestTool, type ManifestTool } from './tool-loop.js';

@smrt({
  packageName: '@happyvertical/smrt-chat',
  collection: 'nested_result_accounts',
  tableName: 'nested_result_accounts',
  api: { include: ['list', 'get', 'peers', 'shared'] },
})
class NestedResultAccount extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @field({ type: 'text', sensitive: true })
  apiSecret = '';

  @field({ type: 'text', readPermission: 'accounts.billing' })
  billingCode = '';

  /** A custom action whose result holds models in an envelope and a list. */
  async peers(): Promise<unknown> {
    return { self: this, list: [this], nested: { deeper: [{ item: this }] } };
  }

  /** A custom action whose result names one envelope twice. */
  async shared(): Promise<unknown> {
    const envelope = { list: [this] };
    return { first: envelope, second: envelope };
  }
}

const key = '@happyvertical/smrt-chat:NestedResultAccount';
const tool: ManifestTool = {
  slug: 'nested_result_accounts.peers',
  collection: 'nested_result_accounts',
  action: 'peers',
  className: 'NestedResultAccount',
  qualifiedName: key,
};

const sharedTool: ManifestTool = {
  ...tool,
  slug: 'nested_result_accounts.shared',
  action: 'shared',
};

describe('assistant nested results', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let id: string;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    db = await getTestDatabase({ classes: [key] });
    const accounts = await ObjectRegistry.getCollection(key, { db });
    const created = await accounts.create({
      name: 'acme',
      apiSecret: 'sk-live-secret',
      billingCode: 'BILL-42',
    } as never);
    id = created.id as string;
  });
  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  const invoke = (permissions: string[], target: ManifestTool = tool) =>
    invokeManifestTool(
      {
        context: { database: db, tenantId: 'tenant-a' },
        permissions: new Set(permissions),
        assertToolAllowed: vi.fn(),
        assertOperation: vi.fn(),
      } as unknown as Parameters<typeof invokeManifestTool>[0],
      target,
      { id },
    );

  it('projects every nested model for the principal', async () => {
    const text = JSON.stringify(await invoke([]));
    expect(text).toContain('acme');
    expect(text).not.toContain('sk-live-secret');
    expect(text).not.toContain('BILL-42');
  });

  it('serves a permission-gated field to a principal who holds it', async () => {
    const text = JSON.stringify(await invoke(['accounts.billing']));
    expect(text).toContain('BILL-42');
    expect(text).not.toContain('sk-live-secret');
  });

  it('projects a model reached twice through one shared envelope', async () => {
    const result = (await invoke([], sharedTool)) as {
      first: { list: Array<{ name: string }> };
      second: { list: Array<{ name: string }> };
    };
    const text = JSON.stringify(result);
    expect(text).not.toContain('sk-live-secret');
    expect(text).not.toContain('BILL-42');
    expect(result.second.list[0]?.name).toBe('acme');
  });
});
