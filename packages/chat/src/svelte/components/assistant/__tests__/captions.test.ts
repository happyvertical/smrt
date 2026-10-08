// @vitest-environment jsdom
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HeardCaptions from '../captions/HeardCaptions.svelte';
import SpokenCaptions from '../captions/SpokenCaptions.svelte';

const lines = [
  {
    id: 'one',
    text: '<b>Plain words</b>',
    speaker: 'heard' as const,
    createdAt: 1,
  },
  { id: 'two', text: 'Latest phrase', speaker: 'heard' as const, createdAt: 2 },
];

describe('caption components', () => {
  // jsdom has no layout observer; real sizing and cleanup are covered in Chrome.
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [HeardCaptions, 'Vous avez dit'],
    [SpokenCaptions, 'Assistant parle'],
  ] as const)('uses the host-localized speaker label for visible and accessible names', (component, speakerLabel) => {
    render(component, { props: { enabled: true, lines, speakerLabel } });
    const region = screen.getByRole('region', { name: speakerLabel });
    expect(region.querySelector('.speaker')).toHaveTextContent(speakerLabel);
  });

  it('keeps heard captions hidden until independently enabled, bounds visible lines, and escapes text', () => {
    const { rerender } = render(HeardCaptions, {
      props: { lines, interim: 'still talking' },
    });
    expect(screen.queryByLabelText('You said')).toBeNull();
    rerender({ enabled: true, lines, interim: 'still talking', maxLines: 2 });
    expect(screen.getByLabelText('You said')).toBeInTheDocument();
    expect(screen.queryByText('Plain words')).toBeNull();
    expect(screen.getByText('<b>Plain words</b>')).toBeInTheDocument();
    expect(screen.getByText('still talking')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('keeps assistant speech quiet to assistive technology unless announcement is explicitly enabled', () => {
    const { rerender } = render(SpokenCaptions, {
      props: {
        enabled: true,
        lines: [{ ...lines[1], speaker: 'spoken' as const }],
      },
    });
    const region = screen.getByLabelText('Assistant is speaking');
    expect(region.querySelector('.caption-lines')).toHaveAttribute(
      'aria-live',
      'off',
    );
    rerender({
      enabled: true,
      announce: true,
      lines: [{ ...lines[1], speaker: 'spoken' as const }],
    });
    expect(region.querySelector('.caption-lines')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });
});
