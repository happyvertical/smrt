import { describe, expect, it } from 'vitest';
import {
  engineReady,
  needsWelcome,
  type OnboardingInfo,
  type ToolInfo,
  toolAction,
} from './onboarding-client.ts';

const tool = (over: Partial<ToolInfo> = {}): ToolInfo => ({
  tool: 'claude-code',
  label: 'Claude Code',
  installed: true,
  signedIn: true,
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
