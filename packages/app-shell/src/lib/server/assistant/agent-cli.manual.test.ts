// Opt-in check against the REAL Claude Code or Codex on this machine (it
// spends the person's own subscription: one short turn). Run with
//   REAL_AGENT_CLI=claude-code|codex \
//   npx vitest run src/lib/server/assistant/agent-cli.manual.test.ts
// Set REAL_AGENT_CLI_RAW=<file> to also append the tool's raw JSON stream to
// that file (the stream holds the model's words and tool results, no token).
// The shell's real /mcp route runs on loopback with a throwaway token; the
// turn must list only the shell's tools and make one tool call through it.
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnEvent } from '../../assistant/events.ts';
import { locateCli } from '../agent-cli/detect.ts';
import { tempDir } from '../agent-cli/test-support.ts';
import { isAgentTool } from '../agent-cli/tools.ts';
import { runAs } from '../owner.ts';
import { callTool } from '../policy.ts';
import { openShell, type ShellHarness } from '../test-support.ts';
import { runAgentTurn } from './agent-turn.ts';
import { startTestMcp, type TestMcp } from './test-mcp.ts';
import { createThread } from './threads.ts';

const which = process.env.REAL_AGENT_CLI;
const real = isAgentTool(which);
let h: ShellHarness;
let mcp: TestMcp;
beforeAll(async () => {
  if (!real) return;
  h = await openShell();
  mcp = await startTestMcp(h.owner);
});
afterAll(async () => {
  if (!real) return;
  await mcp.close();
  await h.close();
});

describe.skipIf(!real)('the real local agent CLI', () => {
  it('answers through the shell’s tools only', async () => {
    const tool = which as 'claude-code' | 'codex';
    await runAs(h.owner, () =>
      callTool(h.owner, 'app_definemodel', {
        name: 'Chore',
        fields: { title: { type: 'text' } },
      }),
    );
    const found = await locateCli(tool);
    expect(found, `${tool} is not installed`).toBeTruthy();
    let path = (found as { path: string }).path;
    const raw = process.env.REAL_AGENT_CLI_RAW;
    if (raw) {
      // A pass-through that also copies the JSON stream to `raw`.
      const wrapper = join(tempDir('raw-tee-'), 'tool');
      writeFileSync(wrapper, `#!/bin/sh\n"${path}" "$@" | tee -a "${raw}"\n`);
      chmodSync(wrapper, 0o755);
      path = wrapper;
    }
    const stateDir = tempDir('real-agent-');
    const events: TurnEvent[] = [];
    const thread = await createThread(h.owner.id, 'smoke');
    const stop = await runAs(h.owner, () =>
      runAgentTurn({
        principal: h.owner,
        thread,
        text: 'First write one line naming every tool you can call. Then call the app_describe tool and tell me in one short sentence what models my app has.',
        tool,
        mcpUrl: mcp.url,
        signal: AbortSignal.timeout(180_000),
        emit: (e) => events.push(e),
        deps: {
          locate: async () => ({
            path,
            extraPath: (found as { extraPath: string[] }).extraPath,
          }),
          credentials: {
            async mint() {
              const token = `smrt_mcp_${randomBytes(32).toString('base64url')}`;
              mcp.setToken(token);
              return token;
            },
            async revoke() {
              mcp.setToken(null);
            },
          },
          stateDir: async () => stateDir,
          baseEnv: process.env,
        },
      }),
    );
    const text = events
      .flatMap((e) => (e.type === 'text' ? [e.delta] : []))
      .join('');
    console.log(
      JSON.stringify({
        stop,
        kinds: events.map((e) => e.type),
        tools: events.flatMap((e) => (e.type === 'tool_call' ? [e.name] : [])),
        errors: events.filter((e) => e.type === 'error'),
        text,
      }),
    );
    expect(stop).toBe('complete');
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r).toMatchObject({ ok: true });
  }, 240_000);
});
