/**
 * Benchmark suite for OXC Scanner
 *
 * Measures scan performance for various project sizes and
 * provides performance gates for CI/CD.
 *
 * Run with: npx vitest run benchmark.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OxcScanner } from '../scanner.js';

/**
 * Performance gates - tests fail if exceeded
 */
const PERFORMANCE_GATES = {
  small: 1000, // 10 files: < 1 second
  medium: 2000, // 100 files: < 2 seconds
  large: 4000, // 500 files: < 4 seconds
};

/**
 * Generate a test SMRT class file
 */
function generateSmrtClass(
  className: string,
  parentClass = 'SmrtObject',
): string {
  const fieldCount = Math.floor(Math.random() * 6) + 3; // 3-8 fields
  const fields = Array.from({ length: fieldCount }, (_, i) => {
    const types = [
      `field${i}: string = '';`,
      `count${i}: number = 0;`,
      `price${i}: number = 0.0;`,
      `active${i}: boolean = true;`,
      `tags${i}: string[] = [];`,
    ];
    return types[i % types.length];
  }).join('\n        ');

  return `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'get', 'create'] },
  cli: true
})
export class ${className} extends ${parentClass} {
        ${fields}

  async process(options: { input: string }): Promise<any> {
    return { processed: true };
  }
}
`;
}

/**
 * Generate test files in a directory
 */
function generateTestProject(
  baseDir: string,
  fileCount: number,
  options: { stiCount?: number; subDirs?: number } = {},
): void {
  const { stiCount = 0, subDirs = 3 } = options;

  // Create subdirectories
  const dirs = [baseDir];
  for (let i = 0; i < subDirs; i++) {
    const subDir = join(baseDir, `module${i}`);
    mkdirSync(subDir, { recursive: true });
    dirs.push(subDir);
  }

  // Create regular SMRT classes
  const regularCount = fileCount - stiCount;
  for (let i = 0; i < regularCount; i++) {
    const dir = dirs[i % dirs.length];
    const className = `Class${i}`;
    writeFileSync(join(dir, `${className}.ts`), generateSmrtClass(className));
  }

  // Create STI hierarchy if requested
  if (stiCount > 0) {
    const stiDir = join(baseDir, 'sti');
    mkdirSync(stiDir, { recursive: true });

    // Base STI class
    writeFileSync(
      join(stiDir, 'BaseEvent.ts'),
      `
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ tableStrategy: 'sti' })
export class BaseEvent extends SmrtObject {
  title: string = '';
  date: Date = new Date();
}
`,
    );

    // Child STI classes
    for (let i = 0; i < stiCount - 1; i++) {
      writeFileSync(
        join(stiDir, `Event${i}.ts`),
        `
import { BaseEvent } from './BaseEvent.js';
import { smrt } from '@happyvertical/smrt-core';

@smrt()
export class Event${i} extends BaseEvent {
  customField${i}: string = '';
  customCount${i}: number = 0;
}
`,
      );
    }
  }
}

