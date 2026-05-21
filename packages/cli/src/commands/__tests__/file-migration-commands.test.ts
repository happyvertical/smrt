import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbDiffCommand } from '../db-diff.js';
import { dbGenerateCommand } from '../db-generate.js';

describe('file-backed migration commands', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables db:generate', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await dbGenerateCommand.handler([], {});

    expect(process.exitCode).toBe(1);
    expect(
      errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
    ).toContain('File-backed SMRT migrations are not supported');
  });

  it('emits JSON when db:generate is rejected in JSON mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbGenerateCommand.handler([], { json: true });

    expect(process.exitCode).toBe(1);
    expect(
      JSON.parse(logSpy.mock.calls.map((call) => call.join('')).join('\n')),
    ).toEqual({
      error: expect.stringContaining(
        'File-backed SMRT migrations are not supported',
      ),
    });
  });

  it('disables db:diff --generate before connecting to a database', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await dbDiffCommand.handler([], { generate: true });

    expect(process.exitCode).toBe(1);
    expect(
      errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
    ).toContain('File-backed SMRT migrations are not supported');
  });

  it('disables all file-generation options on db:diff', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await dbDiffCommand.handler([], { name: 'add-users', format: 'ts' });

    expect(process.exitCode).toBe(1);
    const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('File-backed SMRT migrations are not supported');
    expect(output).toContain('--name');
    expect(output).toContain('--format');
  });

  it('emits JSON when db:diff file-generation options are rejected in JSON mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbDiffCommand.handler([], { generate: true, json: true });

    expect(process.exitCode).toBe(1);
    expect(
      JSON.parse(logSpy.mock.calls.map((call) => call.join('')).join('\n')),
    ).toEqual({
      error: expect.stringContaining(
        'File-backed SMRT migrations are not supported',
      ),
    });
  });
});
