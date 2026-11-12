// The lock-down, asserted: what the command line, the config file and the
// environment of a turn contain, and what they must never contain.
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkProfile } from '../work-profiles.js';
import { assertLoopbackUrl, buildAgentRun, TOKEN_ENV } from './session.js';
import { claudeParser, codexParser, shellToolName } from './stream.js';
import { tempDir } from './test-support.js';

const TOKEN = `smrt_mcp_${'Q'.repeat(43)}`;

function spec(
  tool: 'claude-code' | 'codex',
  resumeId?: string,
  protection?: boolean,
) {
  const stateDir = tempDir();
  return {
    stateDir,
    run: buildAgentRun({
      tool,
      protection,
      location: { path: `/opt/${tool}`, extraPath: ['/opt'] },
      stateDir,
      mcpUrl: 'http://127.0.0.1:4801/mcp',
      token: TOKEN,
      systemPrompt: 'Be a helper.',
      prompt: 'add a chore list',
      resumeId,
      baseEnv: {
        PATH: '/usr/bin',
        HOME: '/h',
        ANTHROPIC_API_KEY: 'x',
        OPENAI_API_KEY: 'x',
        CODEX_API_KEY: 'x',
        SMRT_AI_API_KEY: 'x',
      },
    }),
  };
}

describe('Claude Code command line', () => {
  it('turns every built-in tool off and allows only the shell’s MCP server', () => {
    const { run } = spec('claude-code');
    const a = run.args;
    const arg = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a.slice(0, 5)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]);
    expect(arg('--tools')).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(arg('--allowedTools')).toBe('mcp__smrt');
    expect(arg('--permission-mode')).toBe('dontAsk');
    expect(arg('--permission-prompts')).toBe('none');
    expect(arg('--setting-sources')).toBe('');
    expect(a).toContain('--disable-slash-commands');
    expect(arg('--append-system-prompt')).toBe('Be a helper.');
    expect(a).not.toContain('--dangerously-skip-permissions');
    expect(a).not.toContain('--bare');
    expect(run.command).toBe('/opt/claude-code');
    run.cleanup();
  });

  it('puts the token in the environment only, never argv or a file', () => {
    const { run, stateDir } = spec('claude-code');
    expect(run.args.join('\n')).not.toContain(TOKEN);
    expect(run.env[TOKEN_ENV]).toBe(TOKEN);
    const config = join(run.args[run.args.indexOf('--mcp-config') + 1] ?? '');
    const text = readFileSync(config, 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).toContain(`\${${TOKEN_ENV}}`);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text).mcpServers.smrt.url).toBe(
      'http://127.0.0.1:4801/mcp',
    );
    expect(run.stdin).toBe('add a chore list');
    // The CLI's working directory is empty and private.
    expect(run.cwd).toBe(join(stateDir, 'work'));
    expect(statSync(run.cwd).mode & 0o777).toBe(0o700);
    run.cleanup();
    expect(() => statSync(config)).toThrow();
  });

  it('strips provider keys from the child environment', () => {
    const { run } = spec('claude-code');
    expect(Object.keys(run.env).sort()).toEqual(
      ['HOME', 'PATH', TOKEN_ENV].sort(),
    );
    run.cleanup();
  });

  it('starts a session with an id and resumes it later', () => {
    const first = spec('claude-code').run;
    const id = first.args[first.args.indexOf('--session-id') + 1];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.sessionId).toBe(id);
    const again = spec('claude-code', id).run;
    expect(again.args).toContain('--resume');
    expect(again.args).not.toContain('--session-id');
    expect(again.sessionId).toBe(id);
  });
});

