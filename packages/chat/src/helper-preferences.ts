/** Browser-safe helper preference DTOs. */
export const HELPER_PREFERENCES_VERSION = 1 as const;
export type HelperSelectionPolicy =
  | 'owner-assigned'
  | 'personal'
  | 'app-default-with-personal-override';
export type HelperPlacement = 'bottom-left' | 'bottom-right';
export interface HelperPreferences {
  version: 1;
  offeringId: string;
  name: string;
  voiceId: string;
  placement: HelperPlacement;
  heardSubtitles: boolean;
  spokenSubtitles: boolean;
}
export type HelperPreferenceField = Exclude<keyof HelperPreferences, 'version'>;
export interface HelperOffering {
  id: string;
  label: string;
  styleId: string;
  source: 'ready-made' | 'saved';
  assetId?: string;
}
export interface HelperVoiceOption {
  id: string;
  label: string;
}
export interface HelperPolicy {
  selection: HelperSelectionPolicy;
  defaultPreferences: HelperPreferences;
  assignedPreferences?: HelperPreferences;
  offerings: readonly HelperOffering[];
  voices: readonly HelperVoiceOption[];
  customizable: readonly HelperPreferenceField[];
  customStyleIds: readonly string[];
}
export interface HelperContext {
  actorProfileId: string;
  profileId: string;
  tenantId: string | null;
  applicationId: string;
}
export interface HelperPermissions {
  editableFields: readonly HelperPreferenceField[];
  canReset: boolean;
  customStyleIds: readonly string[];
}
export interface HelperRecovery {
  code:
    | 'invalid-preferences'
    | 'unavailable-offering'
    | 'unavailable-style'
    | 'unavailable-voice';
  message: string;
}
export interface HelperSnapshot {
  preferences: HelperPreferences | null;
  /**
   * A server-derived edit candidate after an unavailable non-owner selection.
   * It is never effective or applied until `HelperClient.save()` succeeds.
   */
  recoveryDraft?: HelperPreferences | null;
  offering: HelperOffering | null;
  selection: HelperSelectionPolicy;
  source: 'default' | 'assigned' | 'personal' | 'unavailable';
  offerings: readonly HelperOffering[];
  voices: readonly HelperVoiceOption[];
  permissions: HelperPermissions;
  hasOverride: boolean;
  recovery: HelperRecovery | null;
}
export interface HelperClient {
  load(): Promise<HelperSnapshot>;
  save(preferences: HelperPreferences): Promise<HelperSnapshot>;
  reset(): Promise<HelperSnapshot>;
}
export interface HelperClearedPreferences {
  version: 1;
  cleared: true;
}
export const HELPER_CLEARED_PREFERENCES: HelperClearedPreferences =
  Object.freeze({ version: 1, cleared: true });
export interface HelperPreferenceStore {
  load(context: HelperContext): Promise<unknown | null>;
  save(context: HelperContext, preferences: HelperPreferences): Promise<void>;
  clear(context: HelperContext): Promise<void>;
}
const fields = [
  'offeringId',
  'name',
  'voiceId',
  'placement',
  'heardSubtitles',
  'spokenSubtitles',
] as const satisfies readonly HelperPreferenceField[];
const preferenceKeys = ['version', ...fields] as const;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).every((key) => keys.includes(key));
const text = (v: unknown) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
export function parseHelperPreferences(
  value: unknown,
): HelperPreferences | null {
  if (
    !record(value) ||
    !only(value, preferenceKeys) ||
    value.version !== 1 ||
    !text(value.offeringId) ||
    typeof value.name !== 'string' ||
    value.name.length > 256 ||
    !text(value.voiceId) ||
    (value.placement !== 'bottom-left' && value.placement !== 'bottom-right') ||
    typeof value.heardSubtitles !== 'boolean' ||
    typeof value.spokenSubtitles !== 'boolean'
  )
    return null;
  return value as unknown as HelperPreferences;
}
export function isHelperClearedPreferences(
  value: unknown,
): value is HelperClearedPreferences {
  return (
    record(value) &&
    only(value, ['version', 'cleared']) &&
    value.version === 1 &&
    value.cleared === true
  );
}
export function helperPreferenceFields(): readonly HelperPreferenceField[] {
  return fields;
}
