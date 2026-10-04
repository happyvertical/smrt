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
 *  - `SMRT_MCP_PATH` (`--mcp-path`) — the app's MCP endpoint path, e.g.
 *    `/mcp`. Defaults to `/api/mcp`. An explicit value (even an empty
 *    environment value) must be valid; a malformed, missing or repeated
 *    value option is a usage error (exit 2) before the bridge listens.
 *
 * Apps that want their own branded bin should call `runMcpStdioBridge`
 * directly from `@happyvertical/smrt-app-cli` — this package's root export —
 * instead of going through this generic entrypoint.
 */

import { runMcpStdioBridge } from '../bridge.js';
import { McpBridgeUsageError, parseMcpBridgeArgs } from '../bridge-args.js';

let parsed: ReturnType<typeof parseMcpBridgeArgs>;
try {
  parsed = parseMcpBridgeArgs(process.argv.slice(2), process.env);
} catch (error) {
  if (!(error instanceof McpBridgeUsageError)) throw error;
  console.error(`smrt-mcp-bridge: ${error.message}`);
  process.exit(2);
}
const arg = (name: Parameters<typeof parsed.values.get>[0]) =>
  parsed.values.get(name);

const envPrefix = arg('env-prefix') ?? process.env.SMRT_MCP_ENV_PREFIX ?? '';

if (!envPrefix) {
  console.error(
    'smrt-mcp-bridge: --env-prefix=<PREFIX> (or SMRT_MCP_ENV_PREFIX) is required.',
  );
  process.exit(2);
}

const appSlug = arg('app-slug') ?? process.env.SMRT_MCP_APP_SLUG;
const defaultServerUrl =
  arg('default-server-url') ?? process.env.SMRT_MCP_DEFAULT_SERVER_URL;
const serverName =
  arg('name') ?? process.env.SMRT_MCP_SERVER_NAME ?? 'smrt-app-mcp';
const serverVersion =
  arg('version') ?? process.env.SMRT_MCP_SERVER_VERSION ?? '0.0.0';

await runMcpStdioBridge({
  transport: parsed.legacyRest ? 'legacy-rest' : 'mcp',
  envPrefix,
  appSlug,
  defaultServerUrl,
  requireSecureServerUrl: true,
  ...(parsed.mcpPath ? { mcpPath: parsed.mcpPath } : {}),
  serverInfo: { name: serverName, version: serverVersion },
});
