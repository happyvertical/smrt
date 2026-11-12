// The exact command line, environment and stdin of one assistant turn through
// a local agent CLI. The lock-down lives here, in one place:
//
//  - App data is changed only through the owner-bound MCP route. Claude's
//    built-ins are absent. Codex requires code_mode_host (and apply_patch):
//    its OS sandbox permits writes only in this attempt's disposable cwd,
//    excludes temp roots and denies command networking. Shell stays disabled.
//  - No user config/rules, project documents, bundled skills or extra MCP.
//  - The token never appears on a command line or on disk: it is in the
//    child's environment only, and the MCP config names the variable.
//  - The prompt is on stdin.
//
// Verified against claude 2.1.319 and codex-cli 0.162.1 (their `--help`); the
// first `init` event of Claude Code lists `tools: []` plus the one MCP server.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ResolvedWorkProfile,
  validateWorkModel,
} from '../work-profiles.js';
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
  profile?: ResolvedWorkProfile;
  outputSchema?: Record<string, unknown>;
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
      '--model',
      input.profile?.model ?? 'fable',
      '--effort',
      input.profile?.effort ?? 'high',
      ...(input.outputSchema
        ? ['--json-schema', JSON.stringify(input.outputSchema)]
        : []),
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
    parse: claudeParser(input.outputSchema),
    sessionId,
    cleanup: () => rmSync(runDir, { recursive: true, force: true }),
  };
}

/**
 * Optional Codex features switched off. code_mode_host alone is enabled below.
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
  const schemaPath = join(runDir, 'output-schema.json');
  if (input.outputSchema)
    writeFileSync(schemaPath, JSON.stringify(input.outputSchema), {
      mode: 0o600,
    });
  const overrides: [string, string][] = [
    [
      'model_reasoning_effort',
      toml(
        input.profile?.effort === 'max'
          ? 'xhigh'
          : (input.profile?.effort ?? 'high'),
      ),
    ],
    ['sandbox_mode', toml('workspace-write')],
    ['sandbox_workspace_write.network_access', 'false'],
    ['sandbox_workspace_write.writable_roots', '[]'],
    ['sandbox_workspace_write.exclude_slash_tmp', 'true'],
    ['sandbox_workspace_write.exclude_tmpdir_env_var', 'true'],
    // No secret-bearing environment is inherited by a model-generated command.
    ['shell_environment_policy.inherit', toml('none')],
    ['project_doc_max_bytes', '0'],
    ['skills.bundled.enabled', 'false'],
    ['approval_policy', toml('never')],
    ['web_search', toml('disabled')],
    [`${server}.url`, toml(input.mcpUrl)],
    [`${server}.bearer_token_env_var`, toml(TOKEN_ENV)],
    // Optional servers get only a short grace period: never start a model
    // without the app's tools while a real catalog is still being prepared.
    [`${server}.required`, 'true'],
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
      ...(input.profile?.model ? ['-m', input.profile.model] : []),
      ...(input.outputSchema ? ['--output-schema', schemaPath] : []),
      // None of the person's config.toml (MCP servers, hooks, profiles) or
      // execpolicy rules; the sign-in (CODEX_HOME) is kept.
      '--ignore-user-config',
      '--ignore-rules',
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
      '--enable',
      CODEX_MODERN_MCP_FEATURE,
      '--enable',
      'code_mode_host',
      ...overrides.flatMap(([k, v]) => ['-c', `${k}=${v}`]),
      ...(input.resumeId ? [input.resumeId] : []),
      '-',
    ],
    cwd: work,
    env: cliEnv(input.location, input.baseEnv, { [TOKEN_ENV]: input.token }),
    stdin: input.prompt,
    parse: codexParser({ confinedBuiltins: true }),
    sessionId: input.resumeId ?? null,
    cleanup: () => rmSync(runDir, { recursive: true, force: true }),
  };
}

/** Build the run: an empty private cwd, a private temp dir, the command. */
export function buildAgentRun(input: SpecInput): AgentRunSpec {
  assertLoopbackUrl(input.mcpUrl);
  if (input.profile?.model !== undefined)
    validateWorkModel(input.profile.model);
  const runRoot = join(input.stateDir, 'run');
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const runDir = mkdtempSync(join(runRoot, 'turn-'));
  try {
    // Codex's code host brings apply_patch. Its only writable root must be a
    // NEW empty 0700 folder on every attempt (also on resume/fallback).
    const work =
      input.tool === 'codex'
        ? join(runDir, 'work')
        : join(input.stateDir, 'work');
    mkdirSync(work, { recursive: true, mode: 0o700 });
    return input.tool === 'claude-code'
      ? claudeSpec(input, runDir, work)
      : codexSpec(input, runDir, work);
  } catch (error) {
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}
