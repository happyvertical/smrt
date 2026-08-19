import { PROJECTS_MODULE_META } from '../ui.js';

const noop = () => {};

// Money is integer minor units (#2401): 6.5 h x 12000 (=$120.00/h) = 78000.
const sampleTimeEntries = [
  {
    id: 'time-entry-1',
    date: '2026-03-18T16:00:00.000Z',
    hours: 6.5,
    description: 'Editorial governance review and fact-linking pass',
    status: 'submitted',
    amount: 78000,
    workerName: 'Taylor Rowan',
    hourlyRate: 12000,
    mileage: 18,
  },
  {
    id: 'time-entry-2',
    date: '2026-03-19T16:00:00.000Z',
    hours: 4.25,
    description: 'Content workflow instrumentation and approval QA',
    status: 'approved',
    amount: 51000,
    workerName: 'Jordan Lee',
    hourlyRate: 12000,
  },
  {
    id: 'time-entry-3',
    date: '2026-03-20T16:00:00.000Z',
    hours: 2,
    description: 'Follow-up revisions for contributor feedback',
    status: 'draft',
    amount: 24000,
    workerName: 'Casey Tran',
    hourlyRate: 12000,
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
const loadDevelopmentBoard = () => import('./DevelopmentBoard.svelte');
const loadProjectBoard = () => import('./ProjectBoard.svelte');

export default {
  packageName: '@happyvertical/smrt-projects',
  displayName: PROJECTS_MODULE_META.displayName,
  description: PROJECTS_MODULE_META.description,
  moduleMeta: PROJECTS_MODULE_META,
  entries: [
    {
      id: 'project-board',
      title: 'Project Board',
      description: 'Controlled provider project board with canonical statuses.',
      loadComponent: loadProjectBoard,
      order: 0,
      props: {
        projectId: 'project-demo',
        statuses: [
          { id: 'todo', name: 'Todo', order: 0 },
          { id: 'done', name: 'Done', order: 1 },
        ],
        items: [
          {
            id: 'item-demo',
            contentId: 'content-demo',
            title: 'Publish project board',
            status: 'Todo',
            fields: {},
            type: 'Issue',
          },
        ],
      },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'development-board',
      title: 'Development Board',
      description: 'Read-only delivery-status projection.',
      loadComponent: loadDevelopmentBoard,
      order: 1,
      props: {
        requests: [
          {
            id: 'request-demo',
            description: 'Publish project board',
            type: 'feature',
            status: 'planned',
            requesterLabel: 'Project owner',
          },
        ],
      },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'time-entry-list',
      title: 'Time Entry List',
      description:
        'Selectable list view for recent time entries with billing context.',
      loadComponent: loadTimeEntryList,
      order: 2,
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
      order: 3,
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
      order: 4,
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
