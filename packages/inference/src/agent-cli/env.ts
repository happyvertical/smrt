// The environment a local agent CLI child gets. An allow-list, not a
// deny-list: the shell's own secrets (master key, `SMRT_*`, provider API
// keys) never reach the child, so the CLI always uses the person's own
// sign-in and the bill is theirs. Provider key variables are also named in a
// deny list, so adding one to the allow-list by accident still drops it.
import { delimiter, dirname } from 'node:path';

const ALLOW_EXACT: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Windows
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'HOMEDRIVE',
  'HOMEPATH',
]);

/** Variables that must never reach a child, whatever the allow-list says. */
const DENY_EXACT: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
]);
const DENY_PREFIXES = ['SMRT_', 'CLAUDE_CODE_USE_', 'ANTHROPIC_', 'OPENAI_'];

function allowed(name: string): boolean {
  if (DENY_EXACT.has(name)) return false;
  if (DENY_PREFIXES.some((p) => name.toUpperCase().startsWith(p))) return false;
  return ALLOW_EXACT.has(name) || name.startsWith('LC_');
}

/**
 * The child's environment: the allow-listed part of `base`, with `extraPath`
 * directories added to the front of PATH (a desktop app started from Finder has
 * a minimal PATH, and an npm-installed CLI is a `#!/usr/bin/env node` script
 * that needs `node` on it), plus `extra` variables (the MCP token, for a tool
 * that reads it from the environment).
 */
export function childEnv(
  base: Readonly<Record<string, string | undefined>>,
  options: {
    extraPath?: readonly string[];
    extra?: Readonly<Record<string, string>>;
  } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && allowed(name)) out[name] = value;
  }
  const pathKey =
    Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = [
    ...(options.extraPath ?? []),
    ...(out[pathKey] ? out[pathKey].split(delimiter) : []),
  ].filter(Boolean);
  out[pathKey] = [...new Set(dirs)].join(delimiter);
  Object.assign(out, options.extra);
  return out;
}

/** The directory of the running Node (an npm CLI shim needs `node`). */
export function nodeDir(): string {
  return dirname(process.execPath);
}
