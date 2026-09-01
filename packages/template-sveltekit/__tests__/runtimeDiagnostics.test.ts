import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectRuntimeDiagnostics } from '@happyvertical/smrt-app-runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeDiagnosticsWebMcpTool,
  registerRuntimeDiagnosticsWebMcp,
  RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME,
} from '../template/src/lib/runtime-diagnostics-webmcp.js';
import {
  createRuntimeDiagnosticsGet,
  RUNTIME_DIAGNOSTICS_READ_PERMISSION,
} from '../template/src/lib/server/runtime-diagnostics.js';

const here = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(
  join(
    here,
    '..',
    'template',
    'src',
    'lib',
    'RuntimeDiagnosticsWebMcp.svelte',
  ),
  'utf8',
);

const publicDiagnostics = projectRuntimeDiagnostics({
  profile: 'local',
  health: 'healthy',
  schema: { status: 'ready', migrations: 'current' },
  capabilities: {
    'asset-storage': 'available',
    authentication: 'available',
    'background-jobs': 'disabled',
    database: 'available',
    'paid-capabilities': 'disabled',
    'secret-storage': 'available',
  },
  toolNames: ['smrt.items.read', RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME],
  worker: { topology: 'inline', required: false },
  observedAt: '2026-09-01T12:34:56Z',
  recentErrors: [],
});

function ownerLocals(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'owner-user' },
    tenantId: 'authorized-tenant',
    sessionId: 'authenticated-session',
    permissions: [],
    membership: {
      userId: 'owner-user',
      tenantId: 'authorized-tenant',
      roleId: 'owner-role',
      isActive: () => true,
    },
    ...overrides,
  };
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe('authenticated runtime diagnostics route', () => {
  it('returns the public projection for an authenticated owner', async () => {
    const readDiagnostics = vi.fn(async () => publicDiagnostics);
    const handler = createRuntimeDiagnosticsGet({
      resolveRoleSlug: vi.fn(async () => 'owner'),
      readDiagnostics,
    });
    const response = await handler({ locals: ownerLocals() });

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(publicDiagnostics);
    expect(readDiagnostics).toHaveBeenCalledOnce();
  });

  it('accepts the explicit diagnostics-read permission for an active principal', async () => {
    const resolveRoleSlug = vi.fn(async () => 'member');
    const handler = createRuntimeDiagnosticsGet({
      resolveRoleSlug,
      readDiagnostics: async () => publicDiagnostics,
    });
    const response = await handler({
      locals: ownerLocals({
        permissions: [RUNTIME_DIAGNOSTICS_READ_PERMISSION],
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveRoleSlug).not.toHaveBeenCalled();
  });

  it('fails unauthenticated, unauthorized member, and cross-tenant access before projection', async () => {
    const cases = [
      { expected: 401, locals: {} },
      { expected: 403, locals: ownerLocals() },
      {
        expected: 401,
        locals: ownerLocals({
          tenantId: 'other-tenant',
        }),
      },
      {
        expected: 401,
        locals: ownerLocals({
          membership: null,
          permissions: [RUNTIME_DIAGNOSTICS_READ_PERMISSION],
        }),
      },
    ];
    for (const testCase of cases) {
      const readDiagnostics = vi.fn(async () => publicDiagnostics);
      const handler = createRuntimeDiagnosticsGet({
        resolveRoleSlug: vi.fn(async () => 'member'),
        readDiagnostics,
      });
      const response = await handler({ locals: testCase.locals });
      expect(response.status).toBe(testCase.expected);
      expect(readDiagnostics).not.toHaveBeenCalled();
      expect(JSON.stringify(await body(response))).not.toContain('profile');
    }
  });

  it('returns only a stable error when an authorized projection fails', async () => {
    const handler = createRuntimeDiagnosticsGet({
      resolveRoleSlug: async () => 'owner',
      readDiagnostics: async () => {
        throw new Error(
          'postgresql://private.example/db /Users/alice/private token=secret',
        );
      },
    });
    const response = await handler({ locals: ownerLocals() });
    const serialized = JSON.stringify(await body(response));

    expect(response.status).toBe(503);
    expect(serialized).toBe(
      '{"schemaVersion":1,"error":{"code":"diagnostics_unavailable"}}',
    );
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('token');
  });
});

describe('runtime diagnostics WebMCP registration', () => {
  it('registers exactly one namespaced read-only page-user tool and disposes with its owner', async () => {
    const registrations: Array<{
      tool: ReturnType<typeof createRuntimeDiagnosticsWebMcpTool>;
      signal: AbortSignal;
    }> = [];
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(publicDiagnostics), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const owner = registerRuntimeDiagnosticsWebMcp({
      fetchFn,
      modelContext: {
        registerTool(tool, options) {
          registrations.push({ tool, signal: options.signal });
        },
      },
    });

    expect(owner).not.toBeNull();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.tool).toMatchObject({
      name: RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { type: 'object', additionalProperties: false },
    });

    const result = await registrations[0]?.tool.execute({ ignored: true });
    expect(JSON.parse(result ?? '{}')).toEqual(publicDiagnostics);
    expect(fetchFn).toHaveBeenCalledWith('/api/_runtime/diagnostics', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    expect(registrations[0]?.signal.aborted).toBe(false);
    owner?.dispose();
    expect(registrations[0]?.signal.aborted).toBe(true);
  });

  it('never exposes raw route failures or calls a principal-bound server tool', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        'postgresql://private.example/db /Users/alice/private token=secret',
        { status: 403 },
      ),
    ) as unknown as typeof fetch;
    const tool = createRuntimeDiagnosticsWebMcpTool(fetchFn);
    const result = await tool.execute({});

    expect(result).toBe(
      '{"ok":false,"error":{"code":"authorization_denied"}}',
    );
    expect(result).not.toContain('postgresql://');
    expect(result).not.toContain('/Users/');
    expect(result).not.toContain('token');
    expect(componentSource).toContain('registerRuntimeDiagnosticsWebMcp()');
    expect(componentSource).toContain('owner?.dispose()');
    expect(componentSource).not.toContain('serverTool');
  });
});
