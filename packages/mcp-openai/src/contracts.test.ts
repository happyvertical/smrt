import { describe, expect, it } from 'vitest';
import {
  capabilityState,
  createOpenAiAppLink,
  openAiNavigationLink,
  readOpenAiDeepLink,
} from './client.js';
import {
  bindOpenAiSettings,
  EMPTY_ARGUMENTS_SCHEMA,
  openAiDisplayMetadata,
  openAiOnboardingDeclaration,
  validateSettingsRead,
  validateSettingsSchema,
  validateSettingsValues,
  withOpenAiEntrypoints,
} from './index.js';
import { appRelativeUrl, json } from './validation.js';

const workflow = {
  name: 'view',
  description: 'Synthetic view',
  inputSchema: EMPTY_ARGUMENTS_SCHEMA,
  outputSchema: { type: 'object' as const },
  effect: 'read' as const,
  idempotent: true,
  openWorld: false,
  ui: { resourceUri: 'ui://synthetic/v1/view' },
  execute: () => ({
    content: [{ type: 'text' as const, text: 'Synthetic headless view' }],
    structuredContent: {},
  }),
};
const schema = {
  type: 'object' as const,
  properties: {
    units: { type: 'string' as const, title: 'Units', enum: ['mm', 'in'] },
    grid: { type: 'boolean' as const, title: 'Grid' },
    count: {
      type: 'integer' as const,
      title: 'Count',
      minimum: 1,
      maximum: 10,
    },
  },
};
describe('pinned navigation declarations', () => {
  it('adds only requested entrypoints without changing ordinary execution', async () => {
    const annotated = withOpenAiEntrypoints(workflow, ['global', 'thread']);
    expect(annotated.metadata).toEqual({
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    });
    expect(annotated.execute).toBe(workflow.execute);
    expect(await annotated.execute({ arguments: {}, principal: null })).toEqual(
      workflow.execute(),
    );
    expect(workflow).not.toHaveProperty('metadata');
  });
  it.each([
    [],
    ['unknown'],
    ['global', 'global'],
  ])('rejects invalid entrypoints %j', (types) =>
    expect(() => withOpenAiEntrypoints(workflow, types as never)).toThrow());
  it.each([
    { inputSchema: { type: 'object', required: ['id'] } },
    { inputSchema: { type: 'object', minProperties: 1 } },
    { effect: 'write' },
    { ui: undefined },
    { ui: { visibility: ['app'] } },
    { metadata: { 'openai/ui': {} } },
  ])('rejects unsafe entrypoint definition %j', (change) =>
    expect(() =>
      withOpenAiEntrypoints({ ...workflow, ...change } as never, ['global']),
    ).toThrow());
  it('validates resource display metadata and preserves optional defaults', () => {
    expect(openAiDisplayMetadata()).toEqual({ 'openai/ui': {} });
    expect(
      openAiDisplayMetadata({ preferredDisplayMode: 'fullscreen' }),
    ).toEqual({ 'openai/ui': { preferredDisplayMode: 'fullscreen' } });
    for (const options of [
      { availableDisplayModes: [] },
      { preferredDisplayMode: 'pip' },
      { availableDisplayModes: ['inline'], preferredDisplayMode: 'fullscreen' },
      { unknown: true },
      { availableDisplayModes: ['inline', 'inline'] },
    ])
      expect(() => openAiDisplayMetadata(options as never)).toThrow();
  });
  it('emits only the manifest onboarding declaration and rejects path escapes', () => {
    expect(openAiOnboardingDeclaration('./skills/setup/SKILL.md')).toEqual({
      extensions: {
        'com.openai': { onboardingSkill: './skills/setup/SKILL.md' },
      },
    });
    for (const path of [
      '/skills/setup/SKILL.md',
      './skills/../SKILL.md',
      './skills/setup/readme.md',
      './skills/%2e/SKILL.md',
      'https://evil.test/SKILL.md',
    ])
      expect(() => openAiOnboardingDeclaration(path)).toThrow();
  });
  it('rejects hostile non-JSON and oversized metadata without invoking accessors', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [
      cyclic,
      { huge: 'x'.repeat(65537) },
      { n: Infinity },
      new Date(),
      {
        get value() {
          throw new Error('accessor executed');
        },
      },
    ])
      expect(() => json(bad)).toThrow();
  });
});
describe('deep links and capability fallback', () => {
  it('encodes exact upstream native/web formats', () => {
    expect(
      createOpenAiAppLink({
        pluginId: 'a/b',
        toolName: 'view/tool',
        platform: 'desktop',
        marketplace: 'private',
        path: '/parts?tag=bolt&sort=asc',
      }),
    ).toBe(
      'codex://plugins/a%2Fb@private/app/view%2Ftool?path=%2Fparts%3Ftag%3Dbolt%26sort%3Dasc',
    );
    expect(
      createOpenAiAppLink({
        pluginId: 'app',
        toolName: 'view',
        platform: 'mobile',
      }),
    ).toBe('chatgpt://plugins/app/app/view?path=%2F');
    expect(
      createOpenAiAppLink({
        pluginId: 'app',
        toolName: 'view',
        platform: 'web',
      }),
    ).toBe('https://chatgpt.com/plugins/app/app/view?path=%2F');
    expect(() =>
      createOpenAiAppLink({
        pluginId: 'app',
        toolName: 'view',
        platform: 'web',
        marketplace: 'private',
      }),
    ).toThrow();
  });
  it.each([
    'https://evil.test',
    '//evil.test',
    '/\\evil',
    '/x#fragment',
    '/a/../b',
    '/%2e%2e/b',
    '/%252e%252e/b',
    '/%2fexternal',
    '/x%00',
    '/x%',
    `/${'x'.repeat(2048)}`,
  ])('rejects unsafe path %s', (url) =>
    expect(() => appRelativeUrl(url)).toThrow());
  it('accepts bounded host context and defaults to functional links for absent/unknown capability', () => {
    expect(readOpenAiDeepLink({})).toBeUndefined();
    expect(
      readOpenAiDeepLink({ 'openai/deepLink': { url: '/item?id=1' } }),
    ).toBe('/item?id=1');
    expect(() =>
      readOpenAiDeepLink({ 'openai/deepLink': { url: '/', tenant: 'forged' } }),
    ).toThrow();
    const link = {
      pluginId: 'app',
      toolName: 'view',
      platform: 'web' as const,
    };
    for (const capability of ['absent', 'unknown', true, {}, 'future']) {
      expect(
        openAiNavigationLink(capability, link, 'https://app.test/settings'),
      ).toBe('https://app.test/settings');
    }
    expect(capabilityState('present')).toBe('present');
    expect(
      openAiNavigationLink('present', link, 'https://app.test/settings'),
    ).toContain('https://chatgpt.com/');
    expect(() =>
      openAiNavigationLink('unknown', link, 'javascript:alert(1)'),
    ).toThrow();
  });
});
describe('primitive settings validation', () => {
  it('accepts reordered schema object keys while preserving array order and limits', () => {
    const reordered = {
      properties: {
        count: { maximum: 10, minimum: 1, title: 'Count', type: 'integer' },
        grid: { title: 'Grid', type: 'boolean' },
        units: { enum: ['mm', 'in'], title: 'Units', type: 'string' },
      },
      type: 'object',
    };
    const values = { units: 'mm', grid: true, count: 1 };
    expect(
      validateSettingsRead({ schema: reordered, values }, schema).values,
    ).toEqual(values);
    for (const changed of [
      {
        ...schema,
        properties: {
          ...schema.properties,
          count: { ...schema.properties.count, maximum: 11 },
        },
      },
      {
        ...schema,
        properties: {
          ...schema.properties,
          units: { ...schema.properties.units, enum: ['in', 'mm'] },
        },
      },
      {
        ...schema,
        properties: {
          ...schema.properties,
          units: { ...schema.properties.units, enum: ['mm', 'cm'] },
        },
      },
    ])
      expect(() =>
        validateSettingsRead({ schema: changed, values }, schema),
      ).toThrow('Settings schema changed unexpectedly');
  });
  it('requires every effective value and validates layout', () => {
    const result = {
      schema,
      values: { units: 'mm', grid: true, count: 1 },
      layout: [
        {
          kind: 'group',
          title: 'Display',
          items: [
            { kind: 'property', property: 'units' },
            { kind: 'tool', tool: 'view', title: 'View' },
          ],
        },
      ],
    };
    expect(validateSettingsRead(result)).toEqual(result);
    expect(() =>
      validateSettingsRead({ ...result, values: { units: 'mm' } }),
    ).toThrow();
    expect(() =>
      validateSettingsRead({ ...result, layout: [{ kind: 'unknown' }] }),
    ).toThrow();
    expect(() =>
      validateSettingsRead({
        ...result,
        layout: [
          {
            kind: 'group',
            title: 'Display',
            items: [{ kind: 'property', property: 'other' }],
          },
        ],
      }),
    ).toThrow();
  });
  it.each([
    { units: 'feet' },
    { count: 1.5 },
    { count: 11 },
    { grid: 'true' },
    { tenantId: 'forged' },
  ])('rejects invalid patches %j', (values) =>
    expect(() => validateSettingsValues(values, schema, true)).toThrow());
  it.each([
    { type: 'array', title: 'A' },
    { type: 'string', title: 'A', pattern: '(a+)+' },
    { type: 'integer', title: 'A', multipleOf: 0 },
    { type: 'string', title: 'A', enum: [] },
    { type: 'number', title: 'A', minimum: 2, maximum: 1 },
  ])('rejects unsupported schema %j', (property) =>
    expect(() =>
      validateSettingsSchema({ type: 'object', properties: { a: property } }),
    ).toThrow());
  it('requires idempotent assignment effects on settings binding', () => {
    expect(() =>
      bindOpenAiSettings({
        schema,
        read: workflow,
        update: { ...workflow, name: 'update', effect: 'destructive' },
        server: () => {
          throw new Error('unused');
        },
      }),
    ).toThrow();
  });
});