describe('Codex command line', () => {
  it('switches off shell, web and the user’s own config', () => {
    const { run } = spec('codex');
    const a = run.args;
    expect(a.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(a).toContain('--ignore-user-config');
    expect(a).toContain('--ignore-rules');
    const disabled = a.flatMap((x, i) => (a[i - 1] === '--disable' ? [x] : []));
    expect(disabled).toEqual(
      expect.arrayContaining([
        'shell_tool',
        'unified_exec',
        'plugins',
        'hooks',
      ]),
    );
    const overrides = a.flatMap((x, i) => (a[i - 1] === '-c' ? [x] : []));
    expect(overrides).toContain('sandbox_mode="workspace-write"');
    expect(overrides).toContain('approval_policy="never"');
    expect(overrides).toEqual(
      expect.arrayContaining([
        'sandbox_workspace_write.network_access=false',
        'sandbox_workspace_write.writable_roots=[]',
        'sandbox_workspace_write.exclude_slash_tmp=true',
        'sandbox_workspace_write.exclude_tmpdir_env_var=true',
        'shell_environment_policy.inherit="none"',
      ]),
    );
    expect(disabled).not.toContain('code_mode_host');
    expect(
      a.some((v, i) => v === 'code_mode_host' && a[i - 1] === '--enable'),
    ).toBe(true);
    expect(overrides).toContain('web_search="disabled"');
    expect(overrides).toContain('mcp_servers.smrt.required=true');
    expect(overrides).toContain(
      'mcp_servers.smrt.url="http://127.0.0.1:4801/mcp"',
    );
    expect(overrides).toContain(
      `mcp_servers.smrt.bearer_token_env_var="${TOKEN_ENV}"`,
    );
    expect(a.at(-1)).toBe('-');
    expect(a.join('\n')).not.toContain(TOKEN);
    expect(run.env[TOKEN_ENV]).toBe(TOKEN);
    expect(Object.keys(run.env)).not.toContain('OPENAI_API_KEY');
    run.cleanup();
  });

  it('resumes with the thread id', () => {
    const { run } = spec('codex', 'thread-9');
    expect(run.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(run.args.slice(-2)).toEqual(['thread-9', '-']);
    run.cleanup();
  });
});

describe('the token only goes to this computer', () => {
  it('refuses a non-loopback or non-http URL', () => {
    expect(assertLoopbackUrl('http://127.0.0.1:1/mcp').port).toBe('1');
    expect(assertLoopbackUrl('http://localhost:2/mcp').hostname).toBe(
      'localhost',
    );
    expect(() => assertLoopbackUrl('https://example.com/mcp')).toThrow();
    expect(() => assertLoopbackUrl('http://192.168.1.5/mcp')).toThrow();
    expect(() =>
      buildAgentRun({
        tool: 'codex',
        location: { path: '/x', extraPath: [] },
        stateDir: tempDir(),
        mcpUrl: 'http://evil.example/mcp',
        token: TOKEN,
        systemPrompt: '',
        prompt: '',
      }),
    ).toThrow();
  });
});

describe('stream parsers', () => {
  it('Claude Code: streams text once, maps tool calls to shell names', () => {
    const parse = claudeParser();
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hi' },
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hi' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'mcp__smrt__app_describe',
              input: {},
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'ok' }],
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hi' },
    ].map((l) => JSON.stringify(l));
    const events = lines.flatMap((l) => parse(l));
    expect(events).toEqual([
      { type: 'session', id: 's1' },
      { type: 'text', delta: 'Hi' },
      { type: 'tool_use', id: 't1', name: 'app_describe', args: '{}' },
      { type: 'tool_result', id: 't1', ok: true, text: 'ok' },
      { type: 'done', ok: true, text: 'Hi' },
    ]);
  });

  it('flags any tool outside the shell’s own as forbidden', () => {
    const claude = claudeParser()(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
        },
      }),
    );
    expect(claude).toEqual([{ type: 'forbidden', what: 'Bash' }]);
    const codex = codexParser()(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution' },
      }),
    );
    expect(codex).toEqual([
      { type: 'forbidden', what: 'command_execution', kind: 'unknown_item' },
    ]);
  });

  it('Codex: anything but the shell’s own tools and messages is forbidden', () => {
    const parse = codexParser();
    for (const type of [
      'command_execution',
      'file_change',
      'web_search',
      'collab_tool_call',
      'something_new',
    ])
      expect(
        parse(JSON.stringify({ type: 'item.started', item: { type } })),
      ).toEqual([{ type: 'forbidden', what: type, kind: 'unknown_item' }]);
    // an MCP call on any other server
    expect(
      parse(
        JSON.stringify({
          type: 'item.started',
          item: { id: 'i', type: 'mcp_tool_call', server: 'other', tool: 'x' },
        }),
      )[0],
    ).toMatchObject({ type: 'forbidden' });
    // and the shell's own is fine
    expect(
      parse(
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'i',
            type: 'mcp_tool_call',
            server: 'smrt',
            tool: 'app_describe',
            arguments: {},
          },
        }),
      ),
    ).toEqual([
      { type: 'tool_use', id: 'i', name: 'app_describe', args: '{}' },
    ]);
  });

  it('Codex: messages, MCP calls, failures; noise is ignored', () => {
    const parse = codexParser();
    expect(parse('not json')).toEqual([]);
    expect(parse(JSON.stringify({ type: 'something.new' }))).toEqual([]);
    expect(
      parse(JSON.stringify({ type: 'thread.started', thread_id: 'th' })),
    ).toEqual([{ type: 'session', id: 'th' }]);
    expect(
      parse(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'hello' },
        }),
      ),
    ).toEqual([{ type: 'message', text: 'hello' }]);
    expect(
      parse(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'nope' },
        }),
      ),
    ).toEqual([{ type: 'done', ok: false, error: 'nope' }]);
  });

  it('shellToolName strips the MCP prefix only', () => {
    expect(shellToolName('mcp__smrt__chore_list')).toBe('chore_list');
    expect(shellToolName('chore_list')).toBe('chore_list');
  });
});

