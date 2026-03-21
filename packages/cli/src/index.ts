#!/usr/bin/env node
/**
 * @happyvertical/smrt-cli
 *
 * Developer CLI for SMRT framework
 * Provides introspection, testing, and project management tools
 */

import { main as runCLI } from './cli-generator.js';

type CliEntryGlobal = typeof globalThis & {
  __SMRT_CLI_ENTRY_RUNNING__?: boolean;
};

const cliEntryGlobal = globalThis as CliEntryGlobal;

// Some source-runner paths can evaluate the CLI entry twice. Guard the shim so
// commands still execute exactly once in development and from the built binary.
if (!cliEntryGlobal.__SMRT_CLI_ENTRY_RUNNING__) {
  cliEntryGlobal.__SMRT_CLI_ENTRY_RUNNING__ = true;

  runCLI().catch((error) => {
    console.error(
      'CLI Error:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    process.exit(1);
  });
}
