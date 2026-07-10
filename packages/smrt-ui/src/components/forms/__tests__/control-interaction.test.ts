import { describe, expect, it, vi } from 'vitest';
import {
  type ControlIdentity,
  createControlInteractionRegistry,
} from '../control-interaction.js';

const identity: ControlIdentity = {
  formId: 'profile',
  controlId: 'display-name',
};

describe('control interaction registry', () => {
  it('discovers serializable metadata and current state', () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text', label: 'Display name' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      getState: () => ({ valid: true }),
    });

    expect(registry.list('profile')).toEqual([
      expect.objectContaining({
        identity,
        metadata: expect.objectContaining({
          kind: 'text',
          label: 'Display name',
          capabilities: expect.arrayContaining(['read', 'stage', 'apply']),
        }),
        state: expect.objectContaining({ value: 'Ada', valid: true }),
      }),
    ]);
  });

  it('stages without mutation, requires agent consent to apply, and supports undo', async () => {
    let value = 'Ada';
    const setValue = vi.fn((next: unknown) => {
      value = String(next);
    });
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text', label: 'Display name' },
      getValue: () => value,
      setValue,
    });

    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    expect(value).toBe('Ada');
    expect(registry.get(identity)?.state.stagedValue).toBe('Grace');

    const denied = await registry.execute(
      { action: 'apply', identity },
      { source: 'agent' },
    );
    expect(denied).toMatchObject({ ok: false, reason: 'consent_required' });

    const applied = await registry.execute(
      { action: 'apply', identity },
      { source: 'agent', confirmed: true },
    );
    expect(applied.ok).toBe(true);
    expect(value).toBe('Grace');

    await registry.execute(
      { action: 'undo', identity },
      { source: 'agent', confirmed: true },
    );
    expect(value).toBe('Ada');
  });

  it('redacts and denies secret controls by default', async () => {
    let value = 'token';
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'password', sensitivity: 'secret' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
    });

    expect(registry.get(identity)?.state).toMatchObject({
      value: undefined,
      valueRedacted: true,
    });
    const result = await registry.execute(
      { action: 'stage', identity, value: 'replacement' },
      { source: 'agent' },
    );
    expect(result).toMatchObject({ ok: false, reason: 'sensitive_control' });
    expect(value).toBe('token');
  });

  it('runs focus, reveal, and highlight without coupling to a DOM implementation', async () => {
    const focus = vi.fn();
    const reveal = vi.fn();
    const highlight = vi.fn();
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      focus,
      reveal,
      highlight,
    });

    await registry.execute({ action: 'focus', identity });
    await registry.execute({ action: 'reveal', identity });
    await registry.execute({ action: 'highlight', identity, durationMs: 400 });

    expect(focus).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledOnce();
    expect(highlight).toHaveBeenCalledWith(400);
  });
});
