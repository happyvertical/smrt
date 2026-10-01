/**
 * Checkbox, Radio and Switch carry an invisible 44x44 hit area around the
 * visible control. jsdom does no layout, so the geometry is asserted against
 * the component source (the contract) and the click behavior against the DOM;
 * the measured result is verified in a real browser.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import Checkbox from '../Checkbox.svelte';
import Switch from '../Switch.svelte';

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) =>
  readFileSync(resolve(here, '..', `${name}.svelte`), 'utf8');

describe.each(['Checkbox', 'Radio', 'Switch'])('%s hit area', (name) => {
  const css = source(name).slice(source(name).indexOf('<style>'));

  it('draws a 44px (2.75rem) transparent ::before target that adds no layout', () => {
    expect(css).toContain('--smrt-control-hit-size, 2.75rem');
    expect(css).toMatch(/::before \{[^}]*position: absolute/);
    expect(css).toMatch(/::before \{[^}]*content: ''/);
  });

  it('keeps the visible control and its label above every hit area', () => {
    expect(css).toMatch(/__(box|mark|track)[^{]*\{[^}]*z-index: 1/);
    expect(css).toMatch(/__label[^{]*\{[^}]*z-index: 1/);
  });
});

describe.each(['Checkbox', 'Radio'])('%s in table cells', (name) => {
  it('never grows horizontally out of the cell', () => {
    expect(source(name)).toMatch(
      /:global\(:is\(td, th\)\) \.(checkbox|radio)::before \{ inline-size: var\(--_box\)/,
    );
  });
});

describe.each(['Checkbox', 'Radio'])('%s beside other content', (name) => {
  it('keeps to its own column unless it stands alone, so it never covers a neighbouring link or text', () => {
    expect(source(name)).toMatch(
      /\.(checkbox|radio):not\(:only-child\)::before \{ inline-size: var\(--_box\); margin-inline-start: calc\(var\(--_box\) \/ -2\)/,
    );
  });
});

describe('Checkbox table cell fill', () => {
  it('uses the whole cell, clipped to it, when the checkbox is its only content', () => {
    const css = source('Checkbox');
    expect(css).toContain('> [data-smrt-hit-target]:only-child');
    expect(css).toMatch(/::before \{ inset: 0;/);
  });

  it('positions the cell at zero specificity, so sticky headers and pinned cells keep theirs', () => {
    const css = source('Checkbox');
    expect(css).toContain(
      ':global(:where(td:has(> [data-smrt-hit-target]:only-child), th:has(> [data-smrt-hit-target]:only-child))) { position: relative; }',
    );
    expect(css).not.toMatch(
      /:global\(:is\(td, th\):has\([^)]*\)\)\) \{ position: relative/,
    );
  });
});

describe('hit area behavior', () => {
  it('Checkbox toggles from a click on its label element', async () => {
    const user = userEvent.setup();
    const { container } = render(Checkbox, { props: { label: 'Accept' } });
    expect(container.querySelector('label')).toHaveAttribute(
      'data-smrt-hit-target',
    );
    await user.click(container.querySelector('label') as HTMLElement);
    expect(screen.getByRole('checkbox', { name: 'Accept' })).toBeChecked();
  });

  it('Checkbox without text keeps the label as the click target', async () => {
    const user = userEvent.setup();
    const { container } = render(Checkbox, {
      props: { 'aria-label': 'Select row' },
    });
    await user.click(container.querySelector('label') as HTMLElement);
    expect(screen.getByRole('checkbox', { name: 'Select row' })).toBeChecked();
  });

  it('Switch toggles from a click on its label element', async () => {
    const user = userEvent.setup();
    const { container } = render(Switch, { props: { label: 'Alerts' } });
    await user.click(container.querySelector('label') as HTMLElement);
    expect(screen.getByRole('switch', { name: 'Alerts' })).toBeChecked();
  });
});
