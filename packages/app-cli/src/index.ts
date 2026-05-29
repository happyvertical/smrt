/**
 * `@happyvertical/smrt-app-cli` — reusable CLI factory for SMRT apps.
 *
 * @example
 * ```ts
 * #!/usr/bin/env node
 * import { createAppCli } from '@happyvertical/smrt-app-cli';
 *
 * const cli = createAppCli({
 *   name: 'willgriffin',
 *   defaultServerUrl: 'https://willgriffin.dev',
 * });
 * await cli.run(process.argv.slice(2));
 * ```
 *
 * @packageDocumentation
 */

import {
  type CliConfig,
  type CliConfigContext,
  getServerUrl,
  getStoredToken,
  loadCliConfig,
  type RequestJsonOptions,
  requestJson,
} from './config.js';

export {
  type CliConfig,
  type CliConfigContext,
  clearStoredToken,
  getServerUrl,
  getStoredToken,
  loadCliConfig,
  type RequestJsonOptions,
  requestJson,
  saveAuth,
  saveCliConfig,
} from './config.js';

import {
  fetchResourceList,
  findCommand,
  findResourceBySlug,
  type ResourceListResponse,
} from './discovery.js';

export {
  type CliResource,
  type CommandDefinition,
  type CommandKind,
  type CommandScope,
  fetchResourceList,
  findCommand,
  findResourceBySlug,
  type ResourceListResponse,
} from './discovery.js';
export { buildUrl, invokeCommand } from './invoke.js';
export { type RenderResult, renderResponse } from './output.js';
export {
  type BuildParserResult,
  buildFlagParser,
  classifySchema,
  type ParsedArgs,
  type SchemaSupportStatus,
} from './parser.js';

import { runAuthLogin, runAuthLogout, runAuthStatus } from './commands/auth.js';
import { runMcpCommand } from './commands/mcp.js';
import { runResourcesCommand } from './commands/resources.js';
import { invokeCommand } from './invoke.js';
import { renderResponse } from './output.js';
import { buildFlagParser } from './parser.js';

export {
  createMcpStdioBridge,
  type McpStdioBridgeOptions,
  runMcpStdioBridge,
} from './bridge.js';

/* ── public API ───────────────────────────────────────────────────────── */

export interface AppCliCommand {
  name: string;
  description: string;
  /**
   * When true, the CLI ensures resources are fetched and available via
   * `ctx.getResources()` before `run()` is called. Default `false`.
   */
  needsResources?: boolean;
  run(args: string[], ctx: AppCliContext): Promise<void>;
}

