import { DatabaseSync } from 'node:sqlite';
import {
  createMcpAppServer,
  type McpAppPrincipal,
  type McpAppServer,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  bindOpenAiSettings,
  EMPTY_ARGUMENTS_SCHEMA,
  openAiDisplayMetadata,
  resolveOpenAiNavigationTarget,
  withOpenAiEntrypoints,
} from './index.js';

const schema = {
  type: 'object' as const,
  properties: {
    units: { type: 'string' as const, title: 'Units', enum: ['mm', 'in'] },
    grid: { type: 'boolean' as const, title: 'Grid' },
  },
};
const owner = {
  id: 'synthetic-owner',
  tenantId: 'tenant-a',
  scopes: ['settings', 'view'],
};
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE settings (owner TEXT, tenant TEXT, units TEXT, grid INTEGER, revision INTEGER, PRIMARY KEY(owner,tenant))',
  );
  db.prepare('INSERT INTO settings VALUES (?, ?, ?, ?, ?)').run(
    owner.id,
    owner.tenantId,
    'mm',
    1,
    0,
  );
  let revoked = false;
  let writes = 0;
  let providerFailure = false;
  let stale = false;
  const values = () => {
    const row = db
      .prepare('SELECT * FROM settings WHERE owner=? AND tenant=?')
      .get(owner.id, owner.tenantId)!;
    return { units: row.units as string, grid: Boolean(row.grid) };
  };
  const base: McpWorkflowToolDefinition = {
    name: 'view',
    description: 'Synthetic view',
    inputSchema: EMPTY_ARGUMENTS_SCHEMA,
    outputSchema: { type: 'object' },
    effect: 'read',
    idempotent: true,
    openWorld: false,
    execute: () => ({
      content: [{ type: 'text', text: 'Complete synthetic headless view' }],
      structuredContent: { title: 'Synthetic item' },
    }),
  };
  let server: McpAppServer;
  const settings = bindOpenAiSettings({
    schema,
    server: () => server,
    read: {
      ...base,
      name: 'settings_read',
      execute: () => ({
        content: [{ type: 'text', text: 'Synthetic settings' }],
        structuredContent: {
          schema,
          values: values(),
          layout: [
            {
              kind: 'group',
              title: 'Settings',
              items: [
                { kind: 'property', property: 'units' },
                { kind: 'tool', tool: 'view', title: 'Open app' },
              ],
            },
          ],
        },
      }),
    },
    update: {
      ...base,
      name: 'settings_update',
      effect: 'write',
      execute: (context) => {
        // Existing domain executor binds identity, atomically patches absolute values,
        // and owns its revision guard. The extension introduces no revision wire field.
        if (
          context.principal?.id !== owner.id ||
          context.principal.tenantId !== owner.tenantId ||
          revoked
        )
          throw new Error('Domain authorization denied');
        const set = context.arguments.set as { units?: string; grid?: boolean };
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db
            .prepare('SELECT * FROM settings WHERE owner=? AND tenant=?')
            .get(context.principal.id, context.principal.tenantId)!;
          const expected = Number(row.revision) - (stale ? 1 : 0);
          const updated = db
            .prepare(
              'UPDATE settings SET units=?, grid=?, revision=revision+1 WHERE owner=? AND tenant=? AND revision=?',
            )
            .run(
              set.units ?? row.units,
              set.grid === undefined ? row.grid : Number(set.grid),
              context.principal.id,
              context.principal.tenantId,
              expected,
            );
          if (updated.changes !== 1) throw new Error('Stale revision');
          if (providerFailure) throw new Error('Synthetic provider failure');
          db.exec('COMMIT');
          writes++;
          return {
            content: [{ type: 'text', text: 'Settings saved' }],
            structuredContent: { values: values() },
          };
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  });
  const view = withOpenAiEntrypoints(
    { ...base, ui: { resourceUri: 'ui://synthetic/v1/view' } },
    ['global', 'thread'],
  );
  server = createMcpAppServer({
    serverInfo: { name: 'synthetic-navigation', version: '1' },
    smrtOptions: () => ({}),
    allowedClassNames: [],
    resources: [
      {
        name: 'View',
        uri: 'ui://synthetic/v1/view',
        version: 'v1',
        html: '<!doctype html><title>Synthetic</title>',
        metadata: openAiDisplayMetadata({
          preferredDisplayMode: 'fullscreen',
          availableDisplayModes: ['inline', 'fullscreen'],
        }),
      },
    ],
    workflowTools: [
      view,
      ...settings.workflows,
      {
        ...base,
        name: 'resolve_target',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false,
        },
        execute: ({ arguments: args, principal }) => {
          if (
            principal?.id !== owner.id ||
            principal.tenantId !== owner.tenantId ||
            args.url !== '/items/owned'
          )
            throw new Error('Navigation target denied');
          return {
            content: [{ type: 'text', text: 'Owned synthetic item' }],
            structuredContent: { id: 'owned' },
          };
        },
      },
    ],
    resourcePolicy: ({ principal, resource }) =>
      !revoked &&
      principal?.id === owner.id &&
      principal.tenantId === owner.tenantId &&
      principal.scopes?.includes('view') === true &&
      resource.uri === 'ui://synthetic/v1/view',
    toolPolicy: ({ principal, tool }) =>
      !revoked &&
      principal?.id === owner.id &&
      principal.tenantId === owner.tenantId &&
      principal.scopes?.includes(
        tool.name.startsWith('settings_') ? 'settings' : 'view',
      ) === true,
  });
  return {
    server,
    settings,
    db,
    values,
    writes: () => writes,
    revoke: () => {
      revoked = true;
    },
    fail: () => {
      providerFailure = true;
    },
    stale: () => {
      stale = true;
    },
  };
}
describe('existing principal workflow authority', () => {
  it('binds settings allow/deny to actor, ownership, active tenant and revocation', async () => {
    const f = fixture();
    try {
      expect(
        f.settings.extensions(await f.server.listTools({ principal: owner })),
      ).toHaveProperty('openai/settings');
      for (const principal of [
        null,
        { ...owner, id: 'other' },
        { ...owner, tenantId: 'tenant-b' },
        { ...owner, scopes: [] },
      ]) {
        expect(
          f.settings.extensions(await f.server.listTools({ principal })),
        ).toEqual({});
        for (const name of [
          'settings_read',
          'settings_update',
          'view',
          'resolve_target',
        ])
          await expect(
            f.server.callTool({
              name,
              arguments: { set: { grid: false } },
              principal,
            }),
          ).rejects.toThrow();
      }
      await expect(
        f.server.callTool({
          name: 'settings_read',
          arguments: {},
          principal: owner,
        }),
      ).resolves.toHaveProperty('structuredContent.values.units', 'mm');
      await expect(
        f.server.callTool({
          name: 'settings_update',
          arguments: { set: { grid: false }, tenantId: 'tenant-b' },
          principal: owner,
        }),
      ).rejects.toThrow();
      f.revoke();
      expect(
        f.settings.extensions(await f.server.listTools({ principal: owner })),
      ).toEqual({});
      await expect(
        f.server.callTool({
          name: 'settings_update',
          arguments: { set: { grid: false } },
          principal: owner,
        }),
      ).rejects.toThrow();
      expect(f.writes()).toBe(0);
    } finally {
      f.db.close();
    }
  });
  it('preserves absolute assignment retries, concurrent patches, rollback and owning revision guards', async () => {
    const f = fixture();
    const update = (set: Record<string, unknown>) =>
      f.server.callTool({
        name: 'settings_update',
        arguments: { set },
        principal: owner,
      });
    try {
      await update({ grid: false });
      await update({ grid: false });
      expect(f.values()).toEqual({ units: 'mm', grid: false });
      await Promise.all([update({ units: 'in' }), update({ grid: true })]);
      expect(f.values()).toEqual({ units: 'in', grid: true });
      f.fail();
      await expect(update({ units: 'mm' })).rejects.toThrow('provider');
      expect(f.values()).toEqual({ units: 'in', grid: true });
      f.stale();
      await expect(update({ grid: false })).rejects.toThrow('revision');
      expect(f.writes()).toBe(4); // No hidden retries by the adapter.
    } finally {
      f.db.close();
    }
  });
  it('omits denied layout tools and resolves routes through the same read policy', async () => {
    const f = fixture();
    try {
      const settingsOnly = { ...owner, scopes: ['settings'] };
      const result = await f.server.callTool({
        name: 'settings_read',
        arguments: {},
        principal: settingsOnly,
      });
      expect(result.structuredContent?.layout).toEqual([
        {
          kind: 'group',
          title: 'Settings',
          items: [{ kind: 'property', property: 'units' }],
        },
      ]);
      await expect(
        resolveOpenAiNavigationTarget({
          server: f.server,
          tool: 'resolve_target',
          url: '/items/owned',
          principal: owner,
        }),
      ).resolves.toHaveProperty('structuredContent.id', 'owned');
      await expect(
        resolveOpenAiNavigationTarget({
          server: f.server,
          tool: 'resolve_target',
          url: '/items/other',
          principal: owner,
        }),
      ).rejects.toThrow();
      await expect(
        resolveOpenAiNavigationTarget({
          server: f.server,
          tool: 'resolve_target',
          url: '/items/owned',
          principal: { ...owner, tenantId: 'other' },
        }),
      ).rejects.toThrow();
      await expect(
        resolveOpenAiNavigationTarget({
          server: f.server,
          tool: 'settings_update',
          url: '/',
          principal: owner,
        }),
      ).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
  it('preserves canonical entrypoint/resource metadata over actual scoped SDK v2 HTTP', async () => {
    const f = fixture();
    let principal: McpAppPrincipal | null = owner;
    const mount = mountMcpRoute(f.server, {
      resolvePrincipal: () => principal,
      extensions: ({ tools }) => f.settings.extensions(tools),
    });
    const envelopes: unknown[] = [];
    const client = new Client(
      { name: 'synthetic-client', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('https://synthetic.test/mcp'),
          {
            fetch: async (input, init) => {
              const request = new Request(input, init);
              const response = await mount({
                request,
                url: new URL(request.url),
              });
              if (
                response.headers
                  .get('Content-Type')
                  ?.includes('application/json')
              )
                envelopes.push(await response.clone().json());
              return response;
            },
          },
        ),
      );
      expect(JSON.stringify(envelopes)).toContain('openai/settings');
      expect(JSON.stringify(envelopes)).toContain('2026-07-28');
      const catalog = await client.listTools();
      expect(
        catalog.tools.find((tool) => tool.name === 'view')?._meta?.[
          'openai/ui'
        ],
      ).toEqual({ entrypoints: [{ type: 'global' }, { type: 'thread' }] });
      const initial = await client.callTool({ name: 'view', arguments: {} });
      expect(initial.content).toEqual([
        { type: 'text', text: 'Complete synthetic headless view' },
      ]);
      const resource = await client.readResource({
        uri: 'ui://synthetic/v1/view',
      });
      expect(resource.contents[0]._meta?.['openai/ui']).toEqual({
        preferredDisplayMode: 'fullscreen',
        availableDisplayModes: ['inline', 'fullscreen'],
      });
      expect(
        await client.callTool({ name: 'settings_read', arguments: {} }),
      ).toHaveProperty('structuredContent.values.units', 'mm');
      for (const denied of [
        null,
        { ...owner, id: 'other' },
        { ...owner, tenantId: 'other' },
        { ...owner, scopes: ['settings'] },
      ]) {
        principal = denied;
        await expect(
          client.readResource({ uri: 'ui://synthetic/v1/view' }),
        ).rejects.toThrow();
      }
      principal = owner;
      f.revoke();
      await expect(
        client.readResource({ uri: 'ui://synthetic/v1/view' }),
      ).rejects.toThrow();
      principal = { ...owner, tenantId: 'other' };
      // The SDK may cache private descriptors; every call still reauthorizes.
      expect(await f.server.listTools({ principal })).toEqual([]);
      await expect(
        client.callTool({ name: 'settings_read', arguments: {} }),
      ).rejects.toThrow();
    } finally {
      await client.close();
      f.db.close();
    }
  });
});
