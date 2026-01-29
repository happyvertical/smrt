/**
 * Test for Issue #850: tableStrategy: 'sti' not inherited from parent class
 * in vitest plugin manifest generation
 *
 * PROBLEM:
 * When using `ManifestBuilder.generate()` (used by both vitest plugin and smrt test),
 * child classes that extend a parent with `tableStrategy: 'sti'` from an external
 * package were incorrectly generated as CTI instead of inheriting STI.
 *
 * ROOT CAUSE:
 * In `ManifestBuilder.createManifest()`, `smrtDependencies` was added to the manifest
 * AFTER `generateManifest()` returned, but `mergeInheritedFields()` (which runs inside
 * `generateManifest()`) needs `smrtDependencies` to load parent definitions from
 * external packages.
 *
 * FIX:
 * Pass `smrtDependencies` to `generateManifest()` in `ManifestBuilder.createManifest()`.
 *
 * EXPECTED:
 * Child classes should inherit `tableStrategy: 'sti'` from their external parent class.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestGenerator } from '../manifest-generator';
import type { ScanResult, SmartObjectDefinition } from '../types';

// Mock the loadExternalManifestSync function
vi.mock('../../manifest/manifest-loader.js', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    loadExternalManifestSync: vi.fn((packageName: string) => {
      // Simulate @happyvertical/smrt-events package manifest
      if (packageName === '@happyvertical/smrt-events') {
        return {
          version: '1.0.0',
          packageName: '@happyvertical/smrt-events',
          objects: {
            '@happyvertical/smrt-events:Event': {
              name: 'event',
              className: 'Event',
              collection: 'events',
              filePath:
                '/node_modules/@happyvertical/smrt-events/dist/event.js',
              fields: {
                title: { type: 'text', required: true },
                startDate: { type: 'datetime', nullable: true },
              },
              methods: {},
              decoratorConfig: {
                tableStrategy: 'sti', // Parent has STI
              },
              packageName: '@happyvertical/smrt-events',
            },
          },
        };
      }
      return null;
    }),
  };
});

describe('Issue #850: STI inheritance in vitest plugin manifest generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should inherit tableStrategy from external parent when smrtDependencies is passed', () => {
    const generator = new ManifestGenerator();

    // Create a child class that extends Event from external package
    const childDef: SmartObjectDefinition = {
      name: 'weather_forecast',
      className: 'WeatherForecast',
      collection: 'weather_forecasts',
      filePath: '/src/models/weather-forecast.ts',
      fields: {
        temperature: { type: 'decimal', required: true },
        humidity: { type: 'decimal', nullable: true },
      },
      methods: {},
      decoratorConfig: {
        // No tableStrategy - should inherit 'sti' from Event
        api: { include: ['list', 'get', 'create', 'update'] },
        mcp: { include: ['list', 'get'] },
        cli: true,
      },
      extends: 'Event', // Extends Event from external package
      packageName: '@happyvertical/caelus',
    };

    const scanResults: ScanResult[] = [
      {
        filePath: '/src/models/weather-forecast.ts',
        objects: [childDef],
        imports: [],
        exports: [],
      },
    ];

    // Generate manifest WITH smrtDependencies
    const manifest = generator.generateManifest(scanResults, {
      packageName: '@happyvertical/caelus',
      smrtDependencies: ['@happyvertical/smrt-events'],
    });

    // Get the WeatherForecast definition
    const weatherForecast =
      manifest.objects['@happyvertical/caelus:WeatherForecast'];

    expect(weatherForecast).toBeDefined();

    // CRITICAL: WeatherForecast should inherit tableStrategy: 'sti' from Event
    expect(weatherForecast.decoratorConfig.tableStrategy).toBe('sti');

    // CRITICAL: WeatherForecast should use the parent's table (events)
    expect(weatherForecast.decoratorConfig.tableName).toBe('events');

    // WeatherForecast should have merged fields from Event
    expect(weatherForecast.fields.title).toBeDefined(); // From Event
    expect(weatherForecast.fields.startDate).toBeDefined(); // From Event
    expect(weatherForecast.fields.temperature).toBeDefined(); // Own field
    expect(weatherForecast.fields.humidity).toBeDefined(); // Own field
  });

  it('should NOT inherit when external package is not in smrtDependencies (expected behavior)', () => {
    const generator = new ManifestGenerator();

    // Same child class definition
    const childDef: SmartObjectDefinition = {
      name: 'weather_forecast',
      className: 'WeatherForecast',
      collection: 'weather_forecasts',
      filePath: '/src/models/weather-forecast.ts',
      fields: {
        temperature: { type: 'decimal', required: true },
      },
      methods: {},
      decoratorConfig: {
        // No tableStrategy - would inherit 'sti' from Event if available
      },
      extends: 'Event',
      packageName: '@happyvertical/caelus',
    };

    const scanResults: ScanResult[] = [
      {
        filePath: '/src/models/weather-forecast.ts',
        objects: [childDef],
        imports: [],
        exports: [],
      },
    ];

    // Generate manifest WITHOUT smrtDependencies
    // This simulates when the parent package is not a dependency
    const manifest = generator.generateManifest(scanResults, {
      packageName: '@happyvertical/caelus',
      // NO smrtDependencies - parent package not available
    });

    const weatherForecast =
      manifest.objects['@happyvertical/caelus:WeatherForecast'];

    expect(weatherForecast).toBeDefined();

    // Without smrtDependencies, the external parent can't be found, so:
    // - tableStrategy is NOT inherited (will be undefined/CTI default)
    // - Fields are NOT merged from parent
    // - tableName is NOT inherited (will use own table)
    // This is EXPECTED behavior when the parent package is not available
    expect(weatherForecast.decoratorConfig.tableStrategy).toBeUndefined();

    // Parent fields are NOT merged (expected when parent not available)
    expect(weatherForecast.fields.title).toBeUndefined();
    expect(weatherForecast.fields.startDate).toBeUndefined();
  });
});
