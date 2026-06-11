/**
 * Golden tests for the L3 gap primitives — batch 1 (Avatar, Chip, Skeleton).
 * Render + interaction + a11y, per the L4 harness pattern (#1422 / #1423).
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Avatar from '../Avatar.svelte';
import Chip from '../Chip.svelte';
import Skeleton from '../Skeleton.svelte';

describe('Avatar', () => {
  it('shows initials + accessible name when no src', () => {
    render(Avatar, { props: { name: 'Ada Lovelace' } });
    const img = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(img).toHaveTextContent('AL');
  });

  it('renders an <img> with alt when src is set', () => {
    render(Avatar, { props: { name: 'Ada', src: 'https://x/a.png' } });
    expect(screen.getByRole('img', { name: 'Ada' }).tagName).toBe('IMG');
  });

  it('announces presence status', () => {
    render(Avatar, { props: { name: 'Ada', status: 'online' } });
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(Avatar, {
      props: { name: 'Ada Lovelace', status: 'away' },
    });
    await expectNoA11yViolations(container);
  });
});

describe('Chip', () => {
  it('renders its label', () => {
    render(Chip, { props: { label: 'TypeScript' } });
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
  });

  it('selectable: toggle button exposes aria-pressed and fires onselect', async () => {
    const onselect = vi.fn();
    render(Chip, {
      props: { label: 'Tag', selectable: true, selected: true, onselect },
    });
    const btn = screen.getByRole('button', { name: 'Tag', pressed: true });
    await userEvent.click(btn);
    expect(onselect).toHaveBeenCalledTimes(1);
  });

  it('closeable: labelled remove button fires onclose', async () => {
    const onclose = vi.fn();
    render(Chip, { props: { label: 'Tag', closeable: true, onclose } });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Tag' }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean (selectable + closeable)', async () => {
    const { container } = render(Chip, {
      props: { label: 'Tag', selectable: true, closeable: true },
    });
    await expectNoA11yViolations(container);
  });
});

describe('Skeleton', () => {
  it('is a labelled status region', () => {
    render(Skeleton, { props: { label: 'Loading profile' } });
    expect(
      screen.getByRole('status', { name: 'Loading profile' }),
    ).toBeInTheDocument();
  });

  it('renders one placeholder per text line', () => {
    const { container } = render(Skeleton, {
      props: { variant: 'text', lines: 3 },
    });
    expect(container.querySelectorAll('.skeleton')).toHaveLength(3);
  });

  it('is axe-clean', async () => {
    const { container } = render(Skeleton, { props: { variant: 'circle' } });
    await expectNoA11yViolations(container);
  });
});
