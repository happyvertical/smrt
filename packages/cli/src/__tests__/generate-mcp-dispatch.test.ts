/**
 * End-to-end dispatch regression for `smrt generate-mcp --version` (#2279).
 *
 * The unit tests in cli-generator-coverage.test.ts pin the parser behaviour;
 * this one drives the real handler the CLI binary uses, through the lazily
 * loaded built-in command map, and asserts the command actually ran with the
 * requested version instead of exiting after printing the CLI version.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';
import { dbMigrateUuidCommand } from '../commands/db-migrate-uuid.js';

describe('smrt generate-mcp --version (regression #2279)', () => {
  let cli: CLIGenerator;
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'smrt-generate-mcp-'));
    cli = new CLIGenerator({ prompt: false, colors: false });
    // Loading the consumer's compiled classes from disk is irrelevant here.
    // The regression drives the public handler; suppress only its private class-loading side effect.
    vi.spyOn(
      cli as unknown as { tryLoadUserClasses: () => Promise<void> },
      'tryLoadUserClasses',
    ).mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });

  it('generates a server stamped with the requested version', async () => {
    const outputPath = join(outputDir, 'index.js');

    await cli.generateHandler()([
      'generate-mcp',
      '--output-path',
      outputPath,
      '--version',
      '0.1.0',
      '--no-config',
      '--no-readme',
    ]);

    const generated = await readFile(outputPath, 'utf-8');
    expect(generated).toContain('const SERVER_VERSION = "0.1.0"');
  });
});

describe('smrt db:migrate-uuid -v (regression #2942)', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeCli(): CLIGenerator {
    const cli = new CLIGenerator({ prompt: false, colors: false });
    vi.spyOn(
      cli as unknown as { tryLoadUserClasses: () => Promise<void> },
      'tryLoadUserClasses',
    ).mockResolvedValue(undefined);
    return cli;
  }

  it('hands -v to the subcommand instead of printing the version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = vi
      .spyOn(dbMigrateUuidCommand, 'handler')
      .mockResolvedValue(undefined);

    await makeCli().generateHandler()(['db:migrate-uuid', '--dry-run', '-v']);

    expect(handler).toHaveBeenCalledTimes(1);
    const options = handler.mock.calls[0][1] as Record<string, unknown>;
    expect(options.verbose).toBe(true);
    expect(options['dry-run']).toBe(true);
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/ v\d/));
  });

  it('still prints the version for a global -v and --version', async () => {
    for (const flag of ['-v', '--version']) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const handler = vi
        .spyOn(dbMigrateUuidCommand, 'handler')
        .mockResolvedValue(undefined);
      await makeCli().generateHandler()([flag]);
      expect(handler).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/ v\d/));
      vi.restoreAllMocks();
    }
  });
});
