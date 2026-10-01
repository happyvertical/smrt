import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Fieldset from '../Fieldset.svelte';

const fields = createRawSnippet(() => ({
  render: () => '<label>Headline <input name="headline" /></label>',
}));

describe('Fieldset', () => {
  it('is a group named by its legend', () => {
    render(Fieldset, { props: { legend: 'The ad', children: fields } });
    expect(screen.getByRole('group', { name: 'The ad' })).toBeInTheDocument();
  });

  it('flows its content unless asked to stack it', () => {
    const { container } = render(Fieldset, {
      props: { legend: 'The ad', children: fields },
    });
    expect(container.querySelector('.content--stack')).toBeNull();
  });

  it('stacks its fields in one column with a gap when asked', () => {
    const { container } = render(Fieldset, {
      props: { legend: 'The ad', stack: true, children: fields },
    });
    expect(container.querySelector('.content.content--stack')).not.toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(Fieldset, {
      props: {
        legend: 'The ad',
        description: 'Shown to readers',
        stack: true,
        children: fields,
      },
    });
    await expectNoA11yViolations(container);
  });
});
