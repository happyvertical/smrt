import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sttStub = {
  isListening: false,
  isInitializing: false,
  isReady: true,
  adapterType: 'browser-speech' as string | null,
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

import FormExtractionValues from './form-extraction-values.fixture.svelte';

describe('Form voice extraction', () => {
  beforeEach(() => {
    sttStub.lastResult = '';
    sttStub.start.mockClear();
    sttStub.stop.mockClear();
  });

  it('skips an invalid earlier field and applies a later valid field', async () => {
    const ageChanged = vi.fn();
    const textChanged = vi.fn();
    render(FormExtractionValues, {
      props: { onagechange: ageChanged, ontextchange: textChanged },
    });

    const listen = screen.getByRole('button', { name: 'Speak all fields' });
    await userEvent.click(listen);
    sttStub.lastResult = 'age nonsense full name Ada Lovelace';
    await userEvent.click(listen);

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue(
        'Ada Lovelace',
      ),
    );
    expect(ageChanged).not.toHaveBeenCalled();
    expect(textChanged).toHaveBeenLastCalledWith('Ada Lovelace');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('staged_value_invalid')).not.toBeInTheDocument();
  });
});