describe('explicit profile invocation', () => {
  it.each([
    'claude-code',
    'codex',
  ] as const)('passes %s model effort and JSON schema without relaxing lockdown', (tool) => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const profile = resolveWorkProfile({
      engine: tool,
      profile: 'design',
      settings: { model: 'strong-test' },
    });
    const run = buildAgentRun({
      tool,
      profile,
      outputSchema: schema,
      location: { path: '/fake/cli', extraPath: [] },
      stateDir: tempDir(),
      mcpUrl: 'http://127.0.0.1:4801/mcp',
      token: TOKEN,
      systemPrompt: 'app only',
      prompt: 'design',
    });
    if (tool === 'claude-code') {
      expect(run.args.slice(5, 11)).toEqual([
        '--model',
        'strong-test',
        '--effort',
        'max',
        '--json-schema',
        JSON.stringify(schema),
      ]);
      expect(run.args).toContain('--strict-mcp-config');
      expect(run.args[run.args.indexOf('--tools') + 1]).toBe('');
    } else {
      expect(run.args.slice(3, 7)).toEqual([
        '-m',
        'strong-test',
        '--output-schema',
        expect.any(String),
      ]);
      expect(JSON.parse(readFileSync(run.args[6], 'utf8'))).toEqual(schema);
      expect(run.args).toContain('model_reasoning_effort="xhigh"');
      expect(run.args).toContain('code_mode_host');
      expect(run.args).toContain('sandbox_mode="workspace-write"');
    }
    expect(run.args.join(' ')).not.toContain(TOKEN);
    run.cleanup();
  });
});

it('keeps unexpected structured-output tools forbidden and captures runtime model identity', () => {
  const parse = claudeParser();
  expect(
    parse(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        model: 'claude-fable-runtime',
      }),
    ),
  ).toEqual([
    { type: 'execution_model', model: 'claude-fable-runtime' },
    { type: 'session', id: 's' },
  ]);
  expect(
    parse(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'x', name: 'StructuredOutput', input: {} },
          ],
        },
      }),
    ),
  ).toEqual([{ type: 'forbidden', what: 'StructuredOutput' }]);
  expect(
    parse(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        structured_output: { ok: true },
        usage: { input_tokens: 15, output_tokens: 5 },
      }),
    ),
  ).toEqual([{ type: 'done', ok: true, tokens: 20 }]);
});

it('includes Anthropic cache usage without double-counting Codex cached input', () => {
  expect(
    claudeParser()(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      }),
    ),
  ).toEqual([{ type: 'done', ok: true, tokens: 135 }]);
  expect(
    codexParser()(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 80 },
      }),
    ),
  ).toEqual([{ type: 'done', ok: true, tokens: 105 }]);
  expect(
    claudeParser()(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 10 },
      }),
    ),
  ).toEqual([{ type: 'done', ok: true }]);
});

it.each([
  'claude-code',
  'codex',
] as const)('rejects unsafe %s argv before building run files', (tool) => {
  const profile = {
    ...resolveWorkProfile({ engine: tool, settings: { model: 'valid-model' } }),
    model: '--dangerously-skip-permissions',
  };
  expect(() =>
    buildAgentRun({
      tool,
      profile,
      location: { path: '/unused', extraPath: [] },
      stateDir: tempDir(),
      mcpUrl: 'http://127.0.0.1:4801/mcp',
      token: TOKEN,
      systemPrompt: '',
      prompt: '',
    }),
  ).toThrow('Invalid work profile model');
});

it('treats host-enabled StructuredOutput as a result channel with no executable tool events', () => {
  const parse = claudeParser({ type: 'object' });
  expect(
    parse(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'result',
              name: 'StructuredOutput',
              input: { ignored: 'raw-payload' },
            },
          ],
        },
      }),
    ),
  ).toEqual([{ type: 'result_channel', name: 'StructuredOutput' }]);
  expect(
    parse(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'result',
              content: 'raw-payload',
            },
          ],
        },
      }),
    ),
  ).toEqual([]);
  expect(
    parse(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        structured_output: { ok: true },
      }),
    ),
  ).toEqual([{ type: 'done', ok: true, text: '{"ok":true}' }]);
  expect(
    parse(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'bad', name: 'Bash', input: {} }],
        },
      }),
    ),
  ).toEqual([{ type: 'forbidden', what: 'Bash' }]);
});

