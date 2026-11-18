// Only the CLI executable/provider transport is fake. Credentials, owner
// discovery, origin lookup, preferences and the fenced job all run for real.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  readOriginFile,
  writeOriginFile,
} from '@happyvertical/smrt-app-runtime';
import {
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from '@happyvertical/smrt-app-runtime/sveltekit';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getRunTrajectory } from '@happyvertical/smrt-core';
import type { TaskRunner } from '@happyvertical/smrt-jobs';
import { afterEach, expect, it, vi } from 'vitest';
import {
  businessBytes,
  businessWorkbook,
} from '../../../test-support/import-workbook.ts';
import {
  asSettingsOwner,
  assistantSettings,
  configureAgentCli,
} from './agent-cli/service.ts';
import { chatgptConnection, setChatGPTConnection } from './chatgpt.ts';
import { configureShell, resetShell } from './host.ts';
import { createShellImportService } from './import-workflow.ts';
import { installShellInference, resetShellInference } from './inference.ts';
import { prepareShellSchema } from './schema.ts';
import './registry.ts';

const binding = vi.hoisted(() => ({
  runtime: undefined as SmrtSvelteKitRuntime | undefined,
}));
// Bind the shell to an actual isolated local runtime, not a credential fake.
vi.mock('./smrt.ts', () => ({
  get runtime() {
    return binding.runtime;
  },
}));
vi.mock('@happyvertical/ai', async (original) => ({
  ...(await original<typeof import('@happyvertical/ai')>()),
  getAI: async (options: Record<string, unknown>) => ({
    getModels: async () => [{ id: 'gpt-6-astra', name: 'Best' }],
    async chat() {
      // The fake transport still asks the REAL SDK session manager for the
      // fixture credential. Neither sign-in resolution nor storage is mocked.
      const token = await (
        options.sessionManager as { accessToken(id: string): Promise<string> }
      ).accessToken(options.clientId as string);
      expect(token === 'fixture-access-token').toBe(true);
      return {
        content: JSON.stringify(businessWorkbook().plan),
        finishReason: 'stop',
      };
    },
  }),
}));
let root: string;
let service: ReturnType<typeof createShellImportService> | undefined;
let runner: TaskRunner | undefined;
afterEach(async () => {
  await runner?.stop();
  service?.dispose();
  runner = undefined;
  service = undefined;
  setChatGPTConnection(undefined);
  configureAgentCli(null);
  resetShellInference();
  await resetShell();
  await (await binding.runtime?.localRuntime())?.db.close?.();
  binding.runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

async function setup(engine: 'codex' | 'claude-code' | 'chatgpt') {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'import-job-engines-')));
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  writeFileSync(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@test/import-job' }),
  );
  const runtime = createSmrtSvelteKitRuntime({
    sourceRoot,
    dataDirectory: join(root, 'data'),
    runtime: resolveApplicationRuntime({ profile: 'local' }),
    env: { NODE_ENV: 'development' },
    backgroundJobs: true,
    prepareDatabase: async (db) => {
      await prepareShellSchema(db);
    },
  });
  binding.runtime = runtime;
  await runtime.init();
  const local = await runtime.localRuntime();
  const invitation = await local.rotateBootstrapInvitation();
  const claim = await local.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
  const owner = { id: claim.userId, tenantId: claim.tenantId };
  configureShell({
    db: async () => local.db,
    dataRoot: async () => local.paths.root,
    secretMasterKey: () => runtime.secretMasterKey(),
  });
  installShellInference();
  await asSettingsOwner(owner, () => assistantSettings().write({ engine }));
  // The persisted desktop origin overrides the upload's old address.
  writeOriginFile(runtime.applicationStateRoot(), 'http://127.0.0.1:1');
  service = createShellImportService({
    db: local.db,
    root: local.paths.root,
    assistant: {
      origin: async () =>
        (await readOriginFile(runtime.applicationStateRoot()))?.origin,
    },
  });
  runner = await local.createEmbeddedJobRunner({
    claimFencing: true,
    concurrency: 1,
    pollInterval: 10,
    retention: false,
  });
  return { owner, local };
}

