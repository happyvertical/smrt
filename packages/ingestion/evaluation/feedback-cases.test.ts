import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { sha256 } from './corpus.mjs';
import { feedbackCases, materializeFeedback } from './feedback-cases.mjs';

test('feedback cohort is fixed eleven calls with identical paired bytes and balanced order', () => {
  const schedule = feedbackCases();
  expect(schedule.cases).toHaveLength(11);
  expect(
    schedule.cases.slice(0, 3).every((row) => row.arm === 'training'),
  ).toBe(true);
  const paired = schedule.cases.slice(3);
  expect(paired.map((row) => row.arm)).toEqual([
    'baseline',
    'treatment',
    'treatment',
    'baseline',
    'treatment',
    'baseline',
    'baseline',
    'treatment',
  ]);
  for (let index = 0; index < paired.length; index += 2) {
    expect(paired[index].family).toBe(paired[index + 1].family);
    expect(paired[index].source.sha256).toBe(paired[index + 1].source.sha256);
  }
  const parent = mkdtempSync(join(tmpdir(), 'feedback-cases-'));
  try {
    const root = join(parent, 'cohort');
    const materialized = materializeFeedback(root);
    expect(sha256(readFileSync(join(root, 'manifest.json')))).toBe(
      materialized.manifestSha256,
    );
    for (const row of materialized.manifest.cases)
      expect(sha256(readFileSync(join(root, row.source.path)))).toBe(
        row.source.sha256,
      );
    expect(() => materializeFeedback(root)).toThrow();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
