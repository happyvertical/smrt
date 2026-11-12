/** Local-owner setup composition; credentials remain in the existing runtime store. */
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrincipalTool } from '@happyvertical/smrt-agents';
import type { generateLocalMcpSetup } from '@happyvertical/smrt-app-cli';
import type { LocalMcpTokenRecord } from '@happyvertical/smrt-app-runtime';
import type { SmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import type { RequestEvent } from '@sveltejs/kit';
import type { createCookbookHostState } from './state.js';

export const PLUGIN_PERMISSION = 'app.plugin';
export const PLUGIN_CLIENTS = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
} as const;
export type PluginClient = keyof typeof PLUGIN_CLIENTS;
export type PluginConnection = {
  client: PluginClient;
  name: string;
  status: LocalMcpTokenRecord['status'] | 'not_connected';
  lastSeen: LocalMcpTokenRecord['lastUsedAt'];
  setup: ReturnType<typeof generateLocalMcpSetup> | null;
};
export type PluginModeState = {
  embed: boolean;
  connections: PluginConnection[];
  chatgpt: string;
  /** The same live definitions supplied to the in-app assistant. */
  tools?: Array<{
    definition: PrincipalTool['aiTool']['function'];
    source: 'model' | 'recipe' | 'app' | 'lifecycle';
    model?: string;
    operation?: string;
    recipe?: string;
  }>;
};

