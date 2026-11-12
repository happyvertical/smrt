import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectAiClient } from '../../connect-ai/types.js';
import FirstRunOnboarding from '../FirstRunOnboarding.svelte';
import type { OnboardingClient, OnboardingState } from '../types.js';

function fixture(
  step: OnboardingState['step'] = 'welcome',
  configured = false,
) {
  let state: OnboardingState = {
    step,
    completed: step === 'done',
    rerunning: false,
    selected: null,
    approvalId: null,
    revision: 'r1',
    preview: null,
    approval: null,
    templates: [
      { id: 'fresh', name: 'Fresh', description: '', lists: [], missing: [] },
      {
        id: 'yoga-studio',
        name: 'Yoga Studio',
        description: 'Classes and members',
        lists: ['Members'],
        missing: [],
      },
    ],
  };
  const api: OnboardingClient = {
    state: vi.fn(async () => state),
    change: vi.fn(async (action) => {
      if (action.action === 'welcome') state = { ...state, step: 'ai' };
      if (['skip', 'continue', 'restart'].includes(action.action))
        state = { ...state, step: 'template' };
      if (action.action === 'preview')
        state = {
          ...state,
          selected: action.id,
          preview: {
            id: action.id,
            previewToken: 'p',
            revision: 0,
            before: [],
            after: ['Members'],
          },
        };
      if (action.action === 'apply')
        state = { ...state, step: 'done', completed: true };
      return state;
    }),
  };
  const connectAi: ConnectAiClient = {
    state: vi.fn(async () => ({
      engine: configured ? 'codex' : null,
      configured,
      apiReady: false,
      chatgpt: { signedIn: false, signingIn: false },
      tools: [
        {
          tool: 'codex',
          installed: true,
          signedIn: true,
          ready: true,
          login: 'idle',
          installUrl: 'https://developers.openai.com/codex/cli',
        },
      ],
    })),
    connect: vi.fn(),
    choose: vi.fn(),
    startChatGPT: vi.fn(),
    signOutChatGPT: vi.fn(),
  };
  const oncomplete = vi.fn();
  const props = {
    client: api,
    connectAi,
    approvalTransport: { sendMessage: vi.fn() },
    initialState: state,
    appName: 'Test app',
    description: 'An app that is yours.',
    apiKeyHref: '/settings/inference',
    oncomplete,
  };
  return { api, props, oncomplete };
}
describe('FirstRunOnboarding', () => {
  it('walks welcome, skippable engine first, preview and completion using keyboard and resolved labels', async () => {
    const f = fixture();
    const user = userEvent.setup();
    const { container } = render(FirstRunOnboarding, { props: f.props });
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
    expect(screen.queryByRole('link', { name: 'Back to Settings' })).toBeNull();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Connect AI' }),
    ).toHaveFocus();
    expect(screen.getAllByRole('heading', { name: 'Connect AI' })).toHaveLength(
      1,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '2',
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(
      await screen.findByRole('button', { name: /Use my Codex/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Start from' }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Preview Yoga Studio' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Review your changes' }),
    ).toHaveTextContent('Members');
    expect(
      screen.getByRole('heading', { name: 'Review your changes' }),
    ).toHaveFocus();
    expect(screen.queryByText('Profile')).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole('button', { name: 'Use this template' }));
    await waitFor(() => expect(f.oncomplete).toHaveBeenCalledOnce());
  });
  it('moves focus from review to the pending owner decision without claiming success', async () => {
    const f = fixture('template');
    const user = userEvent.setup();
    render(FirstRunOnboarding, { props: f.props });
    await user.click(
      screen.getByRole('button', { name: 'Preview Yoga Studio' }),
    );
    vi.mocked(f.api.change).mockResolvedValueOnce({
      ...f.props.initialState,
      step: 'template',
      selected: 'yoga-studio',
      approvalId: 'hold',
      approval: {
        id: 'hold',
        callId: 'call',
        tool: 'cookbook.apply',
        summary: 'Use Yoga Studio.',
        status: 'pending',
      },
      preview: null,
    });
    await user.click(screen.getByRole('button', { name: 'Use this template' }));
    expect(
      await screen.findByRole('region', {
        name: 'Confirm the owner approval below to apply these changes.',
      }),
    ).toHaveFocus();
    expect(screen.queryByText(/set up\./)).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to Settings' }),
    ).toBeInTheDocument();
    expect(f.oncomplete).not.toHaveBeenCalled();
  });
  it('resumes on the AI step with a detected ready CLI', async () => {
    const f = fixture('ai', true);
    render(FirstRunOnboarding, { props: f.props });
    expect(
      await screen.findByRole('button', { name: 'Continue' }),
    ).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Get started' }),
    ).not.toBeInTheDocument();
  });
  it('keeps a failed preview on the template step and retries without showing upstream errors', async () => {
    const f = fixture('template');
    const user = userEvent.setup();
    vi.mocked(f.api.change).mockRejectedValueOnce(new Error('secret'));
    render(FirstRunOnboarding, { props: f.props });
    await user.click(
      screen.getByRole('button', { name: 'Preview Yoga Studio' }),
    );
    expect(await screen.findByRole('alert')).not.toHaveTextContent('secret');
    await user.click(screen.getByRole('button', { name: 'Refresh and retry' }));
    await user.click(
      screen.getByRole('button', { name: 'Preview Yoga Studio' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Review your changes' }),
    ).toBeInTheDocument();
  });
  it('requires confirmation before rerunning from Settings', async () => {
    const f = fixture('done');
    const user = userEvent.setup();
    render(FirstRunOnboarding, { props: f.props });
    await user.click(
      screen.getByRole('button', { name: 'Start over from a template' }),
    );
    expect(f.api.change).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(f.api.change).toHaveBeenCalledWith(
        { action: 'restart' },
        'r1',
        expect.any(AbortSignal),
      ),
    );
  });
});

it('offers Settings when revisiting a completed installation', () => {
  const f = fixture();
  f.props.initialState = {
    ...f.props.initialState,
    completed: true,
    rerunning: true,
  };
  render(FirstRunOnboarding, { props: f.props });
  expect(
    screen.getByRole('link', { name: 'Back to Settings' }),
  ).toHaveAttribute('href', '/settings');
});

it('keeps a host alternative inside the AI step card and removes it on other steps', async () => {
  const f = fixture('ai');
  const aiFooter = createRawSnippet(() => ({
    render: () =>
      '<a href="/settings#own-ai">Use with your own AI in Settings</a>',
  }));
  render(FirstRunOnboarding, { props: { ...f.props, aiFooter } });
  const alternative = await screen.findByRole('link', {
    name: 'Use with your own AI in Settings',
  });
  expect(alternative.closest('[data-smrt-component="Card"]')).toBeTruthy();
  expect(alternative.closest('main.onboarding')).toBeTruthy();
});
