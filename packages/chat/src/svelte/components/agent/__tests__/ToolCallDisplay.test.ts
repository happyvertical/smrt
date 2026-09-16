// @vitest-environment jsdom
/**
 * Component coverage for ToolCallDisplay via the shared S11 harness (#1416).
 *
 * Locks the T2 #1391 dead-code removal: the unused `statusIcon` $derived (which
 * returned '...'/'' for every branch and was never rendered) was removed. The
 * component must still render the tool name and status, and expand on click.
 */
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data-surface';
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
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

  // #2904: additive DataSurfaceActionResult rendering, used by AssistantDock.
  function makeActionResult(
    overrides: Partial<DataSurfaceActionResult> = {},
  ): DataSurfaceActionResult {
    return {
      version: 1,
      requestId: 'req-1',
      identity: {
        surfaceId: 'orders',
        kind: 'table',
        subject: { type: 'tenant', id: 'tenant-a' },
      },
      actionId: 'archive',
      phase: 'preview',
      ok: true,
      ...overrides,
    };
  }

  it('renders a successful preview with Confirm/Reject and fires callbacks', async () => {
    const onconfirmaction = vi.fn();
    const onrejectaction = vi.fn();
    render(ToolCallDisplay, {
      props: {
        toolCall: makeToolCall(),
        actionResult: makeActionResult(),
        onconfirmaction,
        onrejectaction,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /search/i }));
    expect(screen.getByText('Proposed change')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onconfirmaction).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onrejectaction).toHaveBeenCalledOnce();
  });

  it('renders an applied result without Confirm/Reject', async () => {
    render(ToolCallDisplay, {
      props: {
        toolCall: makeToolCall(),
        actionResult: makeActionResult({ phase: 'apply' }),
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /search/i }));
    expect(screen.getByText('Applied change')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();
  });

  it('renders a failure reason when the action result is not ok', async () => {
    render(ToolCallDisplay, {
      props: {
        toolCall: makeToolCall(),
        actionResult: makeActionResult({ ok: false, reason: 'stale_revision' }),
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /search/i }));
    expect(screen.getByText('stale_revision')).toBeInTheDocument();
  });
});
