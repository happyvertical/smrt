// @vitest-environment jsdom
/**
 * Component-level coverage for AssistantThreadList (#2904 review, cycle-3
 * second final F2 — none of the three new assistant components carried an
 * axe assertion; this one had no test file at all).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantThreadList from '../AssistantThreadList.svelte';
import type { AssistantThreadSummary } from '../assistant-transport.js';

const threads: AssistantThreadSummary[] = [
  { id: 't1', title: 'Order question', isResolved: false, messageCount: 3 },
  { id: 't2', title: '', isResolved: false, messageCount: 0 },
];

describe('AssistantThreadList', () => {
  it('renders each thread and fires onselect with its id', async () => {
    const onselect = vi.fn();
    render(AssistantThreadList, {
      props: { threads, activeThreadId: 't1', onselect },
    });

    expect(screen.getByText('Order question')).toBeInTheDocument();
    // Untitled fallback for a thread with an empty title.
    expect(screen.getByText('Untitled')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Untitled'));
    expect(onselect).toHaveBeenCalledWith('t2');
  });

  it('renders a "New conversation" row and fires oncreate when supplied', async () => {
    const oncreate = vi.fn();
    render(AssistantThreadList, {
      props: { threads: [], onselect: vi.fn(), oncreate },
    });

    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    expect(oncreate).toHaveBeenCalledOnce();
  });

  it('is axe-clean', async () => {
    const { container } = render(AssistantThreadList, {
      props: {
        threads,
        activeThreadId: 't1',
        onselect: vi.fn(),
        oncreate: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
