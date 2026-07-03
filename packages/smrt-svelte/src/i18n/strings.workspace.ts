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

  // components/workspace/admin-shell/*
  'ui.admin_shell.no_focus_tools': 'No focus tools',
  'ui.admin_shell.no_app_panel': 'No app panel',
  'ui.admin_shell.no_system_panel': 'No system panel',
  'ui.admin_shell.shell_shortcuts': 'Shell shortcuts',
  'ui.admin_shell.close_shortcuts': 'Close shortcuts',
  'ui.admin_shell.shortcuts': 'Shortcuts',
  'ui.admin_shell.close': 'Close',
  'ui.activity_toasts.dismiss': 'Dismiss activity notification',
  'ui.activity_toasts.dismiss_action': 'Dismiss',
  'ui.activity_item.view': 'View',
  'ui.activity_item.cancel': 'Cancel',
  'ui.activity_list.empty': 'No activities',
  'ui.app_scope_panel.app_scope': 'App scope',
  'ui.hotkey_input.capture_title': 'Press a key to capture it',
  'ui.hotkey_input.conflicts_with': 'Conflicts with',
  'ui.shell_settings_panel.shell_settings': 'Shell settings',
  'ui.shell_settings_panel.description':
    'Panel preferences and physical-key shortcuts.',
  'ui.shell_settings_panel.disable_hotkeys': 'Disable hotkeys',
  'ui.shell_settings_panel.enable_hotkeys': 'Enable hotkeys',
  'ui.shell_settings_panel.collapse': 'Collapse',
  'ui.shell_settings_panel.expand': 'Expand',
  'ui.shortcuts_overlay.open_shortcuts': 'Open shortcuts',
  'ui.shortcuts_overlay.close_drawer': 'Close drawer',
  'ui.shortcuts_overlay.close': 'Close',
  'ui.shortcuts_overlay.escape': 'Esc',
  'ui.system_scope_panel.system_scope': 'System scope',
  'ui.system_scope_panel.activities': 'Activities',
  'ui.system_scope_panel.no_running_work': 'No running work',
  'ui.system_status_chips.system_status': 'System status',
  'ui.tenant_nav.tenant_navigation': 'Tenant navigation',

  // components/workspace/live/* (systemFeed demo — issue #1774)
  'ui.system_feed.title': 'System feed',
  'ui.system_feed.description':
    'Polls an app-provided status endpoint and maps it into the system-scope panels and status chips.',
  'ui.system_feed.pause': 'Pause polling',
  'ui.system_feed.resume': 'Resume polling',
  'ui.system_feed.refresh': 'Refresh now',
  'ui.system_feed.fail_next': 'Fail next fetch',
  'ui.system_feed.status_label': 'Feed status',
  'ui.system_feed.tick_label': 'Ticks',
  'ui.system_feed.error_label': 'Last error',
  'ui.system_feed.jobs_panel': 'Jobs',
  'ui.system_feed.schedules_panel': 'Schedules',
  'ui.system_feed.dispatch_panel': 'Dispatch',
  'ui.system_feed.chip_workers': 'Workers',
  'ui.system_feed.chip_running': 'Running',
  'ui.system_feed.chip_queued': 'Queued',
  'ui.system_feed.chip_failed': 'Failed',
});
