import { describe, expect, it } from 'vitest';
import {
  BundleTreeError,
  MAX_ERROR_SUBJECTS,
  TREE_ERROR_MESSAGE_TABLE,
  type TreeErrorCode,
  toTreeError,
} from './tree-errors.js';

const codes = Object.keys(TREE_ERROR_MESSAGE_TABLE) as TreeErrorCode[];

describe('BundleTreeError', () => {
  it('has fixed, distinct, value-free messages', () => {
    const seen = new Set<string>();
    for (const code of codes) {
      const message = TREE_ERROR_MESSAGE_TABLE[code];
      expect(message.length, code).toBeGreaterThan(10);
      expect(message, code).not.toMatch(/[${}\\/]|%s|undefined|\[object/);
      expect(seen.has(message), code).toBe(false);
      seen.add(message);
      const error = new BundleTreeError(code);
      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(error.name).toBe('BundleTreeError');
    }
  });

  it('keeps field and subjects out of the message', () => {
    const error = new BundleTreeError('secret_file', {
      field: 'out',
      subjects: ['server/.env'],
    });
    expect(error.message).toBe(TREE_ERROR_MESSAGE_TABLE.secret_file);
    expect(error.field).toBe('out');
    expect(error.subjects).toEqual(['server/.env']);
    expect(Object.isFrozen(error.subjects)).toBe(true);
  });

  it('caps the subjects', () => {
    const many = Array.from({ length: 100 }, (_, i) => `p${i}`);
    expect(
      new BundleTreeError('path_escape', { subjects: many }).subjects,
    ).toHaveLength(MAX_ERROR_SUBJECTS);
  });

  it('groups codes into the categories the exit table needs', () => {
    expect(new BundleTreeError('invalid_option').category).toBe('usage');
    expect(new BundleTreeError('out_dir_not_empty').category).toBe(
      'invalid_input',
    );
    expect(new BundleTreeError('secret_file').category).toBe('verification');
    expect(new BundleTreeError('symlink_refused').category).toBe(
      'verification',
    );
    expect(new BundleTreeError('io_failed').category).toBe('io');
  });

  it('maps errno errors without keeping their text', () => {
    const map = (code: string) =>
      toTreeError(
        Object.assign(new Error(`${code}: open '/secret/path'`), { code }),
      );
    expect(map('ELOOP').code).toBe('symlink_refused');
    expect(map('EMLINK').code).toBe('symlink_refused');
    expect(map('ENOENT').code).toBe('entry_changed');
    expect(map('ENOTDIR').code).toBe('entry_changed');
    expect(map('EEXIST').code).toBe('destination_exists');
    expect(map('EACCES').code).toBe('io_failed');
    expect(map('ELOOP').message).not.toContain('/secret');
    const own = new BundleTreeError('path_escape');
    expect(toTreeError(own)).toBe(own);
    expect(toTreeError('weird').code).toBe('io_failed');
  });
});
