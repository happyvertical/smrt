/**
 * @happyvertical/smrt-prompts/svelte
 *
 * Optional Svelte 5 UI for prompt management. Presentational only: the panel
 * takes rows and callbacks, does no fetching, and makes no authorization
 * decision. Hosts render it from a server load that used
 * `PromptSettingsService` and wire saves to their own permission-checked
 * route. The root `@happyvertical/smrt-prompts` export stays Svelte-free.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import PromptSettingsPanel from './components/PromptSettingsPanel.svelte';

export { PromptSettingsPanel };
export type PromptSettingsPanelProps = ComponentProps<
  typeof PromptSettingsPanel
>;

export {
  appRevertPreview,
  isTemplateEditable,
  type PromptSettingsChange,
  type PromptSettingsSupplyingLevel,
  type PromptSettingsView,
  supplyingLevelLabel,
  tenantRevertPreview,
} from './types.js';
