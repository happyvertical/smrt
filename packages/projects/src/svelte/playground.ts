import { PROJECTS_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleTimeEntries = [
  {
    id: 'time-entry-1',
    date: '2026-03-18T16:00:00.000Z',
    hours: 6.5,
    description: 'Editorial governance review and fact-linking pass',
    status: 'submitted',
    amount: 780,
    workerName: 'Taylor Rowan',
    hourlyRate: 120,
    mileage: 18,
  },
  {
    id: 'time-entry-2',
    date: '2026-03-19T16:00:00.000Z',
    hours: 4.25,
    description: 'Content workflow instrumentation and approval QA',
    status: 'approved',
    amount: 510,
    workerName: 'Jordan Lee',
    hourlyRate: 120,
  },
  {
    id: 'time-entry-3',
    date: '2026-03-20T16:00:00.000Z',
    hours: 2,
    description: 'Follow-up revisions for contributor feedback',
    status: 'draft',
    amount: 240,
    workerName: 'Casey Tran',
    hourlyRate: 120,
  },
];

const totalHours = sampleTimeEntries.reduce(
  (sum, entry) => sum + entry.hours,
  0,
);
const totalAmount = sampleTimeEntries.reduce(
  (sum, entry) => sum + (entry.amount ?? 0),
  0,
);
const pendingEntries = sampleTimeEntries.filter(
  (entry) => entry.status === 'submitted',
);

const loadApprovalActions = () => import('./components/ApprovalActions.svelte');
const loadTimeEntryList = () => import('./components/TimeEntryList.svelte');
const loadTimeSummary = () => import('./components/TimeSummary.svelte');

export default {
  packageName: '@happyvertical/smrt-projects',
  displayName: PROJECTS_MODULE_META.displayName,
  description: PROJECTS_MODULE_META.description,
  moduleMeta: PROJECTS_MODULE_META,
  entries: [
    {
      id: 'time-entry-list',
      title: 'Time Entry List',
      description:
        'Selectable list view for recent time entries with billing context.',
      loadComponent: loadTimeEntryList,
      order: 1,
      props: {
        entries: sampleTimeEntries,
        selectable: true,
        selectedIds: ['time-entry-1'],
        currency: 'CAD',
        onselectionchange: noop,
        baseHref: '/projects/time-entries',
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'time-summary',
      title: 'Time Summary',
      description: 'Hours and value summary cards for a project review period.',
      loadComponent: loadTimeSummary,
      order: 2,
      props: {
        totalHours,
        totalAmount,
        pendingHours: pendingEntries.reduce(
          (sum, entry) => sum + entry.hours,
          0,
        ),
        pendingAmount: pendingEntries.reduce(
          (sum, entry) => sum + (entry.amount ?? 0),
          0,
        ),
        approvedHours: sampleTimeEntries
          .filter((entry) => entry.status === 'approved')
          .reduce((sum, entry) => sum + entry.hours, 0),
        approvedAmount: sampleTimeEntries
          .filter((entry) => entry.status === 'approved')
          .reduce((sum, entry) => sum + (entry.amount ?? 0), 0),
        entryCount: sampleTimeEntries.length,
        currency: 'CAD',
        showApproved: true,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'approval-actions',
      title: 'Approval Actions',
      description:
        'Status-sensitive action row for approving or returning submitted work.',
      loadComponent: loadApprovalActions,
      order: 3,
      props: {
        status: 'submitted',
        onapprove: noop,
        onreject: noop,
        onedit: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
