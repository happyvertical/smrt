// The lock-down, asserted: what the command line, the config file and the
// environment of a turn contain, and what they must never contain.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLoopbackUrl, buildAgentRun, TOKEN_ENV } from './session.js';
import { claudeParser, codexParser, shellToolName } from './stream.js';
import { tempDir } from './test-support.js';

const TOKEN = `smrt_mcp_${'Q'.repeat(43)}`;

function spec(tool: 'claude-code' | 'codex', resumeId?: string) {
  const stateDir = tempDir();
  return {
    stateDir,
    run: buildAgentRun({
      tool,
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
    expect(overrides).toContain('sandbox_mode="read-only"');
    expect(overrides).toContain('approval_policy="never"');
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
    expect(codex).toEqual([{ type: 'forbidden', what: 'command_execution' }]);
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
      ).toEqual([{ type: 'forbidden', what: type }]);
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
