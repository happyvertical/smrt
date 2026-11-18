import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createTrackedAiClient,
  getAiRun,
  getRunTrajectory,
} from '@happyvertical/smrt-core';
import type { ChatGPTPlanConnection } from '@happyvertical/smrt-inference/server';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { businessWorkbook } from '../../../test-support/import-workbook.ts';
import { asSettingsOwner, assistantSettings } from './agent-cli/service.ts';
import { setChatGPTConnection } from './chatgpt.ts';
import { createImportAssistant } from './import-assistant.ts';
import { importPlanPrompt } from './import-workflow.ts';
import { installShellInference } from './inference.ts';
import { createShellMcpServer } from './mcp-server.ts';
import { mcpScopeKey } from './target.ts';
import { openShell, type ShellHarness } from './test-support.ts';

const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@happyvertical/ai', () => ({
  getAI: async () => ({
    async chat(_messages: unknown, options: Record<string, unknown>) {
      sent.push(options);
      return {
        content: JSON.stringify(businessWorkbook().plan),
        finishReason: 'stop',
      };
    },
  }),
}));
let h: ShellHarness;
beforeEach(async () => {
  h = await openShell();
  sent.length = 0;
});
afterEach(async () => {
  setChatGPTConnection(undefined);
  await h.close();
});
async function input() {
  const tracked = createTrackedAiClient({
    db: h.db,
    tenantId: h.owner.tenantId,
    transcript: false,
  });
  const { context } = await tracked.openRun({
    type: 'workflow',
    definitionKey: 'app-shell.import',
    ownerId: h.owner.id,
  });
  return {
    prompt: await resolvePrompt(importPlanPrompt.key, {
      variables: {
        schema: '{}',
        facts: 'Bounded workbook facts',
        findings: '[]',
        repairErrors: '[]',
        repairOutput: '',
      },
    }),
    origin: 'http://127.0.0.1:1',
    parent: { context, stepIndex: 0, name: 'Plan and load' },
    signal: new AbortController().signal,
  };
}
async function usage(parentId: string) {
  const handoff = (await getRunTrajectory(h.db, parentId))!.entries.flatMap(
    ({ event }) => (event?.type === 'handoff' ? [event] : []),
  )[0];
  expect(handoff).toMatchObject({ status: 'done', name: 'Plan and load' });
  const child = await getAiRun(h.db, handoff.childRunId!);
  expect(child).toMatchObject({
    type: 'turn',
    parentRunId: parentId,
    calls: 1,
  });
  expect(
    (await getRunTrajectory(h.db, child!.id))!.entries.filter(
      ({ event }) => event?.type === 'call',
    ),
  ).toHaveLength(1);
  return (
    await h.db.query(
      'SELECT provider, prompt_key, prompt_tokens, completion_tokens, total_tokens FROM _smrt_ai_usage WHERE run_id = ?',
      child!.id,
    )
  ).rows[0];
}

