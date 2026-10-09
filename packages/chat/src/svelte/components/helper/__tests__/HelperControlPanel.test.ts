// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type {
  HelperClient,
  HelperOffering,
  HelperSnapshot,
} from '../../../../helper-preferences.js';
import HelperControlPanel from '../HelperControlPanel.svelte';
import {
  createHelperStyleRegistry,
  type HelperStyleDefinition,
} from '../registry.js';
import TestSetup from './TestSetup.svelte';

const snapshot = (): HelperSnapshot => ({
  preferences: {
    version: 1,
    offeringId: 'happy',
    name: 'Happy',
    voiceId: 'calm',
    placement: 'bottom-right',
    heardSubtitles: true,
    spokenSubtitles: false,
  },
  offering: {
    id: 'happy',
    label: 'Happy',
    styleId: 'happy',
    source: 'ready-made',
  },
  selection: 'app-default-with-personal-override',
  source: 'default',
  offerings: [
    { id: 'happy', label: 'Happy', styleId: 'happy', source: 'ready-made' },
    {
      id: 'photo:1',
      label: 'Saved photo',
      styleId: 'photo-cutout',
      source: 'saved',
      assetId: '1',
    },
  ],
  voices: [{ id: 'calm', label: 'Calm' }],
  permissions: {
    editableFields: [
      'offeringId',
      'name',
      'voiceId',
      'placement',
      'heardSubtitles',
      'spokenSubtitles',
    ],
    canReset: true,
    customStyleIds: [],
  },
  hasOverride: false,
  recovery: null,
});

const styles: HelperStyleDefinition[] = [
  'happy',
  'photo-cutout',
  'paper-doll',
].map((id) => ({
  id,
  label: id,
  mount: () => ({ destroy() {}, setMouthOpen() {} }),
}));

