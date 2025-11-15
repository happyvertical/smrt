/**
 * Integration tests for STI Meta<T> fields
 *
 * Tests the complete save/load cycle with a real in-memory database:
 * 1. Define classes with Meta<T> fields
 * 2. Save instances to database
 * 3. Load instances from database
 * 4. Verify meta fields persist correctly
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { meta } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

@smrt({ tableStrategy: 'sti' })
class IntegrationEvent extends SmrtObject {
  title: string = '';
}

@smrt()
class IntegrationHockeyGame extends IntegrationEvent {
  @meta()
  arenaName: string = '';

  @meta()
  capacity: number = 0;

  homeTeam: string = ''; // Regular column field
}

class IntegrationHockeyGameCollection extends SmrtCollection<IntegrationHockeyGame> {
  static readonly _itemClass = IntegrationHockeyGame;
}

@smrt({ tableStrategy: 'sti' })
class IntegrationEvent2 extends SmrtObject {
  title: string = '';
}

@smrt()
class IntegrationConcert extends IntegrationEvent2 {
  @meta()
  venueName: string = '';

  @meta()
  ticketsSold: number = 0;

  artist: string = '';
}

class IntegrationConcertCollection extends SmrtCollection<IntegrationConcert> {
  static readonly _itemClass = IntegrationConcert;
}

describe('STI Meta<T> Integration Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-sti-meta-test-'));
    ObjectRegistry.registerCollection(
      'IntegrationHockeyGame',
      IntegrationHockeyGameCollection,
    );
    ObjectRegistry.registerCollection(
      'IntegrationConcert',
      IntegrationConcertCollection,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Save and load with Meta<T> type annotations', () => {
    it('should persist Meta<T> fields through save/load cycle', async () => {
      const dbPath = join(tempDir, 'hockey-games.json');
      const collection = await IntegrationHockeyGameCollection.create({
        db: { type: 'json', url: dbPath },
      });

      // Create and save instance with meta fields
      const game1 = await collection.create({
        title: 'Oilers vs Flames',
        arenaName: 'Rogers Place',
        capacity: 18500,
        homeTeam: 'Edmonton Oilers',
      });
      await game1.save();

      // Load by ID
      const game2 = await collection.get(game1.id);

      // Verify all fields loaded correctly
      expect(game2).toBeDefined();
      expect(game2?.title).toBe('Oilers vs Flames');
      expect(game2?.arenaName).toBe('Rogers Place');
      expect(game2?.capacity).toBe(18500);
      expect(game2?.homeTeam).toBe('Edmonton Oilers');
    });
  });

  describe('Save and load with meta() field helper', () => {
    it('should persist meta() fields through save/load cycle', async () => {
      const dbPath = join(tempDir, 'concerts.json');
      const collection = await IntegrationConcertCollection.create({
        db: { type: 'json', url: dbPath },
      });

      const concert1 = await collection.create({
        title: 'Rock Concert',
        venueName: 'Saddledome',
        ticketsSold: 15000,
        artist: 'The Rolling Stones',
      });
      await concert1.save();

      const concert2 = await collection.get(concert1.id);

      expect(concert2).toBeDefined();
      expect(concert2?.title).toBe('Rock Concert');
      expect(concert2?.venueName).toBe('Saddledome');
      expect(concert2?.ticketsSold).toBe(15000);
      expect(concert2?.artist).toBe('The Rolling Stones');
    });
  });
});