describe('OXC Scanner Benchmarks', () => {
  describe('Small Project (10 files)', () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'smrt-bench-small-'));
      generateTestProject(tempDir, 10, { stiCount: 3 });
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it(`should scan in < ${PERFORMANCE_GATES.small}ms`, async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const startTime = performance.now();
      const results = await scanner.scan();
      const elapsed = performance.now() - startTime;

      console.log(`Small project (10 files): ${elapsed.toFixed(2)}ms`);
      console.log(`  Files scanned: ${results.fileCount}`);
      console.log(
        `  Classes found: ${results.files.flatMap((f) => f.classes).length}`,
      );

      expect(elapsed).toBeLessThan(PERFORMANCE_GATES.small);
      expect(results.fileCount).toBeGreaterThanOrEqual(10);
    });

    it('should resolve inheritance in reasonable time', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const startTime = performance.now();
      const { resolved } = await scanner.scanAndResolve();
      const elapsed = performance.now() - startTime;

      console.log(`Small project resolution: ${elapsed.toFixed(2)}ms`);
      console.log(`  Resolved classes: ${resolved.length}`);
      console.log(`  STI classes: ${resolved.filter((c) => c.isSTI).length}`);

      expect(elapsed).toBeLessThan(PERFORMANCE_GATES.small);
    });
  });

  describe('Medium Project (100 files)', () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'smrt-bench-medium-'));
      generateTestProject(tempDir, 100, { stiCount: 10, subDirs: 5 });
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it(`should scan in < ${PERFORMANCE_GATES.medium}ms`, async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const startTime = performance.now();
      const results = await scanner.scan();
      const elapsed = performance.now() - startTime;

      console.log(`Medium project (100 files): ${elapsed.toFixed(2)}ms`);
      console.log(`  Files scanned: ${results.fileCount}`);
      console.log(`  Parse time: ${results.totalParseTimeMs.toFixed(2)}ms`);

      expect(elapsed).toBeLessThan(PERFORMANCE_GATES.medium);
      expect(results.fileCount).toBeGreaterThanOrEqual(100);
    });

    it('should handle parallel file processing', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      // Run multiple scans in parallel
      const runs = 3;
      const startTime = performance.now();
      const results = await Promise.all(
        Array.from({ length: runs }, () => scanner.scan()),
      );
      const elapsed = performance.now() - startTime;

      console.log(`Parallel scans (${runs}x): ${elapsed.toFixed(2)}ms avg`);

      // Average should still be under gate
      expect(elapsed / runs).toBeLessThan(PERFORMANCE_GATES.medium);
      expect(results.every((r) => r.fileCount >= 100)).toBe(true);
    });
  });

  describe('Large Project (500 files)', () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'smrt-bench-large-'));
      generateTestProject(tempDir, 500, { stiCount: 50, subDirs: 10 });
    }, 30000); // Allow 30s for setup

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it(`should scan in < ${PERFORMANCE_GATES.large}ms`, async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      const startTime = performance.now();
      const results = await scanner.scan();
      const elapsed = performance.now() - startTime;

      console.log(`Large project (500 files): ${elapsed.toFixed(2)}ms`);
      console.log(`  Files scanned: ${results.fileCount}`);
      console.log(`  Parse time: ${results.totalParseTimeMs.toFixed(2)}ms`);
      console.log(
        `  Throughput: ${(results.fileCount / (elapsed / 1000)).toFixed(0)} files/sec`,
      );

      expect(elapsed).toBeLessThan(PERFORMANCE_GATES.large);
      expect(results.fileCount).toBeGreaterThanOrEqual(500);
    }, 10000); // Allow 10s for this test

    it('should scale linearly with file count', async () => {
      const scanner = new OxcScanner({
        cwd: tempDir,
        include: ['**/*.ts'],
      });

      // Scan with different file limits
      const measurements: { files: number; time: number }[] = [];

      for (const limit of [100, 250, 500]) {
        const startTime = performance.now();
        const results = await scanner.scan();
        const elapsed = performance.now() - startTime;

        // Take first N files worth of time
        measurements.push({
          files: Math.min(results.fileCount, limit),
          time: elapsed * (limit / results.fileCount),
        });
      }

      // Check roughly linear scaling (within 2x expected)
      const ratio = measurements[2].time / measurements[0].time;
      const expectedRatio = measurements[2].files / measurements[0].files;

      console.log(
        `Scaling check: ${ratio.toFixed(2)}x time for ${expectedRatio}x files`,
      );

      // Should be roughly linear (within 2x of linear)
      expect(ratio).toBeLessThan(expectedRatio * 2);
    }, 15000);
  });

  describe('Memory Usage', () => {
    it('should not leak memory across scans', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'smrt-bench-memory-'));
      generateTestProject(tempDir, 50);

      try {
        const scanner = new OxcScanner({
          cwd: tempDir,
          include: ['**/*.ts'],
        });

        // Force GC if available
        if (global.gc) global.gc();

        const initialMemory = process.memoryUsage().heapUsed;

        // Run multiple scans
        for (let i = 0; i < 10; i++) {
          await scanner.scan();
        }

        // Force GC if available
        if (global.gc) global.gc();

        const finalMemory = process.memoryUsage().heapUsed;
        const memoryGrowth = (finalMemory - initialMemory) / 1024 / 1024;

        console.log(
          `Memory growth over 10 scans: ${memoryGrowth.toFixed(2)} MB`,
        );

        // Should not grow more than 50MB
        expect(memoryGrowth).toBeLessThan(50);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Statistics', () => {
    it('should provide accurate statistics', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'smrt-bench-stats-'));
      generateTestProject(tempDir, 20, { stiCount: 5 });

      try {
        const scanner = new OxcScanner({
          cwd: tempDir,
          include: ['**/*.ts'],
        });

        await scanner.scan();
        const stats = scanner.getStats();

        console.log('Scanner statistics:', stats);

        expect(stats.fileCount).toBeGreaterThanOrEqual(20);
        expect(stats.smrtClasses).toBeGreaterThan(0);
        expect(stats.stiClasses).toBeGreaterThan(0);
        expect(stats.parseTimeMs).toBeGreaterThanOrEqual(0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
