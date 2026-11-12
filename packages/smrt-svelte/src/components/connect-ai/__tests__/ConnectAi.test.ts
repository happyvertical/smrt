import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConnectAi from '../ConnectAi.svelte';
import type { ConnectAiClient, ConnectAiState } from '../types.js';

function state(): ConnectAiState {
  return {
    engine: null,
    configured: false,
    apiReady: false,
    chatgpt: { signedIn: false, signingIn: false },
    tools: [
      {
        tool: 'claude-code',
        installed: false,
        signedIn: false,
        login: 'idle',
        installUrl: 'https://code.claude.com/docs/en/setup',
      },
      {
        tool: 'codex',
        installed: false,
        signedIn: false,
        login: 'idle',
        installUrl: 'https://developers.openai.com/codex/cli',
      },
    ],
  };
}
function client(info: ConnectAiState): ConnectAiClient {
  return {
    state: vi.fn(async () => info),
    connect: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    startChatGPT: vi.fn(async () => ({})),
    signOutChatGPT: vi.fn(async () => {}),
  };
}
describe.each([
  undefined,
  'compact',
] as const)('startup readiness in %s presentation', (presentation) => {
  it('does not trust a configured snapshot without a successful per-engine preflight', async () => {
    const info = state();
    info.engine = 'claude-code';
    info.configured = true;
    Object.assign(info.tools[0], { installed: true, signedIn: true });
    const onchange = vi.fn();
    render(ConnectAi, {
      client: client(info),
      presentation,
      apiKeyHref: '/settings',
      initialState: info,
      onchange,
    });
    expect(
      await screen.findByText('Installed, but not usable in this app.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('In use')).toBeNull();
    expect(screen.queryByText('The assistant is ready.')).toBeNull();
    expect(
      await screen.findByRole('button', { name: 'Check again' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(onchange).toHaveBeenLastCalledWith(info, false));
  });
  it.each([
    'working_directory',
    'runtime_unavailable',
    'cli_invocation',
    'tool_host_policy',
  ] as const)('does not claim readiness when startup preflight fails: %s', async (startError) => {
    const info = state();
    info.engine = 'claude-code';
    Object.assign(info.tools[0], {
      installed: true,
      signedIn: true,
      ready: false,
      startError,
    });
    const onchange = vi.fn();
    const { container } = render(ConnectAi, {
      client: client(info),
      presentation,
      apiKeyHref: '/settings/inference',
      initialState: info,
      onchange,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /temporary directory|Node installation|secure options|app tool host/,
    );
    expect(screen.queryByText('The assistant is ready.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(screen.queryByText('In use')).toBeNull();
    await expectNoA11yViolations(container);
  });
});

afterEach(() => vi.restoreAllMocks());

describe.each([
  'onboarding',
  'settings',
] as const)('Connect AI %s', (variant) => {
  it('offers vendor installs, ChatGPT and the existing API-key settings; accessible with legal notes', async () => {
    const info = state();
    const api = client(info);
    const { container } = render(ConnectAi, {
      props: { client: api, apiKeyHref: '/settings/inference', variant },
    });
    expect(
      await screen.findByRole('link', { name: /How to install Claude Code/ }),
    ).toHaveAttribute('href', info.tools[0].installUrl);
    expect(
      screen.getByRole('link', { name: /How to install Codex/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Save an API key' }),
    ).toHaveAttribute('href', '/settings/inference');
    expect(
      screen.getByText(/In-app Claude subscription login is not offered/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Preview limitations apply/ }),
    ).toHaveAttribute('rel', 'noopener noreferrer');
    await expectNoA11yViolations(container);
  });
});

it('starts the installed CLI vendor login and polls, then lets the user select the signed-in engine', async () => {
  const user = userEvent.setup();
  const info = state();
  info.tools[1].installed = true;
  const api = client(info);
  const onchange = vi.fn();
  vi.mocked(api.connect).mockImplementation(async () => {
    info.tools[1].login = 'running';
  });
  render(ConnectAi, {
    props: { client: api, apiKeyHref: '/settings', pollMs: 250, onchange },
  });
  await user.click(
    await screen.findByRole('button', { name: 'Sign in with Codex' }),
  );
  expect(api.connect).toHaveBeenCalledWith('codex', expect.any(AbortSignal));
  expect(
    await screen.findByRole('button', { name: 'Waiting for sign-in…' }),
  ).toBeDisabled();
  info.tools[1].signedIn = true;
  info.tools[1].ready = true;
  info.tools[1].login = 'finished';
  // A refreshed status is a new server snapshot, not a mutated browser credential.
  vi.mocked(api.state).mockImplementation(async () => structuredClone(info));
  await user.click(await screen.findByRole('button', { name: 'Use my Codex' }));
  expect(api.connect).toHaveBeenCalledTimes(2);
  info.engine = 'codex';
  info.configured = true;
  window.dispatchEvent(new Event('focus'));
  await waitFor(() =>
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ engine: 'codex' }),
      true,
    ),
  );
  expect(await screen.findByText('In use')).toBeInTheDocument();
});

it('selects a saved API key without handling it in the component', async () => {
  const user = userEvent.setup();
  const info = state();
  info.apiReady = true;
  const api = client(info);
  render(ConnectAi, { props: { client: api, apiKeyHref: '/settings' } });
  await user.click(
    await screen.findByRole('button', { name: 'Use my API key' }),
  );
  expect(api.choose).toHaveBeenCalledWith('api', expect.any(AbortSignal));
  expect(screen.getByText('An API key is configured.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('starts ChatGPT, shows only its validated link, selects a signed-in account and signs out', async () => {
  const user = userEvent.setup();
  const info = state();
  const api = client(info);
  vi.mocked(api.startChatGPT).mockImplementation(async () => {
    info.chatgpt.signingIn = true;
    return { authorizationUrl: 'https://auth.openai.com/authorize?state=test' };
  });
  vi.mocked(api.state).mockImplementation(async () => structuredClone(info));
  render(ConnectAi, {
    props: { client: api, apiKeyHref: '/settings', pollMs: 250 },
  });
  await user.click(
    await screen.findByRole('button', { name: 'Sign in with ChatGPT' }),
  );
  expect(
    await screen.findByRole('link', { name: /Open the ChatGPT sign-in page/ }),
  ).toHaveAttribute('target', '_blank');
  info.chatgpt = { signedIn: true, signingIn: false };
  window.dispatchEvent(new Event('focus'));
  await user.click(
    await screen.findByRole('button', { name: 'Use my ChatGPT' }),
  );
  expect(api.choose).toHaveBeenCalledWith('chatgpt', expect.any(AbortSignal));
  await user.click(screen.getByRole('button', { name: 'Sign out of ChatGPT' }));
  expect(api.signOutChatGPT).toHaveBeenCalledOnce();
});

it('shows fixed errors and offers a retry without rendering upstream tokens', async () => {
  const api = client(state());
  vi.mocked(api.state).mockRejectedValueOnce(new Error('sk-never-display'));
  render(ConnectAi, { props: { client: api, apiKeyHref: '/settings' } });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not connect AI.',
  );
  expect(document.body.textContent).not.toContain('sk-never-display');
  await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('Nothing connected yet.')).toBeInTheDocument();
});

it('refuses a foreign ChatGPT link and aborts outstanding requests on unmount', async () => {
  const api = client(state());
  vi.mocked(api.startChatGPT).mockResolvedValue({
    authorizationUrl: 'https://evil.test/token',
  });
  const { unmount } = render(ConnectAi, {
    props: { client: api, apiKeyHref: '/settings' },
  });
  await userEvent.click(
    await screen.findByRole('button', { name: 'Sign in with ChatGPT' }),
  );
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(
    screen.queryByRole('link', { name: /Open the ChatGPT/ }),
  ).not.toBeInTheDocument();
  const signal = vi.mocked(api.state).mock.calls[0][0]!;
  unmount();
  expect(signal.aborted).toBe(true);
});

it('renders known sign-in failures and unknown CLI status using translated fixed text', async () => {
  const info = state();
  info.tools[1].installed = true;
  info.tools[1].signedIn = null;
  info.chatgpt.error = { code: 'timed_out' };
  render(ConnectAi, {
    props: { client: client(info), apiKeyHref: '/settings' },
  });
  expect(
    await screen.findByText('Installed, but it did not answer.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Sign-in did not finish.',
  );
  expect(
    screen.getByRole('button', { name: 'Check again' }),
  ).toBeInTheDocument();
});

it('waits for the initial status request before signing in, so a stale snapshot cannot hide polling', async () => {
  const info = state();
  const api = client(info);
  let resolveStatus!: (value: ConnectAiState) => void;
  vi.mocked(api.state).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveStatus = resolve;
    }),
  );
  vi.mocked(api.state).mockImplementation(async () => structuredClone(info));
  vi.mocked(api.startChatGPT).mockImplementation(async () => {
    info.chatgpt.signingIn = true;
    return {};
  });
  render(ConnectAi, {
    props: {
      client: api,
      initialState: info,
      apiKeyHref: '/settings',
      pollMs: 250,
    },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Sign in with ChatGPT' }),
  );
  expect(api.startChatGPT).not.toHaveBeenCalled();
  resolveStatus(structuredClone(info));
  await waitFor(() => expect(api.startChatGPT).toHaveBeenCalledOnce());
  expect(
    await screen.findByRole('button', { name: 'Waiting for sign-in…' }),
  ).toBeDisabled();
  const before = vi.mocked(api.state).mock.calls.length;
  await waitFor(() =>
    expect(vi.mocked(api.state).mock.calls.length).toBeGreaterThan(before),
  );
});

it('compact hosts offer Codex after ChatGPT and retain and the optional ChatGPT model preference', async () => {
  const info = state();
  info.chatgpt = {
    signedIn: true,
    signingIn: false,
    account: { label: 'owner@example.test' },
  };
  info.engine = 'chatgpt';
  info.configured = true;
  const api = client(info);
  api.modelState = vi.fn(async () => ({
    model: null,
    models: [{ id: 'test-model', label: 'Test model' }],
  }));
  api.chooseModel = vi.fn(async () => {});
  const user = userEvent.setup();
  const { container } = render(ConnectAi, {
    props: {
      client: api,
      apiKeyHref: '/settings/inference',
      variant: 'settings',
      presentation: 'compact',
    },
  });
  expect(
    await screen.findByText('Signed in as owner@example.test.'),
  ).toBeInTheDocument();
  expect(container.querySelector('details')).toBeNull();
  expect(container.textContent).toContain('Codex');
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await user.selectOptions(select, 'test-model');
  expect(api.chooseModel).toHaveBeenCalledExactlyOnceWith(
    'test-model',
    expect.any(AbortSignal),
  );
  expect(await screen.findByText('Model saved.')).toBeInTheDocument();
});

it('compact hosts select a CLI after the vendor login finishes, including immediate completion', async () => {
  const info = state();
  info.tools[0].installed = true;
  const api = client(info);
  vi.mocked(api.state).mockImplementation(async () => structuredClone(info));
  vi.mocked(api.connect).mockImplementation(async () => {
    info.tools[0].signedIn = true;
    info.tools[0].ready = true;
    info.tools[0].login = 'finished';
    if (vi.mocked(api.connect).mock.calls.length === 2) {
      info.engine = 'claude-code';
      info.configured = true;
    }
  });
  render(ConnectAi, {
    props: { client: api, apiKeyHref: '/settings', presentation: 'compact' },
  });
  await userEvent.click(
    await screen.findByRole('button', { name: 'Sign in with Claude Code' }),
  );
  expect(await screen.findByText('In use')).toBeInTheDocument();
  expect(api.connect).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Codex')).toBeInTheDocument();
});

it('compact hosts project their established safe errors without exposing the upstream exception', async () => {
  const info = state();
  info.tools[0].installed = true;
  const api = client(info);
  vi.mocked(api.connect).mockRejectedValue(new Error('private upstream text'));
  api.errorMessage = vi.fn(() => 'Claude Code did not answer. Try again.');
  render(ConnectAi, {
    props: { client: api, apiKeyHref: '/settings', presentation: 'compact' },
  });
  await userEvent.click(
    await screen.findByRole('button', { name: 'Sign in with Claude Code' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Claude Code did not answer. Try again.',
  );
  expect(screen.queryByText('private upstream text')).toBeNull();
});

it('compact hosts preserve the missing-tool outcome when a CLI disappears after status', async () => {
  const info = state();
  info.tools[0].installed = true;
  const api = client(info);
  api.connectOutcome = vi.fn(async () => ({ result: 'missing' as const }));
  render(ConnectAi, {
    props: { client: api, apiKeyHref: '/settings', presentation: 'compact' },
  });
  await userEvent.click(
    await screen.findByRole('button', { name: 'Sign in with Claude Code' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Claude Code is not installed.',
  );
  expect(api.connect).not.toHaveBeenCalled();
});

it.each([
  undefined,
  'compact',
] as const)('orders the OpenAI plan before the CLI alternative in %s presentation', async (presentation) => {
  const info = state();
  const { container } = render(ConnectAi, {
    props: { client: client(info), apiKeyHref: '/settings', presentation },
  });
  await screen.findByText('ChatGPT');
  const rows = [...container.querySelectorAll('li')].map(
    (row) => row.textContent ?? '',
  );
  expect(rows.findIndex((row) => row.includes('Claude Code'))).toBeLessThan(
    rows.findIndex((row) => row.includes('ChatGPT')),
  );
  expect(rows.findIndex((row) => row.includes('ChatGPT'))).toBeLessThan(
    rows.findIndex((row) => row.includes('Codex')),
  );
  expect(container.textContent).toContain(
    'Recommended for using your OpenAI plan',
  );
  expect(container.textContent).toContain(
    'An alternative if you already use the Codex CLI.',
  );
});
