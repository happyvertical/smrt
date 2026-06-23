import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // AgentDashboard
  'agents.dashboard.total_schedules': 'Total Schedules',
  'agents.dashboard.running_now': 'Running Now',
  'agents.dashboard.total_runs': 'Total Runs',
  'agents.dashboard.success_rate': 'Success Rate',
  'agents.dashboard.scheduled_agents': 'Scheduled Agents',
  'agents.dashboard.new_schedule': 'New Schedule',
  'agents.dashboard.no_scheduled_agents': 'No scheduled agents',
  'agents.dashboard.create_first_schedule': 'Create First Schedule',
  'agents.dashboard.recent_runs': 'Recent Runs',

  // AgentRunHistory
  'agents.run_history.loading_history': 'Loading history...',
  'agents.run_history.no_run_history': 'No run history',

  // AgentScheduleForm
  'agents.schedule_form.agent_type': 'Agent Type *',
  'agents.schedule_form.select_agent_type': 'Select agent type...',
  'agents.schedule_form.agent_type_placeholder': 'e.g., Praeco, Scraper',
  'agents.schedule_form.agent_id': 'Agent ID (optional)',
  'agents.schedule_form.agent_id_placeholder': 'Specific instance ID',
  'agents.schedule_form.agent_id_hint':
    'Leave empty to create a new instance for each run',
  'agents.schedule_form.method_placeholder': 'run',
  'agents.schedule_form.method_hint':
    'Method to call on the agent (default: run)',
  'agents.schedule_form.cron_schedule': 'Cron Schedule *',
  'agents.schedule_form.cron_hint':
    'Standard 5-field cron format: minute hour day-of-month month day-of-week',
  'agents.schedule_form.max_concurrent': 'Max Concurrent',
  'agents.schedule_form.max_concurrent_hint':
    'Maximum concurrent runs (prevents overlapping)',
  'agents.schedule_form.enable_schedule_immediately':
    'Enable schedule immediately',

  // AgentScheduleList
  'agents.schedule_list.last_run': 'Last Run',
  'agents.schedule_list.next_run': 'Next Run',
  'agents.schedule_list.success_rate': 'Success Rate',
  'agents.schedule_list.loading_schedules': 'Loading schedules...',
  'agents.schedule_list.no_schedules_found': 'No schedules found',
  'agents.schedule_list.run_now': 'Run Now',

  // components/AgentAdminPanel.svelte
  'ui.agent_admin_panel.no_panel_message': 'No admin panel registered for',
  'ui.agent_admin_panel.no_panel_hint':
    "Import the agent's admin package to register its panels.",

  // components/AgentAdminTabs.svelte
  'ui.agent_admin_tabs.no_slots':
    'No configuration slots available for this agent.',
  'ui.agent_admin_tabs.tablist_label': 'Agent configuration tabs',

  // components/AgentSettingsShell.svelte
  'ui.agent_settings_shell.no_agents_message':
    'No agents configured for this site.',
  'ui.agent_settings_shell.no_agents_hint':
    'Agents are discovered by matching their context field to the site domain.',
});