it.each([
  'claude-code',
  'codex',
] as const)('binds the saved %s engine to the shared CLI driver with no app tools', async (engine) => {
  await asSettingsOwner(h.owner, () => assistantSettings().write({ engine }));
  const bin = join(h.dir, 'fake-bin');
  mkdirSync(bin);
  const executable = join(bin, engine === 'codex' ? 'codex' : 'claude');
  const plan = JSON.stringify(businessWorkbook().plan);
  // Same stream shapes as inference's stub CLI; this fake never opens a socket.
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import {readFileSync} from 'node:fs';
const a=process.argv.slice(2), codex=a[0]==='exec';
readFileSync(0,'utf8');
const url=codex ? JSON.parse(a.find(x=>x.startsWith('mcp_servers.smrt.url=')).slice('mcp_servers.smrt.url='.length)) : JSON.parse(readFileSync(a[a.indexOf('--mcp-config')+1],'utf8')).mcpServers.smrt.url;
if(new URL(url).searchParams.get('scope')!=='import-plan') process.exit(2);
const out=x=>process.stdout.write(JSON.stringify(x)+'\\n'), text=${JSON.stringify(plan)};
if(codex){out({type:'thread.started',thread_id:'fake-thread'});out({type:'item.completed',item:{id:'answer',type:'agent_message',text}});out({type:'turn.completed',usage:{}});}
else{out({type:'system',subtype:'init',session_id:'fake-session',tools:[]});out({type:'result',subtype:'success',is_error:false,result:text,usage:{input_tokens:11,output_tokens:7}});}
`,
    { mode: 0o700 },
  );
  let revoked = 0;
  const assistant = createImportAssistant({
    db: h.db,
    root: h.dir,
    agent: {
      locate: async () => ({
        path: executable,
        extraPath: [dirname(process.execPath)],
      }),
      credentials: {
        mint: async () => 'fake-planning-credential',
        revoke: async () => {
          revoked++;
        },
      },
      stateDir: async () => join(h.dir, 'agent-state'),
      baseEnv: { PATH: process.env.PATH, HOME: h.dir },
    },
  });
  const request = await input();
  expect(JSON.parse(await assistant.plan(h.owner, request))).toEqual(
    businessWorkbook().plan,
  );
  expect(await usage(request.parent.context.runId)).toMatchObject({
    provider: engine,
    prompt_key: importPlanPrompt.key,
    prompt_tokens: engine === 'codex' ? null : 11,
    completion_tokens: engine === 'codex' ? null : 7,
  });
  expect(revoked).toBe(1);
});

function fakeConnection(signedIn = true): ChatGPTPlanConnection {
  return {
    start: async () => ({ authorizationUrl: 'https://auth.openai.com/test' }),
    cancel: async () => {},
    signOut: async () => ({ remoteRevocationConfirmed: true }),
    status: async () => ({ signedIn, signingIn: false }),
    models: async () => [{ id: 'gpt-6-astra', label: 'Best' }],
    defaultModel: async () => 'gpt-6-astra',
    clientOptions: async () => ({ type: 'chatgpt-plan' }),
  };
}

it('uses the signed-in ChatGPT engine with no API key and records its uncosted answer', async () => {
  const connection = fakeConnection();
  setChatGPTConnection(connection);
  installShellInference();
  await asSettingsOwner(h.owner, () =>
    assistantSettings().write({ engine: 'chatgpt' }),
  );
  const assistant = createImportAssistant({ db: h.db, root: h.dir });
  await assistant.ready(h.owner);
  const request = await input();
  expect(JSON.parse(await assistant.plan(h.owner, request))).toEqual(
    businessWorkbook().plan,
  );
  expect(await usage(request.parent.context.runId)).toMatchObject({
    provider: 'chatgpt',
    prompt_key: importPlanPrompt.key,
    total_tokens: null,
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].tools ?? []).toEqual([]);
  expect(
    (await getAiRun(h.db, request.parent.context.runId))!
      .inclusiveUncostedCalls,
  ).toBe(1);
});

it('exposes an empty planning MCP catalog and rejects structural and record calls before dispatch', async () => {
  const server = createShellMcpServer(undefined, { tools: 'none' });
  const principal = { ...h.owner, kind: 'human', scopes: ['assistant.use'] };
  expect(mcpScopeKey(new URLSearchParams('scope=import-plan'))).toBe(
    'import-plan',
  );
  expect(await server.listTools({ principal })).toEqual([]);
  for (const name of ['app_definemodel', 'order_create', 'app_publishdraft'])
    await expect(
      server.callTool({ principal, name, arguments: {} }),
    ).rejects.toMatchObject({ status: 403 });
});

it('refuses a disconnected chosen engine with plain connection instructions', async () => {
  setChatGPTConnection(fakeConnection(false));
  await asSettingsOwner(h.owner, () =>
    assistantSettings().write({ engine: 'chatgpt' }),
  );
  await expect(
    createImportAssistant({ db: h.db, root: h.dir }).ready(h.owner),
  ).rejects.toThrow(/Sign in with ChatGPT/);
});
