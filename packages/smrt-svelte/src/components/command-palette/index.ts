/**
 * @happyvertical/smrt-svelte/command-palette
 *
 * Global search and command palette (#3713): a shell-slot trigger, a modal
 * palette, a provider contract, and providers derived from the shell nav and
 * the SMRT manifest.
 */
export { default as CommandPalette } from './CommandPalette.svelte';
export { default as CommandPaletteDialog } from './CommandPaletteDialog.svelte';
export { default as CommandPaletteTrigger } from './CommandPaletteTrigger.svelte';
export {
  COMMAND_PALETTE_CONTEXT,
  setCommandPalette,
  tryUseCommandPalette,
  useCommandPalette,
} from './context.js';
export {
  CommandPaletteController,
  type CommandPaletteOptions,
  createCommandPalette,
} from './controller.svelte.js';
export {
  ariaKeyShortcuts,
  DEFAULT_PALETTE_HOTKEYS,
  formatPaletteHotkey,
  isApplePlatform,
  isPaletteHotkeyEvent,
  matchesPaletteHotkey,
  type PaletteHotkey,
  parsePaletteHotkey,
} from './hotkeys.js';
export {
  highlightSegments,
  type ItemMatch,
  matchItem,
  matchText,
  type TextMatch,
} from './match.js';
export {
  createModelProviders,
  createNavigationProvider,
  type ModelProvidersOptions,
  type NavigationProviderOptions,
  type PaletteManifestEntryLike,
  type PaletteManifestFieldLike,
  type PaletteManifestLike,
  type PaletteModel,
  type PaletteRecordRow,
  type PaletteRecordSearch,
  paletteModelsFromManifest,
} from './providers.js';
export {
  buildPaletteSections,
  DEFAULT_MAX_PER_GROUP,
  flattenSections,
  orderProviders,
  type RankInput,
} from './rank.js';
export type {
  MatchRange,
  PaletteErrorContext,
  PaletteItem,
  PaletteItemKind,
  PaletteItemsContext,
  PaletteProvider,
  PaletteResult,
  PaletteRunContext,
  PaletteSearchContext,
  PaletteSection,
} from './types.js';
export { useCommandPaletteProvider } from './use-provider.svelte.js';
