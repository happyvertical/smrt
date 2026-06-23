/**
 * Unit tests for the smrt-video collection query helpers.
 *
 * Each collection exposes thin `find*` wrappers over `list()`. These run
 * against real in-memory SQLite (schema generated from the test manifest by
 * `smrtVitestPlugin`) — no DB mocking, per `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CharacterCollection } from '../characters.js';
import { VideoCompositionCollection } from '../video-compositions.js';
import { VideoSequenceCollection } from '../video-sequences.js';
import { VideoShotCharacterCollection } from '../video-shot-characters.js';
import { VideoShotCollection } from '../video-shots.js';

describe('video collection query helpers', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('VideoShotCollection', () => {
    it('finds shots by sequence, status, and standalone with no rows', async () => {
      const shots = await VideoShotCollection.create({ db });
      expect(await shots.findBySequence('seq-1')).toEqual([]);
      expect(await shots.findByStatus('ready')).toEqual([]);
      expect(await shots.findStandalone()).toEqual([]);
    });

    it('finds shots filtered by sequence and status', async () => {
      const shots = await VideoShotCollection.create({ db });
      const inSeq = await shots.create({
        title: 'Shot A',
        sequenceId: 'seq-1',
        shotStatus: 'ready',
      });
      await inSeq.save();
      const standalone = await shots.create({
        title: 'Shot B',
        sequenceId: null,
        shotStatus: 'draft',
      });
      await standalone.save();

      const bySeq = await shots.findBySequence('seq-1');
      expect(bySeq.map((s) => s.title)).toEqual(['Shot A']);

      const ready = await shots.findByStatus('ready');
      expect(ready.map((s) => s.title)).toEqual(['Shot A']);

      const loose = await shots.findStandalone();
      expect(loose.map((s) => s.title)).toEqual(['Shot B']);
    });
  });

  describe('VideoSequenceCollection', () => {
    it('finds sequences by composition and standalone', async () => {
      const sequences = await VideoSequenceCollection.create({ db });
      expect(await sequences.findByComposition('comp-1')).toEqual([]);
      expect(await sequences.findStandalone()).toEqual([]);

      const inComp = await sequences.create({
        title: 'Intro',
        compositionId: 'comp-1',
      });
      await inComp.save();

      const byComp = await sequences.findByComposition('comp-1');
      expect(byComp.map((s) => s.title)).toEqual(['Intro']);
    });
  });

  describe('VideoCompositionCollection', () => {
    it('finds compositions by render status and ready set', async () => {
      const compositions = await VideoCompositionCollection.create({ db });
      expect(await compositions.findByRenderStatus('rendering')).toEqual([]);
      expect(await compositions.findReady()).toEqual([]);

      const ready = await compositions.create({
        title: 'Final Cut',
        renderStatus: 'ready',
      });
      await ready.save();

      const readyByStatus = await compositions.findByRenderStatus('ready');
      expect(readyByStatus.map((c) => c.title)).toEqual(['Final Cut']);
      expect((await compositions.findReady()).map((c) => c.title)).toEqual([
        'Final Cut',
      ]);
    });
  });

  describe('VideoShotCharacterCollection', () => {
    it('finds character links by shot and by character', async () => {
      const links = await VideoShotCharacterCollection.create({ db });
      expect(await links.findByShot('shot-1')).toEqual([]);
      expect(await links.findByCharacter('char-1')).toEqual([]);

      const link = await links.create({
        videoShotId: 'shot-1',
        characterId: 'char-1',
        role: 'primary',
      });
      await link.save();

      expect(
        (await links.findByShot('shot-1')).map((l) => l.characterId),
      ).toEqual(['char-1']);
      expect(
        (await links.findByCharacter('char-1')).map((l) => l.videoShotId),
      ).toEqual(['shot-1']);
    });
  });

  describe('CharacterCollection', () => {
    it('finds characters by tenant, performer, and ready status', async () => {
      const characters = await CharacterCollection.create({ db });
      expect(await characters.findByTenant('tenant-1')).toEqual([]);
      expect(await characters.findByPerformer('perf-1')).toEqual([]);
      expect(await characters.findReady()).toEqual([]);

      const ready = await characters.create({
        name: 'Anchor',
        tenantId: 'tenant-1',
        performerId: 'perf-1',
        status: 'ready',
      });
      await ready.save();

      expect(
        (await characters.findByTenant('tenant-1')).map((c) => c.name),
      ).toEqual(['Anchor']);
      expect(
        (await characters.findByPerformer('perf-1')).map((c) => c.name),
      ).toEqual(['Anchor']);
      expect((await characters.findReady()).map((c) => c.name)).toEqual([
        'Anchor',
      ]);
    });
  });
});
