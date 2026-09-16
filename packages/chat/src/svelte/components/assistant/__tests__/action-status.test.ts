/**
 * Unit coverage for toolCallStatusForAction (#2904 review, Copilot PR #2919
 * jAwua/jAwtb) — both AssistantDock.svelte and the demo route previously let
 * `status === 'previewing'` fall through to 'success', showing "Completed"
 * while a preview request was still in flight or about to fail.
 */
import { describe, expect, it } from 'vitest';
import { toolCallStatusForAction } from '../action-status.js';

describe('toolCallStatusForAction', () => {
  it('maps previewing to running', () => {
    expect(toolCallStatusForAction('previewing')).toBe('running');
  });

  it('maps applying to running', () => {
    expect(toolCallStatusForAction('applying')).toBe('running');
  });

  it('maps failed to error', () => {
    expect(toolCallStatusForAction('failed')).toBe('error');
  });

  it('maps previewed to success', () => {
    expect(toolCallStatusForAction('previewed')).toBe('success');
  });

  it('maps applied to success', () => {
    expect(toolCallStatusForAction('applied')).toBe('success');
  });
});
