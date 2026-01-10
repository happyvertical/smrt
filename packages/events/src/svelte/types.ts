/**
 * Events Module Svelte Types
 *
 * TypeScript interfaces for events module UI components.
 */

/**
 * Council/organization that holds meetings
 */
export interface Council {
  id: string;
  slug: string;
  name: string;
  timezone?: string;
}

/**
 * Meeting details for MeetingView
 */
export interface Meeting {
  id: string;
  slug: string;
  name: string;
  startDate: string; // ISO datetime
  status?: string;
  agendaUrl?: string;
  minutesUrl?: string;
  videoUrl?: string;
  highlightsUrl?: string;
  council?: Council;
}

/**
 * Props for MeetingView component
 */
export interface MeetingViewProps {
  meeting: Meeting;
  calendarUrl?: string;
}
