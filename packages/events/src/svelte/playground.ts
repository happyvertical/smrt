import { EVENTS_MODULE_META } from '../ui.js';

const sampleMeeting = {
  id: 'meeting-council-2026-03-18',
  slug: 'council-march-18-2026',
  name: 'March 18, 2026 Council Meeting',
  startDate: '2026-03-18T19:00:00.000Z',
  status: 'published',
  agendaUrl: 'https://example.com/meetings/council-mar-18/agenda.pdf',
  minutesUrl: 'https://example.com/meetings/council-mar-18/minutes.pdf',
  videoUrl: 'https://example.com/meetings/council-mar-18/video',
  highlightsUrl: 'https://example.com/meetings/council-mar-18/highlights',
  council: {
    id: 'council-town',
    slug: 'town-council',
    name: 'Town Council',
    timezone: 'America/Edmonton',
  },
};

const loadMeetingView = () => import('./components/MeetingView.svelte');

export default {
  packageName: '@happyvertical/smrt-events',
  displayName: EVENTS_MODULE_META.displayName,
  description: EVENTS_MODULE_META.description,
  moduleMeta: EVENTS_MODULE_META,
  entries: [
    {
      id: 'meeting-view',
      title: 'Meeting View',
      description:
        'Full meeting detail page with agenda, minutes, video, and highlights links.',
      loadComponent: loadMeetingView,
      order: 1,
      props: {
        meeting: sampleMeeting,
        calendarUrl: '/events/calendar',
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
