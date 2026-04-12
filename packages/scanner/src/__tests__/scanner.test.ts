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

    // Create agent test file with static uiSlots and agent decorator
    writeFileSync(
      join(tempDir, 'agent.ts'),
      `
      import { SmrtObject, smrt } from '@happyvertical/smrt-core';

      @smrt({
        agent: {
          icon: 'newspaper',
          tier: 'standard',
          description: 'Test agent',
        },
        cli: { include: ['discover', 'analyze'] },
        mcp: { include: ['analyze', 'report'] },
      })
      export class TestAgent extends SmrtObject {
        static uiSlots = {
          sources: {
            id: 'sources',
            label: 'Data Sources',
            description: 'Configure data sources',
            icon: 'database',
            order: 1,
          },
          settings: {
            id: 'settings',
            label: 'Agent Settings',
            description: 'Configure defaults',
            icon: 'settings',
            order: 2,
          },
        };

        name: string = '';
        source: string = '';

        async discover(): Promise<any> { return {}; }
        async analyze(): Promise<any> { return {}; }
        async report(): Promise<any> { return {}; }
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

      // Should find Product, Category, TestAgent, Event, Meeting, Conference
      // Helper should be found but not as a SMRT class
      const smrtClasses = results.files
        .flatMap((f) => f.classes)
        .filter((c) => c.hasSmartDecorator);

      expect(smrtClasses.length).toBe(6);
      expect(smrtClasses.map((c) => c.className).sort()).toEqual([
        'Category',
        'Conference',
        'Event',
        'Meeting',
        'Product',
        'TestAgent',
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

  describe('static properties and agent manifests', () => {
    it('should extract static uiSlots into manifest staticProperties', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const { resolved } = await scanner.scanAndResolve();

      // Convert to manifest
      const { ManifestAdapter } = await import('../manifest-adapter.js');
      const adapter = new ManifestAdapter();
      const manifest = adapter.toManifest(resolved, {
        packageName: '@test/agent-pkg',
      });

      const agentKey = '@test/agent-pkg:TestAgent';
      const agentDef = manifest.objects[agentKey];
      expect(agentDef).toBeDefined();

      // Should have staticProperties with uiSlots
      expect(agentDef.staticProperties).toBeDefined();
      expect(agentDef.staticProperties?.uiSlots).toBeDefined();
      expect(agentDef.staticProperties?.uiSlots.sources).toMatchObject({
        id: 'sources',
        label: 'Data Sources',
        icon: 'database',
        order: 1,
      });
      expect(agentDef.staticProperties?.uiSlots.settings).toMatchObject({
        id: 'settings',
        label: 'Agent Settings',
        icon: 'settings',
        order: 2,
      });

      // uiSlots should NOT appear as a regular field
      expect(agentDef.fields.uiSlots).toBeUndefined();

      // Regular instance fields should still be present
      expect(agentDef.fields.name).toBeDefined();
      expect(agentDef.fields.source).toBeDefined();
    });

    it('should have decoratorConfig.agent for agent classes', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const { resolved } = await scanner.scanAndResolve();
      const { ManifestAdapter } = await import('../manifest-adapter.js');
      const adapter = new ManifestAdapter();
      const manifest = adapter.toManifest(resolved, {
        packageName: '@test/agent-pkg',
      });

      const agentDef = manifest.objects['@test/agent-pkg:TestAgent'];
      expect(agentDef.decoratorConfig.agent).toMatchObject({
        icon: 'newspaper',
        tier: 'standard',
        description: 'Test agent',
      });

      // Non-agent class should NOT have agent config
      const productDef = manifest.objects['@test/agent-pkg:Product'];
      expect(productDef.decoratorConfig.agent).toBeUndefined();
    });
  });

  describe('type alias resolution (end-to-end)', () => {
    it('should resolve type alias to text in manifest', async () => {
      // Write a file with a type alias and a class using it
      writeFileSync(
        join(tempDir, 'performer.ts'),
        `
        import { SmrtObject, smrt } from '@happyvertical/smrt-core';

        export type PerformerStatus = 'pending' | 'ready' | 'archived';

        @smrt()
        export class Performer extends SmrtObject {
          name: string = '';
          status: PerformerStatus = 'pending';
        }
        `,
      );

      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['performer.ts'],
      });

      const { results, resolved } = await scanner.scanAndResolve();

      // Verify type aliases were collected
      expect(results.typeAliases).toBeDefined();
      expect(results.typeAliases.PerformerStatus).toBe(
        "'pending' | 'ready' | 'archived'",
      );

      // Verify manifest output
      const { ManifestAdapter } = await import('../manifest-adapter.js');
      const adapter = new ManifestAdapter();
      const manifest = adapter.toManifest(resolved, {
        packageName: '@test/performer-pkg',
        typeAliases: results.typeAliases,
      });

      const performerDef = manifest.objects['@test/performer-pkg:Performer'];
      expect(performerDef).toBeDefined();

      // status should be text, not json
      expect(performerDef.fields.status).toBeDefined();
      expect(performerDef.fields.status.type).toBe('text');
      expect(performerDef.fields.status.default).toBe('pending');
    });

    it('should handle inline literal union without alias', async () => {
      writeFileSync(
        join(tempDir, 'inline-union.ts'),
        `
        import { SmrtObject, smrt } from '@happyvertical/smrt-core';

        @smrt()
        export class Widget extends SmrtObject {
          visibility: 'public' | 'private' | 'unlisted' = 'public';
        }
        `,
      );

      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['inline-union.ts'],
      });

      const { results, resolved } = await scanner.scanAndResolve();

      const { ManifestAdapter } = await import('../manifest-adapter.js');
      const adapter = new ManifestAdapter();
      const manifest = adapter.toManifest(resolved, {
        packageName: '@test/widget-pkg',
        typeAliases: results.typeAliases,
      });

      const widgetDef = manifest.objects['@test/widget-pkg:Widget'];
      expect(widgetDef.fields.visibility.type).toBe('text');
      expect(widgetDef.fields.visibility.default).toBe('public');
    });

    it('should preserve explicit text fields for external enum imports', async () => {
      writeFileSync(
        join(tempDir, 'external-enum.ts'),
        `
        import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
        import { UserStatus } from '@happyvertical/smrt-types';

        @smrt()
        export class ExternalEnumUser extends SmrtObject {
          @field({ type: 'text' })
          status: UserStatus = UserStatus.ACTIVE;
        }
        `,
      );

      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['external-enum.ts'],
      });

      const { results, resolved } = await scanner.scanAndResolve();

      const { ManifestAdapter } = await import('../manifest-adapter.js');
      const adapter = new ManifestAdapter();
      const manifest = adapter.toManifest(resolved, {
        packageName: '@test/widget-pkg',
        typeAliases: results.typeAliases,
      });

      const userDef = manifest.objects['@test/widget-pkg:ExternalEnumUser'];
      expect(userDef.fields.status.type).toBe('text');
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
      expect(stats.smrtClasses).toBe(9); // Product, Category, TestAgent, Event, Meeting, Conference, Performer, Widget, ExternalEnumUser
      expect(stats.stiClasses).toBe(3); // Event, Meeting, Conference
      expect(stats.parseTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
