/** Default app-MCP allow-list and principal policy (#3373). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  createDefaultMcpAppServer,
  mcpAllowedClassNames,
  mcpPrincipalScopePolicy,
} from '../defaults.js';

@smrt({ mcp: { include: ['list'] } })
class LaneDefaultsModel extends SmrtObject {
  label: string = '';
}

describe('mcpAllowedClassNames', () => {
  it('resolves registered model constructors to their registered names once', () => {
    expect(
      mcpAllowedClassNames([LaneDefaultsModel, LaneDefaultsModel]),
    ).toEqual(['LaneDefaultsModel']);
    expect(mcpAllowedClassNames([])).toEqual([]);
  });

  it('rejects anything that is not an explicit list of registered models', () => {
    class Plain {}
    for (const models of [
      [Plain],
      ['LaneDefaultsModel'],
      [null],
      'LaneDefaultsModel',
      undefined,
    ]) {
      expect(() => mcpAllowedClassNames(models as never)).toThrow(TypeError);
    }
  });
});

describe('mcpPrincipalScopePolicy', () => {
  const policy = mcpPrincipalScopePolicy({ requiredScopes: ['items.read'] });
  const owner = {
    id: 'u',
    tenantId: 't',
    kind: 'human',
    scopes: ['items.read'],
  };

  it('accepts a complete human tenant principal holding every scope', () => {
    expect(policy({ principal: owner })).toBe(true);
    expect(
      mcpPrincipalScopePolicy({ requiredScopes: [] })({
        principal: { id: 'u', tenantId: 't', kind: 'human' },
      }),
    ).toBe(true);
  });

  it('defers an absent principal to the base public read-only rule', () => {
    expect(policy({ principal: null })).toBe(true);
  });

  it.each([
    ['missing scope', { ...owner, scopes: ['items.create'] }],
    ['no scopes', { ...owner, scopes: undefined }],
    ['service kind', { ...owner, kind: 'service' }],
    ['no kind', { ...owner, kind: undefined }],
    ['no id', { ...owner, id: undefined }],
    ['empty id', { ...owner, id: '' }],
    ['no tenant', { ...owner, tenantId: undefined }],
    ['empty object', {}],
  ])('denies %s', (_label, principal) => {
    expect(policy({ principal })).toBe(false);
  });

  it('honours configured kinds and snapshots its configuration', () => {
    const scopes = ['items.read'];
    const service = mcpPrincipalScopePolicy({
      requiredScopes: scopes,
      principalKinds: ['service'],
    });
    scopes.length = 0;
    expect(service({ principal: { ...owner, kind: 'service' } })).toBe(true);
    expect(
      service({ principal: { ...owner, kind: 'service', scopes: [] } }),
    ).toBe(false);
    expect(service({ principal: owner })).toBe(false);
  });

  it.each([
    [{ requiredScopes: undefined }],
    [{ requiredScopes: 'items.read' }],
    [{ requiredScopes: ['has space'] }],
    [{ requiredScopes: [''] }],
    [{ requiredScopes: [], principalKinds: 'human' }],
  ])('rejects malformed configuration %j', (options) => {
    expect(() => mcpPrincipalScopePolicy(options as never)).toThrow(TypeError);
  });
});

describe('createDefaultMcpAppServer', () => {
  it('defaults the server identity without sharing a mutable object', () => {
    const one = createDefaultMcpAppServer({
      models: [],
      requiredScopes: [],
      smrtOptions: () => ({}),
    });
    const two = createDefaultMcpAppServer({
      models: [],
      requiredScopes: [],
      smrtOptions: () => ({}),
      serverInfo: { name: 'custom', version: '2' },
    });
    expect(one.serverInfo).toEqual({ name: 'smrt-app', version: '0.1.0' });
    expect(two.serverInfo).toEqual({ name: 'custom', version: '2' });
  });
});

describe('entry-point boundaries', () => {
  const dist = join(import.meta.dirname, '..', '..', 'dist');
  const read = (file: string) => {
    try {
      return readFileSync(join(dist, file), 'utf8');
    } catch {
      return undefined;
    }
  };

  it.runIf(read('sveltekit.js') !== undefined)(
    'server entries import no Svelte or browser bridge code',
    () => {
      for (const file of ['index.js', 'sveltekit.js', 'auth.js']) {
        const source = read(file) ?? '';
        expect(source).not.toMatch(/from\s*['"]svelte/u);
        expect(source).not.toContain('@happyvertical/smrt-svelte');
        expect(source).not.toContain('@happyvertical/smrt-mcp-apps');
        expect(source).not.toContain('smrt-mcp-openai');
      }
      // The SvelteKit entry types its bearer adapter structurally and does
      // not load the JWT verifier.
      expect(read('sveltekit.js')).not.toMatch(/from\s*['"]jose['"]/u);
    },
  );
});
