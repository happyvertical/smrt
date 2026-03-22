const sampleStats = {
  todayPageviews: 18240,
  yesterdayPageviews: 15980,
  todayUsers: 3924,
  yesterdayUsers: 3410,
  trend: 'up',
  trendPercent: 14.1,
};

const sampleEvents = [
  {
    id: 'analytics-event-1',
    eventName: 'page_view',
    clientId: 'client_01HJQ9M4X0A8Q2D',
    pagePath: '/guides/editorial-playbook',
    eventTimestamp: '2026-03-21T16:14:00.000Z',
    status: 'sent',
  },
  {
    id: 'analytics-event-2',
    eventName: 'cta_click',
    clientId: 'client_01HJQ9M4X0A8Q2D',
    pagePath: '/pricing',
    eventTimestamp: '2026-03-21T16:10:00.000Z',
    status: 'sent',
  },
  {
    id: 'analytics-event-3',
    eventName: 'form_submit',
    clientId: 'client_01HJQ9NGH1J9Q8R',
    pagePath: '/newsletter',
    eventTimestamp: '2026-03-21T15:58:00.000Z',
    status: 'pending',
  },
];

const loadAnalyticsSummary = () => import('./AnalyticsSummary.svelte');
const loadEventsTable = () => import('./EventsTable.svelte');
const loadPropertyInfo = () => import('./PropertyInfo.svelte');

export default {
  packageName: '@happyvertical/smrt-analytics',
  displayName: 'Analytics',
  description:
    'Dashboard primitives for property health, traffic trends, and recent event delivery.',
  entries: [
    {
      id: 'analytics-summary',
      title: 'Analytics Summary',
      description:
        'Traffic summary cards that surface today-vs-yesterday performance at a glance.',
      loadComponent: loadAnalyticsSummary,
      order: 1,
      props: {
        stats: sampleStats,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'events-table',
      title: 'Events Table',
      description:
        'Recent outbound analytics events with delivery status and page context.',
      loadComponent: loadEventsTable,
      order: 2,
      props: {
        events: sampleEvents,
        maxRows: 8,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'property-info',
      title: 'Property Info',
      description:
        'Connection status and property metadata for a configured analytics destination.',
      loadComponent: loadPropertyInfo,
      order: 3,
      props: {
        propertyId: 'properties/348920114',
        measurementId: 'G-9A4F2P7Q1C',
        provider: 'ga4',
        status: 'active',
        lastSyncAt: '2026-03-21T16:05:00.000Z',
        siteDomain: 'newsroom.example.com',
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