export interface AppCliContext {
  config: CliConfig;
  serverUrl: string;
  token?: string;
  /** Lazy resource-list fetch. Cached for the duration of the CLI invocation. */
  getResources(): Promise<ResourceListResponse>;
  /** Issue a JSON request via the shared client. */
  requestJson<T = unknown>(
    path: string,
    init?: RequestInit,
    options?: RequestJsonOptions,
  ): Promise<T>;
  /** Issue a raw fetch (for streaming / content-type-aware responses). */
  request(path: string, init?: RequestInit): Promise<Response>;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface CreateAppCliOptions {
  /** Display + branding name, e.g. `willgriffin`. Also drives `envPrefix`. */
  name: string;
  /** Override the env-var prefix. Default: `name.toUpperCase()`. */
  envPrefix?: string;
  /** Override the config dir slug. Default: `name.toLowerCase()`. */
  configDir?: string;
  /** Baked-in default server URL when neither env nor config sets one. */
  defaultServerUrl?: string;
  /**
   * App-specific commands. Dispatched BEFORE built-ins (`auth`,
   * `resources`, `mcp`) and before the resource-slug dispatcher, so an
   * `extraCommands` entry takes precedence over anything with the same
   * top-level argv.
   *
   * - **Built-in shadowing** (`extraCommands: [{ name: 'mcp' }]`): the CLI
   *   prints a one-line stderr warning on first invocation. The extra
   *   command still wins, but the warning makes the override visible.
   *
   * - **Resource-slug shadowing** (`extraCommands: [{ name: 'praecos' }]`
   *   when a server-side class also resolves to slug `praecos`): the
   *   extra command silently wins. There's no warning because checking
   *   would require a discovery round-trip on every invocation. Authors
   *   are responsible for namespacing their extra commands (e.g. prefix
   *   with the app name) to avoid accidental shadowing as the server's
   *   class registry grows. (#1311 review C-2.)
   */
  extraCommands?: AppCliCommand[];
}

export interface AppCli {
  run(argv: string[]): Promise<void>;
  /**
   * Wire up the stdio MCP bridge and connect to stdin/stdout. The CLI
   * advertises itself to local MCP clients as `serverInfo.name` /
   * `.version`. Both fields default from `options.name` (so a brand-
   * new app gets `{ name: '<name>-mcp', version: '0.0.0' }`) — pass an
   * explicit object to override.
   */
  startMcpBridge(serverInfo?: {
    name?: string;
    version?: string;
  }): Promise<void>;
}

export function createAppCli(options: CreateAppCliOptions): AppCli {
  const envPrefix = options.envPrefix ?? options.name.toUpperCase();
  const configDir = options.configDir ?? options.name.toLowerCase();
  const context: CliConfigContext = {
    envPrefix,
    appSlug: configDir,
    defaultServerUrl: options.defaultServerUrl,
  };

  const extraByName = new Map<string, AppCliCommand>();
  for (const cmd of options.extraCommands ?? []) {
    extraByName.set(cmd.name, cmd);
  }

  return {
    run: (argv) => runCli(context, options, extraByName, argv),
    startMcpBridge: async (serverInfo) => {
      const { runMcpStdioBridge } = await import('./bridge.js');
      await runMcpStdioBridge({
        ...context,
        serverInfo: {
          name: serverInfo?.name ?? `${options.name}-mcp`,
          version: serverInfo?.version ?? '0.0.0',
        },
      });
    },
  };
}

/* ── dispatch ────────────────────────────────────────────────────────── */

const BUILT_IN_COMMANDS = new Set(['auth', 'resources', 'mcp']);

async function runCli(
  context: CliConfigContext,
  options: CreateAppCliOptions,
  extras: Map<string, AppCliCommand>,
  argv: string[],
): Promise<void> {
  const stdout = process.stdout;
  const stderr = process.stderr;

  // Top-level error catch so users see a clean message for normal usage
  // errors (`<cli> auth` with no subcommand, unknown resource slug, etc.)
  // rather than an unhandled-rejection stack trace from Node. (#1311
  // review C-1.)
  try {
    await dispatchCli(context, options, extras, argv, stdout, stderr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

async function dispatchCli(
  context: CliConfigContext,
  options: CreateAppCliOptions,
  extras: Map<string, AppCliCommand>,
  argv: string[],
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): Promise<void> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    printUsage(options, extras, stdout);
    return;
  }

  const [command, ...rest] = argv;

  // Extra commands win over built-ins (with deprecation warning the first
  // time a built-in is shadowed in a given process).
  const extra = extras.get(command);
  if (extra) {
    if (BUILT_IN_COMMANDS.has(command)) {
      stderr.write(
        `[smrt-app-cli] extra command \`${command}\` shadows a built-in.\n`,
      );
    }
    const ctx = await buildAppContext(context, extra.needsResources ?? false);
    await extra.run(rest, ctx);
    return;
  }

  // Built-ins.
  if (command === 'auth') {
    const sub = rest[0];
    const opts = { context, stdout, stderr };
    if (sub === 'login') return runAuthLogin(opts, rest.slice(1));
    if (sub === 'status') return runAuthStatus(opts);
    if (sub === 'logout') return runAuthLogout(opts);
    throw new Error(
      'Usage: auth login [--server <url>] [--no-open] | status | logout',
    );
  }

  if (command === 'mcp') {
    return runMcpCommand({ context, stdout }, rest);
  }

  if (command === 'resources') {
    return runResourcesCommand({ context, stdout, stderr }, rest);
  }

  // Resource command: <slug> <command> [id] [...args]
  await runResourceCommand(context, command, rest, stdout, stderr);
}

async function runResourceCommand(
  context: CliConfigContext,
  slug: string,
  rest: string[],
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): Promise<void> {
  const response = await fetchResourceList(context);
  const resource = findResourceBySlug(response, slug);
  if (!resource) {
    const suggestions = response.resources
      .map((r) => r.slug)
      .filter((s) => similar(s, slug))
      .slice(0, 3);
    const hint = suggestions.length
      ? `  Did you mean: ${suggestions.join(', ')}?`
      : '';
    throw new Error(`Unknown resource: ${slug}.${hint}`);
  }

  const commandName = rest[0];
  if (!commandName) {
    throw new Error(
      `Usage: ${slug} <command> [id] [...]. Available: ${resource.commands
        .map((c) => c.commandName)
        .join(', ')}`,
    );
  }

  const command = findCommand(resource, commandName);
  if (!command) {
    throw new Error(
      `Unknown command \`${commandName}\` on resource \`${slug}\`. ` +
        `Available: ${resource.commands.map((c) => c.commandName).join(', ')}`,
    );
  }

  let positional = rest.slice(1);
  let id: string | undefined;
  if (command.scope === 'item') {
    id = positional[0];
    if (!id) {
      throw new Error(
        `Command \`${slug} ${commandName}\` requires an id positional argument.`,
      );
    }
    // Guard: if the user passes a string that's itself a valid command name
    // on this resource, they almost certainly meant to call THAT command,
    // not use the command name as an id. Sending it as an id would silently
    // 404 on the server. (#1311 review C-3.)
    if (findCommand(resource, id)) {
      throw new Error(
        `\`${id}\` is a command on \`${slug}\`, not an id. ` +
          `Did you mean: \`${slug} ${id}${
            findCommand(resource, id)?.scope === 'item' ? ' <id>' : ''
          }\`? ` +
          `\`${slug} ${commandName}\` is an item-scope command and needs an id as the next argument.`,
      );
    }
    positional = positional.slice(1);
  }

  const parser = buildFlagParser(command.parameters);
  if (parser.status.kind === 'unsupported') {
    stderr.write(
      `[smrt-app-cli] complex schema for \`${slug} ${commandName}\`; ` +
        `pass JSON payload directly\n`,
    );
  } else if (parser.status.kind === 'missing') {
    stderr.write(
      `[smrt-app-cli] schema unavailable for \`${slug} ${commandName}\`; ` +
        `pass JSON payload directly: $ <cli> ${slug} ${commandName}` +
        `${id ? ` ${id}` : ''} '<json>'\n`,
    );
  }

  const parsed = parser.parse(positional, command.httpMethod);

  const response2 = await invokeCommand({
    context,
    resource,
    command,
    parsed,
    id,
  });

  const { exitCode } = await renderResponse(response2, { stdout, stderr });
  if (exitCode !== 0) process.exitCode = exitCode;
}

async function buildAppContext(
  context: CliConfigContext,
  eagerResources: boolean,
): Promise<AppCliContext> {
  const config = await loadCliConfig(context);
  const serverUrl = await getServerUrl(context, config);
  const token = await getStoredToken(context, config);

  let resourcesPromise: Promise<ResourceListResponse> | null = null;
  const getResources = () => {
    if (!resourcesPromise) {
      // Plumb the already-loaded config through so the discovery fetch
      // doesn't trigger another loadCliConfig disk read. (#1311 review P2.)
      resourcesPromise = fetchResourceList(context, { loadedConfig: config });
    }
    return resourcesPromise;
  };
  if (eagerResources) {
    void getResources();
  }

  return {
    config,
    serverUrl,
    token,
    getResources,
    requestJson: (path, init, opts) =>
      requestJson(context, path, init, { loadedConfig: config, ...opts }),
    request: async (path, init) => {
      const headers = new Headers(init?.headers);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return fetch(`${serverUrl}${path}`, { ...init, headers });
    },
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function printUsage(
  options: CreateAppCliOptions,
  extras: Map<string, AppCliCommand>,
  out: NodeJS.WriteStream,
): void {
  const name = options.name;
  out.write(`Usage:\n`);
  out.write(`  ${name} auth login [--server <url>] [--no-open]\n`);
  out.write(`  ${name} auth status\n`);
  out.write(`  ${name} auth logout\n`);
  out.write(`  ${name} resources [--json] [--debug]\n`);
  out.write(
    `  ${name} <resource> <command> [id] [--flags...] [json-payload]\n`,
  );
  out.write(`  ${name} mcp tools\n`);
  out.write(`  ${name} mcp call <tool> [<json>]\n`);
  for (const cmd of extras.values()) {
    out.write(`  ${name} ${cmd.name}  — ${cmd.description}\n`);
  }
}

/** Naive levenshtein-style similarity. */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  let diff = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diff += 1;
    if (diff > 2) return false;
  }
  return true;
}
