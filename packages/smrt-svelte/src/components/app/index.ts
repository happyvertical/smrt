/**
 * @happyvertical/smrt-svelte/app
 *
 * Packaged application shell and first-run owner setup UI. Browser-only: no
 * server or `$app/*` imports. Pair with the server `load`/`actions` from
 * `@happyvertical/smrt-app-runtime/sveltekit`.
 */

export {
  type ShellLayout,
  ShellLayoutController,
  ShellLayoutEditor,
  type ShellSectionActionsContext,
  tryUseShellLayout,
  useShellLayout,
} from '../workspace/index.js';
export { default as AppShell } from './AppShell.svelte';
export type { DockToggle } from './dock-toggle.js';
export { default as OwnerSetupForm } from './OwnerSetupForm.svelte';
export type {
  OwnerSetupData,
  OwnerSetupFormResult,
} from './owner-setup-types.js';
export { default as RuntimeDiagnosticsWebMcp } from './RuntimeDiagnosticsWebMcp.svelte';
export {
  createRuntimeDiagnosticsWebMcpTool,
  type RegisterRuntimeDiagnosticsWebMcpOptions,
  RUNTIME_DIAGNOSTICS_ENDPOINT,
  RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME,
  type RuntimeDiagnosticsWebMcpOwner,
  registerRuntimeDiagnosticsWebMcp,
} from './runtime-diagnostics-webmcp.js';
export { default as ShellSettingsPage } from './ShellSettingsPage.svelte';
export type { ShellSlotItem } from './slot-item.js';
