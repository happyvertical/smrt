/**
 * Golden tests for the L3 gap primitives — batch 2 (Tooltip, Dropdown, Tree).
 * Render + keyboard/pointer interaction + a11y, per the L4 harness (#1422).
 */

import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Dropdown from '../Dropdown.svelte';
import Tooltip from '../Tooltip.svelte';
import Tree from '../Tree.svelte';

const triggerSnippet = (text: string) =>
  createRawSnippet(() => ({ render: () => `<button>${text}</button>` }));

describe('Tooltip', () => {
  it('wires the trigger to the bubble via aria-describedby', () => {
    render(Tooltip, {
      props: { text: 'More info', children: triggerSnippet('Help') },
    });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('More info');
    // The trigger wrapper (direct parent of the snippet content) is described
    // by the bubble.
    const trigger = screen.getByRole('button', { name: 'Help' }).parentElement;
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
  });

  it('reveals on hover', async () => {
    render(Tooltip, {
      props: { text: 'More info', delay: 0, children: triggerSnippet('Help') },
    });
    await userEvent.hover(screen.getByRole('button', { name: 'Help' }));
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveClass('open'),
    );
  });

  it('is axe-clean', async () => {
    const { container } = render(Tooltip, {
      props: { text: 'More info', children: triggerSnippet('Help') },
    });
    await expectNoA11yViolations(container);
  });
});

const MENU = [
  { id: 'edit', label: 'Edit' },
  { id: 'dup', label: 'Duplicate' },
  { id: 'del', label: 'Delete' },
];

describe('Dropdown', () => {
  it('trigger advertises a collapsed menu', () => {
    render(Dropdown, { props: { label: 'Actions', items: MENU } });
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a menu and reports selection', async () => {
    const onselect = vi.fn();
    render(Dropdown, { props: { label: 'Actions', items: MENU, onselect } });
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onselect).toHaveBeenCalledWith('del');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    render(Dropdown, { props: { label: 'Actions', items: MENU } });
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('is axe-clean when open', async () => {
    const { container } = render(Dropdown, {
      props: { label: 'Actions', items: MENU },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await expectNoA11yViolations(container);
  });
});

const NODES = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'a', label: 'a.ts' },
      { id: 'b', label: 'b.ts' },
    ],
  },
  { id: 'readme', label: 'README.md' },
];

describe('Tree', () => {
  it('is a labelled tree with levelled items', () => {
    render(Tree, { props: { nodes: NODES, 'aria-label': 'Files' } });
    expect(screen.getByRole('tree', { name: 'Files' })).toBeInTheDocument();
    const folder = screen.getByRole('treeitem', { name: /src/ });
    expect(folder).toHaveAttribute('aria-level', '1');
    expect(folder).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a node to reveal children', async () => {
    render(Tree, { props: { nodes: NODES } });
    await userEvent.click(screen.getByRole('treeitem', { name: /src/ }));
    expect(screen.getByRole('treeitem', { name: 'a.ts' })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });

  it('reports leaf selection', async () => {
    const onselect = vi.fn();
    render(Tree, { props: { nodes: NODES, onselect } });
    await userEvent.click(screen.getByRole('treeitem', { name: 'README.md' }));
    expect(onselect).toHaveBeenCalledWith('readme');
  });

  it('is axe-clean', async () => {
    const { container } = render(Tree, {
      props: { nodes: NODES, expanded: ['src'], 'aria-label': 'Files' },
    });
    await expectNoA11yViolations(container);
  });
});
