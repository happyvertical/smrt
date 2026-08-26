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

  it('stages with provenance without mutation and only lets a human apply', async () => {
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

    const staged = await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent', actorId: 'agent-7', sessionId: 'session-9' },
    );
    expect(staged.snapshot?.state.staged).toMatchObject({
      value: 'Grace',
      revision: 1,
      provenance: {
        source: 'agent',
        actorId: 'agent-7',
        sessionId: 'session-9',
      },
      stale: false,
    });
    expect(value).toBe('Ada');
    expect(registry.get(identity)?.state.stagedValue).toBe('Grace');

    const denied = await registry.execute(
      { action: 'apply', identity },
      { source: 'agent' },
    );
    expect(denied).toMatchObject({
      ok: false,
      reason: 'human_confirmation_required',
    });

    const agentCannotSelfConfirm = await registry.execute(
      { action: 'apply', identity, revision: 1 },
      { source: 'agent', confirmed: true },
    );
    expect(agentCannotSelfConfirm).toMatchObject({
      ok: false,
      reason: 'human_confirmation_required',
    });

    const applied = await registry.execute(
      { action: 'apply', identity, revision: 1 },
      { source: 'user', confirmed: true },
    );
    expect(applied.ok).toBe(true);
    expect(value).toBe('Grace');

    await registry.execute(
      { action: 'undo', identity },
      { source: 'user', confirmed: true },
    );
    expect(value).toBe('Ada');
  });

  it('detects stale revisions and competing direct edits without losing the proposal', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
    });

    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    const wrongRevision = await registry.execute(
      { action: 'apply', identity, revision: 9 },
      { source: 'user', confirmed: true },
    );
    expect(wrongRevision).toMatchObject({
      ok: false,
      reason: 'stale_revision',
    });

    value = 'Katherine';
    expect(registry.get(identity)?.state.staged?.stale).toBe(true);
    const stale = await registry.execute(
      { action: 'apply', identity, revision: 1 },
      { source: 'user', confirmed: true },
    );
    expect(stale).toMatchObject({ ok: false, reason: 'staged_value_stale' });
    expect(value).toBe('Katherine');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');

    const discarded = await registry.execute(
      { action: 'discard', identity, revision: 1 },
      { source: 'user', confirmed: true },
    );
    expect(discarded.ok).toBe(true);
    expect(registry.get(identity)?.state.staged).toBeUndefined();
  });

  it('keeps invalid proposals staged and returns explicit batch results', async () => {
    let first = 'Ada';
    let second = 'Lovelace';
    const secondIdentity = { ...identity, controlId: 'surname' };
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => first,
      setValue: (next) => {
        first = String(next);
      },
      validateValue: (next) =>
        String(next).length >= 3 || 'Use at least three characters',
    });
    registry.register({
      identity: secondIdentity,
      metadata: { kind: 'text' },
      getValue: () => second,
      setValue: (next) => {
        second = String(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'x' },
      { source: 'agent' },
    );
    await registry.execute(
      { action: 'stage', identity: secondIdentity, value: 'Hopper' },
      { source: 'agent' },
    );

    expect(registry.get(identity)?.state.staged).toMatchObject({
      valid: false,
      validationMessage: 'Use at least three characters',
    });
    const batch = await registry.executeBatch(
      [
        { action: 'apply', identity, revision: 1 },
        { action: 'apply', identity: secondIdentity, revision: 2 },
      ],
      { source: 'user', confirmed: true },
    );
    expect(batch).toMatchObject({
      ok: false,
      results: [
        { ok: false, reason: 'Use at least three characters' },
        { ok: true },
      ],
    });
    expect(first).toBe('Ada');
    expect(second).toBe('Hopper');
    expect(registry.get(identity)?.state.staged).toBeDefined();
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

    const snapshot = registry.get(identity);
    expect(snapshot?.state).toMatchObject({
      value: undefined,
      valueRedacted: true,
    });
    expect(snapshot?.metadata.capabilities).not.toEqual(
      expect.arrayContaining(['read', 'stage', 'apply', 'clear', 'undo']),
    );
    const result = await registry.execute(
      { action: 'stage', identity, value: 'replacement' },
      { source: 'agent' },
    );
    expect(result).toMatchObject({ ok: false, reason: 'sensitive_control' });
    expect(value).toBe('token');
  });

  it('redacts sensitive current and staged values in snapshots and events', async () => {
    const policyCommands: unknown[] = [];
    const registry = createControlInteractionRegistry({
      policy: (command) => {
        policyCommands.push(command);
        return { allowed: true };
      },
    });
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));
    registry.register({
      identity,
      metadata: { kind: 'text', sensitivity: 'sensitive' },
      getValue: () => 'private',
      setValue: () => undefined,
    });
    await registry.execute(
      { action: 'stage', identity, value: 'replacement' },
      { source: 'agent' },
    );

    expect(registry.get(identity)?.state).toMatchObject({
      value: undefined,
      valueRedacted: true,
      stagedValue: undefined,
      stagedValueRedacted: true,
      staged: { value: undefined, valueRedacted: true },
    });
    expect(JSON.stringify(events)).not.toContain('private');
    expect(JSON.stringify(events)).not.toContain('replacement');
    expect(JSON.stringify(policyCommands)).not.toContain('replacement');
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