it.each([
  'codex',
  'claude-code',
] as const)('mints and revokes a real owner credential for a %s import job without a request', async (engine) => {
  const { owner, local } = await setup(engine);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, engine === 'codex' ? 'codex' : 'claude');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import {readFileSync} from 'node:fs';
const a=process.argv.slice(2), out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(a.includes('--version')) {console.log('1.2.3');process.exit(0);}
if(a.includes('--help')) process.exit(0);
if(a[0]==='login') {console.log('Logged in using ChatGPT');process.exit(0);}
if(a[0]==='auth') {out({loggedIn:true});process.exit(0);}
if(a.some(x=>x.includes('smrt_preflight'))) {out({type:'turn.started'});process.exit(0);}
const codex=a[0]==='exec'; readFileSync(0,'utf8');
const url=codex?JSON.parse(a.find(x=>x.startsWith('mcp_servers.smrt.url=')).slice('mcp_servers.smrt.url='.length)):JSON.parse(readFileSync(a[a.indexOf('--mcp-config')+1],'utf8')).mcpServers.smrt.url;
if(url!=='http://127.0.0.1:1/mcp?scope=import-plan'||!process.env.SMRT_SHELL_MCP_TOKEN?.startsWith('smrt_mcp_')) process.exit(2);
const text=${JSON.stringify(JSON.stringify(businessWorkbook().plan))};
if(codex) {out({type:'thread.started',thread_id:'test'});out({type:'item.completed',item:{id:'answer',type:'agent_message',text}});out({type:'turn.completed',usage:{input_tokens:11,output_tokens:7}});}
else {out({type:'system',subtype:'init',session_id:'test',tools:[]});out({type:'result',subtype:'success',is_error:false,result:text,usage:{input_tokens:11,output_tokens:7}});}
`,
    { mode: 0o700 },
  );
  configureAgentCli({
    env: { PATH: `${bin}:${dirname(process.execPath)}`, HOME: root },
    home: root,
    platform: process.platform,
    loginShell: false,
    systemDirs: [],
  });
  const run = await service!.start(
    owner,
    new Request('http://127.0.0.1:2/api/shell/import', {
      method: 'POST',
      body: (await businessBytes()) as BodyInit,
    }),
  );
  await runner!.start();
  for (let i = 0; i < 1000; i++) {
    const current = await service!.current(owner);
    if (current?.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await service!.current(owner)).toMatchObject({
    state: 'done',
    status: 'review',
    proof: { ok: true },
  });
  const tokens = (
    await local.db.query(
      'SELECT holder, revoked_at FROM _smrt_local_mcp_tokens',
    )
  ).rows;
  expect(tokens).toHaveLength(1);
  expect(tokens[0].holder).toMatch(/^import-plan-[a-f0-9-]{36}$/);
  expect(tokens[0].revoked_at).toBeTruthy();
  const handoff = (await getRunTrajectory(local.db, run.id))!.entries.find(
    ({ event }) => event?.type === 'handoff',
  )!.event!;
  expect(handoff.status).toBe('done');
  expect(
    (
      await local.db.query(
        'SELECT prompt_tokens, completion_tokens FROM _smrt_ai_usage WHERE run_id = ?',
        handoff.childRunId!,
      )
    ).rows,
  ).toEqual([{ prompt_tokens: 11, completion_tokens: 7 }]);
});

it('resolves ChatGPT sign-in from the data root without an HTTP request', async () => {
  const { owner } = await setup('chatgpt');
  // The real SDK session manager reads the absent private credential file.
  expect(await (await chatgptConnection()).status()).toMatchObject({
    signedIn: false,
  });
  await expect(
    service!.start(
      owner,
      new Request('http://127.0.0.1:2/api/shell/import', {
        method: 'POST',
        body: (await businessBytes()) as BodyInit,
      }),
    ),
  ).rejects.toThrow(/Sign in with ChatGPT/);
});

it('resolves a signed-in ChatGPT session and runs its child turn from a job', async () => {
  const { owner, local } = await setup('chatgpt');
  // Seed the SDK's on-disk session fixture, never the person's real sign-in.
  const credentials = join(local.paths.root, 'chatgpt');
  mkdirSync(credentials, { mode: 0o700 });
  writeFileSync(
    join(credentials, 'chatgpt.json'),
    JSON.stringify({
      hostId: 'test-host',
      sessions: [
        {
          clientId: 'test-client',
          hostId: 'test-host',
          subject: 'test-owner',
          accessToken: 'fixture-access-token',
          refreshToken: 'fixture-refresh-token',
          idToken: 'fixture-id-token',
          scopes: ['openid', 'chatgpt.tokens.use.direct'],
          expiresAt: Date.now() + 3_600_000,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const run = await service!.start(
    owner,
    new Request('http://127.0.0.1:2/api/shell/import', {
      method: 'POST',
      body: (await businessBytes()) as BodyInit,
    }),
  );
  await runner!.start();
  for (let i = 0; i < 1000; i++) {
    if ((await service!.current(owner))?.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await service!.current(owner)).toMatchObject({
    state: 'done',
    status: 'review',
  });
  const handoff = (await getRunTrajectory(local.db, run.id))!.entries.find(
    ({ event }) => event?.type === 'handoff',
  )!.event!;
  expect(
    (
      await local.db.query(
        'SELECT provider, total_tokens FROM _smrt_ai_usage WHERE run_id = ?',
        handoff.childRunId!,
      )
    ).rows,
  ).toEqual([{ provider: 'chatgpt', total_tokens: null }]);
});
