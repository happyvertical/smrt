import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet, hydrate, unmount } from 'svelte';
import { createServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import Board from '../Board.svelte';
import type { BoardColumn } from '../types.js';
import BoardSsrHarness from './BoardSsrHarness.svelte';

interface SupportCard {
  id: string;
  subject: string;
  queue: string;
}

interface SalesCard {
  id: string;
  company: string;
  stage: string;
}

const columns: BoardColumn[] = [
  { id: 'new', label: 'New' },
  { id: 'assigned', label: 'Assigned' },
];

const initialCards: SupportCard[] = [
  { id: 'a', subject: 'Password reset', queue: 'new' },
  { id: 'b', subject: 'Billing question', queue: 'new' },
  { id: 'c', subject: 'Reply needed', queue: 'assigned' },
];

function cardSnippet() {
  return createRawSnippet<
    [
      {
        card: SupportCard;
        column: BoardColumn;
        index: number;
        isDragging: boolean;
      },
    ]
  >((context) => ({
    render: () => `<strong>${context().card.subject}</strong>`,
  }));
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    columns,
    defaultCards: initialCards,
    getCardColumnId: (card: SupportCard) => card.queue,
    setCardColumnId: (card: SupportCard, queue: string) => ({ ...card, queue }),
    getCardLabel: (card: SupportCard) => card.subject,
    card: cardSnippet(),
    label: 'Support queues',
    ...overrides,
  };
}

function lane(name: string) {
  return screen.getByRole('region', { name: new RegExp(name) });
}

