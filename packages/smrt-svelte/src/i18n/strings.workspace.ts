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
  'ui.admin_shell.focus_tools': 'Focus tools',
  'ui.admin_shell.no_app_panel': 'No app panel',
  'ui.admin_shell.no_system_panel': 'No system panel',
  'ui.admin_shell.shell_shortcuts': 'Shell shortcuts',
  'ui.admin_shell.close_shortcuts': 'Close shortcuts',
  'ui.admin_shell.shortcuts': 'Shortcuts',
  'ui.admin_shell.close': 'Close',
  'ui.admin_shell.home': 'Home',
  'ui.admin_shell.menu': 'Menu',
  'ui.admin_shell.expand_panel': 'Expand {panel}',
  'ui.admin_shell.collapse_panel': 'Collapse {panel}',
  'ui.admin_shell.close_panel': 'Close {label}',
  'ui.admin_shell.open_panel': 'Open {label}',
  'ui.admin_shell.resize_panel': 'Resize {label}',
  'ui.shell_nav_toggle.collapse': 'Collapse {label}',
  'ui.shell_nav_toggle.expand': 'Expand {label}',
  'ui.shell_nav_toggle.navigation': 'navigation',
  'ui.phone_top_bar.back': 'Back to {label}',
  'ui.phone_bottom_bar.label': 'Main',
  'ui.phone_bottom_bar.unread': '{count} unread',
  'ui.phone_bottom_bar.new': 'new',
  'ui.activity_toasts.dismiss': 'Dismiss activity notification',
  'ui.activity_toasts.dismiss_action': 'Dismiss',
  'ui.activity_item.view': 'View',
  'ui.activity_item.cancel': 'Cancel',
  'ui.activity_list.empty': 'No activities',
  'ui.activity_ticker.label': 'Running processes',
  'ui.activity_ticker.empty': 'No active processes',
  'ui.activity_ticker.pause': 'Pause scrolling activities',
  'ui.activity_ticker.resume': 'Resume scrolling activities',
  'ui.activity_ticker.queued': 'Queued',
  'ui.app_scope_panel.app_scope': 'App scope',

  // components/app/*.svelte
  'ui.app_shell.settings_link': 'Shell settings',
  'ui.app_shell.navigation': 'Application navigation',
  'ui.app_shell.slot_content': '{slot} content',
  'ui.shell_slot.header_start': 'Header, left',
  'ui.shell_slot.header_center': 'Header, middle',
  'ui.shell_slot.header_end': 'Header, right',
  'ui.shell_slot.footer_start': 'Footer, left',
  'ui.shell_slot.footer_center': 'Footer, middle',
  'ui.shell_slot.footer_end': 'Footer, right',
  'ui.shell_slot.left_sidebar_header': 'Left sidebar, header',
  'ui.shell_slot.left_sidebar_footer': 'Left sidebar, footer',
  'ui.shell_slot.right_sidebar_header': 'Right sidebar, header',
  'ui.shell_slot.right_sidebar_footer': 'Right sidebar, footer',
  'ui.shell_slot.short_header_start': 'Left',
  'ui.shell_slot.short_header_center': 'Middle',
  'ui.shell_slot.short_header_end': 'Right',
  'ui.shell_slot.short_footer_start': 'Left',
  'ui.shell_slot.short_footer_center': 'Middle',
  'ui.shell_slot.short_footer_end': 'Right',
  'ui.shell_slot.short_sidebar_header': 'Header',
  'ui.shell_slot.short_sidebar_footer': 'Footer',
  'ui.owner_setup.heading': 'Set up your local application',
  'ui.owner_setup.unavailable':
    'Local owner setup is unavailable or has already been completed.',
  'ui.owner_setup.intro':
    'Create the real local owner account. This invitation works once and stays on this device.',
  'ui.owner_setup.name': 'Name',
  'ui.owner_setup.email': 'Email',
  'ui.owner_setup.tenant_name': 'Workspace name (optional)',
  'ui.owner_setup.submit': 'Create owner',
  'ui.shell_settings_page.heading': 'Settings',
  'ui.shell_settings_page.description':
    'Adjust the workspace shell — panel layout and keyboard shortcuts.',
  'ui.hotkey_input.capture_title': 'Press a key to capture it',
  'ui.hotkey_input.conflicts_with': 'Conflicts with',
  'ui.shell_settings_panel.shell_settings': 'Shell settings',
  'ui.shell_settings_panel.description':
    'Panel preferences and physical-key shortcuts.',
  'ui.shell_settings_panel.disable_hotkeys': 'Disable hotkeys',
  'ui.shell_settings_panel.enable_hotkeys': 'Enable hotkeys',
  'ui.shell_settings_panel.collapse': 'Collapse',
  'ui.shell_settings_panel.expand': 'Expand',
  'ui.shell_layout_editor.heading': 'Shell layout',
  'ui.shell_layout_editor.description':
    'Choose which panels appear and arrange the navigation. Drag a handle, or focus it, press Space, and use the arrow keys.',
  'ui.shell_layout_editor.reset': 'Reset to defaults',
  'ui.shell_layout_editor.panels': 'Panels',
  'ui.shell_layout_editor.show_panel': 'Show {panel} panel',
  'ui.shell_layout_editor.start_expanded': 'Start {panel} panel expanded',
  'ui.shell_layout_editor.panel_unavailable':
    'The {panel} panel is not available in this app.',
  'ui.shell_layout_editor.navigation': 'Navigation',
  'ui.shell_layout_editor.top_level': 'Top level',
  'ui.shell_layout_editor.show_entry': 'Show {label} in navigation',
  'ui.shell_layout_editor.new_section': 'New section',
  'ui.shell_layout_editor.new_section_label': 'New section',
  'ui.shell_layout_editor.section_name': 'Name of section {label}',
  'ui.shell_layout_editor.rename_item': 'Rename {label}',
  'ui.shell_layout_editor.item_name': 'Name of item {label}',
  'ui.shell_layout_editor.reset_item': 'Reset {label} to {original}',
  'ui.shell_layout_editor.section_icon': 'Icon of {label}',
  'ui.shell_layout_editor.icon_option': 'Use {icon} icon',
  'ui.section_menu.label': '{label} entries',
  'ui.section_menu.empty': 'No entries in this section.',
  'ui.shell_layout_editor.show_title_for': 'Show title of {label}',
  'ui.shell_layout_editor.delete': 'Delete',
  'ui.shell_layout_editor.delete_section': 'Delete section {label}',
  'ui.shell_layout_editor.delete_confirm':
    'Delete {label}? Its items return to their default sections.',
  'ui.shell_layout_editor.preview': 'Preview',
  'ui.shell_layout_editor.preview_label': 'Navigation preview',
  'ui.shell_layout_editor.sortable_label': 'Navigation sections and items',
  'ui.layout_edit.toggle': 'Edit layout',
  'ui.layout_edit.announce_on':
    'Layout editing on. Drag items between zones, or focus a grip, press Space, and use the arrow keys.',
  'ui.layout_edit.announce_off': 'Layout editing off.',
  'ui.layout_edit.zone': '{region} · {slot}',
  'ui.layout_edit.region_hidden': '{region} · hidden',
  'ui.layout_edit.show_region': 'Show {region}',
  'ui.layout_edit.hide_region': 'Hide {region}',
  'ui.layout_edit.hide_last_region':
    'Cannot hide {region}: at least one region must stay visible',
  'ui.app_shell.brand_item': 'App title',
  'ui.layout_edit.section_options': 'Options for section {label}',
  'ui.layout_edit.edit_section': 'Edit section {label}',
  'ui.shell_region.header': 'Header',
  'ui.shell_region.left_sidebar': 'Left sidebar',
  'ui.shell_region.right_sidebar': 'Right sidebar',
  'ui.shell_region.footer': 'Footer',
  'ui.shortcuts_overlay.open_shortcuts': 'Open shortcuts',
  'ui.shortcuts_overlay.close_drawer': 'Close drawer',
  'ui.shortcuts_overlay.close': 'Close',
  'ui.shortcuts_overlay.escape': 'Esc',
  'ui.system_scope_panel.system_scope': 'System scope',
  'ui.system_scope_panel.activities': 'Activities',
  'ui.system_scope_panel.no_running_work': 'No running work',
  'ui.system_status_chips.system_status': 'System status',
  'ui.tenant_nav.tenant_navigation': 'Tenant navigation',
  'ui.tenant_nav.needs_attention': 'Needs attention',
  'ui.workspace_account_menu.open': 'Open account menu',
  'ui.workspace_account_menu.current_tenant': '{tenant} — current',
  'ui.workspace_account_menu.sign_out': 'Sign out',

  // web/activity-feed adapter demo (#1779) — playground/admin-shell-activity-feed
  'ui.activity_feed.title': 'Live activity feed',
  'ui.activity_feed.description':
    'A smrt-web live collection reconciled into the shell activity registry.',
  'ui.activity_feed.enqueue_job': 'Enqueue job',
  'ui.activity_feed.advance_job': 'Advance job',
  'ui.activity_feed.complete_job': 'Complete job',
  'ui.activity_feed.fail_job': 'Fail job',
  'ui.activity_feed.clear_finished': 'Clear finished',
  'ui.activity_feed.rows_heading': 'Backing collection rows',
  'ui.activity_feed.no_rows': 'No rows yet',
  'ui.activity_feed.job_label': 'Render job',

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
