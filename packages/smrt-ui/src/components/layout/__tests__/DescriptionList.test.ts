import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import DescriptionList from '../DescriptionList.svelte';

describe('DescriptionList', () => {
  it('renders items as term/description pairs in a dl', () => {
    const { container } = render(DescriptionList, {
      props: {
        items: [
          { term: 'Status', description: 'Open' },
          { term: 'Owner', description: 'Sam' },
        ],
      },
    });
    const dl = container.querySelector('dl');
    expect(dl).toHaveAttribute('data-smrt-component', 'DescriptionList');
    expect(dl?.querySelectorAll('dt')).toHaveLength(2);
    expect(screen.getByText('Status').tagName).toBe('DT');
    expect(screen.getByText('Open').tagName).toBe('DD');
  });

  it('renders items that share a term', () => {
    const { container } = render(DescriptionList, {
      props: {
        items: [
          { term: 'Phone', description: '555-0100' },
          { term: 'Phone', description: '555-0101' },
        ],
      },
    });
    expect(container.querySelectorAll('dd')).toHaveLength(2);
  });

  it('renders a children snippet after items', () => {
    const children = createRawSnippet(() => ({
      render: () => '<dt>Extra</dt><dd>Value</dd>',
    }));
    const { container } = render(DescriptionList, {
      props: { items: [{ term: 'A', description: 'B' }], children },
    });
    const terms = [...container.querySelectorAll('dt')].map(
      (e) => e.textContent,
    );
    expect(terms).toEqual(['A', 'Extra']);
  });

  it('passes class and attributes through', () => {
    const { container } = render(DescriptionList, {
      props: { items: [], class: 'x', 'aria-label': 'Details' },
    });
    const dl = container.querySelector('dl');
    expect(dl).toHaveClass('x');
    expect(dl).toHaveAttribute('aria-label', 'Details');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(DescriptionList, {
      props: { items: [{ term: 'A', description: 'B' }] },
    });
    await expectNoA11yViolations(container);
  });
});
