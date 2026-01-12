/**
 * Issue #693: STI subclasses with separate tableName still serialize to parent table
 *
 * When STI subclasses declare their own `tableName` in the manifest, there's a
 * disconnect: the manifest says Meeting uses `meetings` table, but at runtime
 * ALL STI subclass properties serialize to the parent `events` table.
 *
 * This causes `db:migrate` to miss columns because it sees separate tables in
 * the manifest and doesn't merge subclass columns into the parent table schema.
 *
 * Fix: `getAllSchemas()` should detect STI subclasses and use the STI base
 * class's tableName, merging subclass columns into the parent table.
 *
 * Related: https://github.com/happyvertical/smrt/issues/693
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

/**
 * STI base class - Event
 * Uses 'issue693events' as its table name
 */
@smrt({ tableStrategy: 'sti', tableName: 'issue693events' })
class Issue693Event extends SmrtObject {
  title: string = '';
  eventDate: Date = new Date();
  venue: string = '';
}

class Issue693EventCollection extends SmrtCollection<Issue693Event> {
  static readonly _itemClass = Issue693Event;
}

/**
 * STI child - Meeting
 * Declares its own tableName 'issue693meetings' in config, but at runtime
 * it should serialize to the parent 'issue693events' table.
 */
@smrt({ tableName: 'issue693meetings' })
class Issue693Meeting extends Issue693Event {
  councilId: string = '';
  agendaUrl: string = '';
  minutesUrl: string = '';
}

class Issue693MeetingCollection extends SmrtCollection<Issue693Meeting> {
  static readonly _itemClass = Issue693Meeting;
}

/**
 * STI child - WeatherForecast
 * Declares its own tableName 'issue693forecasts' in config, but at runtime
 * it should serialize to the parent 'issue693events' table.
 */
@smrt({ tableName: 'issue693forecasts' })
class Issue693WeatherForecast extends Issue693Event {
  temperatureHigh: number = 0.0;
  temperatureLow: number = 0.0;
  humidity: number = 0;
  windGust: number = 0.0;
}

class Issue693WeatherForecastCollection extends SmrtCollection<Issue693WeatherForecast> {
  static readonly _itemClass = Issue693WeatherForecast;
}

