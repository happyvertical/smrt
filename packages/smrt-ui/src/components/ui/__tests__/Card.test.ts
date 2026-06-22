/**
 * Component test for Card (Sweep S11, #1416).
 *
 * Mirrors the Button golden pattern: render → assert structure/variant → axe.
 * Card is a presentational surface — it has no interactive behavior of its own
 * (no clickable/keyboard handler in the source), so this suite covers rendering
 * of content/header/footer snippets, variant + padding classes, the hoverable
 * flag, attribute pass-through (`...rest`), and a11y.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Card from '../Card.svelte';

/** Build a text Snippet for a Card slot. */
function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Card', () => {
  it('renders children inside the card content region', () => {
    render(Card, { props: { children: textSnippet('Body text') } });
    expect(screen.getByText('Body text')).toBeInTheDocument();
  });

  it('applies the default variant and md padding classes', () => {
    const { container } = render(Card, {
      props: { children: textSnippet('Body') },
    });
    const card = container.querySelector('.card');
    expect(card).toHaveClass('default');
    expect(card).toHaveClass('padding-md');
  });

  it('reflects an explicit variant and padding', () => {
    const { container } = render(Card, {
      props: {
        variant: 'elevated',
        padding: 'lg',
        children: textSnippet('Body'),
      },
    });
    const card = container.querySelector('.card');
    expect(card).toHaveClass('elevated');
    expect(card).toHaveClass('padding-lg');
  });

  it('adds the hoverable class only when hoverable is true', () => {
    const { container: plain } = render(Card, {
      props: { children: textSnippet('Body') },
    });
    expect(plain.querySelector('.card')).not.toHaveClass('hoverable');

    const { container: hover } = render(Card, {
      props: { hoverable: true, children: textSnippet('Body') },
    });
    expect(hover.querySelector('.card')).toHaveClass('hoverable');
  });

  it('renders header and footer slots when provided', () => {
    const { container } = render(Card, {
      props: {
        header: textSnippet('Header'),
        footer: textSnippet('Footer'),
        children: textSnippet('Body'),
      },
    });
    expect(container.querySelector('.card-header')).toBeInTheDocument();
    expect(container.querySelector('.card-footer')).toBeInTheDocument();
    expect(screen.getByText('Header')).toBeInTheDocument();
    expect(screen.getByText('Footer')).toBeInTheDocument();
  });

  it('omits header and footer regions when those slots are absent', () => {
    const { container } = render(Card, {
      props: { children: textSnippet('Body') },
    });
    expect(container.querySelector('.card-header')).toBeNull();
    expect(container.querySelector('.card-footer')).toBeNull();
  });

  it('forwards rest attributes (e.g. data-testid, aria-label) to the root', () => {
    const { container } = render(Card, {
      props: {
        'data-testid': 'profile-card',
        'aria-label': 'Profile',
        children: textSnippet('Body'),
      },
    });
    const card = container.querySelector('.card');
    expect(card).toHaveAttribute('data-testid', 'profile-card');
    expect(card).toHaveAttribute('aria-label', 'Profile');
  });

  it('is axe-clean for a content-only card', async () => {
    const { container } = render(Card, {
      props: { children: textSnippet('Accessible body') },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean with header and footer regions', async () => {
    const { container } = render(Card, {
      props: {
        variant: 'outlined',
        header: textSnippet('Heading'),
        footer: textSnippet('Actions'),
        children: textSnippet('Accessible body'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
