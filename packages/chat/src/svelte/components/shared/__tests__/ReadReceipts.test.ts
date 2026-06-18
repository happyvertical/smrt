// @vitest-environment jsdom
/**
 * Component coverage for ReadReceipts via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import ReadReceipts from '../ReadReceipts.svelte';

describe('ReadReceipts', () => {
  it('summarises how many participants have read', () => {
    render(ReadReceipts, {
      props: {
        readBy: [{ name: 'Ada' }, { name: 'Bob' }],
        totalParticipants: 3,
      },
    });
    expect(screen.getByLabelText('2 of 3 read')).toBeInTheDocument();
  });

  it('renders the sent (unread) state with no readers', () => {
    render(ReadReceipts, { props: { readBy: [], totalParticipants: 3 } });
    expect(screen.getByLabelText('0 of 3 read')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(ReadReceipts, {
      props: { readBy: [{ name: 'Ada' }], totalParticipants: 2 },
    });
    await expectNoA11yViolations(container);
  });
});
