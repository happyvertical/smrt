import { describe, expect, it } from 'vitest';
import {
  apiRow,
  chatgptAction,
  chatgptDescription,
  engineReady,
  needsWelcome,
  type OnboardingInfo,
  type ToolInfo,
  toolAction,
  visibleTools,
} from './onboarding-client.ts';

const tool = (over: Partial<ToolInfo> = {}): ToolInfo => ({
  tool: 'claude-code',
  label: 'Claude Code',
  installed: true,
  signedIn: true,
  ready: true,
  installUrl: 'https://example.test/install',
  login: 'idle',
  ...over,
});
const info = (over: Partial<OnboardingInfo> = {}): OnboardingInfo => ({
  onboarding: null,
  engine: 'api',
  apiReady: false,
  tools: [tool(), tool({ tool: 'codex', label: 'Codex' })],
  ...over,
});

describe('toolAction', () => {
  it('gives each state one button with plain words', () => {
    const base = info();
    expect(toolAction(tool({ installed: false }), base)).toEqual({
      kind: 'install',
      label: 'How to install',
    });
    expect(toolAction(tool({ signedIn: false }), base)).toEqual({
      kind: 'sign-in',
      label: 'Sign in with Claude Code',
    });
    expect(
      toolAction(tool({ signedIn: false, login: 'running' }), base).kind,
    ).toBe('waiting');
    expect(toolAction(tool({ signedIn: null }), base).kind).toBe('retry');
    expect(toolAction(tool(), base)).toEqual({
      kind: 'use',
      label: 'Use Claude Code',
    });
    expect(toolAction(tool(), info({ engine: 'claude-code' })).kind).toBe(
      'in-use',
    );
  });
});

describe('engineReady', () => {
  it('follows the engine in effect', () => {
    expect(engineReady(info())).toBe(false);
    expect(engineReady(info({ apiReady: true }))).toBe(true);
    expect(engineReady(info({ engine: 'claude-code' }))).toBe(true);
    expect(
      engineReady(
        info({
          engine: 'codex',
          tools: [tool({ tool: 'codex', signedIn: false })],
        }),
      ),
    ).toBe(false);
  });
});

describe('apiRow', () => {
  it('claims "in use" only for an API key that resolves', () => {
    expect(apiRow(info())).toBe('none');
    expect(apiRow(info({ engine: 'api', apiReady: false }))).toBe('none');
    expect(apiRow(info({ engine: 'api', apiReady: true }))).toBe('in-use');
    expect(apiRow(info({ engine: 'codex', apiReady: true }))).toBe('available');
    expect(apiRow(info({ engine: 'codex', apiReady: false }))).toBe('none');
  });
});

describe('Sign in with ChatGPT on the welcome page', () => {
  const signedIn = { signedIn: true, signingIn: false };
  const signedOut = { signedIn: false, signingIn: false };

  it('offers one button per state, in plain words', () => {
    expect(chatgptAction(info())).toEqual({
      kind: 'sign-in',
      label: 'Sign in with ChatGPT',
    });
    expect(
      chatgptAction(info({ chatgpt: { signedIn: false, signingIn: true } })),
    ).toEqual({ kind: 'waiting', label: 'Waiting for sign-in…' });
    expect(chatgptAction(info({ chatgpt: signedIn }))).toEqual({
      kind: 'use',
      label: 'Use ChatGPT',
    });
    expect(
      chatgptAction(info({ chatgpt: signedIn, engine: 'chatgpt' })),
    ).toEqual({ kind: 'in-use', label: 'In use' });
  });

  it('says what happened without tokens: the account, the wait, or the failure', () => {
    expect(chatgptDescription(info())).toMatch(/preview for open source apps/);
    expect(
      chatgptDescription(
        info({
          chatgpt: { ...signedIn, account: { label: 'me@example.com' } },
        }),
      ),
    ).toBe('Signed in as me@example.com.');
    expect(
      chatgptDescription(
        info({ chatgpt: { signedIn: false, signingIn: true } }),
      ),
    ).toMatch(/Finish signing in/);
    expect(
      chatgptDescription(
        info({
          chatgpt: {
            ...signedOut,
            error: { code: 'declined', message: 'Sign-in was declined.' },
          },
        }),
      ),
    ).toBe('Sign-in was declined.');
  });

  it('the engine is ready only while signed in', () => {
    expect(engineReady(info({ engine: 'chatgpt', chatgpt: signedIn }))).toBe(
      true,
    );
    expect(engineReady(info({ engine: 'chatgpt', chatgpt: signedOut }))).toBe(
      false,
    );
    expect(engineReady(info({ engine: 'chatgpt' }))).toBe(false);
    // An API key does not make the ChatGPT engine ready.
    expect(
      engineReady(
        info({ engine: 'chatgpt', apiReady: true, chatgpt: signedOut }),
      ),
    ).toBe(false);
  });

  it('the API row stays truthful with the new engine', () => {
    expect(apiRow(info({ engine: 'chatgpt', chatgpt: signedIn }))).toBe('none');
    expect(
      apiRow(info({ engine: 'chatgpt', chatgpt: signedIn, apiReady: true })),
    ).toBe('available');
    expect(
      apiRow(info({ engine: 'chatgpt', chatgpt: signedOut, apiReady: true })),
    ).toBe('available');
    expect(apiRow(info({ engine: 'api', apiReady: true }))).toBe('in-use');
  });

  it('Codex leaves the welcome page and lives under Settings > Assistant', () => {
    const welcome = visibleTools(info(), 'welcome');
    expect(welcome.main.map((t) => t.tool)).toEqual(['claude-code']);
    expect(welcome.advanced).toEqual([]);
    const settings = visibleTools(info(), 'settings');
    expect(settings.main.map((t) => t.tool)).toEqual(['claude-code']);
    expect(settings.advanced.map((t) => t.tool)).toEqual(['codex']);
  });
});

describe('needsWelcome', () => {
  it('sends an owner with an empty app once, and nowhere it would trap them', () => {
    const base = { pathname: '/', modelCount: 0, onboarding: null } as const;
    expect(needsWelcome(base)).toBe(true);
    expect(needsWelcome({ ...base, onboarding: 'fresh' })).toBe(false);
    expect(needsWelcome({ ...base, onboarding: 'skipped' })).toBe(false);
    expect(needsWelcome({ ...base, modelCount: 2 })).toBe(false);
    for (const p of [
      '/welcome',
      '/settings',
      '/settings/inference',
      '/setup',
      '/approvals',
    ])
      expect(needsWelcome({ ...base, pathname: p })).toBe(false);
    expect(needsWelcome({ ...base, pathname: '/m/Chore' })).toBe(true);
  });
});
