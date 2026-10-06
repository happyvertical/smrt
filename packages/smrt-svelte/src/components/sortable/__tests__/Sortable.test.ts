import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import Sortable from '../Sortable.svelte';
import type { SortableContainer, SortableItem } from '../types.js';

const containers: SortableContainer[] = [
  { id: 'top', label: 'Top level', fixed: true },
  { id: 'content', label: 'Content' },
  { id: 'people', label: 'People' },
  { id: 'ops', label: 'Operations' },
];

const items: SortableItem[] = [
  { id: 'home', containerId: 'top', label: 'Home' },
  { id: 'posts', containerId: 'content', label: 'Posts' },
  { id: 'pages', containerId: 'content', label: 'Pages' },
  { id: 'users', containerId: 'people', label: 'Users' },
];

const itemSnippet = createRawSnippet<
  [{ item: SortableItem; container: SortableContainer; index: number }]
>((context) => ({ render: () => `<span>${context().item.label}</span>` }));

function props(overrides: Record<string, unknown> = {}) {
  return {
    containers,
    items,
    label: 'Navigation',
    item: itemSnippet,
    ...overrides,
  };
}

function live() {
  return Array.from(document.querySelectorAll('[aria-live]'))
    .map((element) => element.textContent?.trim())
    .filter(Boolean)
    .join(' | ');
}

const handle = (name: string) => screen.getByRole('button', { name });