describe('HelperControlPanel', () => {
  it('commits only the successful server snapshot', async () => {
    const initial: HelperSnapshot = {
      ...snapshot(),
      permissions: {
        ...snapshot().permissions,
        customStyleIds: ['photo-cutout'],
      },
    };
    const saved = {
      ...initial,
      preferences: { ...initial.preferences!, name: 'Server value' },
      source: 'personal' as const,
    };
    const client: HelperClient = {
      load: vi.fn(async () => initial),
      save: vi.fn(async () => saved),
      reset: vi.fn(async () => initial),
    };
    const changed = vi.fn();
    render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry(styles),
        snapshot: initial,
        onchanged: changed,
      },
    });
    await userEvent.type(screen.getByLabelText('Display name'), ' local');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Happy local' }),
    );
    expect(changed).toHaveBeenCalledWith(saved);
  });

  it('keeps the applied snapshot when save fails', async () => {
    const initial = snapshot();
    const client: HelperClient = {
      load: vi.fn(async () => initial),
      save: vi.fn(async () => {
        throw new Error('Policy changed');
      }),
      reset: vi.fn(async () => initial),
    };
    render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry(styles),
        snapshot: initial,
      },
    });
    await userEvent.type(screen.getByLabelText('Display name'), ' changed');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Policy changed')).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('Happy changed');
    expect(screen.getByRole('alert')).toHaveTextContent('Policy changed');
  });

  it('moves the roving radio selection with arrow keys', async () => {
    const initial = snapshot();
    const client: HelperClient = {
      load: vi.fn(async () => initial),
      save: vi.fn(async () => initial),
      reset: vi.fn(async () => initial),
    };
    render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry(styles),
        snapshot: initial,
      },
    });
    const happy = screen.getByRole('radio', { name: 'Happy' });
    happy.focus();
    await userEvent.keyboard('{ArrowRight}');
    const photo = screen.getByRole('radio', { name: 'Saved photo' });
    expect(photo).toHaveAttribute('aria-checked', 'true');
    expect(photo).toHaveAttribute('tabindex', '0');
    expect(happy).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(photo);
  });

  it('selects a newly saved photo as a draft and focuses its gallery choice', async () => {
    const initial: HelperSnapshot = {
      ...snapshot(),
      permissions: {
        ...snapshot().permissions,
        customStyleIds: ['photo-cutout'],
      },
    };
    const created = {
      id: 'photo:2',
      label: 'Cedar · saved today',
      styleId: 'photo-cutout',
      source: 'saved' as const,
      assetId: '2',
    };
    const refreshed: HelperSnapshot = {
      ...initial,
      offerings: [...initial.offerings, created],
    };
    const client: HelperClient = {
      load: vi.fn(async () => refreshed),
      save: vi.fn(async () => initial),
      reset: vi.fn(async () => initial),
    };
    const setupStyle: HelperStyleDefinition = {
      id: 'photo-cutout',
      label: 'Photo',
      Setup: TestSetup,
      mount: () => ({ destroy() {}, setMouthOpen() {} }),
    };
    const changed = vi.fn();
    const view = render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry([styles[0], setupStyle]),
        snapshot: initial,
        onchanged: changed,
      },
    });
    await userEvent.type(screen.getByLabelText('Display name'), ' custom');
    const addPhoto = screen.getByRole('button', { name: 'Add Photo' });
    await userEvent.click(addPhoto);
    expect(
      screen.getByRole('button', { name: 'Back to helper settings' }),
    ).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Save photo' }));
    const cedar = await screen.findByRole('radio', {
      name: 'Cedar · saved today',
    });
    expect(cedar).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(cedar);
    expect(screen.getByLabelText('Display name')).toHaveValue('Happy custom');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(client.save).not.toHaveBeenCalled();
    expect(
      screen.getByText('Photo saved. Save settings to use it.'),
    ).toBeInTheDocument();
    // A host often echoes the callback through a new snapshot object. That
    // update must not turn the staged selection into an applied preference.
    expect(changed).toHaveBeenCalledWith(refreshed);
    await view.rerender({ snapshot: { ...refreshed } });
    expect(cedar).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Display name')).toHaveValue('Happy custom');
  });

  it('returns focus to the setup trigger when custom setup is cancelled', async () => {
    const initial: HelperSnapshot = {
      ...snapshot(),
      permissions: {
        ...snapshot().permissions,
        customStyleIds: ['photo-cutout'],
      },
    };
    const client: HelperClient = {
      load: vi.fn(async () => initial),
      save: vi.fn(async () => initial),
      reset: vi.fn(async () => initial),
    };
    const setupStyle: HelperStyleDefinition = {
      id: 'photo-cutout',
      label: 'Photo',
      Setup: TestSetup,
      mount: () => ({ destroy() {}, setMouthOpen() {} }),
    };
    render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry([styles[0], setupStyle]),
        snapshot: initial,
      },
    });
    const trigger = screen.getByRole('button', { name: 'Add Photo' });
    await userEvent.click(trigger);
    await userEvent.click(
      screen.getByRole('button', { name: 'Back to helper settings' }),
    );
    expect(trigger).toHaveFocus();
  });

  it('adopts a changed recovery draft after custom setup stages an offering', async () => {
    const recoveryDraft = {
      version: 1 as const,
      offeringId: 'happy',
      name: 'Initial recovery name',
      voiceId: 'calm',
      placement: 'bottom-right' as const,
      heardSubtitles: true,
      spokenSubtitles: false,
    };
    const initial: HelperSnapshot = {
      ...snapshot(),
      preferences: null,
      recoveryDraft,
      source: 'unavailable',
      permissions: {
        ...snapshot().permissions,
        customStyleIds: ['photo-cutout'],
      },
    };
    const created = {
      id: 'photo:2',
      label: 'Cedar · saved today',
      styleId: 'photo-cutout',
      source: 'saved' as const,
      assetId: '2',
    };
    const refreshed: HelperSnapshot = {
      ...initial,
      offerings: [...initial.offerings, created],
    };
    const client: HelperClient = {
      load: vi.fn(async () => refreshed),
      save: vi.fn(async () => refreshed),
      reset: vi.fn(async () => refreshed),
    };
    const setupStyle: HelperStyleDefinition = {
      id: 'photo-cutout',
      label: 'Photo',
      Setup: TestSetup,
      mount: () => ({ destroy() {}, setMouthOpen() {} }),
    };
    const view = render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry([styles[0], setupStyle]),
        snapshot: initial,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add Photo' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save photo' }));
    await screen.findByRole('radio', {
      name: 'Cedar · saved today',
      checked: true,
    });
    await view.rerender({
      snapshot: {
        ...refreshed,
        recoveryDraft: { ...recoveryDraft, name: 'Updated recovery name' },
      },
    });
    expect(screen.getByLabelText('Display name')).toHaveValue(
      'Updated recovery name',
    );
    expect(screen.getByRole('radio', { name: 'Happy' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('lets keyboard users replace a removed recovery offering without applying it early', async () => {
    const unavailable: HelperSnapshot = {
      ...snapshot(),
      preferences: null,
      offering: null,
      source: 'unavailable',
      hasOverride: true,
      recoveryDraft: {
        version: 1,
        offeringId: 'removed-photo',
        name: 'Happy',
        voiceId: 'calm',
        placement: 'bottom-right',
        heardSubtitles: true,
        spokenSubtitles: false,
      },
      recovery: {
        code: 'unavailable-offering',
        message: 'The old helper is unavailable.',
      },
    };
    const recovered: HelperSnapshot = {
      ...snapshot(),
      preferences: { ...snapshot().preferences!, offeringId: 'photo:1' },
      offering: snapshot().offerings[1],
      source: 'personal',
    };
    const client: HelperClient = {
      load: vi.fn(async () => unavailable),
      save: vi.fn(async () => recovered),
      reset: vi.fn(async () => recovered),
    };
    const changed = vi.fn();
    render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry(styles),
        snapshot: unavailable,
        onchanged: changed,
      },
    });
    expect(
      screen.getByText('The old helper is unavailable.'),
    ).toBeInTheDocument();
    const happy = screen.getByRole('radio', { name: 'Happy' });
    const photo = screen.getByRole('radio', { name: 'Saved photo' });
    expect(happy).toHaveAttribute('tabindex', '0');
    expect(photo).toHaveAttribute('tabindex', '-1');
    document.body.focus();
    await userEvent.tab();
    expect(happy).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(photo).toHaveFocus();
    expect(photo).toHaveAttribute('aria-checked', 'true');
    expect(client.save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(client.save).toHaveBeenCalledWith(
      expect.objectContaining({ offeringId: 'photo:1' }),
    );
    expect(changed).toHaveBeenCalledWith(recovered);
  });

  it('keeps an unavailable owner assignment locked without inventing recovery fields', () => {
    const assigned: HelperSnapshot = {
      ...snapshot(),
      preferences: null,
      offering: null,
      recoveryDraft: null,
      selection: 'owner-assigned',
      source: 'unavailable',
      permissions: { editableFields: [], canReset: false, customStyleIds: [] },
    };
    const client: HelperClient = {
      load: vi.fn(async () => assigned),
      save: vi.fn(),
      reset: vi.fn(),
    };
    render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry(styles),
        snapshot: assigned,
      },
    });
    expect(
      screen.queryByRole('button', { name: 'Save settings' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Reset to application defaults' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Happy' })).toBeDisabled();
  });

  it('mounts the selected offering preview and destroys stale async mounts once', async () => {
    const initial = snapshot();
    let resolveHappy!: (value: unknown) => void;
    let resolvePhoto!: (value: unknown) => void;
    const loadPayload = vi.fn(
      (offering: HelperOffering) =>
        new Promise<unknown>((resolve) => {
          if (offering.id === 'happy') resolveHappy = resolve;
          else resolvePhoto = resolve;
        }),
    );
    const happyDestroy = vi.fn();
    const photoDestroy = vi.fn();
    const previewStyles: HelperStyleDefinition[] = [
      {
        id: 'happy',
        label: 'Happy',
        mount: vi.fn(() => ({ destroy: happyDestroy, setMouthOpen() {} })),
      },
      {
        id: 'photo-cutout',
        label: 'Photo',
        mount: vi.fn(() => ({ destroy: photoDestroy, setMouthOpen() {} })),
      },
    ];
    const client: HelperClient = {
      load: vi.fn(async () => initial),
      save: vi.fn(async () => initial),
      reset: vi.fn(async () => initial),
    };
    const view = render(HelperControlPanel, {
      props: {
        client,
        registry: createHelperStyleRegistry(previewStyles),
        snapshot: initial,
        loadPayload,
      },
    });
    await vi.waitFor(() =>
      expect(loadPayload).toHaveBeenCalledWith(initial.offerings[0]),
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Saved photo' }));
    await vi.waitFor(() =>
      expect(loadPayload).toHaveBeenCalledWith(initial.offerings[1]),
    );
    resolvePhoto({ photo: true });
    await vi.waitFor(() =>
      expect(previewStyles[1].mount).toHaveBeenCalledOnce(),
    );
    resolveHappy({ happy: true });
    await vi.waitFor(() => expect(happyDestroy).toHaveBeenCalledOnce());
    view.unmount();
    expect(photoDestroy).toHaveBeenCalledOnce();
  });
});
