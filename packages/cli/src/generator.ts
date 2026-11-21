/**
 * `@happyvertical/smrt-cli/generator`: the CLI's command generator, for
 * tools that need the list of commands the CLI serves (`listCommands()`)
 * without running the CLI.
 *
 * Importing this entry has no side effects (unlike the package root, which
 * runs the CLI).
 */

export {
  type CLICommand,
  type CLIConfig,
  type CLIContext,
  CLIGenerator,
} from './cli-generator.js';
