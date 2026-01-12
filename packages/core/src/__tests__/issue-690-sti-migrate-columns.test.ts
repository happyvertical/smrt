/**
 * Issue #690: db:migrate doesn't detect STI subclass columns
 *
 * When using Single Table Inheritance (STI), the `smrt db:migrate` command
 * didn't detect columns that are defined on subclasses. This caused schema
 * drift when subclass properties are serialized to the shared table but
 * the columns don't exist.
 *
 * Root cause: STI subclasses registered from manifests have empty
 * `schema.columns` but populated `fields`. The `getAllSchemas()` method
 * only looked at `schema.columns`, missing subclass fields.
 *
 * Fix: When `schema.columns` is empty but `fields` has entries,
 * `getAllSchemas()` now converts fields to columns for the merge.
 *
 * Related: https://github.com/happyvertical/smrt/issues/690
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
import type { Meta } from '../types';

/**
 * STI base class - Event
 */
@smrt({ tableStrategy: 'sti' })
class Issue690Event extends SmrtObject {
  name: string = '';
  startDate: Date = new Date();
  endDate: Date = new Date();
  location: string = '';
}

class Issue690EventCollection extends SmrtCollection<Issue690Event> {
  static readonly _itemClass = Issue690Event;
}

/**
 * STI child - Meeting (adds council_id, agenda_url, minutes_url)
 */
@smrt()
class Issue690Meeting extends Issue690Event {
  councilId: string = '';
  agendaUrl: string = '';
  minutesUrl: string = '';
}

class Issue690MeetingCollection extends SmrtCollection<Issue690Meeting> {
  static readonly _itemClass = Issue690Meeting;
}

/**
 * STI child - WeatherForecast (adds temperature, humidity, etc.)
 */
@smrt()
class Issue690WeatherForecast extends Issue690Event {
  temperatureHigh: number = 0.0;
  temperatureLow: number = 0.0;
  feelsLike: number = 0.0;
  humidity: number = 0;
  pressure: number = 0;
  windSpeed: number = 0.0;
  uvIndex: number = 0;
}

class Issue690WeatherForecastCollection extends SmrtCollection<Issue690WeatherForecast> {
  static readonly _itemClass = Issue690WeatherForecast;
}

describe('Issue #690: STI Migrate Columns', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-issue-690-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('getAllSchemas() with STI subclasses', () => {
    it('should include columns from STI subclasses in merged schema', async () => {
      // Get all schemas - this is what db:migrate uses
      const schemas = ObjectRegistry.getAllSchemas();

      // Find the events table schema (table name is pluralized lowercase without underscore)
      const eventsSchema = schemas.issue690events;
      expect(eventsSchema).toBeDefined();

      // Parse DDL to extract columns
      const ddl = eventsSchema.ddl;

      // Base class columns should be present
      expect(ddl).toContain('"name"');
      expect(ddl).toContain('"start_date"');
      expect(ddl).toContain('"end_date"');
      expect(ddl).toContain('"location"');

      // Meeting subclass columns should be present (Issue #690 fix)
      expect(ddl).toContain('"council_id"');
      expect(ddl).toContain('"agenda_url"');
      expect(ddl).toContain('"minutes_url"');

      // WeatherForecast subclass columns should be present (Issue #690 fix)
      expect(ddl).toContain('"temperature_high"');
      expect(ddl).toContain('"temperature_low"');
      expect(ddl).toContain('"feels_like"');
      expect(ddl).toContain('"humidity"');
      expect(ddl).toContain('"pressure"');
      expect(ddl).toContain('"wind_speed"');
      expect(ddl).toContain('"uv_index"');

      // STI meta columns should be present
      expect(ddl).toContain('"_meta_type"');
      expect(ddl).toContain('"_meta_data"');
    });

    it('should preserve correct SQL types for STI subclass columns', async () => {
      const schemas = ObjectRegistry.getAllSchemas();
      const eventsSchema = schemas.issue690events;
      const ddl = eventsSchema.ddl;

      // Integer columns (no decimal in default value)
      expect(ddl).toMatch(/"humidity"\s+INTEGER/);
      expect(ddl).toMatch(/"pressure"\s+INTEGER/);
      expect(ddl).toMatch(/"uv_index"\s+INTEGER/);

      // Decimal columns (decimal in default value)
      expect(ddl).toMatch(/"temperature_high"\s+REAL/);
      expect(ddl).toMatch(/"temperature_low"\s+REAL/);
      expect(ddl).toMatch(/"feels_like"\s+REAL/);
      expect(ddl).toMatch(/"wind_speed"\s+REAL/);

      // Text columns
      expect(ddl).toMatch(/"council_id"\s+TEXT/);
      expect(ddl).toMatch(/"agenda_url"\s+TEXT/);
      expect(ddl).toMatch(/"minutes_url"\s+TEXT/);
    });
  });

  describe('End-to-end STI subclass persistence', () => {
    it('should save and load Meeting with all columns present', async () => {
      const options = { db: { type: 'sqlite' as const, url: dbPath } };

      const collection = await Issue690MeetingCollection.create(options);

      // Create a meeting
      const meeting = await collection.create({
        name: 'Town Council Meeting',
        startDate: new Date('2024-01-15T19:00:00Z'),
        endDate: new Date('2024-01-15T21:00:00Z'),
        location: 'Town Hall',
        councilId: 'council-123',
        agendaUrl: 'https://example.com/agenda.pdf',
        minutesUrl: 'https://example.com/minutes.pdf',
      });
      await meeting.save();

      // Reload and verify
      const loaded = await collection.get({ id: meeting.id });
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Town Council Meeting');
      expect(loaded?.councilId).toBe('council-123');
      expect(loaded?.agendaUrl).toBe('https://example.com/agenda.pdf');
      expect(loaded?.minutesUrl).toBe('https://example.com/minutes.pdf');
    });

    it('should save and load WeatherForecast with all columns present', async () => {
      const options = { db: { type: 'sqlite' as const, url: dbPath } };

      const collection =
        await Issue690WeatherForecastCollection.create(options);

      // Create a weather forecast
      const forecast = await collection.create({
        name: 'Daily Forecast',
        startDate: new Date('2024-01-15T00:00:00Z'),
        endDate: new Date('2024-01-15T23:59:59Z'),
        location: 'Edmonton',
        temperatureHigh: 5.5,
        temperatureLow: -10.2,
        feelsLike: -15.0,
        humidity: 65,
        pressure: 1013,
        windSpeed: 25.5,
        uvIndex: 2,
      });
      await forecast.save();

      // Reload and verify
      const loaded = await collection.get({ id: forecast.id });
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Daily Forecast');
      expect(loaded?.temperatureHigh).toBe(5.5);
      expect(loaded?.temperatureLow).toBe(-10.2);
      expect(loaded?.feelsLike).toBe(-15.0);
      expect(loaded?.humidity).toBe(65);
      expect(loaded?.pressure).toBe(1013);
      expect(loaded?.windSpeed).toBe(25.5);
      expect(loaded?.uvIndex).toBe(2);
    });
  });
});
