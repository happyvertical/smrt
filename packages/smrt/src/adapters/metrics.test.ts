/**
 * Tests for MetricsAdapter
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { MetricsAdapter } from './metrics.js';
import type { Signal } from '@have/types';

describe('MetricsAdapter', () => {
  let adapter: MetricsAdapter;

  beforeEach(() => {
    adapter = new MetricsAdapter();
  });

  it('should track successful method executions', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      duration: 100,
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    const metrics = adapter.getMethodMetrics('Product', 'analyze');
    expect(metrics).toBeDefined();
    expect(metrics?.count).toBe(1);
    expect(metrics?.successCount).toBe(1);
    expect(metrics?.errorCount).toBe(0);
    expect(metrics?.totalDuration).toBe(100);
    expect(metrics?.minDuration).toBe(100);
    expect(metrics?.maxDuration).toBe(100);
  });

  it('should track failed method executions', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'error',
      error: new Error('Test error'),
      duration: 50,
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    const metrics = adapter.getMethodMetrics('Product', 'analyze');
    expect(metrics).toBeDefined();
    expect(metrics?.count).toBe(1);
    expect(metrics?.successCount).toBe(0);
    expect(metrics?.errorCount).toBe(1);
  });

  it('should track duration statistics', async () => {
    const signals: Signal[] = [
      {
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'end',
        duration: 100,
        timestamp: Date.now(),
      },
      {
        id: 'exec-2',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'end',
        duration: 200,
        timestamp: Date.now(),
      },
      {
        id: 'exec-3',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'end',
        duration: 150,
        timestamp: Date.now(),
      },
    ];

    for (const signal of signals) {
      await adapter.handle(signal);
    }

    const metrics = adapter.getMethodMetrics('Product', 'analyze');
    expect(metrics?.count).toBe(3);
    expect(metrics?.totalDuration).toBe(450);
    expect(metrics?.minDuration).toBe(100);
    expect(metrics?.maxDuration).toBe(200);

    const avgDuration = adapter.getAverageDuration('Product', 'analyze');
    expect(avgDuration).toBe(150);
  });

  it('should calculate success rate', async () => {
    const signals: Signal[] = [
      {
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'end',
        duration: 100,
        timestamp: Date.now(),
      },
      {
        id: 'exec-2',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'end',
        duration: 100,
        timestamp: Date.now(),
      },
      {
        id: 'exec-3',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'error',
        error: new Error('Test'),
        duration: 100,
        timestamp: Date.now(),
      },
    ];

    for (const signal of signals) {
      await adapter.handle(signal);
    }

    const successRate = adapter.getSuccessRate('Product', 'analyze');
    expect(successRate).toBeCloseTo(0.667, 2);

    const errorRate = adapter.getErrorRate('Product', 'analyze');
    expect(errorRate).toBeCloseTo(0.333, 2);
  });

  it('should track multiple methods independently', async () => {
    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      duration: 100,
      timestamp: Date.now(),
    });

    await adapter.handle({
      id: 'exec-2',
      objectId: 'obj-2',
      className: 'Product',
      method: 'validate',
      type: 'end',
      duration: 50,
      timestamp: Date.now(),
    });

    const analyzeMetrics = adapter.getMethodMetrics('Product', 'analyze');
    const validateMetrics = adapter.getMethodMetrics('Product', 'validate');

    expect(analyzeMetrics?.count).toBe(1);
    expect(validateMetrics?.count).toBe(1);
    expect(analyzeMetrics?.totalDuration).toBe(100);
    expect(validateMetrics?.totalDuration).toBe(50);
  });

  it('should ignore start signals', async () => {
    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    });

    const metrics = adapter.getMethodMetrics('Product', 'analyze');
    expect(metrics).toBeUndefined();
  });

  it('should generate Prometheus format', async () => {
    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      duration: 100,
      timestamp: Date.now(),
    });

    const prometheus = adapter.toPrometheusFormat();

    expect(prometheus).toContain('smrt_method_executions_total');
    expect(prometheus).toContain('smrt_method_duration_seconds');
    expect(prometheus).toContain('class="Product"');
    expect(prometheus).toContain('method="analyze"');
  });

  it('should get metrics snapshot', async () => {
    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      duration: 100,
      timestamp: Date.now(),
    });

    const snapshot = adapter.getMetrics();

    expect(snapshot.methods['Product.analyze']).toBeDefined();
    expect(snapshot.totalSignals).toBe(1);
    expect(snapshot.startTime).toBeLessThanOrEqual(Date.now());
  });

  it('should reset metrics', async () => {
    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      duration: 100,
      timestamp: Date.now(),
    });

    adapter.reset();

    const metrics = adapter.getMethodMetrics('Product', 'analyze');
    expect(metrics).toBeUndefined();

    const snapshot = adapter.getMetrics();
    expect(snapshot.totalSignals).toBe(0);
  });

  it('should return 0 for metrics of non-existent methods', () => {
    const avgDuration = adapter.getAverageDuration('Product', 'nonexistent');
    const successRate = adapter.getSuccessRate('Product', 'nonexistent');
    const errorRate = adapter.getErrorRate('Product', 'nonexistent');

    expect(avgDuration).toBe(0);
    expect(successRate).toBe(0);
    expect(errorRate).toBe(0);
  });
});
