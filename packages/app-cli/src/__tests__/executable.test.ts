import { describe, expect, it, vi } from 'vitest';
import {
  parseAppCliExecutableConfig,
  runAppCliExecutable,
} from '../executable.js';
import type { AppCli, CreateAppCliOptions } from '../index.js';

const ENV = {
  SMRT_APP_NAME: 'work',
  SMRT_APP_ENV_PREFIX: 'WORK',
  SMRT_APP_CONFIG_DIR: 'happyvertical-work',
  SMRT_APP_DEFAULT_SERVER_URL: 'https://work.example',
};

describe('smrt-app executable configuration', () => {
  it('reads non-secret configuration and forwards argv after the delimiter', () => {
    const parsed = parseAppCliExecutableConfig(
      ['--name', 'override', '--', 'tracker', 'claim', '--json'],
      ENV,
    );

    expect(parsed.cliOptions).toEqual({
      name: 'override',
      envPrefix: 'WORK',
      configDir: 'happyvertical-work',
      defaultServerUrl: 'https://work.example',
      requireSecureServerUrl: true,
    });
    expect(parsed.argv).toEqual(['tracker', 'claim', '--json']);
    expect(parsed.stdioMcp).toBe(false);
  });

  it('creates only the canonical app CLI and forwards command argv unchanged', async () => {
    const run = vi.fn(async () => undefined);
    const startMcpBridge = vi.fn(async () => undefined);
    const createCli = vi.fn(
      (_options: CreateAppCliOptions): AppCli => ({ run, startMcpBridge }),
    );

    await runAppCliExecutable({
      argv: ['--', 'auth', 'status'],
      env: ENV,
      createCli,
    });

    expect(createCli).toHaveBeenCalledOnce();
    expect(createCli).toHaveBeenCalledWith({
      name: 'work',
      envPrefix: 'WORK',
      configDir: 'happyvertical-work',
      defaultServerUrl: 'https://work.example',
      requireSecureServerUrl: true,
    });
    expect(run).toHaveBeenCalledWith(['auth', 'status']);
    expect(startMcpBridge).not.toHaveBeenCalled();
  });

  it('passes an explicit MCP identity to the canonical stdio bridge', async () => {
    const run = vi.fn(async () => undefined);
    const startMcpBridge = vi.fn(async () => undefined);
    const createCli = vi.fn(
      (_options: CreateAppCliOptions): AppCli => ({ run, startMcpBridge }),
    );

    await runAppCliExecutable({
      argv: ['--stdio-mcp'],
      env: {
        ...ENV,
        SMRT_APP_MCP_SERVER_NAME: 'work-mcp',
        SMRT_APP_MCP_SERVER_VERSION: '1.2.3',
      },
      createCli,
    });

    expect(startMcpBridge).toHaveBeenCalledWith({
      name: 'work-mcp',
      version: '1.2.3',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...ENV, SMRT_APP_NAME: undefined }, 'Missing executable configuration'],
    [
      { ...ENV, SMRT_APP_ENV_PREFIX: 'work-token' },
      'Invalid environment prefix',
    ],
    [
      {
        ...ENV,
        SMRT_APP_DEFAULT_SERVER_URL: 'https://user:secret@example.test',
      },
      'Invalid server URL',
    ],
    [
      { ...ENV, SMRT_APP_DEFAULT_SERVER_URL: 'http://work.example' },
      'Invalid server URL',
    ],
  ])('fails closed for incomplete or malformed configuration', (env, message) => {
    expect(() => parseAppCliExecutableConfig([], env)).toThrow(message);
  });

  it('permits HTTP only for local development origins', () => {
    expect(
      parseAppCliExecutableConfig([], {
        ...ENV,
        SMRT_APP_DEFAULT_SERVER_URL: 'http://127.0.0.1:5173',
      }).cliOptions.defaultServerUrl,
    ).toBe('http://127.0.0.1:5173');
  });

  it('never includes option values in configuration errors', () => {
    const secret = 'extremely-sensitive-token-value';
    let message = '';
    try {
      parseAppCliExecutableConfig(['--token', secret], ENV);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Unknown executable option: --token');
    expect(message).not.toContain(secret);
  });

  it('requires a complete MCP identity and rejects command argv in stdio mode', () => {
    expect(() =>
      parseAppCliExecutableConfig(['--stdio-mcp'], {
        ...ENV,
        SMRT_APP_MCP_SERVER_NAME: 'work-mcp',
      }),
    ).toThrow('MCP server name and version must be configured together');

    expect(() =>
      parseAppCliExecutableConfig(['--stdio-mcp', '--', 'auth'], {
        ...ENV,
        SMRT_APP_MCP_SERVER_NAME: 'work-mcp',
        SMRT_APP_MCP_SERVER_VERSION: '1.2.3',
      }),
    ).toThrow('MCP stdio mode does not accept command arguments');
  });
});
