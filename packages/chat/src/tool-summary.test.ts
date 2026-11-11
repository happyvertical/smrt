import { describe, expect, it } from 'vitest';
import { describeAssistantTool, toolSummary } from './tool-summary.js';

describe('shared tool descriptions', () => {
  it.each([
    ['customers.create', { name: 'Ada' }, 'Added customer Ada'],
    ['customer_update', { name: 'Ada' }, 'Updated customer Ada'],
    ['invoices.delete', {}, 'Deleted invoice'],
    ['invoices.list', [{}, {}, {}], 'Looked up 3 invoices'],
    ['invoices.read', { items: [{}] }, 'Looked up 1 invoice'],
    [
      'private.unrecognized',
      { key: 'sk-keep-private' },
      'Completed this action',
    ],
  ])('%s gives short words', (name, result, expected) => {
    expect(toolSummary(name, result)).toBe(expected);
    expect(
      toolSummary(
        name,
        JSON.stringify({ structuredContent: { data: result } }),
      ),
    ).toBe(expected);
  });

  it.each([
    '{"name":"sk-sensitive"}',
    '{"name":"token value"}',
    '{"name":"/private/credentials"}',
    '{"name":"SELECT name FROM secrets"}',
    '{"name":"eyJhbGciOiJIUzI1NiJ9.this.is.private"}',
    '{"name":"<img src=x>"}',
    '{"name":"{bad JSON}"}',
  ])('never copies machine payloads into names: %s', (result) => {
    expect(toolSummary('customers.create', result)).toBe('Added customer');
  });

  it('bounds summaries and refuses payloads in unknown tools, including clipped JSON', () => {
    expect(
      toolSummary('custom', { summary: 'A short summary. '.repeat(30) }),
    ).toHaveLength(160);
    for (const summary of [
      '{"data":',
      'DROP TABLE people',
      'Bearer abc',
      '/private/key',
    ]) {
      expect(toolSummary('custom', { summary })).toBe('Completed this action');
    }
    expect(toolSummary('app_addmodel', 'Added customer Ada')).toBe(
      'Added customer Ada',
    );
    expect(describeAssistantTool('customers.create')).toBe('Adding customer');
    expect(toolSummary('customers.create', { name: 'Ada' }, false)).toBe(
      'Could not complete this action',
    );
  });
});
