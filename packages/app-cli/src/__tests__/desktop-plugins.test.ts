import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  type DesktopPluginLauncher,
  generateDesktopPluginArtifacts,
} from '../desktop-plugins.js';

const kitchen = JSON.parse(
  readFileSync(
    new URL('../../../../plugins/smrt-kitchen/plugin.json', import.meta.url),
    'utf8',
  ),
);
const launcher: DesktopPluginLauncher = {
  platform: 'darwin',
  executable: 'server/smrt-mcp-launcher',
};
const pluginDir = 'plugins/smrt-kitchen';

describe('generateDesktopPluginArtifacts', () => {
  it('builds both desktop manifests and the kitchen-style marketplace entries', () => {
    const files = generateDesktopPluginArtifacts(kitchen, launcher);
    const read = (path: string) => JSON.parse(files[path]);
    expect(Object.keys(files)).toEqual([
      'claude-desktop/smrt-kitchen/manifest.json',
      `${pluginDir}/plugin.json`,
      `${pluginDir}/mcp.json`,
      `${pluginDir}/.claude-plugin/plugin.json`,
      '.agents/plugins/marketplace.json',
      '.claude-plugin/marketplace.json',
    ]);

    const metadata = {
      name: kitchen.name,
      version: kitchen.version,
      description: kitchen.description,
      author: { name: kitchen.author.name },
    };
    expect(read('claude-desktop/smrt-kitchen/manifest.json')).toEqual({
      manifest_version: '0.3',
      ...metadata,
      display_name: 'SMRT Kitchen',
      compatibility: { platforms: ['darwin'] },
      server: {
        type: 'binary',
        entry_point: launcher.executable,
        mcp_config: { command: `\${__dirname}/${launcher.executable}` },
      },
    });
    const openaiMarket = read('.agents/plugins/marketplace.json');
    expect(openaiMarket).toEqual({
      name: 'smrt-kitchen',
      interface: { displayName: 'SMRT Kitchen' },
      plugins: [
        {
          name: 'smrt-kitchen',
          source: { source: 'local', path: `./${pluginDir}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    });
    const openaiPath = openaiMarket.plugins[0].source.path.slice(2);
    expect(read(`${openaiPath}/plugin.json`)).toMatchObject({
      ...metadata,
      extensions: {
        'com.openai': {
          interface: {
            displayName: 'SMRT Kitchen',
            developerName: 'HappyVertical',
          },
        },
      },
    });
    expect(read(`${openaiPath}/mcp.json`).mcpServers).toEqual({
      'smrt-kitchen': {
        type: 'stdio',
        command: `./${launcher.executable}`,
        cwd: `\${PLUGIN_ROOT}`,
      },
    });

    const claudeMarket = read('.claude-plugin/marketplace.json');
    expect(claudeMarket).toMatchObject({
      owner: metadata.author,
      plugins: [{ name: 'smrt-kitchen', source: `./${pluginDir}` }],
    });
    const claudePath = claudeMarket.plugins[0].source.slice(2);
    expect(read(`${claudePath}/.claude-plugin/plugin.json`)).toEqual({
      ...metadata,
      mcpServers: {
        'smrt-kitchen': {
          command: `\${CLAUDE_PLUGIN_ROOT}/${launcher.executable}`,
        },
      },
    });
  });

  it('uses stable bytes with reordered fields and defaults the optional display name', () => {
    const minimal = {
      name: 'my-product',
      version: '1.2.3-beta.1+build',
      description: 'My local product',
      author: { name: 'Developer' },
    };
    const windows: DesktopPluginLauncher = {
      platform: 'win32',
      executable: 'server/windows/launcher.exe',
    };
    const files = generateDesktopPluginArtifacts(minimal, windows);
    expect(files).toEqual(
      generateDesktopPluginArtifacts(
        Object.fromEntries(Object.entries(minimal).reverse()),
        windows,
      ),
    );
    expect(
      JSON.parse(files['claude-desktop/my-product/manifest.json']),
    ).toMatchObject({
      display_name: 'my-product',
      compatibility: { platforms: ['win32'] },
      server: {
        entry_point: windows.executable,
        mcp_config: { command: `\${__dirname}/${windows.executable}` },
      },
    });
    expect(JSON.parse(files['plugins/my-product/mcp.json']).mcpServers).toEqual(
      {
        'my-product': {
          type: 'stdio',
          command: './server/windows/launcher.exe',
          cwd: `\${PLUGIN_ROOT}`,
        },
      },
    );
  });

  it('marks the Linux binary as Linux-only', () => {
    const files = generateDesktopPluginArtifacts(kitchen, {
      platform: 'linux',
      executable: 'server/linux/launcher',
    });
    expect(
      JSON.parse(files['claude-desktop/smrt-kitchen/manifest.json']),
    ).toMatchObject({
      compatibility: { platforms: ['linux'] },
      server: {
        entry_point: 'server/linux/launcher',
        mcp_config: { command: `\${__dirname}/server/linux/launcher` },
      },
    });
  });

  it.each([
    undefined,
    'windows',
    'freebsd',
    ['linux'],
  ])('rejects invalid launcher platforms (%#)', (platform) => {
    expect(() =>
      generateDesktopPluginArtifacts(kitchen, {
        ...launcher,
        platform,
      } as DesktopPluginLauncher),
    ).toThrow(
      'Desktop plugin launcher platform must be darwin, win32, or linux',
    );
  });

  it.each([
    [null, 'product manifest'],
    [{ ...kitchen, name: 'A B' }, 'name'],
    [{ ...kitchen, name: '../outside' }, 'name'],
    [{ ...kitchen, name: 'con' }, 'name'],
    [{ ...kitchen, name: 'a'.repeat(65) }, 'name'],
    [{ ...kitchen, version: '1.0' }, 'version'],
    [{ ...kitchen, version: '1.0.0-01' }, 'version'],
    [{ ...kitchen, description: '' }, 'description'],
    [{ ...kitchen, author: {} }, 'author.name'],
    [{ ...kitchen, extensions: [] }, 'extensions'],
    [
      {
        ...kitchen,
        extensions: { 'com.openai': { interface: { displayName: false } } },
      },
      'OpenAI interface displayName',
    ],
  ])('rejects malformed product metadata (%#)', (manifest, field) => {
    expect(() => generateDesktopPluginArtifacts(manifest, launcher)).toThrow(
      `Desktop plugin ${field}`,
    );
  });

  it.each([
    undefined,
    '',
    'node',
    './server/launch',
    '/server/launch',
    'C:/server/launch.exe',
    'server/../launch',
    'server/./launch',
    'server//launch',
    'server/%2e%2e/launch',
    'server/..\\launch',
    'server/launch\0',
    'server/launch\n',
    'server/launch.',
    'server/aux.exe',
    `server/\${HOME}/launch`,
  ])('rejects launcher paths outside the portable executable contract (%#)', (executable) => {
    expect(() =>
      generateDesktopPluginArtifacts(kitchen, {
        ...launcher,
        executable,
      } as typeof launcher),
    ).toThrow('Desktop plugin launcher must be a portable path under server/');
  });

  it('ignores credential-bearing fields and ambient credentials', () => {
    const marker = 'synthetic-private-marker';
    const untrusted = {
      ...kitchen,
      author: { ...kitchen.author, email: marker },
      token: marker,
      mcpServers: { env: { SMRT_APP_TOKEN: marker } },
      extensions: {
        'com.openai': {
          ...kitchen.extensions['com.openai'],
          credentials: marker,
        },
      },
    };
    vi.stubEnv('SMRT_MCP_TOKEN', marker);
    try {
      const files = generateDesktopPluginArtifacts(untrusted, launcher);
      expect(files).toEqual(generateDesktopPluginArtifacts(kitchen, launcher));
      expect(JSON.stringify(files)).not.toContain(marker);
      expect(() =>
        generateDesktopPluginArtifacts(
          { ...untrusted, version: marker },
          launcher,
        ),
      ).toThrow(/^Desktop plugin version must be a semantic version$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('local MCP harness instructions', () => {
  it('generates valid JSON/TOML and shell-quotes paths without including credentials', async () => {
    const { generateLocalMcpSetup } = await import('../desktop-plugins.js');
    const entry = {
      name: 'plebeos',
      command: "/Applications/Owner's App/node",
      args: ['/private/user state/codex.mjs'],
    };
    const setup = generateLocalMcpSetup(entry);
    expect(JSON.parse(setup.mcpJson).mcpServers.plebeos).toEqual(setup.entry);
    expect(JSON.parse(setup.claudeDesktop).mcpServers.plebeos).toEqual(
      setup.entry,
    );
    expect(setup.claudeCode).toContain("Owner'\\''s");
    expect(setup.codex).toContain('[mcp_servers.plebeos]');
    expect(setup.codex).toContain(JSON.stringify(entry.args));
    expect(setup.chatgpt).toContain('cannot reach');
    expect(JSON.stringify(setup)).not.toContain('smrt_mcp_');
    expect(() => generateLocalMcpSetup({ ...entry, name: 'bad]\n' })).toThrow();
    expect(() =>
      generateLocalMcpSetup({ ...entry, args: ['line\nbreak'] }),
    ).toThrow();
  });
});
