import {
  type HelperContext,
  type HelperOffering,
  type HelperPolicy,
  type HelperPreferenceField,
  type HelperPreferenceStore,
  type HelperPreferences,
  type HelperRecovery,
  type HelperSnapshot,
  isHelperClearedPreferences,
  parseHelperPreferences,
} from './helper-preferences.js';
export class HelperPreferencesAuthorizationError extends Error {
  constructor() {
    super('Helper preference access is not authorized.');
    this.name = 'HelperPreferencesAuthorizationError';
  }
}
export class HelperPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperPreferencesValidationError';
  }
}
export interface HelperPreferencesServiceOptions {
  store: HelperPreferenceStore;
  authorize(
    context: HelperContext,
    operation: 'load' | 'save' | 'reset',
  ): boolean | Promise<boolean>;
  resolvePolicy(context: HelperContext): HelperPolicy | Promise<HelperPolicy>;
  styleIds: readonly string[];
  validateOffering(
    context: HelperContext,
    offering: HelperOffering,
  ): void | Promise<void>;
}
export class HelperPreferencesService {
  readonly #o: HelperPreferencesServiceOptions;
  constructor(options: HelperPreferencesServiceOptions) {
    this.#o = options;
  }
  async load(c: HelperContext): Promise<HelperSnapshot> {
    await this.#auth(c, 'load');
    return this.#resolve(c, await this.#o.store.load(c));
  }
  async save(c: HelperContext, value: unknown): Promise<HelperSnapshot> {
    await this.#auth(c, 'save');
    const p = await this.#visiblePolicy(c, await this.#policy(c));
    if (p.selection === 'owner-assigned')
      throw new HelperPreferencesAuthorizationError();
    const next = parseHelperPreferences(value);
    if (!next)
      throw new HelperPreferencesValidationError(
        'Helper preferences are invalid.',
      );
    for (const f of this.#fields())
      if (!p.customizable.includes(f) && next[f] !== p.defaultPreferences[f])
        throw new HelperPreferencesValidationError(
          `The ${f} preference is not customizable.`,
        );
    await this.#validate(c, p, next);
    await this.#o.store.save(c, next);
    return this.#resolve(c, await this.#o.store.load(c));
  }
  async reset(c: HelperContext): Promise<HelperSnapshot> {
    await this.#auth(c, 'reset');
    const p = await this.#policy(c);
    if (p.selection === 'owner-assigned')
      throw new HelperPreferencesAuthorizationError();
    await this.#o.store.clear(c);
    return this.#resolve(c, await this.#o.store.load(c));
  }
  async #auth(c: HelperContext, op: 'load' | 'save' | 'reset') {
    if (!(await this.#o.authorize(c, op)))
      throw new HelperPreferencesAuthorizationError();
  }
  async #policy(c: HelperContext) {
    const p = await this.#o.resolvePolicy(c);
    if (
      !parseHelperPreferences(p.defaultPreferences) ||
      (p.assignedPreferences !== undefined &&
        !parseHelperPreferences(p.assignedPreferences))
    )
      throw new HelperPreferencesValidationError(
        'Helper policy preferences are invalid.',
      );
    return p;
  }
  async #resolve(c: HelperContext, raw: unknown): Promise<HelperSnapshot> {
    const p = await this.#visiblePolicy(c, await this.#policy(c));
    const permissions =
      p.selection === 'owner-assigned'
        ? { editableFields: [], canReset: false, customStyleIds: [] }
        : {
            editableFields: p.customizable,
            canReset: raw !== null && !this.#cleared(raw),
            customStyleIds: p.customStyleIds,
          };
    const assigned = p.selection === 'owner-assigned';
    if (assigned && !p.assignedPreferences)
      return this.#snapshot(p, permissions, null, 'unavailable', false, {
        code: 'invalid-preferences',
        message: 'The assigned helper preferences are unavailable.',
      });
    const baseline = assigned ? p.assignedPreferences! : p.defaultPreferences;
    const persisted = !assigned && raw !== null && !this.#cleared(raw);
    const parsed = assigned
      ? baseline
      : !persisted
        ? baseline
        : parseHelperPreferences(this.#decode(raw));
    if (!parsed) {
      try {
        await this.#validate(c, p, baseline);
        return this.#snapshot(p, permissions, baseline, 'default', true, {
          code: 'invalid-preferences',
          message:
            'Saved helper preferences are invalid. Reset to use current defaults.',
        });
      } catch (error) {
        if (error instanceof HelperPreferencesAuthorizationError) throw error;
        return this.#snapshot(p, permissions, null, 'unavailable', true, {
          code: 'invalid-preferences',
          message: 'The application default helper is unavailable.',
        });
      }
    }
    try {
      if (persisted)
        for (const f of this.#fields())
          if (!p.customizable.includes(f) && parsed[f] !== baseline[f])
            throw new HelperPreferencesValidationError('invalid-preferences');
      await this.#validate(c, p, parsed);
      return this.#snapshot(
        p,
        permissions,
        parsed,
        assigned ? 'assigned' : persisted ? 'personal' : 'default',
        persisted,
        null,
      );
    } catch (error) {
      if (error instanceof HelperPreferencesAuthorizationError) throw error;
      if (assigned)
        return this.#snapshot(p, permissions, null, 'unavailable', false, {
          code: 'invalid-preferences',
          message: 'The assigned helper preferences are unavailable.',
        });
      try {
        await this.#validate(c, p, baseline);
        return this.#snapshot(
          p,
          permissions,
          baseline,
          'default',
          persisted,
          this.#recovery(error),
        );
      } catch (fallbackError) {
        if (fallbackError instanceof HelperPreferencesAuthorizationError)
          throw fallbackError;
        return this.#snapshot(p, permissions, null, 'unavailable', persisted, {
          code: 'invalid-preferences',
          message: 'The application default helper is unavailable.',
        });
      }
    }
  }
  async #visiblePolicy(
    c: HelperContext,
    p: HelperPolicy,
  ): Promise<HelperPolicy> {
    const offerings: HelperOffering[] = [];
    for (const offering of p.offerings) {
      if (!this.#o.styleIds.includes(offering.styleId)) continue;
      try {
        await this.#o.validateOffering(c, offering);
        offerings.push(offering);
      } catch (error) {
        if (error instanceof HelperPreferencesAuthorizationError) throw error;
      }
    }
    return { ...p, offerings };
  }
  #decode(raw: unknown) {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  #cleared(raw: unknown) {
    return isHelperClearedPreferences(
      typeof raw === 'string' ? this.#decode(raw) : raw,
    );
  }
  async #validate(c: HelperContext, p: HelperPolicy, next: HelperPreferences) {
    const offering = p.offerings.find((x) => x.id === next.offeringId);
    if (!offering)
      throw new HelperPreferencesValidationError('unavailable-offering');
    if (!this.#o.styleIds.includes(offering.styleId))
      throw new HelperPreferencesValidationError('unavailable-style');
    if (!p.voices.some((x) => x.id === next.voiceId))
      throw new HelperPreferencesValidationError('unavailable-voice');
    await this.#o.validateOffering(c, offering);
  }
  #recovery(error: unknown): HelperRecovery {
    const code =
      error instanceof HelperPreferencesValidationError &&
      [
        'unavailable-offering',
        'unavailable-style',
        'unavailable-voice',
      ].includes(error.message)
        ? (error.message as HelperRecovery['code'])
        : 'invalid-preferences';
    return {
      code,
      message:
        'Saved helper preferences are no longer available. Reset to use current defaults.',
    };
  }
  #snapshot(
    p: HelperPolicy,
    permissions: HelperSnapshot['permissions'],
    prefs: HelperPreferences | null,
    source: HelperSnapshot['source'],
    hasOverride: boolean,
    recovery: HelperRecovery | null,
  ): HelperSnapshot {
    return {
      preferences: prefs,
      recoveryDraft:
        prefs === null && p.selection !== 'owner-assigned'
          ? this.#recoveryDraft(p, permissions)
          : null,
      offering: prefs
        ? (p.offerings.find((x) => x.id === prefs.offeringId) ?? null)
        : null,
      selection: p.selection,
      source,
      offerings: p.offerings,
      voices: p.voices,
      permissions,
      hasOverride,
      recovery,
    };
  }
  #recoveryDraft(
    p: HelperPolicy,
    permissions: HelperSnapshot['permissions'],
  ): HelperPreferences | null {
    const candidate = { ...p.defaultPreferences };
    const offering = p.offerings.find(
      (item) => item.id === candidate.offeringId,
    );
    if (!offering) {
      if (!permissions.editableFields.includes('offeringId') || !p.offerings[0])
        return null;
      candidate.offeringId = p.offerings[0].id;
    }
    if (!p.voices.some((voice) => voice.id === candidate.voiceId)) {
      if (!permissions.editableFields.includes('voiceId') || !p.voices[0])
        return null;
      candidate.voiceId = p.voices[0].id;
    }
    return parseHelperPreferences(candidate);
  }
  #fields(): readonly HelperPreferenceField[] {
    return [
      'offeringId',
      'name',
      'voiceId',
      'placement',
      'heardSubtitles',
      'spokenSubtitles',
    ];
  }
}
