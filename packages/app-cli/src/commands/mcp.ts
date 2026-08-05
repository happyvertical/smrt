/**
 * `<name> mcp tools` / `<name> mcp call <tool> '<json>'` — thin HTTP proxy
 * to `/api/mcp/tools` and `/api/mcp/call`. The stdio bridge lives in
 * `bin/smrt-mcp-bridge` and `bridge.ts`; these are the equivalent
 * one-shot HTTP commands for ad-hoc inspection.
 *
 * @packageDocumentation
 */

import type { CliConfigContext } from '../config.js';
import { requestJsonResult } from '../config.js';

export interface McpCommandOptions {
  context: CliConfigContext;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  fetch?: typeof fetch;
}

export async function runMcpCommand(
  options: McpCommandOptions,
  args: string[],
): Promise<boolean> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const sub = args[0];

  if (sub === 'tools') {
    const result = await requestJsonResult(
      options.context,
      '/api/mcp/tools',
      { method: 'GET' },
      { fetch: options.fetch },
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok)
      stderr.write(`${result.error.message ?? result.error.code}\n`);
    return result.ok;
  }

  if (sub === 'call') {
    const name = args[1];
    const payload = args[2] ?? '{}';
    if (!name) throw new Error('Usage: mcp call <tool> [<json>]');
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error(
        `Could not parse mcp call payload: ${(error as Error).message}`,
      );
    }
    const result = await requestJsonResult(
      options.context,
      '/api/mcp/call',
      {
        body: JSON.stringify({ arguments: parsed, name }),
        method: 'POST',
      },
      { fetch: options.fetch },
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok)
      stderr.write(`${result.error.message ?? result.error.code}\n`);
    return result.ok;
  }

  throw new Error('Usage: mcp tools | mcp call <tool> [<json>]');
}
