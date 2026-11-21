// #5464 (interim boundary; the full one is #5498): which error text leaves the
// server at each exit. Driver text and a database host are replaced; every
// other message arrives verbatim. The exits are exercised with fakes at the
// layer below each one (the app host, the shell MCP server, a resolver).
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { decideApproval, getApprovalView } from './approvals.ts';
import { call, drive, say, scripted } from './assistant/test-helpers.ts';
import { shellMcpServer } from './catalog.ts';
import { getHost } from './host.ts';
import { createShellMcpServer } from './mcp-server.ts';
import { leaksHost, ownerResult, ownerText } from './owner-text.ts';
import { callTool } from './policy.ts';
import {
  applyWaiting,
  openShell,
  runAs,
  type ShellHarness,
} from './test-support.ts';

// What the runtime and the databases say themselves: all must arrive as is.
const VERBATIM: [string, string][] = [
  ['no id', 'chore has no id'],
  ['required', 'title is required for creating a chore'],
  ['coercion', 'field "done" must be true or false, got "maybe"'],
  ['reference', 'field "owner" refers to a person that does not exist'],
  ['read-only', 'field "total" is read-only (calculated)'],
  ['param', 'param month is required'],
  ['unknown tool', 'unknown tool'],
  ['method text', 'the lease has already ended'],
  ['sqlite unique', 'UNIQUE constraint failed: chores.slug'],
  [
    'postgres unique',
    'duplicate key value violates unique constraint "chores_slug_key"\nDetail: Key (slug)=(mop) already exists.',
  ],
  [
    'postgres fk',
    'insert or update on table "chores" violates foreign key constraint "chores_owner_fkey"\nDetail: Key (owner)=(5) is not present in table "people".',
  ],
  [
    'postgres check',
    'new row for relation "chores" violates check constraint "chores_size_check"',
  ],
];

const DRIVER =
  'Database query failed: INSERT INTO t (a) VALUES ($1)\nCause: connect ECONNREFUSED db.internal.example:5432 user svc_app';
const LEAK = 'could not reach 10.0.3.7:5432';
const SAVE = 'that change could not be saved, try again';
const DOWN = 'the database is unavailable, try again';

