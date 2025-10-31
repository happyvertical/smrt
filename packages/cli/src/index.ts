#!/usr/bin/env node
/**
 * @happyvertical/smrt-cli
 *
 * Developer CLI for SMRT framework
 * Provides introspection, testing, and project management tools
 */

import { main as runCLI } from './cli-generator.js';

// Run CLI and handle errors
runCLI().catch((error) => {
  console.error(
    'CLI Error:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exit(1);
});
