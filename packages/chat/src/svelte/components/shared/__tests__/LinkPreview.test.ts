// @vitest-environment jsdom
/**
 * Component coverage for LinkPreview via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import LinkPreview from '../LinkPreview.svelte';

describe('LinkPreview', () => {
  it('renders a link with title, description, and hostname', () => {
    render(LinkPreview, {
      props: {
        url: 'https://example.com/article',
        title: 'An Article',
        description: 'A short summary',
      },
    });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/article');
    expect(screen.getByText('An Article')).toBeInTheDocument();
    expect(screen.getByText('A short summary')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(LinkPreview, {
      props: { url: 'https://example.com', title: 'Example' },
    });
    await expectNoA11yViolations(container);
  });
});
