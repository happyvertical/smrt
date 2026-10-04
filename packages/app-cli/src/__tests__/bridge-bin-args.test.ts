/**
 * `smrt-mcp-bridge` argument handling (#3413 review F2): an explicitly
 * supplied endpoint path is validated, never silently replaced by the
 * default. Empty, missing, repeated or unsafe values are usage errors that
 * exit non-zero before the bridge listens.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpBridgeUsageError, parseMcpBridgeArgs } from '../bridge-args.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = resolve(root, '../../node_modules/.bin/tsx');

function runBridge(args: string[], env: Record<string, string> = {}) {
  const { SMRT_MCP_PATH: _ignored, ...base } = process.env;
  return spawnSync(tsx, ['src/bin/smrt-mcp-bridge.ts', ...args], {
    cwd: root,
    env: {
      ...base,
      SMRT_MCP_ENV_PREFIX: 'SMRT_BRIDGE_ARGS_TEST',
      SMRT_BRIDGE_ARGS_TEST_SERVER_URL: 'http://127.0.0.1:9',
      ...env,
    },
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('smrt-mcp-bridge --mcp-path', () => {
  it.each([
    [['--mcp-path='], {}],
    [['--mcp-path'], {}],
    [['--mcp-path', '--name=x'], {}],
    [['--mcp-path=/mcp', '--mcp-path=/api/mcp'], {}],
    [['--mcp-path=/mcp', '--mcp-path', '/mcp'], {}],
    [['--mcp-path=mcp'], {}],
    [['--mcp-path=//evil.test/mcp'], {}],
    [[], { SMRT_MCP_PATH: '' }],
    [[], { SMRT_MCP_PATH: '/mcp?x' }],
  ])('rejects %j %j as a usage error before listening', (args, env) => {
    const result = runBridge(args, env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('smrt-mcp-bridge:');
    expect(result.stderr).toMatch(/mcp-path|SMRT_MCP_PATH/u);
    expect(result.stdout).toBe('');
  });

  it.each([
    [['--mcp-path=/mcp'], {}],
    [['--mcp-path', '/mcp'], {}],
    [[], { SMRT_MCP_PATH: '/mcp' }],
    [[], {}],
  ])('accepts %j %j and starts listening', (args, env) => {
    const result = runBridge(args, env);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('smrt-mcp-bridge:');
  });
});

describe('parseMcpBridgeArgs', () => {
  it('keeps the default only when no path is supplied', () => {
    expect(parseMcpBridgeArgs([], {}).mcpPath).toBeUndefined();
    expect(parseMcpBridgeArgs(['--mcp-path=/mcp'], {}).mcpPath).toBe('/mcp');
    expect(parseMcpBridgeArgs(['--mcp-path', '/v2/mcp'], {}).mcpPath).toBe(
      '/v2/mcp',
    );
    expect(parseMcpBridgeArgs([], { SMRT_MCP_PATH: '/mcp' }).mcpPath).toBe(
      '/mcp',
    );
    // The argument wins over the environment.
    expect(
      parseMcpBridgeArgs(['--mcp-path=/a'], { SMRT_MCP_PATH: '/b' }).mcpPath,
    ).toBe('/a');
  });

  it('applies required-value and duplicate rules to every value option', () => {
    for (const argv of [
      ['--env-prefix='],
      ['--name'],
      ['--version', '--legacy-rest'],
      ['--name=a', '--name=b'],
      ['--mcp-path='],
      ['--mcp-path=/a', '--mcp-path=/a'],
    ]) {
      expect(() => parseMcpBridgeArgs(argv, {})).toThrow(McpBridgeUsageError);
    }
    expect(() =>
      parseMcpBridgeArgs(['--mcp-path=/a'], { SMRT_MCP_PATH: '' }),
    ).not.toThrow();
    expect(() => parseMcpBridgeArgs([], { SMRT_MCP_PATH: '' })).toThrow(
      'SMRT_MCP_PATH must be a same-server absolute path',
    );
  });

  it('keeps the legacy flag and ignores unrelated arguments', () => {
    const parsed = parseMcpBridgeArgs(
      ['--legacy-rest', 'stray', '--unknown', '--name', 'acme'],
      {},
    );
    expect(parsed.legacyRest).toBe(true);
    expect(parsed.values.get('name')).toBe('acme');
  });
});
