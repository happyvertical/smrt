// The exact command line, environment and stdin of one assistant turn through
// a local agent CLI. The lock-down lives here, in one place:
//
//  - The only tools the model has are the shell's own, from the shell's MCP
//    route, authenticated by a short-lived owner-bound token. Every built-in
//    tool of the CLI that touches the machine (shell, file read/edit, web,
//    sub-agents) is switched off, and the stream is checked for one anyway
//    (stream.ts `forbidden`).
//  - The CLI runs in an empty, private working directory and loads none of the
//    person's own settings, hooks, skills, plugins or MCP servers.
//  - The token never appears on a command line or on disk: it is in the
//    child's environment only, and the MCP config names the variable.
//  - The prompt is on stdin.
//
// Verified against claude 2.1.319 and codex-cli 0.162.1 (their `--help`); the
// first `init` event of Claude Code lists `tools: []` plus the one MCP server.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentCliLocation } from './detect.js';
import { cliEnv } from './detect.js';
import {
  type AgentEvent,
  claudeParser,
  codexParser,
  MCP_SERVER_NAME,
} from './stream.js';
import type { AgentTool } from './tools.js';

/** The environment variable that carries the MCP token to the child. */
export const TOKEN_ENV = 'SMRT_SHELL_MCP_TOKEN';

export interface AgentRunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  parse(line: string): AgentEvent[];
  /** The id a later turn resumes with (known up front for Claude Code). */
  sessionId: string | null;
  /** Remove the per-run files. */
  cleanup(): void;
}

export interface SpecInput {
  tool: AgentTool;
  location: AgentCliLocation;
  /** `<data root>/agent-cli`: holds `work/` (empty cwd) and `run/` (temp). */
  stateDir: string;
  /** Loopback URL of the shell's `/mcp` route. */
  mcpUrl: string;
  token: string;
  /** The assistant guidance for this engine. */
  systemPrompt: string;
  prompt: string;
  /** The CLI's own session id from an earlier turn of this thread. */
  resumeId?: string | null;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** Only a loopback URL may ever receive the token. */
export function assertLoopbackUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback =
    host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (url.protocol !== 'http:' || !loopback)
    throw new Error('The shell is not served from this computer.');
  return url;
}

/** TOML basic string for a `-c key=value` override. */
const toml = (value: string): string => JSON.stringify(value);

function claudeSpec(
  input: SpecInput,
  runDir: string,
  work: string,
): AgentRunSpec {
  const sessionId = input.resumeId ?? randomUUID();
  const configPath = join(runDir, 'mcp.json');
  // `${VAR}` in a header is expanded by Claude Code from the child's
  // environment: the file holds no secret.
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: input.mcpUrl,
          headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        },
      },
    }),
    { mode: 0o600 },
  );
  return {
    command: input.location.path,
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // No built-in tools at all (shell, file, web, sub-agents).
      '--tools',
      '',
      // Only the shell's MCP server; the allow rule covers its tools only.
      '--strict-mcp-config',
      '--mcp-config',
      configPath,
      '--allowedTools',
      `mcp__${MCP_SERVER_NAME}`,
      // Anything not allowed is denied, never asked.
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      // None of the person's user/project/local settings (hooks, plugins).
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-chrome',
      '--append-system-prompt',
      input.systemPrompt,
      ...(input.resumeId
        ? ['--resume', input.resumeId]
        : ['--session-id', sessionId]),
    ],
    cwd: work,
    env: cliEnv(input.location, input.baseEnv, { [TOKEN_ENV]: input.token }),
    stdin: input.prompt,
    parse: claudeParser(),
    sessionId,
    cleanup: () => rmSync(runDir, { recursive: true, force: true }),
  };
}

/**
 * Codex features that reach the machine or the wider world, all switched off.
 * Every name is one `codex features list` prints for 0.162.1.
 */
const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'multi_agent_v2',
  'view_image',
  'image_generation',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'memories',
  'skill_search',
  'tool_suggest',
  'goals',
  'code_mode',
  'code_mode_host',
  'request_permissions_tool',
] as const;

/**
 * Codex 0.162.1 speaks the older streamable-HTTP handshake unless this
 * (still "under development") feature is on; the shell's `/mcp` route accepts
 * only the 2026-07-28 protocol. Checked with `codex app-server` against the
 * route: with it the server's tools list and a tool call work, without it the
 * server never connects.
 */
const CODEX_MODERN_MCP_FEATURE = 'mcp_2026_07_28';

function codexSpec(
  input: SpecInput,
  runDir: string,
  work: string,
): AgentRunSpec {
  const server = `mcp_servers.${MCP_SERVER_NAME}`;
  const overrides: [string, string][] = [
    ['sandbox_mode', toml('read-only')],
    ['approval_policy', toml('never')],
    ['web_search', toml('disabled')],
    [`${server}.url`, toml(input.mcpUrl)],
    [`${server}.bearer_token_env_var`, toml(TOKEN_ENV)],
    [`${server}.default_tools_approval_mode`, toml('approve')],
    [`${server}.startup_timeout_sec`, '30'],
    [`${server}.tool_timeout_sec`, '300'],
    ['developer_instructions', toml(input.systemPrompt)],
  ];
  return {
    command: input.location.path,
    args: [
      'exec',
      ...(input.resumeId ? ['resume'] : []),
      '--json',
      '--skip-git-repo-check',
      // None of the person's config.toml (MCP servers, hooks, profiles) or
      // execpolicy rules; the sign-in (CODEX_HOME) is kept.
      '--ignore-user-config',
      '--ignore-rules',
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
      '--enable',
      CODEX_MODERN_MCP_FEATURE,
      ...overrides.flatMap(([k, v]) => ['-c', `${k}=${v}`]),
      ...(input.resumeId ? [input.resumeId] : []),
      '-',
    ],
    cwd: work,
    env: cliEnv(input.location, input.baseEnv, { [TOKEN_ENV]: input.token }),
    stdin: input.prompt,
    parse: codexParser(),
    sessionId: input.resumeId ?? null,
    cleanup: () => rmSync(runDir, { recursive: true, force: true }),
  };
}

/** Build the run: an empty private cwd, a private temp dir, the command. */
export function buildAgentRun(input: SpecInput): AgentRunSpec {
  assertLoopbackUrl(input.mcpUrl);
  const work = join(input.stateDir, 'work');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const runRoot = join(input.stateDir, 'run');
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const runDir = mkdtempSync(join(runRoot, 'turn-'));
  return input.tool === 'claude-code'
    ? claudeSpec(input, runDir, work)
    : codexSpec(input, runDir, work);
}
