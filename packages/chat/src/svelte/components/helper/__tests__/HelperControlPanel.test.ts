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
    const initial = snapshot();
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
    await userEvent.click(
      screen.getByRole('button', { name: 'Save settings' }),
    );
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
    await userEvent.click(
      screen.getByRole('button', { name: 'Save settings' }),
    );
    expect(await screen.findByText('Policy changed')).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('Happy');
  });

  it('keeps reset reachable when an unavailable stored selection has no effective preferences', async () => {
    const unavailable: HelperSnapshot = {
      ...snapshot(),
      preferences: null,
      offering: null,
      source: 'unavailable',
      hasOverride: true,
      recovery: {
        code: 'unavailable-offering',
        message: 'Saved helper is unavailable.',
      },
    };
    const recovered = snapshot();
    const client: HelperClient = {
      load: vi.fn(async () => unavailable),
      save: vi.fn(),
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
      screen.getByText('Saved helper is unavailable.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reset to application defaults' }),
    ).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Save settings' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Reset to application defaults' }),
    );
    expect(client.reset).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(recovered);
  });

  it('locks an owner-assigned helper without a save action', () => {
    const assigned: HelperSnapshot = {
      ...snapshot(),
      selection: 'owner-assigned',
      source: 'assigned',
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
    expect(screen.getByLabelText('Display name')).toBeDisabled();
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
