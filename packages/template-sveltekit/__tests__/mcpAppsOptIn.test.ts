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
 * origin check, hosted bearer auth (and its caching), and the metadata route
 * are proven in that package's tests (`sveltekit-defaults`, `origin`,
 * `auth-hosted`). The overlay files are type-checked against the template by
 * `pnpm typecheck` (tsconfig.fixture.json).
 */
describe('opt-in MCP Apps runtime', () => {
  it('ships two route files and the application-owned principal binding only', () => {
    expect(files(join(staged, 'src')).sort()).toEqual([
      'src/lib/server/mcp-hosted-principal.ts',
      'src/routes/.well-known/oauth-protected-resource/api/mcp/+server.ts',
      'src/routes/api/mcp/+server.ts',
    ]);
  });

  it('mounts the app route with an explicit model and scope over session authority', () => {
    const route = source('src/routes/api/mcp/+server.ts');
    expect(route).toContain('export const POST = mountMcpAppRoute({');
    expect(route).toContain('models: [Item]');
    expect(route).toContain("requiredScopes: ['items.read']");
    expect(route).toContain('smrtOptions: () => ({ db: runtime.databaseConfig() })');
    // The default principal comes from the verified session locals; the only
    // resolver is the hosted bearer mapping, never a route-level override.
    expect(route.match(/resolvePrincipal:/g)).toEqual(['resolvePrincipal:']);
    expect(route).toContain('resolvePrincipal: resolveHostedMcpPrincipal');
    expect(route).not.toContain('checkOrigin');
    expect(route).not.toContain('Authorization');
    expect(route).toContain('csp: {}');
  });

  it('shares one hosted auth configuration between the route and its metadata', () => {
    const route = source('src/routes/api/mcp/+server.ts');
    const metadata = source(
      'src/routes/.well-known/oauth-protected-resource/api/mcp/+server.ts',
    );
    for (const file of [route, metadata]) {
      expect(file).toContain('createHostedMcpResourceAuth({');
      expect(file).toContain('resolvePrincipal: resolveHostedMcpPrincipal');
    }
    expect(metadata).toContain(
      'export const GET = mountMcpProtectedResourceMetadataRoute(',
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
