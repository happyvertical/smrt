import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OxcScanner } from '../scanner.js';

describe('OxcScanner', () => {
  let tempDir: string;

  beforeAll(() => {
    // Create temp directory for test files
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-scanner-test-'));

    // Create test files
    writeFileSync(
      join(tempDir, 'product.ts'),
      `
      import { SmrtObject, smrt } from '@happyvertical/smrt-core';

      @smrt({
        api: { include: ['list', 'get', 'create'] },
        cli: true
      })
      export class Product extends SmrtObject {
        name: string = '';
        price: number = 0.0;
        quantity: number = 0;
        active: boolean = true;
        tags: string[] = [];
      }
    `,
    );

    writeFileSync(
      join(tempDir, 'category.ts'),
      `
      import { SmrtObject, smrt } from '@happyvertical/smrt-core';

      @smrt()
      export class Category extends SmrtObject {
        name: string = '';
        description: string = '';
      }
    `,
    );

    writeFileSync(
      join(tempDir, 'helper.ts'),
      `
      // No @smrt decorator - should not be included
      export class Helper {
        static format(value: string): string {
          return value.toUpperCase();
        }
      }
    `,
    );

    // Create subdirectory with STI example
    const stiDir = join(tempDir, 'events');
    const mkdirSync = require('node:fs').mkdirSync;
    mkdirSync(stiDir, { recursive: true });

    writeFileSync(
      join(stiDir, 'event.ts'),
      `
      import { SmrtObject, smrt } from '@happyvertical/smrt-core';

      @smrt({ tableStrategy: 'sti' })
      export class Event extends SmrtObject {
        title: string = '';
        date: Date = new Date();
      }

      @smrt()
      export class Meeting extends Event {
        roomNumber: string = '';
        attendees: string[] = [];
      }

      @smrt()
      export class Conference extends Event {
        sponsorName: string = '';
        ticketPrice: number = 0.0;
      }
    `,
    );
  });

  afterAll(() => {
    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('scan', () => {
    it('should find all TypeScript files in directory', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
        exclude: [],
      });

      const results = await scanner.scan();

      expect(results.fileCount).toBeGreaterThan(0);
      expect(results.files.length).toBeGreaterThan(0);
    });

    it('should extract SMRT decorated classes', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const results = await scanner.scan();

      // Should find Product, Category, Event, Meeting, Conference
      // Helper should be found but not as a SMRT class
      const smrtClasses = results.files
        .flatMap((f) => f.classes)
        .filter((c) => c.hasSmartDecorator);

      expect(smrtClasses.length).toBe(5);
      expect(smrtClasses.map((c) => c.className).sort()).toEqual([
        'Category',
        'Conference',
        'Event',
        'Meeting',
        'Product',
      ]);
    });

    it('should respect exclude patterns', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
        exclude: ['**/events/**'],
      });

      const results = await scanner.scan();

      const fileNames = results.files.map((f) => f.filePath);
      const hasEventFile = fileNames.some((f) => f.includes('events'));
      expect(hasEventFile).toBe(false);
    });

    it('should track parse time', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const results = await scanner.scan();

      expect(results.totalParseTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('scanAndResolve', () => {
    it('should resolve inheritance chains', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const { resolved } = await scanner.scanAndResolve();

      // Check inheritance resolution
      const meeting = resolved.find((c) => c.className === 'Meeting');
      expect(meeting).toBeDefined();
      expect(meeting?.inheritanceChain).toContain('Event');
      expect(meeting?.inheritanceChain).toContain('Meeting');
    });

    it('should detect STI classes', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const { resolved } = await scanner.scanAndResolve();

      // Event should be STI base
      const event = resolved.find((c) => c.className === 'Event');
      expect(event?.isSTI).toBe(true);
      expect(event?.stiBase).toBe('Event');

      // Meeting should inherit STI
      const meeting = resolved.find((c) => c.className === 'Meeting');
      expect(meeting?.isSTI).toBe(true);
      expect(meeting?.stiBase).toBe('Event');

      // Product should not be STI
      const product = resolved.find((c) => c.className === 'Product');
      expect(product?.isSTI).toBe(false);
    });

    it('should merge inherited fields', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const { resolved } = await scanner.scanAndResolve();

      const meeting = resolved.find((c) => c.className === 'Meeting');
      // Use allFields for STI classes which includes inherited fields
      const fieldNames = meeting?.allFields.map((f) => f.name) || [];

      // Should have both inherited fields from Event and own fields
      expect(fieldNames).toContain('title'); // from Event
      expect(fieldNames).toContain('date'); // from Event
      expect(fieldNames).toContain('roomNumber'); // own
      expect(fieldNames).toContain('attendees'); // own
    });
  });

  describe('getStats', () => {
    it('should return scan statistics', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      await scanner.scan();
      const stats = scanner.getStats();

      expect(stats.fileCount).toBeGreaterThan(0);
      expect(stats.totalClasses).toBeGreaterThan(0);
      expect(stats.smrtClasses).toBe(5); // Product, Category, Event, Meeting, Conference
      expect(stats.stiClasses).toBe(3); // Event, Meeting, Conference
      expect(stats.parseTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