describe('Sortable', () => {
  it('reorders within a container from the keyboard, announcing each step', async () => {
    const onmove = vi.fn();
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    handle('Move Posts').focus();
    await user.keyboard(' ');
    expect(live()).toContain('Picked up Posts');
    expect(handle('Move Posts').getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(live()).toContain('Posts, position 2 of 2 in Content.');
    await user.keyboard('{Enter}');
    expect(onmove).toHaveBeenCalledTimes(1);
    expect(onmove.mock.calls[0][0]).toMatchObject({
      item: { id: 'posts' },
      source: { containerId: 'content', index: 0 },
      target: { containerId: 'content', index: 1 },
    });
    await vi.waitFor(() =>
      expect(live()).toContain('Moved Posts to Content, position 2 of 2.'),
    );
  });

  it('crosses into the adjacent container at either end of a list', async () => {
    const onmove = vi.fn();
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    handle('Move Pages').focus();
    await user.keyboard(' {ArrowDown}');
    expect(live()).toContain('Pages, position 1 of 2 in People.');
    await user.keyboard('{ArrowDown}');
    expect(live()).toContain('Pages, position 2 of 2 in People.');
    await user.keyboard('{ArrowDown}');
    expect(live()).toContain('Pages, position 1 of 1 in Operations.');
    await user.keyboard('{Escape}');
    handle('Move Posts').focus();
    await user.keyboard(' {ArrowUp}');
    expect(live()).toContain('Posts, position 2 of 2 in Top level.');
    await user.keyboard('{Enter}');
    expect(onmove.mock.calls[0][0]).toMatchObject({
      source: { containerId: 'content', index: 0 },
      target: { containerId: 'top', index: 1 },
    });
  });

  it('moves into an empty container', async () => {
    const onmove = vi.fn();
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    handle('Move Users').focus();
    await user.keyboard(' {ArrowDown}{Enter}');
    expect(onmove.mock.calls[0][0]).toMatchObject({
      target: { containerId: 'ops', index: 0 },
    });
    expect(screen.getByText('No items in Operations.')).toBeTruthy();
  });

  it('cancels with Escape and when focus leaves the handle', async () => {
    const onmove = vi.fn();
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    handle('Move Posts').focus();
    await user.keyboard(' {ArrowDown}{Escape}');
    expect(live()).toContain('Cancelled moving Posts.');
    expect(handle('Move Posts').getAttribute('aria-pressed')).toBe('false');
    await user.keyboard(' ');
    handle('Move Pages').focus();
    await vi.waitFor(() =>
      expect(handle('Move Posts').getAttribute('aria-pressed')).toBe('false'),
    );
    expect(onmove).not.toHaveBeenCalled();
  });

  it('skips a disabled container and announces it', async () => {
    const onmove = vi.fn();
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({
        onmove,
        containers: containers.map((c) =>
          c.id === 'people' ? { ...c, disabled: true } : c,
        ),
      }),
    });
    handle('Move Pages').focus();
    await user.keyboard(' {ArrowDown}');
    expect(live()).toContain('People is unavailable.');
    await user.keyboard('{Enter}');
    expect(onmove).not.toHaveBeenCalled();
  });

  it('does not reorder within the source container when that is disallowed', () => {
    const onmove = vi.fn();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove, allowSameContainerReorder: false }),
    });
    const source = handle('Move Posts');
    const sibling = handle('Move Pages').closest(
      '[data-smrt-sortable-item-id]',
    ) as HTMLElement;
    Object.defineProperty(sibling, 'getBoundingClientRect', {
      value: () => ({ top: 10, height: 20 }),
    });
    const original = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => sibling),
    });
    const base = { pointerId: 9, pointerType: 'mouse' };
    fireEvent.pointerDown(source, {
      ...base,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(source, { ...base, clientX: 0, clientY: 40 });
    fireEvent.pointerUp(source, { ...base, clientX: 0, clientY: 40 });
    expect(onmove).not.toHaveBeenCalled();
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: original,
    });
  });

  it('lets the keyboard leave a pinned container when same-container reordering is off', async () => {
    const onmove = vi.fn();
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove, allowSameContainerReorder: false }),
    });
    handle('Move Posts').focus();
    await user.keyboard(' {ArrowDown}');
    expect(live()).toContain('Posts, position 1 of 2 in People.');
    // Reordering inside the new container is free.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onmove.mock.calls[0][0]).toMatchObject({
      source: { containerId: 'content', index: 0 },
      target: { containerId: 'people', index: 1 },
    });
  });

  it('is read-only without onmove', async () => {
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, { props: props() });
    handle('Move Posts').focus();
    await user.keyboard(' ');
    expect(handle('Move Posts').getAttribute('aria-pressed')).toBe('false');
    expect(live()).toBe('');
  });

  it('restores and announces when persistence rejects, then allows the next move', async () => {
    const onmove = vi
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    handle('Move Posts').focus();
    await user.keyboard(' {ArrowDown}{Enter}');
    await vi.waitFor(() =>
      expect(live()).toContain('Could not move Posts. The list was restored.'),
    );
    await user.keyboard(' {ArrowDown}{Enter}');
    expect(onmove).toHaveBeenCalledTimes(2);
  });

  it('moves with pointer events after a drag threshold', () => {
    const onmove = vi.fn();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    const source = handle('Move Posts');
    const destination = handle('Move Users').closest(
      '[data-smrt-sortable-item-id]',
    ) as HTMLElement;
    Object.defineProperty(destination, 'getBoundingClientRect', {
      value: () => ({ top: 10, height: 20 }),
    });
    const original = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => destination),
    });
    const base = { pointerId: 3, pointerType: 'touch' };
    fireEvent.pointerDown(source, {
      ...base,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(source, { ...base, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(source, { ...base, clientX: 10, clientY: 10 });
    expect(onmove.mock.calls[0][0]).toMatchObject({
      source: { containerId: 'content', index: 0 },
      target: { containerId: 'people', index: 0 },
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: original,
    });
  });

  it('cancels a pointer drag released outside the list', () => {
    const onmove = vi.fn();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    const source = handle('Move Posts');
    const original = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => document.body),
    });
    const base = { pointerId: 4, pointerType: 'mouse' };
    fireEvent.pointerDown(source, {
      ...base,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(source, { ...base, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(source, { ...base, clientX: 20, clientY: 20 });
    expect(onmove).not.toHaveBeenCalled();
    expect(live()).toContain('Cancelled moving Posts.');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: original,
    });
  });

  it('moves with native drag and drop onto an item and onto a container', async () => {
    const onmove = vi.fn();
    render(Sortable<SortableItem, SortableContainer>, {
      props: props({ onmove }),
    });
    const dataTransfer = { setData: vi.fn() };
    fireEvent.dragStart(handle('Move Posts'), { dataTransfer });
    fireEvent.drop(
      handle('Move Users').closest('[data-smrt-sortable-item-id]') as Element,
      { clientY: 1 },
    );
    expect(onmove.mock.calls[0][0]).toMatchObject({
      target: { containerId: 'people', index: 1 },
    });
    await vi.waitFor(() => expect(live()).toContain('Moved Posts'));
    fireEvent.dragStart(handle('Move Pages'), { dataTransfer });
    fireEvent.drop(screen.getByRole('region', { name: 'Operations' }));
    expect(onmove.mock.calls[1][0]).toMatchObject({
      target: { containerId: 'ops', index: 0 },
    });
  });

  describe('reorderContainers', () => {
    it('gives only movable containers a handle and moves them with the keyboard', async () => {
      const oncontainermove = vi.fn();
      const user = userEvent.setup();
      render(Sortable<SortableItem, SortableContainer>, {
        props: props({ reorderContainers: true, oncontainermove }),
      });
      expect(
        screen.queryByRole('button', { name: 'Move Top level' }),
      ).toBeNull();
      handle('Move Content').focus();
      await user.keyboard(' ');
      expect(live()).toContain('Picked up Content');
      await user.keyboard('{ArrowDown}');
      expect(live()).toContain('Content, position 2 of 3 in Navigation.');
      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
      expect(oncontainermove.mock.calls[0][0]).toMatchObject({
        container: { id: 'content' },
        source: 0,
        target: 2,
      });
    });

    it('moves a container with pointer events', () => {
      const oncontainermove = vi.fn();
      render(Sortable<SortableItem, SortableContainer>, {
        props: props({ reorderContainers: true, oncontainermove }),
      });
      const source = handle('Move Content');
      const destination = screen.getByRole('region', { name: 'Operations' });
      Object.defineProperty(destination, 'getBoundingClientRect', {
        value: () => ({ top: 10, height: 20 }),
      });
      const original = document.elementFromPoint;
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: vi.fn(() => destination),
      });
      const base = { pointerId: 5, pointerType: 'mouse' };
      fireEvent.pointerDown(source, {
        ...base,
        button: 0,
        clientX: 0,
        clientY: 0,
      });
      fireEvent.pointerMove(source, { ...base, clientX: 0, clientY: 30 });
      fireEvent.pointerUp(source, { ...base, clientX: 0, clientY: 30 });
      expect(oncontainermove.mock.calls[0][0]).toMatchObject({
        container: { id: 'content' },
        source: 0,
        target: 2,
      });
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: original,
      });
    });

    it('does not offer container handles when reordering is off', () => {
      render(Sortable<SortableItem, SortableContainer>, { props: props() });
      expect(screen.queryByRole('button', { name: 'Move Content' })).toBeNull();
    });
  });

  it('is axe-clean', async () => {
    const { container } = render(Sortable<SortableItem, SortableContainer>, {
      props: props({
        onmove: vi.fn(),
        reorderContainers: true,
        oncontainermove: vi.fn(),
      }),
    });
    await expectNoA11yViolations(container);
  });
});
