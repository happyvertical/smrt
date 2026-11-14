import { describe, expect, it, vi } from 'vitest';
import { createAgentCliService } from './agent-cli/service.js';
import { fakeDeps, installFakeCli, tempDir } from './agent-cli/test-support.js';
import { cliEngineStatus, inferenceEngineStatus } from './engine-status.js';

const action = { label: 'Connect', href: '/host/connect' };
describe('host-driven engine diagnostics', () => {
  it('refuses an installed signed-in engine until startup preflight explicitly succeeds', () => {
    expect(
      cliEngineStatus(
        'claude-code',
        { installed: true, signedIn: true },
        action,
      ),
    ).toMatchObject({
      configured: false,
      code: 'agent_cli_startup',
      action,
    });
  });
  it.each([
    'claude-code',
    'codex',
  ] as const)('%s distinguishes missing, signed out and an unknown sign-in state', (tool) => {
    expect(
      cliEngineStatus(tool, { installed: false, signedIn: false }, action),
    ).toMatchObject({ configured: false, code: 'agent_cli_missing', action });
    for (const signedIn of [false, null])
      expect(
        cliEngineStatus(tool, { installed: true, signedIn }, action),
      ).toMatchObject({
        configured: false,
        code: 'agent_cli_signed_out',
        action,
      });
    expect(
      cliEngineStatus(
        tool,
        { installed: true, signedIn: true, ready: true },
        action,
      ),
    ).toMatchObject({ configured: true });
    expect(
      cliEngineStatus(
        tool,
        { installed: true, signedIn: true, ready: true },
        action,
      ).action,
    ).toBeUndefined();
  });

  it('consults only the selected engine and uses host destinations', async () => {
    const cliStatus = vi.fn(async () => ({
      installed: true,
      signedIn: true,
      ready: true,
    }));
    const status = vi.fn(async () => ({ signedIn: false, signingIn: false }));
    const apiStatus = vi.fn(async () => ({
      configured: false,
      code: 'api_unconfigured',
    }));
    const host = {
      cliStatus,
      chatgpt: { status },
      apiStatus,
      actions: { cli: action, chatgpt: action, api: action },
    };
    expect(await inferenceEngineStatus('codex', host)).toMatchObject({
      configured: true,
      engine: 'codex',
    });
    expect(status).not.toHaveBeenCalled();
    expect(apiStatus).not.toHaveBeenCalled();
    expect(await inferenceEngineStatus('chatgpt', host)).toMatchObject({
      configured: false,
      code: 'chatgpt_signed_out',
      action,
    });
    expect(await inferenceEngineStatus('api', host)).toMatchObject({
      configured: false,
      code: 'api_unconfigured',
      action,
    });
    expect(cliStatus).toHaveBeenCalledTimes(1);
    status.mockResolvedValue({ signedIn: true, signingIn: false });
    expect(await inferenceEngineStatus('chatgpt', host)).toEqual({
      configured: true,
      engine: 'chatgpt',
      engineLabel: 'ChatGPT',
    });
  });

  it('keeps CLI caches host-local and invalidates status explicitly', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'codex');
    const service = createAgentCliService(fakeDeps(home, [bin]));
    const first = await service.cliStatus('codex');
    expect(await service.cliStatus('codex')).toBe(first);
    service.invalidateCliStatus('codex');
    expect(await service.cliStatus('codex')).not.toBe(first);
    const other = createAgentCliService(fakeDeps(tempDir(), [tempDir()]));
    expect((await other.cliStatus('codex')).installed).toBe(false);
    expect((await service.cliStatus('codex')).installed).toBe(true);
  });
});
