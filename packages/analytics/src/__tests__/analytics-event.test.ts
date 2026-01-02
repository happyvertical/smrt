/**
 * Tests for AnalyticsEvent model and collection
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsEventCollection } from '../collections/AnalyticsEventCollection.js';
import { AnalyticsEvent } from '../models/AnalyticsEvent.js';
import { TrackingEventStatus } from '../types/index.js';
import {
  createTestDb,
  getAdapterDisplayName,
  getTestAdapter,
  isPostgresAvailable,
} from './helpers/index.js';

// Check postgres availability at module load (top-level await)
const pgAvailable = await isPostgresAvailable();
const skipTests = getTestAdapter() === 'postgres' && !pgAvailable;

describe('AnalyticsEvent', () => {
  describe('constructor', () => {
    it('should create an event with default values', () => {
      const event = new AnalyticsEvent();

      expect(event.propertyId).toBe('');
      expect(event.eventName).toBe('');
      expect(event.clientId).toBe('');
      expect(event.userId).toBe('');
      expect(event.params).toBe('{}');
      expect(event.status).toBe(TrackingEventStatus.PENDING);
      expect(event.retryCount).toBe(0);
      expect(event.nonPersonalizedAds).toBe(false);
    });

    it('should create an event with options', () => {
      const event = new AnalyticsEvent({
        propertyId: 'prop-123',
        eventName: 'purchase',
        clientId: 'client-456',
        userId: 'user-789',
        params: JSON.stringify({ value: 99.99, currency: 'USD' }),
      });

      expect(event.propertyId).toBe('prop-123');
      expect(event.eventName).toBe('purchase');
      expect(event.clientId).toBe('client-456');
      expect(event.userId).toBe('user-789');
    });
  });

  describe('params handling', () => {
    it('should get and set event parameters', () => {
      const event = new AnalyticsEvent();

      event.setParams({
        value: 99.99,
        currency: 'USD',
        transaction_id: 'order-123',
      });

      const params = event.getParams();
      expect(params.value).toBe(99.99);
      expect(params.currency).toBe('USD');
      expect(params.transaction_id).toBe('order-123');
    });

    it('should add individual parameters', () => {
      const event = new AnalyticsEvent();
      event.setParams({ existing: 'value' });

      event.addParam('newKey', 'newValue');
      event.addParam('numKey', 42);

      const params = event.getParams();
      expect(params.existing).toBe('value');
      expect(params.newKey).toBe('newValue');
      expect(params.numKey).toBe(42);
    });

    it('should return empty object for invalid JSON', () => {
      const event = new AnalyticsEvent();
      event.params = 'invalid json';

      expect(event.getParams()).toEqual({});
    });
  });

  describe('event type checks', () => {
    it('should correctly identify pageview events', () => {
      const pageView1 = new AnalyticsEvent({ eventName: 'page_view' });
      const pageView2 = new AnalyticsEvent({ eventName: 'pageview' });
      const other = new AnalyticsEvent({ eventName: 'click' });

      expect(pageView1.isPageview()).toBe(true);
      expect(pageView2.isPageview()).toBe(true);
      expect(other.isPageview()).toBe(false);
    });

    it('should correctly identify conversion events', () => {
      const purchase = new AnalyticsEvent({ eventName: 'purchase' });
      const signUp = new AnalyticsEvent({ eventName: 'sign_up' });
      const lead = new AnalyticsEvent({ eventName: 'generate_lead' });
      const checkout = new AnalyticsEvent({ eventName: 'begin_checkout' });
      const other = new AnalyticsEvent({ eventName: 'page_view' });

      expect(purchase.isConversion()).toBe(true);
      expect(signUp.isConversion()).toBe(true);
      expect(lead.isConversion()).toBe(true);
      expect(checkout.isConversion()).toBe(true);
      expect(other.isConversion()).toBe(false);
    });
  });

  describe('status management', () => {
    it('should mark as sent successfully', () => {
      const event = new AnalyticsEvent();
      expect(event.sentAt).toBeNull();

      event.markSent();

      expect(event.status).toBe(TrackingEventStatus.SENT);
      expect(event.sentAt).toBeInstanceOf(Date);
      expect(event.errorMessage).toBe('');
    });

    it('should mark as failed and increment retry count', () => {
      const event = new AnalyticsEvent();
      expect(event.retryCount).toBe(0);

      event.markFailed('Connection timeout');

      expect(event.status).toBe(TrackingEventStatus.FAILED);
      expect(event.errorMessage).toBe('Connection timeout');
      expect(event.retryCount).toBe(1);

      event.markFailed('Another error');
      expect(event.retryCount).toBe(2);
    });

    it('should reset for retry', () => {
      const event = new AnalyticsEvent();
      event.markSent();

      event.resetForRetry();

      expect(event.status).toBe(TrackingEventStatus.PENDING);
      expect(event.sentAt).toBeNull();
    });
  });

  describe('retry logic', () => {
    it('should allow retry when failed and under max retries', () => {
      const event = new AnalyticsEvent();
      event.markFailed('Error 1');

      expect(event.shouldRetry(3)).toBe(true);
    });

    it('should not allow retry when max retries exceeded', () => {
      const event = new AnalyticsEvent();
      event.markFailed('Error 1');
      event.markFailed('Error 2');
      event.markFailed('Error 3');

      expect(event.shouldRetry(3)).toBe(false);
    });

    it('should not allow retry when not in failed status', () => {
      const event = new AnalyticsEvent();
      expect(event.shouldRetry(3)).toBe(false);

      event.markSent();
      expect(event.shouldRetry(3)).toBe(false);
    });
  });

  describe('toTrackEvent', () => {
    it('should build SDK TrackEvent object', () => {
      const timestamp = new Date('2024-01-15T10:00:00Z');
      const event = new AnalyticsEvent({
        eventName: 'purchase',
        clientId: 'client-123',
        userId: 'user-456',
        eventTimestamp: timestamp,
        nonPersonalizedAds: true,
      });
      event.setParams({ value: 99.99, currency: 'USD' });

      const trackEvent = event.toTrackEvent();

      expect(trackEvent.name).toBe('purchase');
      expect(trackEvent.params).toEqual({ value: 99.99, currency: 'USD' });
      expect(trackEvent.clientId).toBe('client-123');
      expect(trackEvent.userId).toBe('user-456');
      expect(trackEvent.timestamp).toBe(timestamp.getTime() * 1000);
      expect(trackEvent.nonPersonalizedAds).toBe(true);
    });

    it('should omit empty clientId and userId', () => {
      const event = new AnalyticsEvent({ eventName: 'page_view' });

      const trackEvent = event.toTrackEvent();

      expect(trackEvent.clientId).toBeUndefined();
      expect(trackEvent.userId).toBeUndefined();
    });
  });
});

describe.skipIf(skipTests)(
  `AnalyticsEventCollection [${getAdapterDisplayName()}]`,
  () => {
    let collection: AnalyticsEventCollection;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const testDb = await createTestDb();
      cleanup = testDb.cleanup;
      collection = await AnalyticsEventCollection.create({
        persistence: testDb.config,
      });
    });

    afterEach(async () => {
      await cleanup();
    });

    it('should create and list events', async () => {
      const event = await collection.create({
        propertyId: 'prop-123',
        eventName: 'purchase',
        clientId: 'client-456',
      });
      await event.save();

      const events = await collection.list({});
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('purchase');
    });

    it('should find events by event name', async () => {
      const purchase = await collection.create({
        eventName: 'purchase',
        propertyId: 'prop-1',
      });
      await purchase.save();

      const pageView = await collection.create({
        eventName: 'page_view',
        propertyId: 'prop-1',
      });
      await pageView.save();

      const purchases = await collection.findByEventName('purchase');
      expect(purchases).toHaveLength(1);
      expect(purchases[0].eventName).toBe('purchase');
    });

    it('should find events by status', async () => {
      const pending = await collection.create({
        propertyId: 'prop-status',
        eventName: 'event1',
        status: TrackingEventStatus.PENDING,
      });
      await pending.save();

      const sent = await collection.create({
        propertyId: 'prop-status',
        eventName: 'event2',
        status: TrackingEventStatus.SENT,
      });
      await sent.save();

      const failed = await collection.create({
        propertyId: 'prop-status',
        eventName: 'event3',
        status: TrackingEventStatus.FAILED,
      });
      await failed.save();

      const pendingEvents = await collection.findPending();
      expect(pendingEvents).toHaveLength(1);
      expect(pendingEvents[0].eventName).toBe('event1');

      const sentEvents = await collection.findSent();
      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0].eventName).toBe('event2');

      const failedEvents = await collection.findFailed();
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].eventName).toBe('event3');
    });

    it('should find events for retry', async () => {
      const retriable = await collection.create({
        propertyId: 'prop-retry',
        eventName: 'retriable',
        status: TrackingEventStatus.FAILED,
        retryCount: 1,
      });
      await retriable.save();

      const exhausted = await collection.create({
        propertyId: 'prop-retry',
        eventName: 'exhausted',
        status: TrackingEventStatus.FAILED,
        retryCount: 5,
      });
      await exhausted.save();

      const forRetry = await collection.findForRetry(3);
      expect(forRetry).toHaveLength(1);
      expect(forRetry[0].eventName).toBe('retriable');
    });

    it('should find conversion events', async () => {
      const purchase = await collection.create({
        eventName: 'purchase',
        propertyId: 'prop-1',
      });
      await purchase.save();

      const pageView = await collection.create({
        eventName: 'page_view',
        propertyId: 'prop-1',
      });
      await pageView.save();

      const signUp = await collection.create({
        eventName: 'sign_up',
        propertyId: 'prop-1',
      });
      await signUp.save();

      const conversions = await collection.findConversions('prop-1');
      expect(conversions).toHaveLength(2);
      expect(conversions.map((e) => e.eventName).sort()).toEqual([
        'purchase',
        'sign_up',
      ]);
    });

    it('should get property stats', async () => {
      const propertyId = 'prop-stats';

      await (
        await collection.create({
          propertyId,
          eventName: 'purchase',
          status: TrackingEventStatus.SENT,
        })
      ).save();

      await (
        await collection.create({
          propertyId,
          eventName: 'page_view',
          status: TrackingEventStatus.SENT,
        })
      ).save();

      await (
        await collection.create({
          propertyId,
          eventName: 'sign_up',
          status: TrackingEventStatus.PENDING,
        })
      ).save();

      await (
        await collection.create({
          propertyId,
          eventName: 'click',
          status: TrackingEventStatus.FAILED,
        })
      ).save();

      const stats = await collection.getPropertyStats(propertyId);

      expect(stats.total).toBe(4);
      expect(stats.sent).toBe(2);
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.conversions).toBe(2); // purchase, sign_up
      expect(stats.pageviews).toBe(1); // page_view
    });

    it('should count events by event name', async () => {
      const propertyId = 'prop-count';

      await (
        await collection.create({ propertyId, eventName: 'page_view' })
      ).save();
      await (
        await collection.create({ propertyId, eventName: 'page_view' })
      ).save();
      await (
        await collection.create({ propertyId, eventName: 'purchase' })
      ).save();

      const counts = await collection.countByEventName(propertyId);

      expect(counts.get('page_view')).toBe(2);
      expect(counts.get('purchase')).toBe(1);
    });
  },
);
