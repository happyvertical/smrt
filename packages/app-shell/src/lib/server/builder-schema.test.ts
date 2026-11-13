import { FIELD_TYPES } from '@happyvertical/smrt-app-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, drive, say, scripted } from './assistant/test-helpers.ts';
import { createShellMcpServer } from './mcp-server.ts';
import { toolsFor } from './policy.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

type Schema = {
  type?: string;
  enum?: string[];
  pattern?: string;
  properties?: Record<string, Schema>;
  propertyNames?: Schema;
  additionalProperties?: Schema;
  required?: string[];
};
const schemaOf = async (name: string) =>
  (await toolsFor(h.owner)).find((t) => t.name === name)?.inputSchema as Schema;

describe('the builder tools say which types and names are allowed', () => {
  it('app_definemodel exposes the type enum and the field-name pattern', async () => {
    const s = await schemaOf('app_definemodel');
    const def = s.properties?.fields?.additionalProperties;
    expect(def?.properties?.type?.enum).toEqual([...FIELD_TYPES]);
    expect(def?.properties?.type?.enum).toEqual(
      expect.arrayContaining(['text', 'number', 'integer', 'boolean', 'date']),
    );
    expect(Object.keys(def?.properties ?? {})).toEqual(
      expect.arrayContaining(['type', 'choices', 'ref', 'required', 'label']),
    );
    const pattern = s.properties?.fields?.propertyNames?.pattern as string;
    const re = new RegExp(pattern);
    expect(re.test('dueDate')).toBe(true);
    expect(re.test('due_date')).toBe(false);
    expect(re.test('Title')).toBe(false);
  });

  it('app_addfield and app_changefieldtype expose the same', async () => {
    const add = await schemaOf('app_addfield');
    expect(add.properties?.definition?.properties?.type?.enum).toEqual([
      ...FIELD_TYPES,
    ]);
    expect(
      new RegExp(add.properties?.field?.pattern as string).test('due_date'),
    ).toBe(false);
    const change = await schemaOf('app_changefieldtype');
    expect(change.properties?.definition?.properties?.type?.enum).toEqual([
      ...FIELD_TYPES,
    ]);
    expect(
      new RegExp(change.properties?.field?.pattern as string).test('dueDate'),
    ).toBe(true);
  });

  it('/mcp tools/list carries the same schema', async () => {
    const server = createShellMcpServer();
    const tools = await server.listTools({
      principal: {
        id: h.owner.id,
        tenantId: h.owner.tenantId,
        kind: 'human',
        scopes: [],
      },
    } as never);
    const t = tools.find((x: { name: string }) => x.name === 'app_definemodel');
    expect(
      ((t?.inputSchema ?? {}) as Schema).properties?.fields
        ?.additionalProperties?.properties?.type?.enum,
    ).toEqual([...FIELD_TYPES]);
  });

  it('a stubbed model builds Chore using only what the generated schema says', async () => {
    const { model, requests } = scripted([
      (r) => {
        const tool = r.tools.find((t) => t.function.name === 'app_definemodel');
        const params = tool?.function.parameters as unknown as Schema;
        const def = params.properties?.fields?.additionalProperties;
        const allowed = def?.properties?.type?.enum ?? [];
        const re = new RegExp(
          params.properties?.fields?.propertyNames?.pattern as string,
        );
        // The wishes of the person, matched to the allowed vocabulary only.
        const wish: [string, string, boolean][] = [
          ['title', 'text', true],
          ['dueDate', 'date', false],
          ['done', 'boolean', false],
          ['points', 'integer', false],
        ];
        const fields: Record<string, unknown> = {};
        for (const [name, type, required] of wish) {
          expect(allowed).toContain(type);
          expect(re.test(name)).toBe(true);
          fields[name] = { type, ...(required ? { required } : {}) };
        }
        return say(
          'Adding Chores.',
          call('app_definemodel', { name: 'Chore', fields }),
        );
      },
      () => say('Done.'),
    ]);
    const { events, stop } = await drive({
      principal: h.owner,
      model,
      text: 'Track chores: a title, a due date, done or not, and points',
    });
    expect(stop).toBe('complete');
    expect(requests).toHaveLength(2);
    const results = events.filter((e) => e.type === 'tool_result') as {
      ok: boolean;
    }[];
    expect(results.every((e) => e.ok)).toBe(true);
    const { getHost } = await import('./host.ts');
    expect(
      Object.keys((await getHost()).describe().models.Chore.fields),
    ).toEqual(expect.arrayContaining(['title', 'dueDate', 'done', 'points']));
  });
});

describe('a rejected type or name steers the model to a fix in one retry', () => {
  it('lists the allowed types and the expected form, and the retry succeeds', async () => {
    const { model, requests } = scripted([
      () =>
        say(
          '',
          call('app_definemodel', {
            name: 'Visit',
            fields: { title: { type: 'string' }, due_date: { type: 'date' } },
          }),
        ),
      (r) => {
        const last = JSON.stringify(r.messages.at(-1)?.content ?? '');
        expect(last).toContain(
          "unknown type 'string'; use one of text, number, integer, boolean, date, money, choice, reference, json",
        );
        expect(last).toContain('camelCase');
        expect(last).toContain("did you mean 'dueDate'");
        return say(
          '',
          call('app_definemodel', {
            name: 'Visit',
            fields: { title: { type: 'text' }, dueDate: { type: 'date' } },
          }),
        );
      },
      () => say('Built.'),
    ]);
    const { events, stop } = await drive({
      principal: h.owner,
      model,
      text: 'visits',
    });
    expect(stop).toBe('complete');
    expect(requests).toHaveLength(3);
    const ok = (
      events.filter((e) => e.type === 'tool_result') as { ok: boolean }[]
    ).map((e) => e.ok);
    expect(ok).toEqual([false, true]);
  });
});

describe('every tool the assistant sends to a provider is self-contained', () => {
  const FORBIDDEN_TOP = ['anyOf', 'oneOf', 'allOf', 'not', 'enum', 'const'];
  const refs = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) {
      for (const x of v) refs(x, out);
    } else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (k === '$ref' || k === '$defs' || k === '$schema') out.push(k);
        refs(x, out);
      }
    return out;
  };

  it('with an app model present, shell and app tools alike', async () => {
    const { callTool } = await import('./policy.ts');
    await callTool(h.owner, 'app_definemodel', {
      name: 'Chore',
      fields: {
        title: { type: 'text', required: true },
        dueDate: { type: 'date' },
        done: { type: 'boolean' },
        points: { type: 'integer' },
      },
    }).catch(() => undefined);
    const { requests } = await (async () => {
      const s = scripted([() => say('ok')]);
      await drive({ principal: h.owner, model: s.model, text: 'hi' });
      return s;
    })();
    const tools = requests[0].tools;
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(
      expect.arrayContaining(['app_definemodel', 'chore_get', 'chore_create']),
    );
    for (const t of tools) {
      const p = t.function.parameters as Record<string, unknown>;
      expect(p.type, t.function.name).toBe('object');
      expect(Object.keys(p), t.function.name).not.toEqual(
        expect.arrayContaining(FORBIDDEN_TOP.slice(0, 1)),
      );
      for (const key of FORBIDDEN_TOP)
        expect(Object.keys(p), `${t.function.name} ${key}`).not.toContain(key);
      expect(refs(p), t.function.name).toEqual([]);
    }
  });
});
