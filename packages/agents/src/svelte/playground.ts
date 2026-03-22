import { AGENTS_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleSchedules = [
  {
    id: 'schedule-digest',
    agentType: 'DailyDigestAgent',
    agentId: 'digest-western',
    agentConfig: { region: 'western-canada' },
    cron: '0 7 * * *',
    timezone: 'America/Edmonton',
    enabled: true,
    status: 'active',
    lastRun: '2026-03-21T13:00:00.000Z',
    nextRun: '2026-03-22T13:00:00.000Z',
    lastStatus: 'success',
    lastError: null,
    runCount: 184,
    successCount: 179,
    failureCount: 5,
    maxConcurrent: 1,
    runningCount: 0,
    timeout: 1800000,
    method: 'run',
    methodArgs: {},
    createdAt: '2026-01-04T17:00:00.000Z',
    updatedAt: '2026-03-21T13:02:00.000Z',
  },
  {
    id: 'schedule-governance',
    agentType: 'GovernanceWatchAgent',
    agentId: null,
    agentConfig: { profileKey: 'publication' },
    cron: '*/30 * * * *',
    timezone: 'UTC',
    enabled: true,
    status: 'error',
    lastRun: '2026-03-21T16:00:00.000Z',
    nextRun: '2026-03-21T16:30:00.000Z',
    lastStatus: 'failed',
    lastError: 'Readiness sync failed for one assignment.',
    runCount: 928,
    successCount: 901,
    failureCount: 27,
    maxConcurrent: 2,
    runningCount: 1,
    timeout: 900000,
    method: 'reconcile',
    methodArgs: { backfill: false },
    createdAt: '2026-02-09T10:10:00.000Z',
    updatedAt: '2026-03-21T16:01:11.000Z',
  },
];

const sampleHistory = [
  {
    id: 'run-1',
    scheduleId: 'schedule-governance',
    agentType: 'GovernanceWatchAgent',
    status: 'failed',
    startedAt: '2026-03-21T16:00:00.000Z',
    completedAt: '2026-03-21T16:01:11.000Z',
    duration: 71000,
    error: 'One assignment was missing readiness metadata.',
  },
  {
    id: 'run-2',
    scheduleId: 'schedule-digest',
    agentType: 'DailyDigestAgent',
    status: 'success',
    startedAt: '2026-03-21T13:00:00.000Z',
    completedAt: '2026-03-21T13:00:18.000Z',
    duration: 18000,
    error: null,
  },
];

const loadAgentDashboard = () => import('./components/AgentDashboard.svelte');
const loadAgentRunHistory = () => import('./components/AgentRunHistory.svelte');
const loadAgentScheduleForm = () =>
  import('./components/AgentScheduleForm.svelte');

export default {
  packageName: '@happyvertical/smrt-agents',
  displayName: AGENTS_MODULE_META.displayName,
  description: AGENTS_MODULE_META.description,
  moduleMeta: AGENTS_MODULE_META,
  entries: [
    {
      id: 'agent-dashboard',
      title: 'Agent Dashboard',
      description:
        'Overview of active schedules, run health, and recent execution history.',
      loadComponent: loadAgentDashboard,
      order: 1,
      props: {
        schedules: sampleSchedules,
        recentHistory: sampleHistory,
        onScheduleClick: noop,
        onEnable: noop,
        onDisable: noop,
        onDelete: noop,
        onRunNow: noop,
        onCreateSchedule: noop,
        onHistoryEntryClick: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'agent-schedule-form',
      title: 'Agent Schedule Form',
      description:
        'Configuration form for a scheduled agent run, with presets and execution controls.',
      loadComponent: loadAgentScheduleForm,
      order: 2,
      props: {
        initialData: {
          agentType: 'GovernanceWatchAgent',
          cron: '*/30 * * * *',
          timezone: 'UTC',
          enabled: true,
          maxConcurrent: 2,
          timeout: 900000,
          method: 'reconcile',
        },
        agentTypes: ['DailyDigestAgent', 'GovernanceWatchAgent', 'ExportAgent'],
        onSubmit: noop,
        onCancel: noop,
        editMode: true,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'agent-run-history',
      title: 'Agent Run History',
      description:
        'Execution history table for recent schedule runs and failures.',
      loadComponent: loadAgentRunHistory,
      order: 3,
      props: {
        history: sampleHistory,
        onEntryClick: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
