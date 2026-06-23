/**
 * Regression: Form voice-listening init failures don't wedge the form (C2/C3).
 *
 * `startFormListening` awaited `stt.initialize()`/`stt.start()` with no
 * try/catch. On rejection the listening flags stayed set, the auto-stop $effect
 * (gated on !isStarting) was suppressed, and the form was stuck in a permanent
 * "listening" state with no surfaced error. The fix wraps the flow in
 * try/catch/finally: reset the flags and show the error.
 */
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

const sttStub = {
  isListening: false,
  isInitializing: false,
  isReady: false,
  adapterType: null as string | null,
  downloadProgress: 0,
  lastResult: '',
  initialize: vi.fn(async () => {
    throw new Error('model download failed');
  }),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
};

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'smrt' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => sttStub,
}));

import Form from '../Form.svelte';

function child() {
  return createRawSnippet(() => ({
    render: () => '<span>fields</span>',
  }));
}

describe('Form — voice-listening init failure (C2)', () => {
  it('surfaces an error and does not wedge when STT init rejects', async () => {
    render(Form, {
      props: { children: child(), showFormListen: true },
    });

    // The form-listen button is shown in smrt mode; clicking it starts listening.
    const listenBtn = screen.getByRole('button');
    await userEvent.click(listenBtn);

    // initialize() rejected — an error must be surfaced (role=alert region).
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /model download failed/i,
    );

    // And the form is NOT wedged: the polite status region is not stuck on the
    // "listening" message (listening flag was reset).
    const status = screen.getByRole('status');
    expect(status.textContent?.trim()).toBe('');
  });
});
