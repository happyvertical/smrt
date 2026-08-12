// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  fireEvent,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ProjectBoard from '../../ProjectBoard.svelte';

const statuses = [
  { id: 'todo', name: 'Todo', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];

const items = [
  {
    id: 'item-1',
    contentId: 'content-1',
    title: 'Publish release notes',
    status: 'Todo',
    fields: {},
    type: 'Issue' as const,
  },
  {
    id: 'item-2',
    contentId: 'content-2',
    title: 'Stale provider status',
    status: 'Provider-only',
    fields: {},
    type: 'DraftIssue' as const,
  },
];

const sameStatusItems = [
  items[0],
  {
    id: 'item-3',
    contentId: 'content-3',
    title: 'Review release notes',
    status: 'Todo',
    fields: {},
    type: 'Issue' as const,
  },
];

describe('ProjectBoard', () => {
  it('does not persist same-status keyboard or pointer reordering', async () => {
    const onmove = vi.fn().mockResolvedValue(undefined);
    const onrefresh = vi.fn().mockResolvedValue(undefined);
    render(ProjectBoard, {
      props: {
        projectId: 'project-1',
        statuses,
        items: sameStatusItems,
        onmove,
        onrefresh,
      },
    });

    const first = screen.getByRole('button', {
      name: /Publish release notes/,
    });
    const second = screen.getByRole('button', {
      name: /Review release notes/,
    });
    first.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(' ');
    fireEvent.dragStart(first, { dataTransfer: { setData: vi.fn() } });
    fireEvent.drop(second, { clientY: 999 });

    expect(onmove).not.toHaveBeenCalled();
    expect(onrefresh).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Moved Publish release notes to Todo/i),
    ).not.toBeInTheDocument();
  });

  it('stays read-only when a browser move callback has no authoritative refresh', async () => {
    const onmove = vi.fn();
    render(ProjectBoard, {
      // Runtime callers can bypass the public discriminated callback contract.
      // The adapter must still avoid a move that cannot reconcile its cards.
      props: {
        projectId: 'project-1',
        statuses,
        items: [items[0]],
        onmove,
      } as never,
    });

    const card = screen.getByRole('button', {
      name: /Publish release notes/,
    });
    await userEvent.click(card);
    card.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard(' ');
    expect(onmove).not.toHaveBeenCalled();
  });

  it('preserves supplied status order, keeps unmatched items visible, and sends a pure move intent', async () => {
    const onmove = vi.fn().mockResolvedValue(undefined);
    const onrefresh = vi.fn().mockResolvedValue(undefined);
    const onselect = vi.fn();
    const { container } = render(ProjectBoard, {
      props: {
        projectId: 'project-1',
        statuses,
        items,
        onmove,
        onrefresh,
        onselect,
      },
    });

    const lanes = Array.from(
      container.querySelectorAll<HTMLElement>('.smrt-board__lane'),
    );
    expect(lanes.map((lane) => lane.getAttribute('aria-label'))).toEqual([
      'Todo, 1 cards',
      'Done, 0 cards',
      'Unassigned, 1 cards',
    ]);
    expect(screen.getByText('Stale provider status')).toBeVisible();

    const card = screen.getByRole('button', {
      name: /Publish release notes/,
    });
    await userEvent.click(card);
    expect(onselect).toHaveBeenCalledWith(items[0]);

    card.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard(' ');
    await vi.waitFor(() => {
      expect(onmove).toHaveBeenCalledWith({
        projectId: 'project-1',
        itemId: 'item-1',
        status: 'Done',
      });
      expect(onrefresh).toHaveBeenCalledTimes(1);
    });
    await expectNoA11yViolations(container);
  });

  it('refreshes authoritative state and lets Board make one sanitized failure announcement', async () => {
    const onmove = vi
      .fn()
      .mockRejectedValue(new Error('provider token detail'));
    const onrefresh = vi.fn().mockResolvedValue(undefined);
    render(ProjectBoard, {
      props: {
        projectId: 'project-1',
        statuses,
        items: [items[0]],
        onmove,
        onrefresh,
      },
    });

    const card = screen.getByRole('button', {
      name: /Publish release notes/,
    });
    card.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard(' ');

    await vi.waitFor(() => {
      expect(onrefresh).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText(
          'Could not move Publish release notes. The board was restored.',
        ),
      ).toBeVisible();
      expect(
        screen.getAllByText(
          'Could not move Publish release notes. The board was restored.',
        ),
      ).toHaveLength(1);
    });
  });
});
