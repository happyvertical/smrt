// Shebang is injected at build time via vite.config.ts (rollupOptions.output.banner).
/**
 * `smrt-mcp-bridge` — generic stdio MCP bridge.
 *
 * Usage:
 *
 * ```
 * smrt-mcp-bridge --env-prefix=WILLGRIFFIN \
 *   --name=willgriffin-mcp --version=0.1.0
 * ```
 *
 * All options can also be passed as env vars:
 *
 *  - `SMRT_MCP_ENV_PREFIX` — env-prefix the bridge uses to look up the app's
 *    server URL/token/config file.
 *  - `SMRT_MCP_APP_SLUG` — directory name under `~/.config`.
 *  - `SMRT_MCP_SERVER_NAME` / `SMRT_MCP_SERVER_VERSION` — local server identity.
 *  - `SMRT_MCP_DEFAULT_SERVER_URL` — fallback server URL.
 *
 * Apps that want their own branded bin should call `runMcpStdioBridge`
 * directly from `@happyvertical/smrt-app-mcp/cli` instead of going through
 * this generic entrypoint.
 */

import { runMcpStdioBridge } from '../bridge.js';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const flagIdx = process.argv.indexOf(`--${name}`);
  if (flagIdx >= 0 && flagIdx + 1 < process.argv.length) {
    return process.argv[flagIdx + 1];
  }
  return undefined;
}

const envPrefix =
  readArg('env-prefix') ?? process.env.SMRT_MCP_ENV_PREFIX ?? '';

if (!envPrefix) {
  console.error(
    'smrt-mcp-bridge: --env-prefix=<PREFIX> (or SMRT_MCP_ENV_PREFIX) is required.',
  );
  process.exit(2);
}

const appSlug = readArg('app-slug') ?? process.env.SMRT_MCP_APP_SLUG;
const defaultServerUrl =
  readArg('default-server-url') ?? process.env.SMRT_MCP_DEFAULT_SERVER_URL;
const serverName =
  readArg('name') ?? process.env.SMRT_MCP_SERVER_NAME ?? 'smrt-app-mcp';
const serverVersion =
  readArg('version') ?? process.env.SMRT_MCP_SERVER_VERSION ?? '0.0.0';

await runMcpStdioBridge({
  envPrefix,
  appSlug,
  defaultServerUrl,
  serverInfo: { name: serverName, version: serverVersion },
});
