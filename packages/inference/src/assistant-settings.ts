/**
 * The assistant's ordinary settings (#5005), edited in the inference settings
 * panel and stored by smrt-preferences' `assistant-settings` kind. App-wide
 * owner choices; never accepted from a model. Every setting defaults on.
 * Browser-safe.
 */

export interface AssistantSettings {
  /**
   * When chat asks for a tool limited to workflow runs, hand the request to a
   * workflow run instead of refusing it.
   */
  escalateToWorkflow?: boolean;
  /** Show a workflow run's proposed changes before applying them. */
  previewBeforeApply?: boolean;
  /** Ask the owner before chat deletes or removes anything. */
  requireRemovalApproval?: boolean;
  /** Run Claude Code and Codex in the app's protected tool setup. */
  protectLocalCli?: boolean;
}

/** The setting names, in display order. */
export const ASSISTANT_SETTING_KEYS = [
  'escalateToWorkflow',
  'previewBeforeApply',
  'requireRemovalApproval',
  'protectLocalCli',
] as const satisfies readonly (keyof AssistantSettings)[];

/** Every setting resolved: an absent one is on. */
export function resolveAssistantSettings(
  settings: AssistantSettings | null | undefined,
): Required<AssistantSettings> {
  return {
    escalateToWorkflow: settings?.escalateToWorkflow !== false,
    previewBeforeApply: settings?.previewBeforeApply !== false,
    requireRemovalApproval: settings?.requireRemovalApproval !== false,
    protectLocalCli: settings?.protectLocalCli !== false,
  };
}

/** True when `value` holds only known settings, each a boolean. */
export function isAssistantSettings(
  value: unknown,
): value is AssistantSettings {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, setting]) =>
        (ASSISTANT_SETTING_KEYS as readonly string[]).includes(key) &&
        typeof setting === 'boolean',
    )
  );
}
