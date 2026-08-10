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

describe('smrt generate-mcp --version (regression #2279)', () => {
  let cli: CLIGenerator;
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'smrt-generate-mcp-'));
    cli = new CLIGenerator({ prompt: false, colors: false });
    // Loading the consumer's compiled classes from disk is irrelevant here.
    vi.spyOn(cli as never, 'tryLoadUserClasses').mockResolvedValue(undefined);
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
