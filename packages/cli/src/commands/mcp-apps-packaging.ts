/**
 * Portable MCP Apps plugin packaging helpers.
 *
 * These helpers intentionally validate distribution metadata only. Runtime
 * MCP extension metadata is owned by the v2 server adapter and is not an
 * install-plugin manifest.
 */
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { CLICommand } from '../cli-generator.js';

export interface McpAppsFinding {
  code: string;
  message: string;
}

export interface McpAppsValidationResult {
  findings: McpAppsFinding[];
  valid: boolean;
}

const PLUGIN_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const CANONICAL_SCOPE_REGISTRY =
  '@happyvertical:registry=https://npm.happyvertical.com/';
const SECRET_KEY =
  /(?:api[_-]?key|secret|token|password|authorization|credential)/i;
const SAFE_PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/;

function add(result: McpAppsValidationResult, code: string, message: string) {
  result.findings.push({ code, message });
}

function readJson(path: string, result: McpAppsValidationResult): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    add(
      result,
      'json-malformed',
      `${relative(process.cwd(), path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRelativePath(
  value: unknown,
  field: string,
  root: string,
  result: McpAppsValidationResult,
) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('./') ||
    value.includes('\\') ||
    value.split('/').includes('..')
  ) {
    add(
      result,
      'unsafe-path',
      `${field} must be a root-relative ./ path without parent segments`,
    );
    return;
  }
  const target = resolve(root, value);
  if (!target.startsWith(`${root}${sep}`)) {
    add(result, 'unsafe-path', `${field} resolves outside the plugin root`);
    return;
  }
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      add(result, 'invalid-resource', `${field} must name a regular file`);
  } catch {
    add(result, 'missing-resource', `${field} does not exist`);
  }
}

function scanTree(
  root: string,
  current: string,
  result: McpAppsValidationResult,
) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const display = relative(root, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      add(
        result,
        'symlink',
        `${display} is a symbolic link; plugin packages must contain regular files`,
      );
    } else if (stat.isDirectory()) {
      scanTree(root, path, result);
    }
  }
}

function scanSecrets(
  value: unknown,
  source: string,
  result: McpAppsValidationResult,
) {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      scanSecrets(item, source, result);
    });
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && typeof child === 'string' && child.trim()) {
      add(
        result,
        'secret-artifact',
        `${source} contains a credential-shaped ${key} field`,
      );
    }
    scanSecrets(child, source, result);
  }
}

function validateServerUrl(
  value: unknown,
  name: string,
  result: McpAppsValidationResult,
) {
  if (typeof value !== 'string')
    return add(result, 'server-url', `mcpServers.${name}.url must be a string`);
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '[::1]';
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopback)
    ) {
      add(
        result,
        'server-url',
        `mcpServers.${name}.url must use HTTPS, except loopback development URLs`,
      );
    }
  } catch {
    add(result, 'server-url', `mcpServers.${name}.url is not a URL`);
  }
}

/** Validate portable plugin files and the optional OpenAI install extension. */
export function validateMcpAppsPackage(
  rootPath: string,
): McpAppsValidationResult {
  const root = resolve(rootPath);
  const result: McpAppsValidationResult = { findings: [], valid: false };
  try {
    scanTree(root, root, result);
  } catch {
    add(result, 'plugin-root', 'Plugin root must be a readable directory');
    return result;
  }

  const pluginPath = join(root, 'plugin.json');
  const mcpPath = join(root, 'mcp.json');
  if (!lstatExists(pluginPath))
    add(result, 'plugin-missing', 'plugin.json is required at the plugin root');
  if (!lstatExists(mcpPath))
    add(result, 'mcp-missing', 'mcp.json is required at the plugin root');
  const plugin = lstatExists(pluginPath)
    ? readJson(pluginPath, result)
    : undefined;
  const mcp = lstatExists(mcpPath) ? readJson(mcpPath, result) : undefined;

  if (isObject(plugin)) {
    scanSecrets(plugin, 'plugin.json', result);
    if (plugin.$schema !== PLUGIN_SCHEMA)
      add(
        result,
        'plugin-schema',
        `plugin.json.$schema must be ${PLUGIN_SCHEMA}`,
      );
    if (typeof plugin.name !== 'string' || !SAFE_PLUGIN_NAME.test(plugin.name))
      add(
        result,
        'plugin-name',
        'plugin.json.name must be a lowercase portable plugin name',
      );
    if (plugin.extensions !== undefined && !isObject(plugin.extensions))
      add(result, 'extensions', 'plugin.json.extensions must be an object');
    const extensions = isObject(plugin.extensions)
      ? plugin.extensions
      : undefined;
    const openai = extensions?.['com.openai'];
    if (openai !== undefined && !isObject(openai))
      add(
        result,
        'openai-extension',
        'extensions.com.openai must be an object',
      );
    if (isObject(openai)) {
      if (openai.apps !== undefined)
        safeRelativePath(
          openai.apps,
          'extensions.com.openai.apps',
          root,
          result,
        );
      const ui = openai.interface;
      if (ui !== undefined && !isObject(ui))
        add(
          result,
          'openai-interface',
          'extensions.com.openai.interface must be an object',
        );
      if (isObject(ui)) {
        for (const key of ['composerIcon', 'logo'])
          if (ui[key] !== undefined)
            safeRelativePath(
              ui[key],
              `extensions.com.openai.interface.${key}`,
              root,
              result,
            );
        if (
          ui.screenshots !== undefined &&
          (!Array.isArray(ui.screenshots) ||
            ui.screenshots.some((path) => typeof path !== 'string'))
        )
          add(
            result,
            'openai-screenshots',
            'interface.screenshots must be an array of paths',
          );
      }
    }
  }
  if (isObject(mcp)) {
    scanSecrets(mcp, 'mcp.json', result);
    if (mcp.$schema !== MCP_SCHEMA)
      add(result, 'mcp-schema', `mcp.json.$schema must be ${MCP_SCHEMA}`);
    if (!isObject(mcp.mcpServers) || Object.keys(mcp.mcpServers).length === 0)
      add(
        result,
        'mcp-servers',
        'mcp.json requires a non-empty mcpServers object',
      );
    else
      for (const [name, server] of Object.entries(mcp.mcpServers)) {
        if (!name.trim() || !isObject(server)) {
          add(
            result,
            'mcp-server',
            `mcpServers.${name || '<empty>'} must be an object with a name`,
          );
          continue;
        }
        if (server.type !== 'streamable-http')
          add(
            result,
            'mcp-transport',
            `mcpServers.${name}.type must be streamable-http`,
          );
        validateServerUrl(server.url, name, result);
      }
  }
  result.valid = result.findings.length === 0;
  return result;
}

function lstatExists(path: string) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Add the public, credential-free SMRT package route to a generated app.
 * A pre-existing scope route is an explicit consumer decision and must not be
 * silently replaced.
 */
export function configureMcpAppsConsumerRegistry(appRoot: string) {
  const npmrcPath = join(resolve(appRoot), '.npmrc');
  let existing = '';
  try {
    const stat = lstatSync(npmrcPath);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error('Generated application .npmrc must be a regular file');
    existing = readFileSync(npmrcPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const scopeLines = existing
    .split(/\r?\n/)
    .filter((line) => /^\s*@happyvertical:registry\s*=/.test(line));
  if (scopeLines.length > 0) {
    if (
      scopeLines.some(
        (line) =>
          line.trim().replace(/\s+/g, '') ===
          CANONICAL_SCOPE_REGISTRY.replace(/\s+/g, ''),
      )
    )
      return;
    throw new Error(
      'Generated application already declares a different @happyvertical registry; refusing to replace it',
    );
  }

  writeFileSync(
    npmrcPath,
    `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${CANONICAL_SCOPE_REGISTRY}\n`,
  );
}

/** Copy the opt-in app route/resources and merge only its declared dependencies. */
export function addMcpAppsRuntime(sourceRoot: string, appRoot: string) {
  const resolvedSource = resolve(sourceRoot);
  const sourceRootPath = lstatSync(resolvedSource).isFile()
    ? dirname(resolvedSource)
    : resolvedSource;
  const source = join(sourceRootPath, 'mcp-apps-template');
  const dependencies = JSON.parse(
    readFileSync(join(source, 'package.dependencies.json'), 'utf8'),
  ) as Record<string, string>;
  cpSync(join(source, 'src'), join(resolve(appRoot), 'src'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const packagePath = join(resolve(appRoot), 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  packageJson.dependencies = { ...packageJson.dependencies, ...dependencies };
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

/** Create the minimal local portable package. It intentionally has no .app.json: registered IDs are host-owned. */
export function scaffoldMcpAppsPackage(
  rootPath: string,
  name: string,
  version = '0.1.0',
) {
  const root = resolve(rootPath);
  mkdirSync(root, { recursive: true });
  const pluginPath = join(root, 'plugin.json');
  const mcpPath = join(root, 'mcp.json');
  if (lstatExists(pluginPath) || lstatExists(mcpPath))
    throw new Error('Refusing to overwrite existing MCP Apps package files');
  writeFileSync(
    pluginPath,
    `${JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version, description: 'SMRT MCP Apps package', extensions: { 'com.openai': { interface: { displayName: name, shortDescription: 'SMRT MCP Apps package' } } } }, null, 2)}\n`,
  );
  writeFileSync(
    mcpPath,
    `${JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { smrt: { type: 'streamable-http', url: 'http://127.0.0.1:3000/api/mcp' } } }, null, 2)}\n`,
  );
}

export const mcpAppsCommands: Record<string, CLICommand> = {
  'mcp-apps scaffold': {
    name: 'mcp-apps scaffold',
    description:
      'Create opt-in portable MCP Apps plugin metadata for a local SMRT app',
    options: {
      'output-dir': {
        type: 'string',
        description: 'Plugin directory (defaults to ./mcp-apps)',
      },
      name: {
        type: 'string',
        description: 'Portable plugin name',
        default: 'smrt-app',
      },
      version: {
        type: 'string',
        description: 'Portable plugin version',
        default: '0.1.0',
      },
    },
    handler: async (_args, options) => {
      const root =
        typeof options['output-dir'] === 'string'
          ? options['output-dir']
          : './mcp-apps';
      const name = typeof options.name === 'string' ? options.name : 'smrt-app';
      const version =
        typeof options.version === 'string' ? options.version : '0.1.0';
      scaffoldMcpAppsPackage(root, name, version);
      console.log(`Created portable MCP Apps metadata in ${root}.`);
      console.log(
        'Mount and authorize the native v2 /api/mcp endpoint before changing the loopback URL.',
      );
    },
  },
  'mcp-apps validate': {
    name: 'mcp-apps validate',
    description:
      'Fail closed when portable MCP Apps package metadata is unsafe or incomplete',
    options: {
      'output-dir': {
        type: 'string',
        description: 'Plugin directory (defaults to ./mcp-apps)',
      },
    },
    handler: async (_args, options) => {
      const root =
        typeof options['output-dir'] === 'string'
          ? options['output-dir']
          : './mcp-apps';
      const result = validateMcpAppsPackage(root);
      for (const finding of result.findings)
        console.error(`${finding.code}: ${finding.message}`);
      if (!result.valid)
        throw new Error(
          `MCP Apps package validation failed with ${result.findings.length} finding(s)`,
        );
      console.log(`MCP Apps package at ${root} is valid.`);
    },
  },
};