describe('Board', () => {
  it('moves generic support cards in uncontrolled mode with a typed keyboard intent', async () => {
    const user = userEvent.setup();
    const onmove = vi.fn();
    const onselect = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({ onmove, onselect }),
    });

    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard(' ');

    expect(onmove).toHaveBeenCalledWith(
      expect.objectContaining({
        card: initialCards[0],
        source: { columnId: 'new', index: 0 },
        target: { columnId: 'assigned', index: 0 },
      }),
    );
    expect(
      within(lane('Assigned')).getByText('Password reset'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Moved Password reset to Assigned, position 1 of 2.'),
    ).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Password reset' }),
      ).toHaveFocus(),
    );
    expect(onselect).not.toHaveBeenCalled();
  });

  it('keeps controlled cards authoritative unless optimistic presentation is requested', async () => {
    const user = userEvent.setup();
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({ cards: initialCards, onmove }),
    });

    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');

    expect(onmove).toHaveBeenCalledOnce();
    expect(within(lane('New')).getByText('Password reset')).toBeInTheDocument();
    expect(
      within(lane('Assigned')).queryByText('Password reset'),
    ).not.toBeInTheDocument();
  });

  it('treats a controlled board without onmove as read-only', async () => {
    const user = userEvent.setup();
    const onselect = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({ cards: initialCards, onselect }),
    });
    const card = screen.getByRole('button', { name: 'Password reset' });
    expect(card).toHaveAttribute('draggable', 'false');
    expect(card).not.toHaveAttribute('aria-disabled');
    expect(card).not.toHaveClass('smrt-board__card--touch-drag');
    card.focus();
    await user.keyboard(' ');
    expect(
      screen.queryByText(/Picked up Password reset/),
    ).not.toBeInTheDocument();
    expect(onselect).toHaveBeenCalledWith(initialCards[0]);
  });

  it('updates precomputed lane cards when controlled cards change', async () => {
    const onmove = vi.fn();
    const { rerender } = render(Board<SupportCard, BoardColumn>, {
      props: props({ cards: initialCards, onmove }),
    });
    expect(lane('New')).toHaveAccessibleName('New, 2 cards');
    const updatedCards = [
      { ...initialCards[0], queue: 'assigned' },
      ...initialCards.slice(1),
    ];

    await rerender(props({ cards: updatedCards, onmove }));

    expect(lane('New')).toHaveAccessibleName('New, 1 cards');
    expect(lane('Assigned')).toHaveAccessibleName('Assigned, 2 cards');
    expect(
      within(lane('Assigned')).getByText('Password reset'),
    ).toBeInTheDocument();
  });

  it('can disable same-column reordering without suppressing cross-column moves', async () => {
    const user = userEvent.setup();
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({ allowSameColumnReorder: false, onmove }),
    });
    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onmove).not.toHaveBeenCalled();
    expect(screen.queryByText(/Moved Password reset/)).not.toBeInTheDocument();
    expect(within(lane('New')).getAllByRole('button')[0]).toHaveAccessibleName(
      'Password reset',
    );

    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    expect(onmove).toHaveBeenCalledWith(
      expect.objectContaining({ target: { columnId: 'assigned', index: 0 } }),
    );
  });

  it('does not emit a pointer same-column move when reordering is disabled', () => {
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({ allowSameColumnReorder: false, onmove }),
    });
    const card = screen.getByRole('button', { name: 'Password reset' });
    const sibling = screen.getByRole('button', { name: 'Billing question' });
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    fireEvent.drop(sibling, { clientY: 1 });

    expect(onmove).not.toHaveBeenCalled();
    expect(screen.queryByText(/Moved Password reset/)).not.toBeInTheDocument();
  });

  it('uses native pointer drag and drop to emit a move', () => {
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, { props: props({ onmove }) });
    const card = screen.getByRole('button', { name: 'Password reset' });
    const destination = screen.getByRole('button', { name: 'Reply needed' });
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    fireEvent.drop(destination, { clientY: 1 });

    expect(onmove).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { columnId: 'new', index: 0 },
        target: { columnId: 'assigned', index: 1 },
      }),
    );
  });

  it('moves a card with touch Pointer Events after a drag threshold', async () => {
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, { props: props({ onmove }) });
    const card = screen.getByRole('button', { name: 'Password reset' });
    const destination = screen.getByRole('button', { name: 'Reply needed' });
    Object.defineProperty(destination, 'getBoundingClientRect', {
      value: () => ({ top: 10, height: 20 }),
    });
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => destination),
    });

    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 7,
      pointerType: 'touch',
    });
    fireEvent.pointerMove(card, {
      clientX: 10,
      clientY: 10,
      pointerId: 7,
      pointerType: 'touch',
    });
    fireEvent.pointerUp(card, {
      clientX: 10,
      clientY: 10,
      pointerId: 7,
      pointerType: 'touch',
    });

    expect(onmove).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { columnId: 'new', index: 0 },
        target: { columnId: 'assigned', index: 0 },
      }),
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    });
  });

  it('moves a card with mouse Pointer Events after a drag threshold', () => {
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, { props: props({ onmove }) });
    const card = screen.getByRole('button', { name: 'Password reset' });
    const destination = screen.getByRole('button', { name: 'Reply needed' });
    Object.defineProperty(destination, 'getBoundingClientRect', {
      value: () => ({ top: 10, height: 20 }),
    });
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => destination),
    });

    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 9,
      pointerType: 'mouse',
    });
    fireEvent.pointerMove(card, {
      clientX: 10,
      clientY: 10,
      pointerId: 9,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(card, {
      clientX: 10,
      clientY: 10,
      pointerId: 9,
      pointerType: 'mouse',
    });

    expect(onmove).toHaveBeenCalledWith(
      expect.objectContaining({ target: { columnId: 'assigned', index: 0 } }),
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    });
  });

  it('cancels a mouse Pointer Event drag and restores card focus', async () => {
    render(Board<SupportCard, BoardColumn>, { props: props() });
    const card = screen.getByRole('button', { name: 'Password reset' });
    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 8,
      pointerType: 'mouse',
    });
    fireEvent.pointerMove(card, {
      clientX: 8,
      clientY: 0,
      pointerId: 8,
      pointerType: 'mouse',
    });
    fireEvent.pointerCancel(card, { pointerId: 8, pointerType: 'mouse' });

    expect(
      screen.getByText('Cancelled moving Password reset.'),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(card).toHaveFocus());
  });

  it('cancels a pointer drag that is hit-tested over another Board with shared column ids', async () => {
    const firstMove = vi.fn();
    const secondMove = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({ onmove: firstMove }),
    });
    render(Board<SupportCard, BoardColumn>, {
      props: props({ onmove: secondMove }),
    });
    const boards = screen.getAllByRole('region', { name: 'Support queues' });
    const firstCard = within(boards[0]).getByRole('button', {
      name: 'Password reset',
    });
    const secondDestination = within(boards[1]).getByRole('button', {
      name: 'Reply needed',
    });
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => secondDestination),
    });

    fireEvent.pointerDown(firstCard, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 10,
      pointerType: 'mouse',
    });
    fireEvent.pointerMove(firstCard, {
      clientX: 10,
      clientY: 0,
      pointerId: 10,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(firstCard, {
      clientX: 10,
      clientY: 0,
      pointerId: 10,
      pointerType: 'mouse',
    });

    expect(firstMove).not.toHaveBeenCalled();
    expect(secondMove).not.toHaveBeenCalled();
    expect(
      within(boards[0]).getByText('Cancelled moving Password reset.'),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(firstCard).toHaveFocus());
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    });
  });

  it('rejects a pointer drop into a disabled lane, announces it, and restores focus', async () => {
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({
        columns: [columns[0], { ...columns[1], disabled: true }],
        onmove,
      }),
    });
    const card = screen.getByRole('button', { name: 'Password reset' });
    const destination = screen.getByRole('button', { name: 'Reply needed' });
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    fireEvent.drop(destination, { clientY: 1 });

    expect(onmove).not.toHaveBeenCalled();
    expect(screen.getByText('Assigned is unavailable.')).toBeInTheDocument();
    await vi.waitFor(() => expect(card).toHaveFocus());
  });

  it('restores an optimistic controlled move when persistence rejects', async () => {
    const user = userEvent.setup();
    const onmove = vi.fn().mockRejectedValue(new Error('offline'));
    render(Board<SupportCard, BoardColumn>, {
      props: props({ cards: initialCards, optimistic: true, onmove }),
    });

    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    await vi.waitFor(() =>
      expect(
        screen.getByText(
          'Could not move Password reset. The board was restored.',
        ),
      ).toBeInTheDocument(),
    );

    expect(within(lane('New')).getByText('Password reset')).toBeInTheDocument();
    expect(
      within(lane('Assigned')).queryByText('Password reset'),
    ).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Password reset' }),
      ).toHaveFocus(),
    );
  });

  it('announces pickup, supports cancellation, collapse controls, and is axe-clean', async () => {
    const user = userEvent.setup();
    const { container } = render(Board<SupportCard, BoardColumn>, {
      props: props({ collapsible: true }),
    });
    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    expect(
      screen.getByText(
        /Picked up Password reset\. Available destinations: New, Assigned\./,
      ),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(
      screen.getByText('Cancelled moving Password reset.'),
    ).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: 'Collapse New' });
    await user.click(collapse);
    expect(collapse).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByRole('button', { name: 'Expand New' }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('expands a collapsed keyboard destination before committing so the moved card remains visible', async () => {
    const user = userEvent.setup();
    render(Board<SupportCard, BoardColumn>, {
      props: props({ collapsible: true }),
    });
    await user.click(screen.getByRole('button', { name: 'Collapse Assigned' }));
    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');

    expect(
      screen.getByRole('button', { name: 'Collapse Assigned' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(lane('Assigned')).getByText('Password reset'),
    ).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        within(lane('Assigned')).getByRole('button', {
          name: 'Password reset',
        }),
      ).toHaveFocus(),
    );
  });

  it('allows ordinary selection after a cancelled keyboard pickup', async () => {
    const user = userEvent.setup();
    const onselect = vi.fn();
    render(Board<SupportCard, BoardColumn>, { props: props({ onselect }) });
    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{Escape}');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await user.click(card);
    expect(onselect).toHaveBeenCalledWith(initialCards[0]);
  });

  it('skips disabled lanes and announces the unavailable destination', async () => {
    const user = userEvent.setup();
    render(Board<SupportCard, BoardColumn>, {
      props: props({
        columns: [columns[0], { ...columns[1], disabled: true }],
      }),
    });
    const card = screen.getByRole('button', { name: 'Password reset' });
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('Assigned is unavailable.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('allows a card to leave a disabled source lane', async () => {
    const user = userEvent.setup();
    const disabledSourceCards = [{ ...initialCards[0], queue: 'assigned' }];
    const onmove = vi.fn();
    render(Board<SupportCard, BoardColumn>, {
      props: props({
        columns: [{ ...columns[0] }, { ...columns[1], disabled: true }],
        defaultCards: disabledSourceCards,
        onmove,
      }),
    });
    const card = screen.getByRole('button', { name: 'Password reset' });
    expect(card).toHaveAttribute('draggable', 'true');
    card.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{Enter}');
    expect(onmove).toHaveBeenCalledWith(
      expect.objectContaining({ target: { columnId: 'new', index: 0 } }),
    );
  });

  it('serializes deferred move persistence and permits the next move only after the first settles', async () => {
    const user = userEvent.setup();
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const onmove = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    render(Board<SupportCard, BoardColumn>, { props: props({ onmove }) });

    const first = screen.getByRole('button', { name: 'Password reset' });
    first.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(onmove).toHaveBeenCalledTimes(1));

    const second = screen.getByRole('button', { name: 'Billing question' });
    second.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    expect(onmove).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.waitFor(() =>
      expect(
        within(lane('Assigned')).getByText('Password reset'),
      ).toBeInTheDocument(),
    );
    second.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(onmove).toHaveBeenCalledTimes(2));
    resolveSecond();
    await vi.waitFor(() =>
      expect(
        within(lane('Assigned')).getByText('Billing question'),
      ).toBeInTheDocument(),
    );
  });

  it('renders stable board structure on the server without domain imports', async () => {
    const vite = await createServer({
      appType: 'custom',
      configFile: false,
      plugins: [svelte()],
      root: process.cwd(),
      server: { middlewareMode: true },
    });
    const { default: SsrBoard } = await vite.ssrLoadModule(
      '/src/components/board/__tests__/BoardSsrHarness.svelte',
    );
    const { render: renderSsr } = await vite.ssrLoadModule('svelte/server');
    const result = renderSsr(SsrBoard);
    expect(result.body).toContain('Sales pipeline');
    expect(result.body).toContain('Acme');
    expect(result.body).toContain('lane-0');
    await vite.close();

    const host = document.createElement('div');
    host.innerHTML = result.body;
    document.body.append(host);
    const instance = hydrate(BoardSsrHarness, {
      target: host,
    });
    expect(
      within(host).getByRole('region', { name: 'Lead, 1 cards' }),
    ).toBeInTheDocument();
    expect(
      within(host).getByRole('button', { name: 'Acme' }),
    ).toBeInTheDocument();
    await unmount(instance);
    host.remove();
  });

  it('scopes live descriptions when board instances share card ids', async () => {
    const user = userEvent.setup();
    const { container } = render(Board<SupportCard, BoardColumn>, {
      props: props(),
    });
    render(Board<SupportCard, BoardColumn>, { props: props() });
    const boards = screen.getAllByRole('region', { name: 'Support queues' });
    expect(boards).toHaveLength(2);
    const firstCard = within(boards[0]).getByRole('button', {
      name: 'Password reset',
    });
    const secondCard = within(boards[1]).getByRole('button', {
      name: 'Password reset',
    });
    firstCard.focus();
    await user.keyboard(' ');
    const firstLiveId = firstCard.getAttribute('aria-describedby');
    await user.keyboard('{Escape}');
    secondCard.focus();
    await user.keyboard(' ');
    const secondLiveId = secondCard.getAttribute('aria-describedby');
    expect(firstLiveId).toBeTruthy();
    expect(secondLiveId).toBeTruthy();
    expect(firstLiveId).not.toBe(secondLiveId);
    expect(
      within(boards[0]).getByText('Cancelled moving Password reset.'),
    ).toHaveAttribute('id', firstLiveId);
    expect(
      within(boards[1]).getByText(/Picked up Password reset/),
    ).toHaveAttribute('id', secondLiveId);
  });
});
