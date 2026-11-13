// The system-browser opener and the failure words. Nothing is spawned: the
// spawn function is a stub.
import { describe, expect, it, vi } from 'vitest';
import {
  browserCommand,
  chatgptFailureNote,
  openSystemBrowser,
  type SpawnLike,
} from './support.js';

const CHATGPT_SETTINGS_HREF = '/settings/assistant#chatgpt';
const failureNote = chatgptFailureNote;
const noteFor = (error: unknown) => failureNote(error, CHATGPT_SETTINGS_HREF);
const URL_OK =
  'https://auth.openai.com/api/accounts/authorize?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fauth%2Fcallback&state=s&nonce=n';

function stubSpawn() {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref: () => undefined, once: () => undefined };
  };
  return { spawn, calls };
}

describe('openSystemBrowser', () => {
  it('opens OpenAI’s page with the platform’s opener', async () => {
    for (const [platform, command] of [
      ['darwin', 'open'],
      ['linux', 'xdg-open'],
    ] as const) {
      const { spawn, calls } = stubSpawn();
      expect(await openSystemBrowser(URL_OK, { platform, spawn })).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(command);
      expect(calls[0].args).toEqual([URL_OK]);
      expect(calls[0].options).toMatchObject({
        detached: true,
        stdio: 'ignore',
      });
    }
  });

  it('on Windows quotes the address for cmd, which would split it at "&"', async () => {
    const { spawn, calls } = stubSpawn();
    await openSystemBrowser(URL_OK, { platform: 'win32', spawn });
    expect(calls[0].command).toBe('cmd');
    expect(calls[0].args).toEqual(['/c', 'start', '""', `"${URL_OK}"`]);
    expect(calls[0].options).toMatchObject({ windowsVerbatimArguments: true });
  });

  it('refuses any address that is not https on the sign-in host, spawning nothing', async () => {
    const { spawn, calls } = stubSpawn();
    for (const bad of [
      'http://auth.openai.com/x',
      'https://evil.example.com/x',
      'https://auth.openai.com.evil.example/x',
      'https://user@auth.openai.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '--help',
      '',
    ])
      await expect(
        openSystemBrowser(bad, { platform: 'darwin', spawn }),
      ).rejects.toThrow(/sign-in page/);
    expect(calls).toHaveLength(0);
  });

  it('reports false when the opener cannot start', async () => {
    const spawn: SpawnLike = () => {
      throw new Error('ENOENT');
    };
    expect(await openSystemBrowser(URL_OK, { platform: 'linux', spawn })).toBe(
      false,
    );
    const onError: SpawnLike = () => ({
      unref: () => undefined,
      once: (_event, listener) => {
        listener();
      },
    });
    expect(
      await openSystemBrowser(URL_OK, { platform: 'linux', spawn: onError }),
    ).toBe(false);
  });

  it('has a command for every platform', () => {
    expect(browserCommand(URL_OK, 'freebsd').command).toBe('xdg-open');
  });
});

describe('chatgptFailureNote', () => {
  const named = (name: string, code?: string) =>
    Object.assign(new Error('x'), { name, code });
  it('gives each plan failure words, and a sign-in action only where it helps', () => {
    const revoked = noteFor(named('ChatGPTPlanSessionRevokedError'));
    expect(revoked?.action).toEqual({
      label: 'Sign in again',
      href: CHATGPT_SETTINGS_HREF,
    });
    expect(noteFor(named('ChatGPTPlanWorkspaceError'))?.action).toBeDefined();
    expect(
      noteFor(named('ChatGPTPlanUsageLimitError'))?.action,
    ).toBeUndefined();
    expect(
      noteFor(named('ChatGPTPlanUsageUnavailableError'))?.action,
    ).toBeUndefined();
    expect(
      noteFor(
        named(
          'ChatGPTPlanError',
          'subscription_sharing_unsupported_capability',
        ),
      )?.code,
    ).toBe('chatgpt_unsupported');
    expect(noteFor(new Error('boom'))).toBeUndefined();
    expect(vi.isMockFunction(chatgptFailureNote)).toBe(false);
  });
});
