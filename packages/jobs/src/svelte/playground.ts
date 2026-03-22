import { JOBS_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleJobs = [
  {
    id: 'job-publish-1',
    queue: 'content',
    objectType: '@happyvertical/smrt-content:Article',
    objectId: 'article-aurora-kitchen',
    method: 'publish',
    args: { force: false },
    status: 'running',
    priority: 80,
    attempts: 1,
    maxAttempts: 3,
    timeout: 600000,
    timeoutBehavior: 'fail',
    runAt: '2026-03-21T16:15:00.000Z',
    startedAt: '2026-03-21T16:15:15.000Z',
    completedAt: null,
    lastError: null,
    resultPointer: null,
    workerId: 'worker-content-1',
    createdAt: '2026-03-21T16:14:50.000Z',
    updatedAt: '2026-03-21T16:15:20.000Z',
  },
  {
    id: 'job-review-2',
    queue: 'governance',
    objectType: '@happyvertical/smrt-content:GovernancePolicy',
    objectId: 'policy-facts',
    method: 'recalculateReadiness',
    args: { profileKey: 'publication' },
    status: 'failed',
    priority: 95,
    attempts: 3,
    maxAttempts: 3,
    timeout: 300000,
    timeoutBehavior: 'fail',
    runAt: '2026-03-21T15:40:00.000Z',
    startedAt: '2026-03-21T15:40:02.000Z',
    completedAt: '2026-03-21T15:41:11.000Z',
    lastError: 'Relationship column missing during readiness sync.',
    resultPointer: null,
    workerId: 'worker-governance-2',
    createdAt: '2026-03-21T15:39:30.000Z',
    updatedAt: '2026-03-21T15:41:11.000Z',
  },
  {
    id: 'job-export-3',
    queue: 'exports',
    objectType: '@happyvertical/smrt-content:ArticleCollection',
    objectId: null,
    method: 'buildStaticFeed',
    args: { destination: 'cdn' },
    status: 'completed',
    priority: 40,
    attempts: 1,
    maxAttempts: 2,
    timeout: 900000,
    timeoutBehavior: 'warn',
    runAt: '2026-03-21T14:30:00.000Z',
    startedAt: '2026-03-21T14:30:00.000Z',
    completedAt: '2026-03-21T14:31:25.000Z',
    lastError: null,
    resultPointer: 'results/exports/build-static-feed-3.json',
    workerId: 'worker-export-1',
    createdAt: '2026-03-21T14:29:52.000Z',
    updatedAt: '2026-03-21T14:31:25.000Z',
  },
];

const sampleStats = {
  total: 3421,
  pending: 24,
  ready: 13,
  running: 4,
  completed: 3340,
  failed: 31,
  cancelled: 9,
  avgDuration: 18450,
  successRate: 0.976,
};

const sampleQueues = [
  {
    name: 'content',
    pending: 8,
    running: 2,
    completed24h: 412,
    failed24h: 4,
    avgDuration: 22800,
  },
  {
    name: 'governance',
    pending: 5,
    running: 1,
    completed24h: 188,
    failed24h: 7,
    avgDuration: 31200,
  },
  {
    name: 'exports',
    pending: 11,
    running: 1,
    completed24h: 94,
    failed24h: 1,
    avgDuration: 52200,
  },
];

const loadJobDashboard = () => import('./components/JobDashboard.svelte');
const loadJobDetail = () => import('./components/JobDetail.svelte');
const loadJobStatusBadge = () => import('./components/JobStatusBadge.svelte');

export default {
  packageName: '@happyvertical/smrt-jobs',
  displayName: JOBS_MODULE_META.displayName,
  description: JOBS_MODULE_META.description,
  moduleMeta: JOBS_MODULE_META,
  entries: [
    {
      id: 'job-dashboard',
      title: 'Job Dashboard',
      description:
        'Operational overview for background job queues with recent and failed work.',
      loadComponent: loadJobDashboard,
      order: 1,
      props: {
        stats: sampleStats,
        queues: sampleQueues,
        recentJobs: sampleJobs,
        failedJobs: sampleJobs.filter((job) => job.status === 'failed'),
        onJobClick: noop,
        onRetry: noop,
        onCancel: noop,
        onViewAll: noop,
        onViewFailed: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'job-detail',
      title: 'Job Detail',
      description:
        'Detailed execution view for a single background job with retry and cancellation actions.',
      loadComponent: loadJobDetail,
      order: 2,
      props: {
        job: sampleJobs[1],
        onRetry: noop,
        onDelete: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'job-status-badge',
      title: 'Job Status Badge',
      description: 'Compact status treatment used throughout the jobs surface.',
      loadComponent: loadJobStatusBadge,
      order: 3,
      props: {
        status: 'running',
        size: 'md',
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