describe('Issue #693: STI subclasses with separate tableName', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-issue-693-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Direct getAllSchemas() verification', () => {
    it('should resolve STI base tableName even when schema declares different tableName', () => {
      // Verify that the classes have their own declared tableNames
      const meetingClass = ObjectRegistry.findClass('Issue693Meeting');
      const forecastClass = ObjectRegistry.findClass('Issue693WeatherForecast');
      const eventClass = ObjectRegistry.findClass('Issue693Event');

      expect(eventClass?.schema?.tableName).toBe('issue693events');

      // These MAY have been corrected by the manifest generator, but the fix
      // in getAllSchemas() should handle both cases:
      // 1. When manifest generator has already corrected (via inheritance)
      // 2. When loaded from external manifest with different tableName
      const schemas = ObjectRegistry.getAllSchemas();

      // The key assertion: there should be ONE schema for the STI hierarchy
      // (the parent table), not separate tables for each subclass
      expect(schemas.issue693events).toBeDefined();

      // If separate tables existed, they would appear here - but they shouldn't
      // The fix ensures subclass columns are merged into parent table
      const tableNames = Object.keys(schemas);
      const issue693Tables = tableNames.filter((t) => t.includes('issue693'));
      expect(issue693Tables).toEqual(['issue693events']);
    });
  });

  describe('STI detection', () => {
    it('should recognize STI subclasses even with their own tableName', () => {
      // Base class is STI
      expect(ObjectRegistry.getTableStrategy('Issue693Event')).toBe('sti');
      // Subclasses should inherit STI strategy
      expect(ObjectRegistry.getTableStrategy('Issue693Meeting')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('Issue693WeatherForecast')).toBe(
        'sti',
      );
    });

    it('should find correct STI base class', () => {
      expect(ObjectRegistry.getSTIBase('Issue693Event')).toBe('Issue693Event');
      expect(ObjectRegistry.getSTIBase('Issue693Meeting')).toBe(
        'Issue693Event',
      );
      expect(ObjectRegistry.getSTIBase('Issue693WeatherForecast')).toBe(
        'Issue693Event',
      );
    });
  });

  describe('getAllSchemas() with STI subclasses having own tableName', () => {
    it('should merge subclass columns into parent table, not separate tables', () => {
      const schemas = ObjectRegistry.getAllSchemas();

      // The parent table should exist with ALL columns merged
      const eventsSchema = schemas.issue693events;
      expect(eventsSchema).toBeDefined();

      // Subclass tables should NOT exist (columns merged into parent)
      expect(schemas.issue693meetings).toBeUndefined();
      expect(schemas.issue693forecasts).toBeUndefined();
    });

    it('should include all subclass columns in parent table DDL', () => {
      const schemas = ObjectRegistry.getAllSchemas();
      const eventsSchema = schemas.issue693events;
      const ddl = eventsSchema.ddl;

      // Base class columns
      expect(ddl).toContain('"title"');
      expect(ddl).toContain('"event_date"');
      expect(ddl).toContain('"venue"');

      // Meeting subclass columns (Issue #693 fix)
      expect(ddl).toContain('"council_id"');
      expect(ddl).toContain('"agenda_url"');
      expect(ddl).toContain('"minutes_url"');

      // WeatherForecast subclass columns (Issue #693 fix)
      expect(ddl).toContain('"temperature_high"');
      expect(ddl).toContain('"temperature_low"');
      expect(ddl).toContain('"humidity"');
      expect(ddl).toContain('"wind_gust"');

      // STI meta columns
      expect(ddl).toContain('"_meta_type"');
      expect(ddl).toContain('"_meta_data"');
    });

    it('should preserve correct SQL types for merged columns', () => {
      const schemas = ObjectRegistry.getAllSchemas();
      const eventsSchema = schemas.issue693events;
      const ddl = eventsSchema.ddl;

      // Integer columns (no decimal in default value)
      expect(ddl).toMatch(/"humidity"\s+INTEGER/);

      // Decimal columns (decimal in default value)
      expect(ddl).toMatch(/"temperature_high"\s+REAL/);
      expect(ddl).toMatch(/"temperature_low"\s+REAL/);
      expect(ddl).toMatch(/"wind_gust"\s+REAL/);

      // Text columns
      expect(ddl).toMatch(/"council_id"\s+TEXT/);
      expect(ddl).toMatch(/"agenda_url"\s+TEXT/);
      expect(ddl).toMatch(/"minutes_url"\s+TEXT/);
    });
  });

  describe('End-to-end persistence', () => {
    it('should save and load Meeting correctly using parent table', async () => {
      const options = { db: { type: 'sqlite' as const, url: dbPath } };
      const collection = await Issue693MeetingCollection.create(options);

      const meeting = await collection.create({
        title: 'Town Council Meeting',
        eventDate: new Date('2024-03-15T19:00:00Z'),
        venue: 'Town Hall',
        councilId: 'council-456',
        agendaUrl: 'https://example.com/agenda.pdf',
        minutesUrl: 'https://example.com/minutes.pdf',
      });
      await meeting.save();

      // Reload and verify
      const loaded = await collection.get({ id: meeting.id });
      expect(loaded).toBeDefined();
      expect(loaded?.title).toBe('Town Council Meeting');
      expect(loaded?.councilId).toBe('council-456');
      expect(loaded?.agendaUrl).toBe('https://example.com/agenda.pdf');
      expect(loaded?.minutesUrl).toBe('https://example.com/minutes.pdf');
    });

    it('should save and load WeatherForecast correctly using parent table', async () => {
      const options = { db: { type: 'sqlite' as const, url: dbPath } };
      const collection =
        await Issue693WeatherForecastCollection.create(options);

      const forecast = await collection.create({
        title: 'Daily Forecast',
        eventDate: new Date('2024-03-15T00:00:00Z'),
        venue: 'Edmonton',
        temperatureHigh: 8.5,
        temperatureLow: -5.2,
        humidity: 70,
        windGust: 45.5,
      });
      await forecast.save();

      // Reload and verify
      const loaded = await collection.get({ id: forecast.id });
      expect(loaded).toBeDefined();
      expect(loaded?.title).toBe('Daily Forecast');
      expect(loaded?.temperatureHigh).toBe(8.5);
      expect(loaded?.temperatureLow).toBe(-5.2);
      expect(loaded?.humidity).toBe(70);
      expect(loaded?.windGust).toBe(45.5);
    });

    it('should support polymorphic queries across STI hierarchy', async () => {
      const options = { db: { type: 'sqlite' as const, url: dbPath } };

      // Create instances through their specific collections
      const meetingCollection = await Issue693MeetingCollection.create(options);
      const forecastCollection =
        await Issue693WeatherForecastCollection.create(options);
      const eventCollection = await Issue693EventCollection.create(options);

      // Create different types
      const meeting = await meetingCollection.create({
        title: 'Board Meeting',
        eventDate: new Date('2024-03-10T14:00:00Z'),
        venue: 'Conference Room',
        councilId: 'board-123',
        agendaUrl: 'https://example.com/board-agenda.pdf',
        minutesUrl: '',
      });
      await meeting.save();

      const forecast = await forecastCollection.create({
        title: 'Weather Alert',
        eventDate: new Date('2024-03-11T06:00:00Z'),
        venue: 'Calgary',
        temperatureHigh: -2.0,
        temperatureLow: -15.5,
        humidity: 45,
        windGust: 80.0,
      });
      await forecast.save();

      // Query all events through base collection
      const allEvents = await eventCollection.list({});
      expect(allEvents.length).toBe(2);

      // Verify correct types are instantiated
      const titles = allEvents.map((e) => e.title).sort();
      expect(titles).toEqual(['Board Meeting', 'Weather Alert']);
    });
  });
});
