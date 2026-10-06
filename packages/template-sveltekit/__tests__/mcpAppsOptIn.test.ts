import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const staged = join(process.cwd(), 'mcp-apps-template');
const source = (path: string) => readFileSync(join(staged, path), 'utf8');

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? files(path) : [relative(staged, path)];
  });
}

/**
 * The overlay mounts `@happyvertical/smrt-app-mcp` defaults (#3373). Server
 * creation, the model allow-list, the session principal, scope policy, the
 * origin check, hosted bearer auth (and its caching), the metadata route and
 * the `runtime`-derived bindings are proven in that package's tests
 * (`sveltekit-defaults`, `origin`, `auth-hosted`, `runtime-route`). The overlay files are type-checked against the template by
 * `pnpm typecheck` (tsconfig.fixture.json).
 */
describe('opt-in MCP Apps runtime', () => {
  it('ships only the two route files; principal bindings come from the runtime', () => {
    expect(files(join(staged, 'src')).sort()).toEqual([
      'src/routes/.well-known/oauth-protected-resource/api/mcp/+server.ts',
      'src/routes/api/mcp/+server.ts',
    ]);
  });

  it('mounts the app route with an explicit model and scope over session authority', () => {
    const route = source('src/routes/api/mcp/+server.ts');
    expect(route).toContain('export const POST = mountMcpAppRoute({');
    expect(route).toContain('models: [Item]');
    expect(route).toContain("requiredScopes: ['items.read']");
    // The runtime supplies the request database, the bearer adapter and the
    // principal binding (#3491); the overlay wires none of them by hand.
    expect(route).toContain('  runtime,\n');
    expect(route).not.toContain('smrtOptions');
    // The default principal comes from the verified session locals; bearer
    // principals (local owner tokens, hosted access tokens) come from the
    // runtime bindings. No route-level or app-owned resolver override.
    expect(route).not.toContain('resolvePrincipal:');
    expect(route).not.toContain('checkOrigin');
    expect(route).not.toContain('Authorization');
    expect(route).toContain('csp: {}');
  });

  it('exposes only read-only tools until per-operation authorization exists', () => {
    const route = source('src/routes/api/mcp/+server.ts');
    // `items.read` gates every published tool, so the catalog itself must be
    // limited to read effects; create/update/delete are never enumerable.
    expect(route).toContain("effects: ['read']");
  });

  it('leaves the bearer binding to the runtime, never an override', () => {
    const route = source('src/routes/api/mcp/+server.ts');
    // Under database-rls the request transaction must carry the bearer
    // user, tenant and permissions, not the anonymous or cookie session:
    // `runtime` binds with `runtime.runAsPrincipal` (smrt-app-mcp
    // `runtime-route.test.ts`, and `localMcpToken`/`mcpBearerRls` here).
    expect(route).not.toContain('bindPrincipal');
  });

  it('derives the route and its metadata from the runtime with no top-level await', () => {
    const route = source('src/routes/api/mcp/+server.ts');
    const metadata = source(
      'src/routes/.well-known/oauth-protected-resource/api/mcp/+server.ts',
    );
    for (const file of [route, metadata]) {
      // The profile is resolved per request by the mounts, so neither module
      // awaits it at import time or builds its own auth adapter.
      expect(file).not.toContain('await runtime.resolvedRuntime()');
      expect(file).not.toContain("from '@happyvertical/smrt-app-mcp/auth'");
      expect(file).not.toMatch(/^\s*auth:/m);
    }
    expect(metadata).toContain(
      'export const GET = mountMcpProtectedResourceMetadataRoute({ runtime });',
    );
  });

  it('declares only its explicit optional dependencies', () => {
    const release = `^${JSON.parse(readFileSync(join(process.cwd(), '../core/package.json'), 'utf8')).version}`;
    expect(JSON.parse(source('package.dependencies.json'))).toEqual({
      '@happyvertical/smrt-app-mcp': release,
      '@happyvertical/smrt-mcp-openai': release,
    });
  });
});
