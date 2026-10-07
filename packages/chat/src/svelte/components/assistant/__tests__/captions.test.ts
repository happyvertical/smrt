// @vitest-environment jsdom
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
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
  it('keeps heard captions hidden until independently enabled, bounds visible lines, and escapes text', () => {
    const { rerender } = render(HeardCaptions, {
      props: { lines, interim: 'still talking' },
    });
    expect(screen.queryByLabelText('What you said')).toBeNull();
    rerender({ enabled: true, lines, interim: 'still talking', maxLines: 1 });
    expect(screen.getByLabelText('What you said')).toBeInTheDocument();
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
    const region = screen.getByLabelText('Assistant speech');
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
