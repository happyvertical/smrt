/**
 * EventCollection - Collection manager for Event objects
 *
 * Provides hierarchy traversal, filtering, and search capabilities.
 */

import { SmrtCollection } from '@smrt/core';
import { Event } from '../models/Event';
import type { EventSearchFilters, EventStatus } from '../types';

export class EventCollection extends SmrtCollection<Event> {
  static readonly _itemClass = Event;

  /**
   * Get events by series
   *
   * @param seriesId - EventSeries ID
   * @returns Array of Event instances
   */
  async getBySeriesId(seriesId: string): Promise<Event[]> {
    return await this.list({ where: { seriesId } });
  }

  /**
   * Get events at a specific place
   *
   * @param placeId - Place ID
   * @returns Array of Event instances
   */
  async getByPlace(placeId: string): Promise<Event[]> {
    return await this.list({ where: { placeId } });
  }

  /**
   * Get events by date range
   *
   * @param startDate - Start of date range
   * @param endDate - End of date range
   * @returns Array of Event instances
   */
  async getByDateRange(startDate: Date, endDate: Date): Promise<Event[]> {
    const allEvents = await this.list({});

    return allEvents.filter((event) => {
      if (!event.startDate) return false;
      return event.startDate >= startDate && event.startDate <= endDate;
    });
  }

  /**
   * Get upcoming events
   *
   * @param limit - Maximum number of events to return
   * @returns Array of Event instances starting in the future
   */
  async getUpcoming(limit?: number): Promise<Event[]> {
    const allEvents = await this.list({});
    const now = new Date();

    const upcoming = allEvents
      .filter((event) => event.startDate && event.startDate > now)
      .sort((a, b) => {
        if (!a.startDate || !b.startDate) return 0;
        return a.startDate.getTime() - b.startDate.getTime();
      });

    return limit ? upcoming.slice(0, limit) : upcoming;
  }

  /**
   * Get events by status
   *
   * @param status - Event status to filter by
   * @returns Array of Event instances
   */
  async getByStatus(status: EventStatus): Promise<Event[]> {
    return await this.list({ where: { status } });
  }

  /**
   * Get events by type
   *
   * @param typeId - EventType ID
   * @returns Array of Event instances
   */
  async getByType(typeId: string): Promise<Event[]> {
    return await this.list({ where: { typeId } });
  }

  /**
   * Get root events (no parent)
   *
   * @returns Array of Event instances with no parent
   */
  async getRootEvents(): Promise<Event[]> {
    const allEvents = await this.list({});
    return allEvents.filter((event) => !event.parentEventId);
  }

  /**
   * Get children of a parent event
   *
   * @param parentEventId - Parent event ID
   * @returns Array of child Event instances
   */
  async getByParent(parentEventId: string): Promise<Event[]> {
    return await this.list({ where: { parentEventId } });
  }

  /**
   * Get full event tree (hierarchy)
   *
   * @param eventId - Root event ID
   * @returns Object with root event and nested children
   */
  async getEventTree(eventId: string): Promise<Event | null> {
    const event = await this.get({ id: eventId });
    if (!event) return null;

    return await event.getHierarchy().then((h) => h.current);
  }

  /**
   * Search events with filters
   *
   * @param query - Search query for name/description
   * @param filters - Additional filter criteria
   * @returns Array of matching Event instances
   */
  async search(query: string, filters?: EventSearchFilters): Promise<Event[]> {
    let events = await this.list({});

    // Filter by query
    if (query) {
      const lowerQuery = query.toLowerCase();
      events = events.filter(
        (e) =>
          e.name?.toLowerCase().includes(lowerQuery) ||
          e.description?.toLowerCase().includes(lowerQuery),
      );
    }

    // Apply filters
    if (filters) {
      if (filters.typeId) {
        events = events.filter((e) => e.typeId === filters.typeId);
      }
      if (filters.seriesId) {
        events = events.filter((e) => e.seriesId === filters.seriesId);
      }
      if (filters.placeId) {
        events = events.filter((e) => e.placeId === filters.placeId);
      }
      if (filters.status) {
        if (Array.isArray(filters.status)) {
          events = events.filter((e) => filters.status!.includes(e.status));
        } else {
          events = events.filter((e) => e.status === filters.status);
        }
      }
      if (filters.startDate) {
        events = events.filter(
          (e) => e.startDate && e.startDate >= filters.startDate!,
        );
      }
      if (filters.endDate) {
        events = events.filter(
          (e) => e.startDate && e.startDate <= filters.endDate!,
        );
      }
      if (filters.organizerId) {
        // Filter by series organizer
        events = events.filter(async (e) => {
          const series = await e.getSeries();
          return series && series.organizerId === filters.organizerId;
        });
      }
    }

    return events;
  }

  /**
   * Get events in progress
   *
   * @returns Array of Event instances currently in progress
   */
  async getInProgress(): Promise<Event[]> {
    const inProgressEvents = await this.getByStatus('in_progress');
    return inProgressEvents.filter((event) => event.isInProgress());
  }
}
