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

  // #2904 review, Copilot PR #2919 jAwua/jAwtb: AssistantDock/the demo route
  // map an in-flight preview/apply action to this 'running' toolCall status
  // (see action-status.test.ts) — assert it actually renders "Running", not
  // "Completed".
  it('renders "Running" for a running tool call', () => {
    render(ToolCallDisplay, {
      props: {
        toolCall: makeToolCall({ status: 'running', result: undefined }),
      },
    });
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
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

  it('a pending preview reads "Awaiting confirmation", starts expanded, and exposes Confirm/Reject', async () => {
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
    // #2904 review fix: a preview must never read "Completed" and must be
    // expanded by default so Confirm/Reject are visible without a click.
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.getByText('Awaiting confirmation')).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /search/i });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Proposed change')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onconfirmaction).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onrejectaction).toHaveBeenCalledOnce();
  });

  it('the header toggle still collapses an awaiting-confirmation card', async () => {
    render(ToolCallDisplay, {
      props: { toolCall: makeToolCall(), actionResult: makeActionResult() },
    });
    const header = screen.getByRole('button', { name: /search/i });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders "Applied" with a result body and no Confirm/Reject once applied', async () => {
    render(ToolCallDisplay, {
      props: {
        toolCall: makeToolCall(),
        actionResult: makeActionResult({
          phase: 'apply',
          details: { rowId: 'order-2', status: 'shipped' },
        }),
      },
    });
    expect(screen.getByText('Applied')).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /search/i });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Applied change')).toBeInTheDocument();
    expect(screen.getByText(/order-2/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to a plain confirmation line when an applied result has no details', () => {
    render(ToolCallDisplay, {
      props: {
        toolCall: makeToolCall(),
        actionResult: makeActionResult({ phase: 'apply' }),
      },
    });
    expect(
      screen.getByText('Change applied successfully.'),
    ).toBeInTheDocument();
  });

  it('renders "Failed" with the reason when the action result is not ok', async () => {
    render(ToolCallDisplay, {
      props: {
        toolCall: makeToolCall(),
        actionResult: makeActionResult({ ok: false, reason: 'stale_revision' }),
      },
    });
    expect(screen.getByText('Failed')).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /search/i });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('stale_revision')).toBeInTheDocument();
  });
});
