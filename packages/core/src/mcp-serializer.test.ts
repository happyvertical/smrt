import { describe, expect, it, vi } from 'vitest';

const { resolveImport } = vi.hoisted(() => ({
  resolveImport: vi.fn(() => {
    throw new Error('consumer fallback must not run');
  }),
}));

vi.mock('import-meta-resolve', () => ({ resolve: resolveImport }));

import { resolveMcpGetSerializer } from './mcp-serializer';

describe('MCP get serializer resolution', () => {
  it('does not resolve a consumer fallback after a direct import succeeds', async () => {
    const serializer = await resolveMcpGetSerializer({
      importPath: 'vitest',
      exportName: 'expect',
    });

    expect(serializer).toBe(expect);
    expect(resolveImport).not.toHaveBeenCalled();
  });
});
