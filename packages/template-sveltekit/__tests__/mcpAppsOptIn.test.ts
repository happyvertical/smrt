import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const staged = join(process.cwd(), 'mcp-apps-template');
const source = (path: string) => readFileSync(join(staged, path), 'utf8');

describe('opt-in MCP Apps runtime', () => {
  it('ships a native v2 mount with session-authorized tenant scopes', () => {
    expect(source('src/routes/api/mcp/+server.ts')).toContain('mountMcpRoute');
    const server = source('src/lib/server/mcp.ts');
    expect(server).toContain('event.locals?.permissions');
    expect(server).toContain("principal.scopes?.includes('items.read')");
    expect(server).toContain('csp: {}');
    expect(server).not.toContain('Authorization');
  });

  it('ships the portable bridge and only its explicit optional dependencies', () => {
    expect(source('src/lib/McpAppsBridge.svelte')).toContain('useMcpApp');
    expect(source('src/lib/McpAppsBridge.svelte')).toContain(
      'requestOpenAiDisplayMode',
    );
    expect(
      JSON.parse(source('package.dependencies.json')),
    ).toEqual({
      '@happyvertical/smrt-app-mcp': '^0.51.36',
      '@happyvertical/smrt-mcp-openai': '^0.51.36',
    });
  });
});