let h: ShellHarness;
beforeAll(async () => {
  process.env.DATABASE_URL =
    'postgres://svc_app:pw@db.internal.example:5432/app';
  h = await openShell();
  await runAs(h.owner, async () => {
    await callTool(h.owner, 'app_definemodel', {
      name: 'Chore',
      fields: { title: { type: 'text' } },
    });
  });
  await applyWaiting(h.owner);
});
afterAll(async () => {
  delete process.env.DATABASE_URL;
  await h.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const mcp = () => ({
  id: h.owner.id,
  tenantId: h.owner.tenantId,
  kind: 'human',
  scopes: [] as string[],
});
const errored = (text: string) => ({
  isError: true,
  content: [{ type: 'text', text }],
  structuredContent: { error: { message: text } },
});
const everywhere = (r: unknown) => JSON.stringify(r);

describe('ownerText', () => {
  it.each(VERBATIM)('passes %s through unchanged', (_n, text) => {
    expect(ownerText(text)).toBe(text);
    expect(ownerText(`Error: ${text}`)).toBe(`Error: ${text}`);
  });

  it('replaces driver text and logs the raw text', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(ownerText(DRIVER)).toContain(SAVE);
    expect(ownerText('Error: Database query failed: SELECT 1')).toContain(DOWN);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('checks host names and IPs as whole words only', () => {
    expect(leaksHost('10.0.3.7')).toBe(true);
    expect(leaksHost('peer [fe80::1]:5432 refused')).toBe(true);
    expect(leaksHost('db.internal.example refused')).toBe(true);
    expect(leaksHost('xdb.internal.example.org')).toBe(false);
    expect(leaksHost('SSL is on; svc_app owns it; at 12:30:45')).toBe(false);
    expect(leaksHost('version 1.2.3 of 300.1.1.1')).toBe(false);
    expect(leaksHost('build 1.2.3.400 done')).toBe(false);
    expect(leaksHost('Foo:: bar and ::')).toBe(false);
    // the deliberate blunt rule: a valid dotted quad is hidden even as a version
    expect(leaksHost('needs version 1.2.3.4')).toBe(true);
    expect(leaksHost('loopback ::1')).toBe(true);
    // punctuation after an address, and an address after a label
    expect(leaksHost('no route to fd00::7: timed out')).toBe(true);
    expect(leaksHost('addr:fd00::7')).toBe(true);
    expect(leaksHost('host:2001:db8::5 refused')).toBe(true);
    expect(leaksHost('connect ::1:5432')).toBe(true);
    expect(leaksHost('at 10.0.3.7:5432')).toBe(true);
    expect(leaksHost('host=fd00::7 refused')).toBe(true);
    for (const t of [
      'std::vector and Foo::bar and a::b',
      'Foo::b1',
      'std::c0',
      'Rust::fe1',
      'Foo::add1',
      'Foo::Bar',
      'at 12:30:45',
    ])
      expect(leaksHost(t), t).toBe(false);
  });

  it('scans long input in bounded time', () => {
    const t = Date.now();
    leaksHost('a'.repeat(10_000));
    leaksHost('a:'.repeat(5_000));
    leaksHost(`${'a'.repeat(10_000)}!`);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('ownerResult', () => {
  it('keeps the same object when nothing was replaced', () => {
    const r = {
      isError: true,
      content: [{ type: 'text', text: 'title is required' }],
      structuredContent: { error: { message: 'x' }, at: new Date(0) },
    };
    expect(ownerResult(r)).toBe(r);
    expect(ownerResult(errored(DRIVER))).not.toBe(r);
    // a non-plain object (a class instance) is still scrubbed
    class Detail {
      cause = DRIVER;
    }
    const withInstance = { ...errored('x'), structuredContent: new Detail() };
    expect(JSON.stringify(ownerResult(withInstance))).not.toContain('INSERT');
  });
});

describe('every exit', () => {
  async function appThrows(message: string) {
    const host = await getHost();
    vi.spyOn(host, 'callAppTool').mockRejectedValue(new Error(message));
  }
  async function appReturns(text: string) {
    const host = await getHost();
    vi.spyOn(host, 'callAppTool').mockResolvedValue(errored(text) as never);
  }

  describe.each(VERBATIM)('%s arrives verbatim', (_n, text) => {
    it('app tool result and throw', async () => {
      await appReturns(text);
      expect(everywhere(await callTool(h.owner, 'chore_list', {}))).toContain(
        JSON.stringify(text).slice(1, -1),
      );
      await appThrows(text);
      await expect(callTool(h.owner, 'chore_list', {})).rejects.toThrow(text);
    });
    it('shell tool result', async () => {
      vi.spyOn(shellMcpServer(), 'callTool').mockResolvedValue(
        errored(text) as never,
      );
      expect(everywhere(await callTool(h.owner, 'app_describe', {}))).toContain(
        JSON.stringify(text).slice(1, -1),
      );
    });
    it('assistant chip and the result the model reads', async () => {
      await appReturns(text);
      const { model, requests } = scripted([
        () => say('', call('chore_list', {})),
        () => say('done'),
      ]);
      await drive({ principal: h.owner, model });
      // The chip's own summary is a friendly classification (unchanged here);
      // the model, and the thread, get the tool's text as is.
      expect(JSON.stringify(requests[1].messages)).toContain(
        JSON.stringify(text).slice(1, -1),
      );
    });
    it('/mcp call and list errors', async () => {
      await appThrows(text);
      await expect(
        createShellMcpServer().callTool({
          name: 'chore_list',
          arguments: {},
          principal: mcp(),
        } as never),
      ).rejects.toThrow(text);
      await expect(
        createShellMcpServer(() => {
          throw new Error(text);
        }).listTools({ principal: mcp() } as never),
      ).rejects.toThrow(text);
    });
  });

  describe.each([
    [
      'driver text',
      DRIVER,
      SAVE,
      ['ECONNREFUSED', 'db.internal.example', 'svc_app', 'INSERT'],
    ],
    ['a host leak', LEAK, DOWN, ['10.0.3.7']],
  ])('%s is replaced', (_n, raw, reason, banned) => {
    const clean = (s: string) => {
      for (const b of banned) expect(s).not.toContain(b);
      expect(s).toContain(reason);
    };
    beforeAll(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('app tool result and throw', async () => {
      await appReturns(raw);
      clean(everywhere(await callTool(h.owner, 'chore_list', {})));
      await appThrows(raw);
      const e = await callTool(h.owner, 'chore_list', {}).catch((x) => x);
      clean(String(e.message));
    });
    it('shell tool result', async () => {
      vi.spyOn(shellMcpServer(), 'callTool').mockResolvedValue(
        errored(`Error: ${raw}`) as never,
      );
      clean(everywhere(await callTool(h.owner, 'app_describe', {})));
    });
    it('assistant chip and the result the model reads', async () => {
      await appReturns(raw);
      const { model, requests } = scripted([
        () => say('', call('chore_list', {})),
        () => say('done'),
      ]);
      const { events } = await drive({ principal: h.owner, model });
      const chip = (
        events.find((e) => e.type === 'tool_result') as { summary: string }
      ).summary;
      for (const b of banned) expect(chip).not.toContain(b);
      clean(JSON.stringify(requests[1].messages));
    });
    it('approval stored text', async () => {
      const host = await getHost();
      const rec = (await host.create('Chore', { title: 'x' })) as {
        id: string;
      };
      const pending = await callTool(h.owner, 'chore_delete', { id: rec.id });
      const body = JSON.parse((pending.content as { text: string }[])[0].text);
      const id = (body.result ?? body).approvalId as string;
      const two = errored(raw);
      two.content.push({ type: 'text', text: `second: ${raw}` });
      vi.spyOn(host, 'callAppTool').mockResolvedValue(two as never);
      const outcome = (await decideApproval(id, true, h.owner.id)) as {
        status: string;
        error?: string;
      };
      expect(outcome.status).toBe('failed');
      clean(outcome.error ?? '');
      // What the owner reads back later: every stored content item too.
      const view = await getApprovalView(id);
      clean(JSON.stringify(view?.result));
    });
    it('approval stored text when the host throws', async () => {
      const host = await getHost();
      const rec = (await host.create('Chore', { title: 'y' })) as {
        id: string;
      };
      const pending = await callTool(h.owner, 'chore_delete', { id: rec.id });
      const body = JSON.parse((pending.content as { text: string }[])[0].text);
      const id = (body.result ?? body).approvalId as string;
      await appThrows(raw);
      const outcome = (await decideApproval(id, true, h.owner.id)) as {
        error?: string;
      };
      clean(outcome.error ?? '');
    });
    it('/mcp call error, list error and denied path', async () => {
      await appThrows(raw);
      const call1 = await createShellMcpServer()
        .callTool({
          name: 'chore_list',
          arguments: {},
          principal: mcp(),
        } as never)
        .catch((x) => x);
      clean(String(call1.message));
      const list = await createShellMcpServer(() => {
        throw new Error(raw);
      })
        .listTools({ principal: mcp() } as never)
        .catch((x) => x);
      clean(String(list.message));
      const denied = await createShellMcpServer(() => {
        throw new Error(raw);
      })
        .callTool({
          name: 'chore_list',
          arguments: {},
          principal: mcp(),
        } as never)
        .catch((x) => x);
      clean(String(denied.message));
    });
  });
});
