/**
 * Configuration-driven executable support for published SMRT app CLIs.
 *
 * This adapter deliberately owns no command schemas or transport behavior. It
 * validates non-secret application identity, creates the canonical app CLI,
 * and forwards the remaining argv unchanged.
 *
 * @packageDocumentation
 */

import { assertSecureServerUrl } from './config.js';
import {
  type AppCli,
  type CreateAppCliOptions,
  createAppCli,
} from './index.js';

export interface AppCliExecutableConfig {
  cliOptions: Pick<
    CreateAppCliOptions,
    | 'name'
    | 'envPrefix'
    | 'configDir'
    | 'defaultServerUrl'
    | 'requireSecureServerUrl'
  >;
  argv: string[];
  mcp?: {
    name: string;
    version: string;
  };
  stdioMcp: boolean;
}

export interface RunAppCliExecutableOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  createCli?: (options: CreateAppCliOptions) => AppCli;
}

const CONFIG_KEYS = [
  'name',
  'env-prefix',
  'config-dir',
  'default-server-url',
  'mcp-server-name',
  'mcp-server-version',
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

const ENV_BY_KEY: Record<ConfigKey, string> = {
  name: 'SMRT_APP_NAME',
  'env-prefix': 'SMRT_APP_ENV_PREFIX',
  'config-dir': 'SMRT_APP_CONFIG_DIR',
  'default-server-url': 'SMRT_APP_DEFAULT_SERVER_URL',
  'mcp-server-name': 'SMRT_APP_MCP_SERVER_NAME',
  'mcp-server-version': 'SMRT_APP_MCP_SERVER_VERSION',
};

const APP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const ENV_PREFIX_RE = /^[A-Z][A-Z0-9_]*$/u;
const CONFIG_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MCP_IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** Parse and validate the generic executable's non-secret configuration. */
export function parseAppCliExecutableConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): AppCliExecutableConfig {
  const values = new Map<ConfigKey, string>();
  let stdioMcp = false;
  let cursor = 0;

  while (cursor < argv.length) {
    const arg = argv[cursor];
    if (arg === '--') {
      cursor += 1;
      break;
    }
    if (arg === '--stdio-mcp') {
      stdioMcp = true;
      cursor += 1;
      continue;
    }
    if (!arg.startsWith('--')) break;

    const equalsIndex = arg.indexOf('=');
    const rawKey = arg.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
    if (!CONFIG_KEYS.includes(rawKey as ConfigKey)) {
      throw new Error(`Unknown executable option: --${rawKey}.`);
    }
    const key = rawKey as ConfigKey;
    const value =
      equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : argv[cursor + 1];
    if (!value || (equalsIndex < 0 && value.startsWith('--'))) {
      throw new Error(`Executable option --${key} requires a value.`);
    }
    if (values.has(key)) {
      throw new Error(
        `Executable option --${key} was provided more than once.`,
      );
    }
    values.set(key, value);
    cursor += equalsIndex >= 0 ? 1 : 2;
  }

  for (const key of CONFIG_KEYS) {
    if (!values.has(key) && env[ENV_BY_KEY[key]]) {
      values.set(key, env[ENV_BY_KEY[key]] as string);
    }
  }

  const name = required(values, 'name');
  const envPrefix = required(values, 'env-prefix');
  const configDir = required(values, 'config-dir');
  const defaultServerUrl = required(values, 'default-server-url');

  validate(name, APP_NAME_RE, 'app name');
  validate(envPrefix, ENV_PREFIX_RE, 'environment prefix');
  validate(configDir, CONFIG_DIR_RE, 'config directory');
  assertSecureServerUrl(defaultServerUrl);

  const mcpName = values.get('mcp-server-name');
  const mcpVersion = values.get('mcp-server-version');
  if ((mcpName && !mcpVersion) || (!mcpName && mcpVersion)) {
    throw new Error('MCP server name and version must be configured together.');
  }
  if (stdioMcp && (!mcpName || !mcpVersion)) {
    throw new Error('MCP stdio mode requires a server name and version.');
  }
  if (mcpName) validate(mcpName, MCP_IDENTITY_RE, 'MCP server name');
  if (mcpVersion) validate(mcpVersion, MCP_IDENTITY_RE, 'MCP server version');

  const commandArgv = argv.slice(cursor);
  if (stdioMcp && commandArgv.length > 0) {
    throw new Error('MCP stdio mode does not accept command arguments.');
  }

  return {
    cliOptions: {
      name,
      envPrefix,
      configDir,
      defaultServerUrl,
      requireSecureServerUrl: true,
    },
    argv: commandArgv,
    mcp:
      mcpName && mcpVersion
        ? { name: mcpName, version: mcpVersion }
        : undefined,
    stdioMcp,
  };
}

/** Create the canonical app CLI and execute its forwarded command or bridge. */
export async function runAppCliExecutable(
  options: RunAppCliExecutableOptions = {},
): Promise<void> {
  const config = parseAppCliExecutableConfig(
    options.argv ?? process.argv.slice(2),
    options.env ?? process.env,
  );
  const cli = (options.createCli ?? createAppCli)(config.cliOptions);
  if (config.stdioMcp) {
    await cli.startMcpBridge(config.mcp);
    return;
  }
  await cli.run(config.argv);
}

function required(values: Map<ConfigKey, string>, key: ConfigKey): string {
  const value = values.get(key);
  if (!value) {
    throw new Error(
      `Missing executable configuration: --${key} or ${ENV_BY_KEY[key]}.`,
    );
  }
  return value;
}

function validate(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${label} configuration.`);
  }
}
