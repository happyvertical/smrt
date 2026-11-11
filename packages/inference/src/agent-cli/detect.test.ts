// Detection with fake binaries on a temp PATH and a temp HOME: installed,
// signed in or out, missing, found only outside PATH, and the child
// environment. No real CLI is started.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAgentCli, detectAgentClis } from './detect.js';
import { childEnv } from './env.js';
import { candidateDirs } from './locate.js';
import { AgentLogin } from './login.js';
import { fakeDeps, installFakeCli, tempDir } from './test-support.js';

describe('detectAgentCli', () => {
  it('reports an installed, signed-in Claude Code with its version', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'claude-code', { version: '2.5.7' });
    writeFileSync(join(home, 'signed-in'), '');
    const status = await detectAgentCli('claude-code', fakeDeps(home, [bin]));
    expect(status).toMatchObject({
      tool: 'claude-code',
      label: 'Claude Code',
      installed: true,
      version: '2.5.7',
      signedIn: true,
    });
    // Nothing about the account (the fake status prints an email and an org).
    expect(JSON.stringify(status)).not.toMatch(/person@example|Private Org/);
  });

  it('reports signed out when the tool says so', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'codex', { version: '0.9.0' });
    const status = await detectAgentCli('codex', fakeDeps(home, [bin]));
    expect(status).toMatchObject({
      tool: 'codex',
      installed: true,
      version: '0.9.0',
      signedIn: false,
    });
    writeFileSync(join(home, 'signed-in'), '');
    expect(
      (await detectAgentCli('codex', fakeDeps(home, [bin]))).signedIn,
    ).toBe(true);
  });

  it('reports a missing tool with the vendor install page', async () => {
    const status = await detectAgentCli(
      'claude-code',
      fakeDeps(tempDir(), [tempDir()]),
    );
    expect(status).toMatchObject({
      installed: false,
      signedIn: false,
      installUrl: 'https://code.claude.com/docs/en/setup',
    });
    expect(status.version).toBeUndefined();
  });

  it('finds a tool that is not on PATH in the usual install places', async () => {
    // A desktop app started from Finder: PATH has nothing useful.
    const home = tempDir();
    installFakeCli(join(home, '.local', 'bin'), 'claude-code');
    installFakeCli(join(home, '.npm-global', 'bin'), 'codex');
    const deps = fakeDeps(home, []);
    expect(candidateDirs(deps)).toContain(join(home, '.local', 'bin'));
    const all = await detectAgentClis(deps);
    expect(all.map((s) => [s.tool, s.installed])).toEqual([
      ['claude-code', true],
      ['codex', true],
    ]);
  });

  it('says it could not ask when the tool does not start', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'claude-code', { brokenVersion: true });
    const status = await detectAgentCli('claude-code', fakeDeps(home, [bin]));
    expect(status).toMatchObject({ installed: true, signedIn: null });
  });

  it('never gives the tool the shell’s keys or the provider keys', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'claude-code');
    await detectAgentCli(
      'claude-code',
      fakeDeps(home, [bin], {
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-openai-secret',
        CODEX_API_KEY: 'codex-secret',
        SMRT_AI_API_KEY: 'smrt-secret',
        SMRT_SECRET_MASTER_KEY: 'master-secret',
        SOME_OTHER_TOKEN: 'other-secret',
      }),
    );
    const dump = readFileSync(join(home, 'env-dump'), 'utf8');
    expect(dump).toContain('HOME=');
    expect(dump).not.toMatch(/secret/);
    expect(dump).not.toMatch(/ANTHROPIC|OPENAI|CODEX_API|SMRT_/);
  });
});

describe('childEnv', () => {
  it('keeps what a CLI needs and drops everything else', () => {
    const env = childEnv(
      {
        PATH: '/usr/bin',
        HOME: '/h',
        LC_ALL: 'C',
        ANTHROPIC_API_KEY: 'a',
        ANTHROPIC_BASE_URL: 'http://x',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CODEX_ACCESS_TOKEN: 'c',
        OPENAI_API_KEY: 'o',
        SMRT_AI_PROVIDER: 's',
        AWS_SECRET_ACCESS_KEY: 'w',
      },
      { extraPath: ['/opt/tool'], extra: { SMRT_SHELL_MCP_TOKEN: 't' } },
    );
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', 'LC_ALL', 'PATH', 'SMRT_SHELL_MCP_TOKEN'].sort(),
    );
    expect(env.PATH?.startsWith('/opt/tool')).toBe(true);
  });
});

describe('AgentLogin', () => {
  it('runs the tool’s own sign-in, then the status flips', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'claude-code');
    const deps = fakeDeps(home, [bin]);
    const ended: string[] = [];
    const login = new AgentLogin({ deps, onEnd: (t) => ended.push(t) });
    expect((await detectAgentCli('claude-code', deps)).signedIn).toBe(false);
    expect(await login.start('claude-code')).toBe('started');
    expect(login.snapshot('claude-code').state).toBe('running');
    await login.settled('claude-code');
    expect(login.snapshot('claude-code').state).toBe('finished');
    expect(ended).toEqual(['claude-code']);
    expect((await detectAgentCli('claude-code', deps)).signedIn).toBe(true);
  });

  it('says missing when the tool is not installed', async () => {
    const login = new AgentLogin({ deps: fakeDeps(tempDir(), [tempDir()]) });
    expect(await login.start('codex')).toBe('missing');
  });
});
