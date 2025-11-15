/**
 * Reproduction test for issue #288 and #289
 *
 * Issue #288: Foreign key fields not registered in STI model schemas
 * Issue #289: STI discriminator (_meta_type) not set automatically when saving subclass instances
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Base class with STI (renamed to avoid collision with cli-module.test.ts)
@smrt({ tableStrategy: 'sti' })
class TestArticle extends SmrtObject {
  title: string = '';
  body: string = '';
  published_at: Date | null = null;
  word_count: number = 0;
}

// Child class with foreign keys (like MeetingAnnouncement)
@smrt()
class TestMeetingAnnouncement extends TestArticle {
  @field({ required: true })
  @foreignKey('Meeting')
  meetingId: string = '';

  @foreignKey('Council')
  councilId: string = '';
}

// Collections
class TestArticleCollection extends SmrtCollection<TestArticle> {
  static readonly _itemClass = TestArticle;
}

class TestMeetingAnnouncementCollection extends SmrtCollection<TestMeetingAnnouncement> {
  static readonly _itemClass = TestMeetingAnnouncement;
}

describe('Issue #288 and #289 Reproduction', () => {
  let dbDir: string;
  let dbPath: string;
  let collection: TestMeetingAnnouncementCollection;

  beforeEach(async () => {
    // Create temp directory for test database
    dbDir = await mkdtemp(join(tmpdir(), 'smrt-test-'));
    dbPath = join(dbDir, 'test.db');

    // Create collection
    collection = await TestMeetingAnnouncementCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(async () => {
    // Cleanup
    if (dbDir) {
      await rm(dbDir, { recursive: true, force: true });
    }
  });

  describe('Issue #288: Foreign key fields not registered', () => {
    it('should register foreign key fields in the schema', () => {
      // Get registered fields for TestMeetingAnnouncement
      const fields = ObjectRegistry.getFields('TestMeetingAnnouncement');

      console.log(
        'Registered fields for TestMeetingAnnouncement:',
        Array.from(fields.keys()),
      );
      console.log(
        'All fields with types:',
        Array.from(fields.entries()).map(([k, v]) => `${k}: ${v.type}`),
      );

      // Also check TestArticle fields
      const articleFields = ObjectRegistry.getFields('TestArticle');
      console.log(
        'Registered fields for TestArticle:',
        Array.from(articleFields.keys()),
      );

      // Foreign key fields should be registered
      expect(fields.has('meetingId')).toBe(true);
      expect(fields.has('councilId')).toBe(true);

      // Check that they're marked as foreignKey type, not meta
      const meetingIdField = fields.get('meetingId');
      const councilIdField = fields.get('councilId');

      expect(meetingIdField?.type).toBe('foreignKey');
      expect(councilIdField?.type).toBe('foreignKey');
    });

    it('should allow querying by foreign key fields', async () => {
      // Create an announcement
      const announcement = await collection.create({
        meetingId: 'meeting-123',
        councilId: 'council-456',
        title: 'Test Announcement',
        body: 'Test body',
      });
      await announcement.save();

      // Query by foreign key field - this should NOT throw
      const result = await collection.findOne({
        where: { meetingId: 'meeting-123' },
      });

      expect(result).toBeDefined();
      expect(result?.meetingId).toBe('meeting-123');
    });
  });

  describe('Issue #289: _meta_type not set automatically', () => {
    it('should detect STI strategy for child class', () => {
      const strategy = ObjectRegistry.getTableStrategy(
        'TestMeetingAnnouncement',
      );
      expect(strategy).toBe('sti');
    });

    it('should automatically set _meta_type in toJSON()', async () => {
      const announcement = new TestMeetingAnnouncement({
        meetingId: 'meeting-123',
        councilId: 'council-456',
        title: 'Test Announcement',
        body: 'Test body',
        db: { type: 'sqlite', url: dbPath },
      });

      // MUST call initialize() to apply option values to Field instances
      await announcement.initialize();

      // Check if values are set on the instance
      console.log('Instance meetingId:', announcement.meetingId);
      console.log('Instance councilId:', announcement.councilId);
      console.log('Instance keys:', Object.keys(announcement));
      console.log('Has meetingId property?', 'meetingId' in announcement);
      console.log('Has councilId property?', 'councilId' in announcement);

      const json = announcement.toJSON();

      console.log('toJSON() result:', JSON.stringify(json, null, 2));
      console.log('Has meetingId in json?', 'meetingId' in json);
      console.log('Has councilId in json?', 'councilId' in json);
      console.log('Has _meta_data?', '_meta_data' in json);
      console.log('_meta_data contents:', json._meta_data);

      // _meta_type should be set automatically
      expect(json._meta_type).toBe('TestMeetingAnnouncement');

      // Foreign keys should be in the JSON output (either directly or in _meta_data)
      expect(
        'meetingId' in json ||
          ('_meta_data' in json && json._meta_data?.meetingId),
      ).toBe(true);
    });

    it('should save without validation errors', async () => {
      const announcement = await collection.create({
        meetingId: 'meeting-123',
        councilId: 'council-456',
        title: 'Test Announcement',
        body: 'Test body',
      });

      // This should NOT throw "Missing _meta_type discriminator" error
      await expect(announcement.save()).resolves.not.toThrow();
    });
  });
});
