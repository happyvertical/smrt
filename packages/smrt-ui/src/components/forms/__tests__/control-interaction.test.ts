import { describe, expect, it, vi } from 'vitest';
import {
  type ControlIdentity,
  createControlInteractionRegistry,
  executeLocalControlBatch,
  executeLocalControlCommand,
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

  it('does not expose mutable aliases through public snapshots', () => {
    const value = { profile: { name: 'Ada' } };
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'custom' },
      getValue: () => value,
      setValue: () => undefined,
    });

    const snapshot = registry.get(identity);
    if (!snapshot) throw new Error('missing snapshot');
    (snapshot.state.value as typeof value).profile.name = 'Grace';
    expect(value.profile.name).toBe('Ada');
  });

  it('fails closed when a public value cannot be cloned', () => {
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'custom' },
      getValue: () => ({ callback: () => undefined }),
      setValue: () => undefined,
    });

    expect(registry.get(identity)?.state).toMatchObject({
      value: undefined,
      valueRedacted: true,
    });
  });

  it('stages with provenance without mutation and only lets a human apply', async () => {
    let value = 'Ada';
    const events: Array<{ context?: { localGesture?: boolean } }> = [];
    const setValue = vi.fn((next: unknown) => {
      value = String(next);
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.subscribe((event) => events.push(event));
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

    const spoofedHuman = await registry.execute(
      { action: 'apply', identity, revision: 1 },
      { source: 'user', confirmed: true },
    );
    expect(spoofedHuman).toMatchObject({
      ok: false,
      reason: 'local_gesture_required',
    });

    const gesture = new Event('click');
    const applied = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      gesture,
    );
    expect(applied.ok).toBe(true);
    expect(value).toBe('Grace');
    expect(events.at(-1)?.context?.localGesture).toBe(true);

    await registry.execute(
      { action: 'stage', identity, value: 'Katherine' },
      { source: 'agent' },
    );
    const replayed = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 2 },
      gesture,
    );
    expect(replayed).toMatchObject({
      ok: false,
      reason: 'local_gesture_required',
    });
    expect(value).toBe('Grace');

    await executeLocalControlCommand(
      registry,
      { action: 'discard', identity, revision: 2 },
      new Event('click'),
    );

    const spoofedClear = await registry.execute(
      { action: 'clear', identity },
      { source: 'user', confirmed: true },
    );
    expect(spoofedClear).toMatchObject({
      ok: false,
      reason: 'local_gesture_required',
    });
    const spoofedUndo = await registry.execute(
      { action: 'undo', identity },
      { source: 'user', confirmed: true },
    );
    expect(spoofedUndo).toMatchObject({
      ok: false,
      reason: 'local_gesture_required',
    });
    await executeLocalControlCommand(
      registry,
      { action: 'undo', identity },
      new Event('click'),
    );
    expect(value).toBe('Ada');
  });

  it('rejects synthetic events unless the host explicitly recognizes them', async () => {
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

    const result = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'local_gesture_required',
    });
    expect(value).toBe('Ada');
  });

  it('detects stale revisions and competing direct edits without losing the proposal', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
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
    const wrongRevision = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 9 },
      new Event('click'),
    );
    expect(wrongRevision).toMatchObject({
      ok: false,
      reason: 'stale_revision',
    });

    value = 'Katherine';
    expect(registry.get(identity)?.state.staged?.stale).toBe(true);
    const stale = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    expect(stale).toMatchObject({ ok: false, reason: 'staged_value_stale' });
    expect(value).toBe('Katherine');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');

    const discarded = await executeLocalControlCommand(
      registry,
      { action: 'discard', identity, revision: 1 },
      new Event('click'),
    );
    expect(discarded.ok).toBe(true);
    expect(registry.get(identity)?.state.staged).toBeUndefined();
  });

  it('allows a trusted discard after the control becomes disabled', async () => {
    let disabled = false;
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => 'Ada',
      setValue: () => undefined,
      getState: () => ({ disabled }),
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    disabled = true;

    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'discard', identity, revision: 1 },
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(identity)?.state.staged).toBeUndefined();
  });

  it('rechecks disabled state after an asynchronous policy decision', async () => {
    let disabled = false;
    let releasePolicy: (() => void) | undefined;
    let policyStarted: (() => void) | undefined;
    const policyGate = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const started = new Promise<void>((resolve) => {
      policyStarted = resolve;
    });
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
      policy: async (command) => {
        if (command.action === 'apply') {
          policyStarted?.();
          await policyGate;
        }
        return { allowed: true };
      },
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      getState: () => ({ disabled }),
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await started;
    disabled = true;
    releasePolicy?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'control_not_editable',
    });
    expect(value).toBe('Ada');
  });

  it('rechecks disabled state after asynchronous proposal validation', async () => {
    let disabled = false;
    let blockValidation = false;
    let releaseValidation: (() => void) | undefined;
    let validationStarted: (() => void) | undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      validateValue: async () => {
        if (blockValidation) {
          validationStarted?.();
          await validationGate;
        }
        return true;
      },
      getState: () => ({ disabled }),
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    blockValidation = true;

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await started;
    disabled = true;
    releaseValidation?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'control_not_editable',
    });
    expect(value).toBe('Ada');
  });

  it('keeps invalid proposals staged and returns explicit batch results', async () => {
    let first = 'Ada';
    let second = 'Lovelace';
    const secondIdentity = { ...identity, controlId: 'surname' };
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
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
    const batch = await executeLocalControlBatch(
      registry,
      [
        { action: 'apply', identity, revision: 1 },
        { action: 'apply', identity: secondIdentity, revision: 2 },
      ],
      new Event('click'),
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
      isLocalGesture: () => true,
    });
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));
    registry.register({
      identity,
      metadata: { kind: 'text', sensitivity: 'sensitive' },
      getValue: () => 'private',
      setValue: () => undefined,
      validateValue: (value) => `Do not use ${String(value)}`,
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
    const invalid = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    expect(invalid.reason).toBe('staged_value_invalid');
    expect(JSON.stringify(invalid)).not.toContain('replacement');
  });

  it('redacts sensitive exceptions from results and events', async () => {
    const events: unknown[] = [];
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.subscribe((event) => events.push(event));
    registry.register({
      identity,
      metadata: { kind: 'text', sensitivity: 'sensitive' },
      getValue: () => 'private',
      setValue: () => {
        throw new Error('could not set replacement');
      },
      validateValue: () => {
        throw new Error('validator saw replacement');
      },
    });

    const staged = await registry.execute(
      { action: 'stage', identity, value: 'replacement' },
      { source: 'agent' },
    );
    expect(staged).toMatchObject({ ok: false, reason: 'command_failed' });
    expect(JSON.stringify(staged)).not.toContain('replacement');
    expect(JSON.stringify(events)).not.toContain('replacement');
  });

  it('redacts sensitive snapshot failures before policy evaluation', async () => {
    const events: unknown[] = [];
    const registry = createControlInteractionRegistry();
    registry.subscribe((event) => events.push(event));
    registry.register({
      identity,
      metadata: { kind: 'text', sensitivity: 'sensitive' },
      getValue: () => 'private',
      setValue: () => undefined,
      getState: () => {
        throw new Error('private snapshot details');
      },
    });

    const outcome = await registry.execute(
      { action: 'stage', identity, value: 'replacement' },
      { source: 'agent' },
    );

    expect(outcome).toMatchObject({ ok: false, reason: 'command_failed' });
    expect(JSON.stringify(outcome)).not.toContain('private snapshot details');
    expect(JSON.stringify(events)).not.toContain('private snapshot details');
  });

  it('restores the prior proposal when replacement staging throws', async () => {
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => 'Ada',
      setValue: () => undefined,
      validateValue: (value) => {
        if (value === 'Katherine') throw new Error('validator_failed');
        return true;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const replacement = await registry.execute(
      { action: 'stage', identity, value: 'Katherine' },
      { source: 'agent' },
    );
    expect(replacement).toMatchObject({
      ok: false,
      reason: 'validator_failed',
    });
    expect(registry.get(identity)?.state.staged).toMatchObject({
      value: 'Grace',
      revision: 1,
    });
  });

  it('restores the prior proposal when replacement snapshotting throws', async () => {
    let failNextRead = false;
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('snapshot_failed');
        }
        return 'Ada';
      },
      setValue: () => undefined,
      validateValue: (value) => {
        if (value === 'Katherine') failNextRead = true;
        return true;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    const replacement = await registry.execute(
      { action: 'stage', identity, value: 'Katherine' },
      { source: 'agent' },
    );

    expect(replacement).toMatchObject({
      ok: false,
      reason: 'snapshot_failed',
    });
    expect(registry.get(identity)?.state.staged).toMatchObject({
      value: 'Grace',
      revision: 1,
    });
  });

  it('uses the guarded staged snapshot as the successful command result', async () => {
    let postValidationReads = 0;
    let replacing = false;
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => {
        if (replacing) {
          postValidationReads += 1;
          if (postValidationReads > 2) throw new Error('late_snapshot_failed');
        }
        return 'Ada';
      },
      setValue: () => undefined,
      validateValue: (value) => {
        if (value === 'Katherine') replacing = true;
        return true;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const replacement = await registry.execute(
      { action: 'stage', identity, value: 'Katherine' },
      { source: 'agent' },
    );
    replacing = false;

    expect(replacement).toMatchObject({ ok: true });
    expect(postValidationReads).toBe(2);
    expect(replacement.snapshot?.state.staged).toMatchObject({
      value: 'Katherine',
      revision: 2,
    });
  });

  it('does not let subscriber failures change committed command results', async () => {
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => 'Ada',
      setValue: () => undefined,
    });
    registry.subscribe(() => {
      throw new Error('observer_failed');
    });

    const staged = await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    expect(staged.ok).toBe(true);
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
  });

  it('isolates policy and subscriber objects from executable commands', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      policy: (command) => {
        command.action = 'apply';
        return { allowed: true };
      },
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
    });
    registry.subscribe((event) => {
      if (event.result) {
        event.result.ok = false;
        event.result.reason = 'observer-forged';
      }
      event.identity.controlId = 'observer-forged';
    });

    const staged = await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    expect(staged).toMatchObject({ ok: true, action: 'stage' });
    expect(value).toBe('Ada');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
  });

  it('redacts sensitive custom-policy denial reasons', async () => {
    const registry = createControlInteractionRegistry({
      policy: () => ({ allowed: false, reason: 'private-policy-detail' }),
    });
    registry.register({
      identity,
      metadata: { kind: 'text', sensitivity: 'sensitive' },
      getValue: () => 'private',
      setValue: () => undefined,
    });

    expect(
      await registry.execute(
        { action: 'stage', identity, value: 'replacement' },
        { source: 'agent' },
      ),
    ).toMatchObject({ ok: false, reason: 'command_failed' });
  });

  it('serializes asynchronous proposals so the newest command wins', async () => {
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstValidation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const registry = createControlInteractionRegistry();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => 'Ada',
      setValue: () => undefined,
      validateValue: async (value) => {
        if (value === 'Grace') {
          markFirstStarted?.();
          await firstValidation;
        }
        return true;
      },
    });

    const first = registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    const second = registry.execute(
      { action: 'stage', identity, value: 'Katherine' },
      { source: 'agent' },
    );
    await firstStarted;
    releaseFirst?.();

    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(registry.get(identity)?.state.staged).toMatchObject({
      value: 'Katherine',
      revision: 2,
    });
  });

  it('serializes apply validation against a competing proposal', async () => {
    let value = 'Ada';
    let blockApplyValidation = false;
    let releaseApply: (() => void) | undefined;
    let markApplyStarted: (() => void) | undefined;
    const applyValidation = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applyStarted = new Promise<void>((resolve) => {
      markApplyStarted = resolve;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      validateValue: async (next) => {
        if (blockApplyValidation && next === 'Grace') {
          markApplyStarted?.();
          await applyValidation;
        }
        return true;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    blockApplyValidation = true;

    const apply = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await applyStarted;
    const competingStage = registry.execute(
      { action: 'stage', identity, value: 'Katherine' },
      { source: 'agent' },
    );
    expect(value).toBe('Ada');
    releaseApply?.();

    expect((await apply).ok).toBe(true);
    expect((await competingStage).ok).toBe(true);
    expect(value).toBe('Grace');
    expect(registry.get(identity)?.state.staged).toMatchObject({
      value: 'Katherine',
      revision: 2,
      stale: false,
    });
  });

  it('keeps a proposal when a control rejects its applied value', async () => {
    const value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: () => undefined,
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applied = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    expect(applied).toMatchObject({
      ok: false,
      reason: 'staged_value_rejected',
    });
    expect(value).toBe('Ada');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
  });

  it('records the actual normalized value accepted by a confirmed apply', async () => {
    let value = 1;
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'number' },
      getValue: () => value,
      setValue: (next) => {
        value = Number(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: '42' },
      { source: 'agent' },
    );

    const applied = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );

    expect(applied).toMatchObject({ ok: true });
    expect(value).toBe(42);
    expect(registry.get(identity)?.state.staged).toBeUndefined();
  });

  it('rolls back a partial mutation when an applied setter throws', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
        if (next === 'Grace') throw new Error('setter_failed');
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applied = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );

    expect(applied).toMatchObject({ ok: false, reason: 'setter_failed' });
    expect(value).toBe('Ada');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
  });

  it('does not roll back over a human edit that lands during an async apply', async () => {
    let value = 'Ada';
    let userEditRevision = 0;
    let userEditValue = value;
    let releaseSetter: (() => void) | undefined;
    const setterBlocked = new Promise<void>((resolve) => {
      releaseSetter = resolve;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue: async (next) => {
        value = String(next);
        await setterBlocked;
        value = 'partial';
        throw new Error('setter_failed');
      },
      restoreValue: (next) => {
        value = String(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await vi.waitFor(() => expect(value).toBe('Grace'));
    value = 'Katherine';
    userEditValue = value;
    userEditRevision += 1;
    releaseSetter?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'setter_failed',
    });
    expect(value).toBe('Katherine');
  });

  it('rolls back an asynchronously owned partial setter mutation', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: async (next) => {
        if (next === 'Grace') {
          await Promise.resolve();
          value = 'partial';
          throw new Error('setter_failed');
        }
        value = String(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'apply', identity, revision: 1 },
        new Event('click'),
      ),
    ).toMatchObject({ ok: false, reason: 'setter_failed' });
    expect(value).toBe('Ada');
  });

  it('rolls back an applied value when live validation throws', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      validate: () => {
        throw new Error('live_validation_failed');
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applied = await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );

    expect(applied).toMatchObject({
      ok: false,
      reason: 'live_validation_failed',
    });
    expect(value).toBe('Ada');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
  });

  it('keeps staged and undo state when clear or undo is rejected', async () => {
    let value = 'Ada';
    let rejectWrites = false;
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        if (!rejectWrites) value = String(next);
      },
      clear: () => {
        if (!rejectWrites) value = '';
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    rejectWrites = true;
    const clear = await executeLocalControlCommand(
      registry,
      { action: 'clear', identity },
      new Event('click'),
    );
    expect(clear).toMatchObject({
      ok: false,
      reason: 'staged_value_rejected',
    });
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');

    rejectWrites = false;
    await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    rejectWrites = true;
    const undo = await executeLocalControlCommand(
      registry,
      { action: 'undo', identity },
      new Event('click'),
    );
    expect(undo).toMatchObject({
      ok: false,
      reason: 'staged_value_rejected',
    });
    rejectWrites = false;
    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'undo', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    expect(value).toBe('Ada');
  });

  it('rolls back partial clear and undo mutations while retaining recovery state', async () => {
    let value = 'Ada';
    let rejectClear = true;
    let rejectUndo = false;
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
        if (rejectUndo && next === 'Ada') throw new Error('undo_failed');
      },
      clear: () => {
        value = 'partially-cleared';
        return !rejectClear;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'clear', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: false, reason: 'staged_value_rejected' });
    expect(value).toBe('Ada');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');

    value = 'Ada';
    rejectClear = false;
    await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    rejectUndo = true;
    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'undo', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: false, reason: 'undo_failed' });
    expect(value).toBe('Grace');

    rejectUndo = false;
    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'undo', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    expect(value).toBe('Ada');
  });

  it('accepts an explicitly affirmed idempotent clear', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'slider' },
      getValue: () => 0,
      setValue: () => undefined,
      clear: () => true,
    });
    await registry.execute(
      { action: 'stage', identity, value: 10 },
      { source: 'agent' },
    );

    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'clear', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(identity)?.state.staged).toBeUndefined();
  });

  it('does not roll back over human edits during asynchronous clear or undo', async () => {
    let value = 'Ada';
    let userEditRevision = 0;
    let userEditValue = value;
    let releaseClear: (() => void) | undefined;
    let releaseUndo: (() => void) | undefined;
    const clearBlocked = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const undoBlocked = new Promise<void>((resolve) => {
      releaseUndo = resolve;
    });
    let blockUndo = false;
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue: async (next) => {
        value = String(next);
        if (blockUndo && next === 'Ada') {
          await undoBlocked;
          value = 'partial';
          throw new Error('undo_failed');
        }
      },
      restoreValue: (next) => {
        value = String(next);
      },
      clear: async () => {
        value = '';
        await clearBlocked;
        value = 'partial';
        return false;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const clearing = executeLocalControlCommand(
      registry,
      { action: 'clear', identity },
      new Event('click'),
    );
    await vi.waitFor(() => expect(value).toBe(''));
    value = 'Katherine';
    userEditValue = value;
    userEditRevision += 1;
    releaseClear?.();
    expect(await clearing).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(value).toBe('Katherine');

    value = 'Ada';
    await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    blockUndo = true;
    const undoing = executeLocalControlCommand(
      registry,
      { action: 'undo', identity },
      new Event('click'),
    );
    await vi.waitFor(() => expect(value).toBe('Ada'));
    value = 'Katherine';
    userEditValue = value;
    userEditRevision += 1;
    releaseUndo?.();
    expect(await undoing).toMatchObject({ ok: false, reason: 'undo_failed' });
    expect(value).toBe('Katherine');
  });

  it('rolls back an asynchronously owned partial clear mutation', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      clear: async () => {
        await Promise.resolve();
        value = 'partial';
        return false;
      },
    });

    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'clear', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: false, reason: 'staged_value_rejected' });
    expect(value).toBe('Ada');
  });

  it('preserves an intervening human edit instead of applying stale undo history', async () => {
    let value = 'Ada';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
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
    await executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    value = 'Katherine';

    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'undo', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: false, reason: 'staged_value_stale' });
    expect(value).toBe('Katherine');
  });

  it('honors an explicit clear rejection for an already-empty control', async () => {
    let value = '';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      clear: () => false,
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'clear', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: false, reason: 'staged_value_rejected' });
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
  });

  it('preserves a same-value human edit made during async validation', async () => {
    let value = 'Ada';
    let userEditValue = value;
    let userEditRevision = 0;
    let releaseValidation: (() => void) | undefined;
    let validationStarted: (() => void) | undefined;
    const validationBlocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validationStartedPromise = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue: (next) => {
        value = String(next);
      },
      restoreValue: (next) => {
        value = String(next);
      },
      validate: async () => {
        validationStarted?.();
        await validationBlocked;
        return false;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await validationStartedPromise;
    value = 'Grace';
    userEditValue = value;
    userEditRevision += 1;
    releaseValidation?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(value).toBe('Grace');
  });

  it('replays a human edit that occurs while async restoration is pending', async () => {
    let value = 'Ada';
    let userEditValue = value;
    let userEditRevision = 0;
    let releaseRestore: (() => void) | undefined;
    let restoreStarted: (() => void) | undefined;
    const restoreBlocked = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const restoreStartedPromise = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    const restoreValue = vi.fn(async (next: unknown) => {
      restoreStarted?.();
      await restoreBlocked;
      value = String(next);
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue: (next) => {
        value = String(next);
        throw new Error('setter_failed');
      },
      restoreValue,
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await restoreStartedPromise;
    value = 'Katherine';
    userEditValue = value;
    userEditRevision += 1;
    releaseRestore?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'setter_failed',
    });
    expect(value).toBe('Katherine');
    expect(restoreValue).toHaveBeenCalledTimes(2);
  });

  it('does not commit a successful async apply over a newer human edit', async () => {
    let value = 'Ada';
    let userEditValue = value;
    let userEditRevision = 0;
    let releaseSetter: (() => void) | undefined;
    let setterStarted: (() => void) | undefined;
    const setterBlocked = new Promise<void>((resolve) => {
      releaseSetter = resolve;
    });
    const setterStartedPromise = new Promise<void>((resolve) => {
      setterStarted = resolve;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue: async (next) => {
        setterStarted?.();
        await setterBlocked;
        value = String(next);
      },
      restoreValue: (next) => {
        value = String(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await setterStartedPromise;
    value = 'Katherine';
    userEditValue = value;
    userEditRevision += 1;
    releaseSetter?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(value).toBe('Katherine');
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'undo', identity },
        new Event('click'),
      ),
    ).toMatchObject({ ok: false, reason: 'nothing_to_undo' });
  });

  it('rejects a newer human edit made during async proposal validation', async () => {
    let value = 'Ada';
    let userEditValue = value;
    let userEditRevision = 0;
    let releaseValidation: (() => void) | undefined;
    let validationStarted: (() => void) | undefined;
    const validationBlocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validationStartedPromise = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let blockValidation = false;
    const setValue = vi.fn((next: unknown) => {
      value = String(next);
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue,
      validateValue: async () => {
        if (blockValidation) {
          validationStarted?.();
          await validationBlocked;
        }
        return true;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    blockValidation = true;

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await validationStartedPromise;
    userEditValue = value;
    userEditRevision += 1;
    releaseValidation?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(setValue).not.toHaveBeenCalled();
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
  });

  it('rejects newer human edits made during async clear and undo policy', async () => {
    let value = 'Ada';
    let userEditValue = value;
    let userEditRevision = 0;
    let blockedAction: 'clear' | 'undo' | undefined;
    let releasePolicy: (() => void) | undefined;
    let policyStarted: (() => void) | undefined;
    let policyBlocked = Promise.resolve();
    const blockPolicy = (action: 'clear' | 'undo') => {
      blockedAction = action;
      policyBlocked = new Promise<void>((resolve) => {
        releasePolicy = resolve;
      });
      return new Promise<void>((resolve) => {
        policyStarted = resolve;
      });
    };
    const setValue = vi.fn((next: unknown) => {
      value = String(next);
    });
    const clear = vi.fn(() => {
      value = '';
      return true;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
      policy: async (command) => {
        if (command.action === blockedAction) {
          policyStarted?.();
          await policyBlocked;
        }
        return { allowed: true };
      },
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue,
      clear,
    });

    const clearStarted = blockPolicy('clear');
    const clearing = executeLocalControlCommand(
      registry,
      { action: 'clear', identity },
      new Event('click'),
    );
    await clearStarted;
    userEditValue = value;
    userEditRevision += 1;
    releasePolicy?.();
    expect(await clearing).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(clear).not.toHaveBeenCalled();

    blockedAction = undefined;
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'apply', identity, revision: 1 },
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    setValue.mockClear();

    const undoStarted = blockPolicy('undo');
    const undoing = executeLocalControlCommand(
      registry,
      { action: 'undo', identity },
      new Event('click'),
    );
    await undoStarted;
    userEditValue = value;
    userEditRevision += 1;
    releasePolicy?.();
    expect(await undoing).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('does not commit an async apply after its registration is replaced', async () => {
    let originalValue = 'Ada';
    let replacementValue = 'Katherine';
    let releaseSetter: (() => void) | undefined;
    let setterStarted: (() => void) | undefined;
    const setterBlocked = new Promise<void>((resolve) => {
      releaseSetter = resolve;
    });
    const setterStartedPromise = new Promise<void>((resolve) => {
      setterStarted = resolve;
    });
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => originalValue,
      setValue: async (next) => {
        setterStarted?.();
        await setterBlocked;
        originalValue = String(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const applying = executeLocalControlCommand(
      registry,
      { action: 'apply', identity, revision: 1 },
      new Event('click'),
    );
    await setterStartedPromise;
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => replacementValue,
      setValue: (next) => {
        replacementValue = String(next);
      },
    });
    releaseSetter?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(replacementValue).toBe('Katherine');
  });

  it('does not commit successful async clear or undo over newer human edits', async () => {
    let value = 'Ada';
    let userEditValue = value;
    let userEditRevision = 0;
    let releaseMutation: (() => void) | undefined;
    let mutationStarted: (() => void) | undefined;
    let blockSetter = false;
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    const waitForMutation = () => {
      const blocked = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      const started = new Promise<void>((resolve) => {
        mutationStarted = resolve;
      });
      return { blocked, started };
    };
    let pending = waitForMutation();
    registry.register({
      identity,
      metadata: { kind: 'text' },
      getValue: () => value,
      getUserEditSnapshot: () => ({
        revision: userEditRevision,
        value: userEditValue,
      }),
      setValue: async (next) => {
        if (blockSetter) {
          mutationStarted?.();
          await pending.blocked;
        }
        value = String(next);
      },
      restoreValue: (next) => {
        value = String(next);
      },
      clear: async () => {
        mutationStarted?.();
        await pending.blocked;
        value = '';
        return true;
      },
    });

    const clearing = executeLocalControlCommand(
      registry,
      { action: 'clear', identity },
      new Event('click'),
    );
    await pending.started;
    value = 'Katherine';
    userEditValue = value;
    userEditRevision += 1;
    releaseMutation?.();
    expect(await clearing).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(value).toBe('Katherine');

    blockSetter = false;
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    expect(
      await executeLocalControlCommand(
        registry,
        { action: 'apply', identity, revision: 1 },
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });

    pending = waitForMutation();
    blockSetter = true;
    const undoing = executeLocalControlCommand(
      registry,
      { action: 'undo', identity },
      new Event('click'),
    );
    await pending.started;
    value = 'Byron';
    userEditValue = value;
    userEditRevision += 1;
    releaseMutation?.();
    expect(await undoing).toMatchObject({
      ok: false,
      reason: 'staged_value_stale',
    });
    expect(value).toBe('Byron');
  });

  it('does not collide subject identities containing separators', async () => {
    const firstIdentity = {
      ...identity,
      subject: { type: 'record:x', id: '1' },
    };
    const secondIdentity = {
      ...identity,
      subject: { type: 'record', id: 'x:1' },
    };
    const registry = createControlInteractionRegistry();
    registry.register({
      identity: firstIdentity,
      metadata: { kind: 'text' },
      getValue: () => 'First',
      setValue: () => undefined,
    });
    registry.register({
      identity: secondIdentity,
      metadata: { kind: 'text' },
      getValue: () => 'Second',
      setValue: () => undefined,
    });
    await registry.execute(
      { action: 'stage', identity: firstIdentity, value: 'Grace' },
      { source: 'agent' },
    );

    expect(registry.list()).toHaveLength(2);
    expect(registry.get(firstIdentity)?.state.staged?.value).toBe('Grace');
    expect(registry.get(secondIdentity)?.state.staged).toBeUndefined();
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
