import { describe, expect, it, vi } from 'vitest';
import type {
  HelperContext,
  HelperPolicy,
  HelperPreferenceStore,
  HelperPreferences,
} from './helper-preferences.js';
import {
  HelperPreferencesAuthorizationError,
  HelperPreferencesService,
  HelperPreferencesValidationError,
} from './helper-preferences-service.js';

const context: HelperContext = {
  actorProfileId: 'actor-1',
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  applicationId: 'app-1',
};

const defaults: HelperPreferences = {
  version: 1,
  offeringId: 'happy',
  name: 'Happy',
  voiceId: 'marin',
  placement: 'bottom-right',
  heardSubtitles: true,
  spokenSubtitles: true,
};

function policy(
  selection: HelperPolicy['selection'] = 'personal',
): HelperPolicy {
  return {
    selection,
    defaultPreferences: defaults,
    ...(selection === 'owner-assigned'
      ? { assignedPreferences: { ...defaults, name: 'Assigned' } }
      : {}),
    offerings: [
      { id: 'happy', label: 'Happy', styleId: 'happy', source: 'ready-made' },
      {
        id: 'photo:one',
        label: 'Photo',
        styleId: 'photo-cutout',
        source: 'saved',
        assetId: 'asset-1',
      },
    ],
    voices: [
      { id: 'marin', label: 'Marin' },
      { id: 'cedar', label: 'Cedar' },
    ],
    customizable: [
      'offeringId',
      'name',
      'voiceId',
      'placement',
      'heardSubtitles',
      'spokenSubtitles',
    ],
    customStyleIds: ['happy', 'photo-cutout'],
  };
}

function store(
  raw: unknown | null = null,
): HelperPreferenceStore & { value: unknown | null } {
  return {
    value: raw,
    load: vi.fn(async function (this: { value: unknown | null }) {
      return this.value;
    }),
    save: vi.fn(async function (
      this: { value: unknown | null },
      _context,
      value,
    ) {
      this.value = value;
    }),
    clear: vi.fn(async function (this: { value: unknown | null }) {
      this.value = { version: 1, override: null };
    }),
  };
}

