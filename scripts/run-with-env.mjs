#!/usr/bin/env node
/**
 * Run one command with extra environment variables, on any platform.
 *
 *   node ../../scripts/run-with-env.mjs NAME=value [NAME=value ...] -- <command> [args...]
 *
 * pnpm runs package scripts through cmd.exe on Windows, which rejects the
 * POSIX `NAME=value command` prefix (smrt#4857). This helper sets the
 * variables itself and runs the command through the platform shell, so
 * `node_modules/.bin` shims (`svelte-kit.cmd` on Windows) resolve the same way
 * they do for the script itself. It covers one command; chain several with
 * `&&` in the package script, one helper call per command.
 *
 * The command's arguments were already split by the package script's shell.
 * They are joined again for the platform shell, so an argument that would need
 * quoting there (whitespace or shell metacharacters) is rejected rather than
 * re-split differently on sh and cmd.exe.
 */

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const USAGE =
  'usage: run-with-env.mjs NAME=value [NAME=value ...] -- <command> [args...]';
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const PLAIN_ARGUMENT = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * Parse `NAME=value ... -- command args` into the variables and the command
 * line to hand to the platform shell.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{ env: Record<string, string>, command: string }}
 */
export function parseRunWithEnvArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator === -1) throw new Error(`missing "--"; ${USAGE}`);

  const env = {};
  for (const assignment of argv.slice(0, separator)) {
    const match = ASSIGNMENT.exec(assignment);
    if (!match) {
      throw new Error(`not a NAME=value assignment: ${assignment}; ${USAGE}`);
    }
    env[match[1]] = match[2];
  }
  if (Object.keys(env).length === 0) {
    throw new Error(`no NAME=value assignment before "--"; ${USAGE}`);
  }

  const words = argv.slice(separator + 1);
  if (words.length === 0) throw new Error(`missing command; ${USAGE}`);
  for (const word of words) {
    if (!PLAIN_ARGUMENT.test(word)) {
      throw new Error(
        `argument needs shell quoting, which this helper does not do: ${JSON.stringify(word)}`,
      );
    }
  }
  return { env, command: words.join(' ') };
}

function main() {
  let parsed;
  try {
    parsed = parseRunWithEnvArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`run-with-env: ${error.message}`);
    process.exit(2);
  }

  const child = spawn(parsed.command, {
    env: { ...process.env, ...parsed.env },
    shell: true,
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    console.error(`run-with-env: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`run-with-env: ${parsed.command} killed by ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
