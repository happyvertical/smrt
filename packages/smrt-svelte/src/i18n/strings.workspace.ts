/**
 * Workspace / admin / browser-AI message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in the workspace shell, admin
 * panels, and browser-AI test components. Keys use the `ui` namespace and follow
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

  // components/admin/AgentAdminPanel.svelte
  'ui.agent_admin_panel.no_panel_message': 'No admin panel registered for',
  'ui.agent_admin_panel.no_panel_hint':
    "Import the agent's admin package to register its panels.",

  // components/admin/AgentAdminTabs.svelte
  'ui.agent_admin_tabs.no_slots':
    'No configuration slots available for this agent.',
  'ui.agent_admin_tabs.tablist_label': 'Agent configuration tabs',

  // components/admin/AgentSettingsShell.svelte
  'ui.agent_settings_shell.no_agents_message':
    'No agents configured for this site.',
  'ui.agent_settings_shell.no_agents_hint':
    'Agents are discovered by matching their context field to the site domain.',

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
