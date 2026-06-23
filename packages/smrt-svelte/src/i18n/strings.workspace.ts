/**
 * Workspace / browser-AI message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in the workspace shell and
 * browser-AI test components. (The agent-admin shells + their `ui.agent_admin_*`
 * keys moved to `@happyvertical/smrt-agents` in #1589.) Keys use the `ui`
 * namespace and follow
 * `ui.<component_snake>.<descriptor_snake>`. Client-safe (no languages root
 * import). Registered via `defineMessages` so the client `t` / `<Trans>` fall
 * back to these defaults when no server snapshot is present.
 */

import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // browser-ai/svelte/components/STTTest.svelte
  'ui.stt_test.heading': 'STT Adapter Test',
  'ui.stt_test.adapter_browser': 'Browser (Web Speech API)',
  'ui.stt_test.adapter_whisper_wasm': 'Whisper WASM (v2)',
  'ui.stt_test.adapter_whisper_cpp': 'Whisper CPP',
  'ui.stt_test.status_initializing': 'Initializing...',
  'ui.stt_test.status_ready': 'Ready',
  'ui.stt_test.status_not_initialized': 'Not initialized',

  // components/workspace/WorkspaceShell.svelte
  'ui.workspace_shell.close_navigation': 'Close navigation',
  'ui.workspace_shell.close_inspector': 'Close inspector',
  'ui.workspace_shell.primary_navigation': 'Primary navigation',
  'ui.workspace_shell.workspace_navigation': 'Workspace navigation',
  'ui.workspace_shell.inspector_tools': 'Inspector tools',

  // components/workspace/tools-dock/ToolsDock.svelte
  'ui.tools_dock.no_tools_available': 'No tools available',
  'ui.tools_dock.no_tools_context':
    'No tools are available for the current context.',
  'ui.tools_dock.select_tool': 'Select a tool to begin.',
  'ui.tools_dock.workspace_tools': 'Workspace tools',
});
