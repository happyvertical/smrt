/**
 * The app's transcript setting (#4781): stored as the app-scope
 * `transcripts` row of `_smrt_inference_overrides` and applied as core's
 * transcript app settings layer (`setAiTranscriptAppSettings()`), between
 * `config()` and `SMRT_INFERENCE_TRANSCRIPTS`. Tenants cannot override it.
 *
 * A write through `InferenceSettingsService.setTranscriptSettings()` applies
 * in its own process at once; the override resolver re-applies the row
 * whenever it reads rows (within its TTL), and processes without it call
 * {@link loadInferenceTranscriptSettings} at startup.
 */
import {
  type SmrtClassOptions,
  type SmrtCollectionOptions,
  setAiTranscriptAppSettings,
} from '@happyvertical/smrt-core';
import {
  APP_INFERENCE_SCOPE_ID,
  type InferenceOverride,
} from '../models/InferenceOverride.js';
import { InferenceOverrideCollection } from '../models/InferenceOverrideCollection.js';
import {
  type InferenceTranscriptSettingsValue,
  TRANSCRIPTS_BINDING,
} from './targets.js';

/** The stored value of the app's `transcripts` row, or `null`. */
export function storedTranscriptSettings(
  appRows: ReadonlyMap<string, InferenceOverride>,
): InferenceTranscriptSettingsValue | null {
  const row = appRows.get(TRANSCRIPTS_BINDING);
  if (!row) return null;
  try {
    return (row.getValue() as InferenceTranscriptSettingsValue | null) ?? null;
  } catch {
    // A row that no longer validates never takes effect.
    return null;
  }
}

/**
 * Install the stored app row as core's transcript app settings layer
 * (`null` clears it, so a removed row reverts to config). Returns it.
 */
export function applyStoredTranscriptSettings(
  appRows: ReadonlyMap<string, InferenceOverride>,
): InferenceTranscriptSettingsValue | null {
  const value = storedTranscriptSettings(appRows);
  setAiTranscriptAppSettings(value);
  return value;
}

/**
 * Read the app's stored transcript setting and install it as core's app
 * settings layer. Call once at startup in a process that makes AI calls
 * without the override resolver (a worker); the resolver keeps it current
 * otherwise.
 */
export async function loadInferenceTranscriptSettings(
  options: {
    db?: SmrtClassOptions;
    overrides?: InferenceOverrideCollection;
  } = {},
): Promise<InferenceTranscriptSettingsValue | null> {
  const overrides =
    options.overrides ??
    ((await InferenceOverrideCollection.create({
      ...(options.db ?? {}),
      defaultListLimit: undefined,
      maxListLimit: undefined,
    } as SmrtCollectionOptions)) as InferenceOverrideCollection);
  return applyStoredTranscriptSettings(
    await overrides.getScopeMap('app', APP_INFERENCE_SCOPE_ID),
  );
}