export function createPluginMode(options: {
  runtime: SmrtSvelteKitRuntime;
  sourceRoot: string;
  name: string;
  state: () => Promise<Awaited<ReturnType<typeof createCookbookHostState>>>;
  tools?: (actor: {
    id: string;
    tenantId: string;
  }) => Promise<PluginModeState['tools']>;
  authorize(
    event: RequestEvent,
  ): Promise<{ id: string; tenantId: string } | null>;
}) {
  const { runtime } = options;
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  async function locations(client: PluginClient) {
    const local = await runtime.localRuntime();
    if (!local.mcpTokens) throw new Error('Local MCP token store unavailable');
    const directory = join(runtime.applicationStateRoot(), 'plugin-mode');
    return {
      local,
      store: local.mcpTokens,
      directory,
      config: join(directory, `${client}.json`),
      launcher: join(directory, `${client}.mjs`),
    };
  }
  async function launchOptions(client: PluginClient) {
    const paths = await locations(client);
    const packaged = join(
      options.sourceRoot,
      '..',
      'bridge',
      'smrt-mcp-bridge.mjs',
    );
    const bridgePath = await access(packaged).then(
      () => packaged,
      () =>
        join(
          dirname(
            fileURLToPath(import.meta.resolve('@happyvertical/smrt-app-cli')),
          ),
          'bin',
          'smrt-mcp-bridge.js',
        ),
    );
    let resourceRoot = dirname(process.execPath);
    while (relative(resourceRoot, bridgePath).startsWith('..'))
      resourceRoot = dirname(resourceRoot);
    return {
      productId: runtime.applicationId(),
      appId: runtime.applicationId(),
      dataDirectory: paths.local.paths.root,
      sourceRoot: options.sourceRoot,
      resourceRoot,
      nodePath: process.execPath,
      bridgePath,
      healthRoute: '/api/_runtime/health',
      envPrefix: 'SMRT_PLUGIN',
      scopes: [PLUGIN_PERMISSION],
      credentialPath: paths.config,
      mcpPath: '/mcp',
      serverName: options.name,
      serverVersion: '1.0.0',
    };
  }
  async function setup(client: PluginClient) {
    const { launcher } = await locations(client);
    const { generateLocalMcpSetup } = await import(
      '@happyvertical/smrt-app-cli'
    );
    return generateLocalMcpSetup({
      name: options.name,
      command: process.execPath,
      args: [launcher],
    });
  }
  async function read(actor: {
    id: string;
    tenantId: string;
  }): Promise<PluginModeState> {
    const local = await runtime.localRuntime();
    if (!local.mcpTokens) throw new Error('Local MCP token store unavailable');
    const records = await local.mcpTokens.list();
    const { generateLocalMcpSetup } = await import(
      '@happyvertical/smrt-app-cli'
    );
    return {
      tools: await options.tools?.(actor),
      embed: await (await options.state()).embed(actor.tenantId, actor.id),
      connections: await Promise.all(
        (Object.keys(PLUGIN_CLIENTS) as PluginClient[]).map(async (client) => {
          const record =
            records.find(
              (r) =>
                r.holder === `plugin-mode:${client}` && r.status === 'active',
            ) ?? records.find((r) => r.holder === `plugin-mode:${client}`);
          return {
            client,
            name: PLUGIN_CLIENTS[client],
            status: record?.status ?? 'not_connected',
            lastSeen: record?.lastUsedAt ?? null,
            setup: record?.status === 'active' ? await setup(client) : null,
          };
        }),
      ),
      chatgpt: generateLocalMcpSetup({
        name: options.name,
        command: process.execPath,
        args: [],
      }).chatgpt,
    };
  }
  async function handle(event: RequestEvent) {
    // No proxy headers or bearer can turn a remote request into a local owner.
    let peer: string;
    try {
      peer = event.getClientAddress();
    } catch {
      return reply({ code: 'not_allowed' }, 403);
    }
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(event.url.hostname) ||
      event.request.headers.get('host') !== event.url.host ||
      event.request.headers.has('authorization')
    )
      return reply({ code: 'not_allowed' }, 403);
    const actor = await options.authorize(event);
    if (!actor) return reply({ code: 'not_allowed' }, 403);
    if (event.request.method === 'GET') return reply(await read(actor));
    if (event.request.method !== 'POST')
      return reply({ code: 'method_not_allowed' }, 405);
    if (event.request.headers.get('origin') !== event.url.origin)
      return reply({ code: 'invalid_origin' }, 403);
    if (
      event.request.headers.get('content-type')?.split(';')[0].trim() !==
      'application/json'
    )
      return reply({ code: 'invalid_request' }, 415);
    const reader = event.request.body?.getReader();
    if (!reader) return reply({ code: 'invalid_request' }, 400);
    let body: Record<string, unknown>;
    try {
      let raw = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4096) {
          await reader.cancel();
          return reply({ code: 'body_too_large' }, 413);
        }
        raw += decoder.decode(part.value, { stream: true });
      }
      body = JSON.parse(raw + decoder.decode());
      if (!body || Array.isArray(body) || typeof body !== 'object')
        return reply({ code: 'invalid_request' }, 400);
    } catch {
      return reply({ code: 'invalid_request' }, 400);
    } finally {
      reader.releaseLock();
    }
    if (
      body.action === 'embed' &&
      typeof body.enabled === 'boolean' &&
      Object.keys(body).length === 2
    ) {
      await (await options.state()).setEmbed(
        actor.tenantId,
        actor.id,
        body.enabled,
      );
    } else {
      const client = body.client;
      if (
        typeof client !== 'string' ||
        !Object.hasOwn(PLUGIN_CLIENTS, client) ||
        Object.keys(body).length !== 2 ||
        (body.action !== 'connect' && body.action !== 'revoke')
      )
        return reply({ code: 'invalid_request' }, 400);
      const selected = client as PluginClient;
      const paths = await locations(selected);
      const holder = `plugin-mode:${selected}`;
      if (body.action === 'revoke') {
        await paths.store.revokeHolder(holder);
        await unlink(paths.config).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
      } else {
        const issued = await paths.store.issue(
          {
            scopes: [PLUGIN_PERMISSION],
            holder,
            label: PLUGIN_CLIENTS[selected],
          },
          { userId: actor.id, tenantId: actor.tenantId },
        );
        try {
          const { saveCliConfig } = await import('@happyvertical/smrt-app-cli');
          await saveCliConfig(
            { envPrefix: 'SMRT_PLUGIN', configPath: paths.config },
            { serverUrl: event.url.origin, token: issued.token },
          );
          await mkdir(paths.directory, { recursive: true, mode: 0o700 });
          await writeFile(
            paths.launcher,
            `import { runLauncher } from ${JSON.stringify(import.meta.resolve('@happyvertical/smrt-desktop/launcher'))};\nprocess.exitCode = await runLauncher(${JSON.stringify(await launchOptions(selected))});\n`,
            { mode: 0o600 },
          );
        } catch {
          await paths.store.revoke(issued.id);
          return reply({ code: 'setup_failed' }, 503);
        }
      }
    }
    return reply(await read(actor));
  }
  return { handle, read };
}
