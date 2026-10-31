/**
 * #3468: `MagicLinkToken` carries the login-token hash and is declared
 * `sensitive: true` with `api: { exclude: ['*'] }` / `mcp: { exclude: ['*'] }`
 * ("No API access - internal only"). No generator read `'*'` as a wildcard,
 * so it excluded nothing: REST routed every CRUD verb and method, MCP listed
 * `magiclinktoken_verify` / `_hashtoken` / `_generate`, and the undecorated
 * `MagicLinkTokenCollection` inherited the same open surface.
 *
 * The scanner and `ObjectRegistry.getConfig()` now read `exclude: ['*']` as
 * closed. The admin-visibility CLI `list` the model declares stays.
 */
import { readFile } from 'node:fs/promises';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  isApiActionEnabledForObject,
  MCPGenerator,
} from '@happyvertical/smrt-core/generators';
import type { SmartObjectManifest } from '@happyvertical/smrt-core/scanner/types';
import { resolveApiActionSet } from '@happyvertical/smrt-core/vite-plugin';
import { describe, expect, it } from 'vitest';
import '../index.js';

const MODEL = '@happyvertical/smrt-profiles:MagicLinkToken';
const COLLECTION = '@happyvertical/smrt-profiles:MagicLinkTokenCollection';

describe('MagicLinkToken generated surface (#3468)', () => {
  it('generates no REST route for the token or its collection', async () => {
    for (const action of ['list', 'get', 'create', 'update', 'delete']) {
      expect(isApiActionEnabledForObject(MODEL, action), action).toBe(false);
    }
    const manifest = JSON.parse(
      await readFile(
        new URL('../../.smrt/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as SmartObjectManifest;
    for (const key of [MODEL, COLLECTION]) {
      const objectDef = manifest.objects[key];
      expect(objectDef, key).toBeDefined();
      expect([...resolveApiActionSet(objectDef, manifest)], key).toEqual([]);
    }
  });

  it('lists no MCP tool for the token or its collection', async () => {
    const tools = (await new MCPGenerator().generateTools()).map(
      (tool) => tool.name,
    );
    expect(
      tools.filter((name) => /^magiclinktoken(collection)?_/.test(name)),
    ).toEqual([]);
    expect(ObjectRegistry.getConfig(MODEL).mcp).toEqual({ include: [] });
    expect(ObjectRegistry.getConfig(MODEL).api).toEqual({ include: [] });
    expect(ObjectRegistry.getConfig(MODEL).cli).toEqual({ include: ['list'] });
  });
});