describe('HelperPreferencesService', () => {
  it('denies every operation without an authorization callback', async () => {
    const service = new HelperPreferencesService({
      store: store(),
      resolvePolicy: policy,
      authorize: () => false,
      styleIds: ['happy', 'photo-cutout'],
      validateOffering: () => {},
    });
    await expect(service.load(context)).rejects.toBeInstanceOf(
      HelperPreferencesAuthorizationError,
    );
  });

  it('persists a whole personal preference value and revalidates it on reload', async () => {
    const persistence = store();
    const service = new HelperPreferencesService({
      store: persistence,
      resolvePolicy: policy,
      authorize: () => true,
      styleIds: ['happy', 'photo-cutout'],
      validateOffering: () => {},
    });
    const chosen = {
      ...defaults,
      offeringId: 'photo:one',
      voiceId: 'cedar',
      name: 'Ada',
    };
    await expect(service.save(context, chosen)).resolves.toMatchObject({
      preferences: chosen,
      hasOverride: true,
    });
    expect(persistence.value).toEqual(chosen);
    await expect(service.load(context)).resolves.toMatchObject({
      preferences: chosen,
    });
  });

  it('rejects unknown keys and unavailable voice/offering values before writes', async () => {
    const persistence = store();
    const service = new HelperPreferencesService({
      store: persistence,
      resolvePolicy: policy,
      authorize: () => true,
      styleIds: ['happy', 'photo-cutout'],
      validateOffering: () => {},
    });
    await expect(
      service.save(context, {
        ...defaults,
        voiceId: 'forged',
        providerUrl: 'https://example.test',
      }),
    ).rejects.toBeInstanceOf(HelperPreferencesValidationError);
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it('limits app defaults with personal override to declared customizable fields', async () => {
    const persistence = store();
    const service = new HelperPreferencesService({
      store: persistence,
      resolvePolicy: () => ({
        ...policy('app-default-with-personal-override'),
        customizable: ['name', 'placement', 'spokenSubtitles'],
      }),
      authorize: () => true,
      styleIds: ['happy', 'photo-cutout'],
      validateOffering: () => {},
    });
    await expect(
      service.save(context, {
        ...defaults,
        name: 'Ada',
        placement: 'bottom-left',
      }),
    ).resolves.toMatchObject({
      preferences: { name: 'Ada', placement: 'bottom-left' },
    });
    await expect(
      service.save(context, { ...defaults, offeringId: 'photo:one' }),
    ).rejects.toThrow('offeringId');
  });

  it('uses assigned preferences and rejects personal changes for owner-assigned policy', async () => {
    const persistence = store({ version: 1, override: { name: 'Forged' } });
    const service = new HelperPreferencesService({
      store: persistence,
      resolvePolicy: () => policy('owner-assigned'),
      authorize: () => true,
      styleIds: ['happy', 'photo-cutout'],
      validateOffering: () => {},
    });
    await expect(service.load(context)).resolves.toMatchObject({
      preferences: { name: 'Assigned' },
      hasOverride: false,
    });
    await expect(service.save(context, defaults)).rejects.toBeInstanceOf(
      HelperPreferencesAuthorizationError,
    );
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it('returns an explicit resettable snapshot when stored metadata becomes invalid under changed policy', async () => {
    const persistence = store(
      JSON.stringify({ ...defaults, offeringId: 'photo:one' }),
    );
    const changed = policy();
    changed.offerings = [changed.offerings[0]];
    const service = new HelperPreferencesService({
      store: persistence,
      resolvePolicy: () => changed,
      authorize: () => true,
      styleIds: ['happy', 'photo-cutout'],
      validateOffering: () => {},
    });
    await expect(service.load(context)).resolves.toMatchObject({
      preferences: defaults,
      recovery: { code: 'unavailable-offering' },
    });
    await service.reset(context);
    expect(persistence.clear).toHaveBeenCalledWith(context);
  });

  it('filters malformed, unregistered, and denied gallery offerings before exposing a snapshot', async () => {
    const persistence = store({ ...defaults, offeringId: 'photo:one' });
    const offered = policy();
    offered.offerings = [
      ...offered.offerings,
      {
        id: 'bad-style',
        label: 'Bad',
        styleId: 'not-registered',
        source: 'ready-made',
      },
    ];
    const service = new HelperPreferencesService({
      store: persistence,
      resolvePolicy: () => offered,
      authorize: () => true,
      styleIds: ['happy', 'photo-cutout'],
      validateOffering: (_context, offering) => {
        if (offering.id === 'photo:one') throw new Error('asset unavailable');
      },
    });
    await expect(service.load(context)).resolves.toMatchObject({
      offerings: [{ id: 'happy' }],
      preferences: defaults,
      recovery: { code: 'unavailable-offering' },
    });
    await expect(
      service.save(context, { ...defaults, offeringId: 'photo:one' }),
    ).rejects.toBeInstanceOf(HelperPreferencesValidationError);
  });

  it('does not substitute defaults when an owner assignment is absent', async () => {
    const assigned = policy('owner-assigned');
    delete assigned.assignedPreferences;
    const service = new HelperPreferencesService({
      store: store(),
      resolvePolicy: () => assigned,
      authorize: () => true,
      styleIds: ['happy'],
      validateOffering: () => {},
    });
    await expect(service.load(context)).resolves.toMatchObject({
      source: 'unavailable',
      preferences: null,
    });
  });

  it('propagates authorization failures from selected offering validation', async () => {
    const service = new HelperPreferencesService({
      store: store({ ...defaults }),
      resolvePolicy: policy,
      authorize: () => true,
      styleIds: ['happy'],
      validateOffering: () => {
        throw new HelperPreferencesAuthorizationError();
      },
    });
    await expect(service.load(context)).rejects.toBeInstanceOf(
      HelperPreferencesAuthorizationError,
    );
  });

  it('provides a complete editable recovery draft without changing locked values', async () => {
    const persistence = store({ ...defaults, offeringId: 'removed' });
    const unavailableDefault = policy('app-default-with-personal-override');
    unavailableDefault.defaultPreferences = {
      ...defaults,
      offeringId: 'removed',
    };
    unavailableDefault.customizable = ['offeringId'];
    const service = new HelperPreferencesService({
      store: persistence,
      resolvePolicy: () => unavailableDefault,
      authorize: () => true,
      styleIds: ['happy'],
      validateOffering: () => {},
    });
    const snapshot = await service.load(context);
    expect(snapshot).toMatchObject({
      preferences: null,
      recoveryDraft: { offeringId: 'happy', name: 'Happy', voiceId: 'marin' },
    });
    await expect(
      service.save(context, snapshot.recoveryDraft),
    ).resolves.toMatchObject({
      preferences: { offeringId: 'happy', name: 'Happy', voiceId: 'marin' },
    });
  });
});