it('keeps schema result channels separate from mixed app tool calls and prose', () => {
  const parse = claudeParser({ type: 'object' });
  expect(
    parse(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Preparing a result' },
            {
              type: 'tool_use',
              id: 'app',
              name: 'mcp__smrt__app_describe',
              input: {},
            },
            {
              type: 'tool_use',
              id: 'schema',
              name: 'StructuredOutput',
              input: {},
            },
          ],
        },
      }),
    ),
  ).toEqual([
    { type: 'tool_use', id: 'app', name: 'app_describe', args: '{}' },
    { type: 'result_channel', name: 'StructuredOutput' },
  ]);
  expect(
    parse(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'schema',
              content: 'internal result',
            },
            {
              type: 'tool_result',
              tool_use_id: 'app',
              content: 'app observation',
            },
            {
              type: 'tool_result',
              tool_use_id: 'unmatched',
              content: 'unknown observation',
            },
          ],
        },
      }),
    ),
  ).toEqual([
    { type: 'tool_result', id: 'app', ok: true, text: 'app observation' },
    {
      type: 'tool_result',
      id: 'unmatched',
      ok: true,
      text: 'unknown observation',
    },
  ]);
  expect(
    parse(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'prose' },
        },
      }),
    ),
  ).toEqual([]);
});

it('classifies foreign Claude MCP tools separately from builtins', () => {
  expect(
    claudeParser()(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'foreign',
              name: 'mcp__foreign__read',
              input: { secret: 'raw-payload' },
            },
          ],
        },
      }),
    ),
  ).toEqual([
    { type: 'forbidden', what: 'mcp__foreign__read', kind: 'unoffered_mcp' },
  ]);
});

it('gives concurrent Codex attempts fresh empty private writable roots and removes them on cleanup', () => {
  const stateDir = tempDir();
  const input = {
    tool: 'codex' as const,
    stateDir,
    location: { path: '/fake', extraPath: [] },
    mcpUrl: 'http://127.0.0.1:4801/mcp',
    token: TOKEN,
    systemPrompt: '',
    prompt: '',
  };
  const first = buildAgentRun(input);
  const second = buildAgentRun({ ...input, resumeId: 'prior' });
  expect(first.cwd).not.toBe(second.cwd);
  for (const run of [first, second]) {
    expect(run.cwd.startsWith(join(stateDir, 'run'))).toBe(true);
    expect(statSync(run.cwd).mode & 0o777).toBe(0o700);
    expect(readdirSync(run.cwd)).toEqual([]);
    writeFileSync(join(run.cwd, 'stray-patch'), 'discard me');
    run.cleanup();
    expect(existsSync(run.cwd)).toBe(false);
  }
});

it.each([
  'claude-code',
  'codex',
] as const)('allows native %s config/tools only when the host disables protection, retaining token and environment guarantees', (tool) => {
  const { run, stateDir } = spec(tool, undefined, false);
  expect(run.args.join(' ')).not.toContain(TOKEN);
  expect(run.env.OPENAI_API_KEY).toBeUndefined();
  expect(run.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(run.env[TOKEN_ENV]).toBe(TOKEN);
  expect(run.cwd).toBe(join(stateDir, 'work'));
  if (tool === 'claude-code') {
    for (const flag of [
      '--tools',
      '--strict-mcp-config',
      '--setting-sources',
      '--disable-slash-commands',
      '--no-chrome',
    ])
      expect(run.args).not.toContain(flag);
    expect(run.args[run.args.indexOf('--permission-mode') + 1]).toBe(
      'bypassPermissions',
    );
    expect(run.args[run.args.indexOf('--permission-prompts') + 1]).toBe('none');
  } else {
    for (const flag of ['--disable', '--ignore-user-config', '--ignore-rules'])
      expect(run.args).not.toContain(flag);
    expect(run.args).toContain('sandbox_mode="danger-full-access"');
    expect(run.args).toContain('approval_policy="never"');
    expect(run.args).toContain('web_search="live"');
    expect(run.args).toContain(
      'mcp_servers.smrt.bearer_token_env_var="SMRT_SHELL_MCP_TOKEN"',
    );
  }
  run.cleanup();
  expect(existsSync(run.cwd)).toBe(true);
});
