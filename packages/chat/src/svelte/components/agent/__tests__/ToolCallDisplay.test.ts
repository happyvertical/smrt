// @vitest-environment jsdom
/**
 * Component coverage for ToolCallDisplay via the shared S11 harness (#1416).
 *
 * Locks the T2 #1391 dead-code removal: the unused `statusIcon` $derived (which
 * returned '...'/'' for every branch and was never rendered) was removed. The
 * component must still render the tool name and status, and expand on click.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import type { ToolCallDisplayData } from '../../../types.js';
import ToolCallDisplay from '../ToolCallDisplay.svelte';

function makeToolCall(
  overrides: Partial<ToolCallDisplayData> = {},
): ToolCallDisplayData {
  return {
    toolName: 'search',
    toolCallId: 'tc-1',
    arguments: { q: 'hello' },
    status: 'success',
    result: ['a', 'b'],
    duration: 1200,
    ...overrides,
  };
}

describe('ToolCallDisplay', () => {
  it('renders the tool name and a human status label', () => {
    render(ToolCallDisplay, { props: { toolCall: makeToolCall() } });
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('expands to reveal arguments and result on click', async () => {
    render(ToolCallDisplay, { props: { toolCall: makeToolCall() } });
    const header = screen.getByRole('button');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Arguments')).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(ToolCallDisplay, {
      props: { toolCall: makeToolCall({ status: 'error', error: 'boom' }) },
    });
    await expectNoA11yViolations(container);
  });
});
