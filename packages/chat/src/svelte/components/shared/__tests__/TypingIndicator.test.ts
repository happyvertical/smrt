// @vitest-environment jsdom
/**
 * Component coverage for TypingIndicator via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import TypingIndicator from '../TypingIndicator.svelte';

describe('TypingIndicator', () => {
  it('names a single typist', () => {
    render(TypingIndicator, { props: { names: ['Ada'] } });
    expect(screen.getByText('Ada is typing')).toBeInTheDocument();
  });

  it('names two typists', () => {
    render(TypingIndicator, { props: { names: ['Ada', 'Bob'] } });
    expect(screen.getByText('Ada and Bob are typing')).toBeInTheDocument();
  });

  it('renders nothing when nobody is typing', () => {
    const { container } = render(TypingIndicator, { props: { names: [] } });
    expect(container.querySelector('.typing')).toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(TypingIndicator, {
      props: { names: ['Ada'] },
    });
    await expectNoA11yViolations(container);
  });
});
