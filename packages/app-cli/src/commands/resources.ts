/**
 * `<name> resources [--json] [--debug]` — print the discovered resource
 * list. Default mode is a compact human-readable summary; `--json` dumps
 * the raw discovery payload; `--debug` adds the full warnings list.
 *
 * @packageDocumentation
 */

import type { CliConfigContext } from '../config.js';
import type { CliResource, ResourceListResponse } from '../discovery.js';
import { fetchResourceList } from '../discovery.js';

export interface ResourcesCommandOptions {
  context: CliConfigContext;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Tests: pre-supplied response, skips network. */
  injectResponse?: ResourceListResponse;
  /** Tests: custom fetch. */
  fetch?: typeof fetch;
}

export async function runResourcesCommand(
  options: ResourcesCommandOptions,
  args: string[],
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const json = args.includes('--json');
  const debug = args.includes('--debug');

  const response =
    options.injectResponse ??
    (await fetchResourceList(options.context, {
      fetch: options.fetch,
    }));

  if (json) {
    stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  if (response.resources.length === 0) {
    if (!response.user.authenticated) {
      stdout.write('(no resources — not authenticated)\n');
    } else {
      stdout.write('(no resources discovered)\n');
    }
    return;
  }

  for (const resource of response.resources) {
    stdout.write(`${resource.slug}  (${resource.className})\n`);
    for (const command of resource.commands) {
      stdout.write(`  - ${formatCommandLine(resource, command)}\n`);
    }
  }

  if (response.warnings.length > 0) {
    if (debug) {
      stderr.write(`\nwarnings:\n`);
      for (const w of response.warnings) {
        stderr.write(`  - ${w}\n`);
      }
    } else {
      stderr.write(
        `\n${response.warnings.length} command${
          response.warnings.length === 1 ? '' : 's'
        } unavailable (use --debug for details)\n`,
      );
    }
  }
}

function formatCommandLine(
  _resource: CliResource,
  command: import('../discovery.js').CommandDefinition,
): string {
  const idHint = command.scope === 'item' ? ' <id>' : '';
  const description = command.description ? `  — ${command.description}` : '';
  return `${command.commandName}${idHint}${description}`;
}
