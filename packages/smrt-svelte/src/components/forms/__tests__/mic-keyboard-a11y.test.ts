/**
 * Regression: per-field voice mics are keyboard-operable (C1, WCAG 2.1.1).
 *
 * Before the fix the mic <button>s were bound only to mousedown/up + touch
 * handlers (onclick was a no-op preventDefault), so a keyboard user could focus
 * the mic but never record. The fix adds Enter/Space toggle activation, mirror-
 * ing FormMicButton. TextInput is the representative editable field;
 * DateTimeInput is covered too because its SMRT-mode text input is read-only —
 * the mic is the ONLY keyboard entry path there.
 *
 * useAppState/useSTT throw outside a <Provider>, so both are mocked. The STT
 * stub starts `isReady: true` so the hold flow skips initialize() and the
 * start()/stop() spies fire synchronously enough to assert.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sttStub = {
  isListening: false,
  isInitializing: false,
  isReady: true,
  adapterType: 'whisper-wasm',
  downloadProgress: 0,
  lastResult: '',
  initialize: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
};

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'smrt' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => sttStub,
}));

import DateTimeInput from '../DateTimeInput.svelte';
import TextInput from '../TextInput.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  sttStub.adapterType = 'whisper-wasm';
});

describe('TextInput mic — keyboard activation (C1)', () => {
  it('exposes the mic as a focusable button with an accessible name', () => {
    render(TextInput, { props: { name: 'note', label: 'Note' } });
    const mic = screen.getByRole('button', { name: /speak|mic|voice/i });
    expect(mic).toBeInTheDocument();
    // Native <button> => in the tab order (not an empty/dead tab stop).
    expect(mic).not.toHaveAttribute('tabindex', '-1');
  });

  it('starts recording on Enter and stops on the next Enter (toggle)', async () => {
    render(TextInput, { props: { name: 'note', label: 'Note' } });
    const mic = screen.getByRole('button', { name: /speak|mic|voice/i });

    mic.focus();
    await userEvent.keyboard('{Enter}');
    expect(sttStub.start).toHaveBeenCalledTimes(1);

    await userEvent.keyboard('{Enter}');
    expect(sttStub.stop).toHaveBeenCalledTimes(1);
  });

  it('starts recording on Space', async () => {
    render(TextInput, { props: { name: 'note', label: 'Note' } });
    const mic = screen.getByRole('button', { name: /speak|mic|voice/i });

    mic.focus();
    await userEvent.keyboard(' ');
    expect(sttStub.start).toHaveBeenCalledTimes(1);
  });
});

describe('DateTimeInput mic — keyboard activation (C1)', () => {
  it('records via keyboard even though the text field is read-only', async () => {
    render(DateTimeInput, { props: { name: 'when', label: 'When' } });
    const mic = screen.getByRole('button', { name: /speak|mic|voice|date/i });

    mic.focus();
    await userEvent.keyboard('{Enter}');
    expect(sttStub.start).toHaveBeenCalledTimes(1);
  });
});
