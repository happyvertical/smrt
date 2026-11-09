// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InferenceAliasView,
  InferenceFusionView,
  InferenceProviderView,
  InferenceTierView,
} from '../types.js';
import PanelContextHarness from './__tests__/panel-context-harness.svelte';
import InferenceSettingsPanel from './InferenceSettingsPanel.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];
const KEY = 'sk-live-0123456789abcdef';

function render(props: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(InferenceSettingsPanel, { target, props }));
  flushSync();
  return target;
}

afterEach(() => {
  while (mounted.length > 0) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const PROVIDERS: InferenceProviderView[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'preset',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
  },
  {
    id: 'lemonade',
    label: 'Lemonade (local)',
    kind: 'preset',
    baseUrl: 'http://127.0.0.1:13305/v1',
    requiresApiKey: false,
    local: true,
  },
  { id: 'openai', label: 'openai', kind: 'provider', requiresApiKey: true },
];

const TIERS: InferenceTierView[] = [
  {
    tier: 'cheap',
    effectiveLabel: 'Same as default (configured client)',
    supplyingLevel: 'default',
    appRevertLabel: 'Same as default (configured client)',
    inheritedLabel: 'Same as default (configured client)',
  },
  {
    tier: 'great',
    effectiveTarget: { alias: 'local' },
    effectiveLabel: 'Alias local',
    supplyingLevel: 'tenant',
    appTarget: { alias: 'frontier' },
    tenantTarget: { alias: 'local' },
    appRevertLabel: 'anthropic/claude-config',
    inheritedLabel: 'Alias frontier',
    tenantAllowList: ['alias:local'],
  },
];

const ALIASES: InferenceAliasView[] = [
  {
    name: 'frontier',
    source: 'app',
    candidates: [
      { provider: 'anthropic', model: 'claude-a' },
      { preset: 'openrouter', model: 'qwen', apiKeyEnv: 'OPENROUTER_API_KEY' },
    ],
  },
  {
    name: 'local',
    source: 'config',
    candidates: [{ preset: 'lemonade', model: 'qwen' }],
  },
];

const FUSIONS: InferenceFusionView[] = [
  { name: 'review-pair', source: 'registry', definition: { mode: 'pair' } },
  {
    name: 'ab-test',
    source: 'app',
    definition: { mode: 'pair', seats: [] },
    editable: true,
  },
];

function select(target: HTMLElement, selector: string, value: string): void {
  const element = target.querySelector<HTMLSelectElement>(selector);
  if (!element) throw new Error(`no select ${selector}`);
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

function submit(form: HTMLFormElement | null): void {
  if (!form) throw new Error('no form');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
}

describe('InferenceSettingsPanel default view', () => {
  it('renders the default view with no advanced controls present', () => {
    const target = render({
      defaults: { mode: 'byo', provider: 'openai', keySet: false },
      providers: PROVIDERS,
      tiers: TIERS,
      aliases: ALIASES,
      fusions: FUSIONS,
      onSaveDefaults: () => {},
    });
    expect(
      target.querySelector('[data-testid="inference-default-view"]'),
    ).not.toBeNull();
    expect(target.querySelectorAll('input[name="mode"]')).toHaveLength(4);
    expect(target.querySelector('select[name="provider"]')).not.toBeNull();
    expect(target.querySelector('input[name="baseUrl"]')).not.toBeNull();
    expect(target.querySelector('input[name="model"]')).not.toBeNull();
    expect(target.querySelector('select[name="defaultTier"]')).not.toBeNull();
    // Nothing of Advanced is in the DOM until it is opened.
    expect(
      target.querySelector('[data-testid="inference-advanced"]'),
    ).toBeNull();
    expect(target.querySelector('[data-testid^="inference-tier-"]')).toBeNull();
    expect(
      target.querySelector('[data-testid^="inference-alias-"]'),
    ).toBeNull();
    expect(
      target.querySelector('[data-testid="inference-fusions"]'),
    ).toBeNull();
    expect(target.querySelector('select[name="kind"]')).toBeNull();
    const toggle = target.querySelector<HTMLButtonElement>(
      '.isp-advanced-toggle',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    flushSync();
    expect(
      target.querySelector('[data-testid="inference-advanced"]'),
    ).not.toBeNull();
    expect(
      target.querySelectorAll('[data-testid^="inference-tier-"]'),
    ).toHaveLength(2);
  });

  it('shows the key only as set / not set', () => {
    const target = render({
      defaults: { mode: 'byo', provider: 'openai', keySet: true },
      providers: PROVIDERS,
      onSaveKey: () => {},
    });
    expect(
      target.querySelector('[data-testid="inference-key-status"]')?.textContent,
    ).toContain('set');
    expect(
      target.querySelector('[data-testid="inference-key-status"]')?.textContent,
    ).not.toContain('not set');
    const input = target.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    );
    expect(input?.type).toBe('password');
    expect(input?.value).toBe('');
  });

  it('never puts the key in emitted form data or the DOM after save', async () => {
    const onSaveKey = vi.fn(async () => {});
    const onSaveDefaults = vi.fn();
    const target = render({
      defaults: { mode: 'byo', provider: 'openai', keySet: false },
      providers: PROVIDERS,
      onSaveKey,
      onSaveDefaults,
    });
    const input = target.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    );
    if (!input) throw new Error('no key input');
    input.value = KEY;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    submit(target.querySelector('[data-testid="inference-key-form"]'));
    await tick();
    flushSync();

    expect(onSaveKey).toHaveBeenCalledWith({ provider: 'openai', key: KEY });
    expect(input.value).toBe('');
    expect(
      target.querySelector('[data-testid="inference-key-status"]')?.textContent,
    ).toContain('API key: set');
    expect(document.body.innerHTML).not.toContain(KEY);

    const choices = target.querySelector<HTMLFormElement>(
      '[data-testid="inference-choices-form"]',
    );
    if (!choices) throw new Error('no choices form');
    const fields = [...new FormData(choices).entries()];
    expect(JSON.stringify(fields)).not.toContain(KEY);
    expect(fields.map(([name]) => name)).not.toContain('apiKey');
    submit(choices);
    expect(onSaveDefaults).toHaveBeenCalledTimes(1);
    const change = onSaveDefaults.mock.calls[0]?.[0];
    expect(change).toEqual({
      mode: 'byo',
      provider: 'openai',
      defaultTier: 'good',
    });
    expect(JSON.stringify(change)).not.toContain(KEY);
  });

  it('drops a typed key when the provider or endpoint changes', async () => {
    const onSaveKey = vi.fn(async () => {});
    const target = render({
      defaults: { mode: 'byo', provider: 'openai' },
      providers: PROVIDERS,
      onSaveKey,
    });
    const typed = target.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    );
    if (!typed) throw new Error('no key input');
    typed.value = KEY;
    select(target, 'select[name="provider"]', 'openrouter');
    const fresh = target.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    );
    expect(fresh?.value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
    submit(target.querySelector('[data-testid="inference-key-form"]'));
    await tick();
    expect(onSaveKey).not.toHaveBeenCalled();

    if (!fresh) throw new Error('no key input');
    fresh.value = KEY;
    submit(target.querySelector('[data-testid="inference-key-form"]'));
    await tick();
    expect(onSaveKey).toHaveBeenCalledWith({
      provider: 'openrouter',
      preset: 'openrouter',
      key: KEY,
    });
  });

  it('tests the connection through the host without a key', async () => {
    const onTestConnection = vi.fn(async () => ({
      reachable: true,
      detail: 'https://openrouter.ai answered 200',
    }));
    const target = render({
      defaults: { mode: 'byo', provider: 'openrouter', model: 'qwen/qwen3' },
      providers: PROVIDERS,
      onTestConnection,
    });
    const button = [...target.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === 'Test connection',
    );
    button?.click();
    await tick();
    await tick();
    flushSync();
    expect(onTestConnection).toHaveBeenCalledWith({
      preset: 'openrouter',
      model: 'qwen/qwen3',
    });
    expect(
      target.querySelector('[data-testid="inference-test-result"]')
        ?.textContent,
    ).toContain('Connected');
  });

  it('hides provider fields for hosted and off, and filters local providers', () => {
    const target = render({
      defaults: { mode: 'hosted' },
      providers: PROVIDERS,
    });
    expect(target.querySelector('select[name="provider"]')).toBeNull();
    const local = target.querySelector<HTMLInputElement>(
      'input[name="mode"][value="local"]',
    );
    local?.click();
    flushSync();
    const options = [
      ...(target.querySelector<HTMLSelectElement>('select[name="provider"]')
        ?.options ?? []),
    ].map((option) => option.value);
    expect(options).toEqual(['', 'lemonade']);
  });
});

describe('InferenceSettingsPanel advanced', () => {
  it('shows each scope its own revert preview', () => {
    const app = render({ tiers: TIERS, scope: 'app', advancedOpen: true });
    expect(
      app.querySelector('[data-testid="inference-tier-great"] .itr-hint')
        ?.textContent,
    ).toContain('anthropic/claude-config');
    const tenant = render({
      tiers: TIERS,
      scope: 'tenant',
      advancedOpen: true,
    });
    const hint = tenant.querySelectorAll(
      '[data-testid="inference-tier-great"] .itr-hint',
    );
    const text = hint[hint.length - 1]?.textContent ?? '';
    // Tenant revert returns to config + app override, never the bare default.
    expect(text).toContain('Alias frontier');
    expect(text).not.toContain('anthropic/claude-config');
  });

  it('emits tier changes and disables targets the allow-list does not open', () => {
    const onSaveTier = vi.fn();
    const target = render({
      tiers: TIERS,
      aliases: ALIASES,
      fusions: FUSIONS,
      providers: PROVIDERS,
      scope: 'tenant',
      advancedOpen: true,
      onSaveTier,
    });
    const row = target.querySelector<HTMLElement>(
      '[data-testid="inference-tier-great"]',
    );
    if (!row) throw new Error('no row');
    const kinds = row.querySelector<HTMLSelectElement>('select[name="kind"]');
    const disabled = [...(kinds?.options ?? [])]
      .filter((option) => option.disabled)
      .map((option) => option.value);
    expect(disabled).toEqual(['model', 'fusion']);
    const aliasOptions = [
      ...row.querySelectorAll<HTMLOptionElement>('select[name="alias"] option'),
    ];
    expect(
      aliasOptions.find((option) => option.value === 'frontier')?.disabled,
    ).toBe(true);
    expect(
      aliasOptions.find((option) => option.value === 'local')?.disabled,
    ).toBe(false);
    submit(row as HTMLFormElement);
    expect(onSaveTier).toHaveBeenCalledWith({
      tier: 'great',
      scope: 'tenant',
      target: { alias: 'local' },
    });
    select(
      target,
      '[data-testid="inference-tier-great"] select[name="kind"]',
      'default',
    );
    submit(row as HTMLFormElement);
    expect(onSaveTier).toHaveBeenLastCalledWith({
      tier: 'great',
      scope: 'tenant',
      target: null,
    });
  });

  it('discards unsaved tier edits when the context changes', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const harness = mount(PanelContextHarness, {
      target,
      props: { initial: TIERS, contextKey: 'tenant-a' },
    }) as unknown as { setContextKey: (next: unknown) => void };
    mounted.push(harness as unknown as ReturnType<typeof mount>);
    flushSync();
    select(
      target,
      '[data-testid="inference-tier-cheap"] select[name="kind"]',
      'model',
    );
    expect(
      target.querySelector(
        '[data-testid="inference-tier-cheap"] input[name="model"]',
      ),
    ).not.toBeNull();
    harness.setContextKey('tenant-b');
    flushSync();
    const kind = target.querySelector<HTMLSelectElement>(
      '[data-testid="inference-tier-cheap"] select[name="kind"]',
    );
    expect(kind?.value).toBe('default');
  });

  it('edits aliases with ordered candidates and a per-candidate test', async () => {
    const onSaveAlias = vi.fn();
    const onTestCandidate = vi.fn(async () => ({
      reachable: false,
      detail: 'credential rejected',
    }));
    const target = render({
      aliases: ALIASES,
      advancedOpen: true,
      onSaveAlias,
      onTestCandidate,
    });
    const editor = target.querySelector<HTMLFormElement>(
      '[data-testid="inference-alias-frontier"]',
    );
    if (!editor) throw new Error('no editor');
    const buttons = [...editor.querySelectorAll('button')];
    buttons.find((button) => button.textContent?.trim() === 'Test')?.click();
    await tick();
    await tick();
    flushSync();
    expect(onTestCandidate).toHaveBeenCalledWith({
      provider: 'anthropic',
      model: 'claude-a',
    });
    expect(editor.textContent).toContain('credential rejected');
    editor
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Move anthropic/claude-a down"]',
      )
      ?.click();
    flushSync();
    submit(editor);
    expect(onSaveAlias).toHaveBeenCalledWith({
      name: 'frontier',
      candidates: [
        {
          preset: 'openrouter',
          model: 'qwen',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
        { provider: 'anthropic', model: 'claude-a' },
      ],
    });
  });

  it('keeps aliases and fusions read-only in the tenant scope', () => {
    const target = render({
      aliases: ALIASES,
      fusions: FUSIONS,
      scope: 'tenant',
      advancedOpen: true,
      onSaveAlias: () => {},
      onSaveFusion: () => {},
    });
    expect(
      target.querySelector('[data-testid="inference-alias-new"]'),
    ).toBeNull();
    expect(target.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(
      target.querySelector('[data-testid="inference-fusions"] textarea'),
    ).toBeNull();
  });

  it('renders fusions from the passed-in list with JSON edit for config entries', () => {
    const onSaveFusion = vi.fn();
    const target = render({
      fusions: FUSIONS,
      advancedOpen: true,
      onSaveFusion,
    });
    const list = target.querySelector<HTMLElement>(
      '[data-testid="inference-fusions"]',
    );
    expect(list?.querySelector('pre')?.textContent).toContain('"mode": "pair"');
    const textarea = list?.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="ab-test JSON"]',
    );
    if (!textarea) throw new Error('no editor');
    textarea.value = '{"mode":"handoff","seats":[]}';
    submit(textarea.form);
    expect(onSaveFusion).toHaveBeenCalledWith({
      name: 'ab-test',
      definition: { mode: 'handoff', seats: [] },
    });
    textarea.value = 'not json';
    submit(textarea.form);
    expect(onSaveFusion).toHaveBeenCalledTimes(1);
    expect(list?.textContent).toContain('Not valid JSON.');
  });

  it('shows what a fusion replaces and why the executor would refuse it (#4800)', () => {
    const target = render({
      fusions: [
        {
          name: 'review',
          source: 'app',
          definition: { mode: 'single', seats: [] },
          editable: true,
          shadows: ['registry', 'config'],
          issues: [
            {
              path: 'fusion:review.seats[0].prompt',
              message: 'names prompt "x", which no definePrompt() registered',
            },
          ],
        },
      ],
      advancedOpen: true,
    });
    const list = target.querySelector<HTMLElement>(
      '[data-testid="inference-fusions"]',
    );
    expect(list?.textContent).toContain('replaces registry, config');
    const issues = list?.querySelector(
      '[data-testid="inference-fusion-issues"]',
    );
    expect(issues?.getAttribute('role')).toBe('alert');
    expect(issues?.textContent).toContain('no definePrompt() registered');
  });
});

describe('InferenceSettingsPanel usage tab', () => {
  it('works with only the model dimension', () => {
    const target = render({
      usage: {
        by: ['model'],
        costBasis: 'estimated_cost as recorded at call time',
        buckets: [
          {
            key: { model: 'openai:gpt-mini' },
            calls: 3,
            totalTokens: 120,
            estimatedCost: 0.0012,
          },
          {
            key: { model: null },
            calls: 1,
            totalTokens: 10,
            estimatedCost: 0,
            uncostedCalls: 1,
          },
        ],
      },
    });
    const usageTab = [...target.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === 'Usage',
    ) as HTMLButtonElement;
    usageTab.click();
    flushSync();
    const headers = [...target.querySelectorAll('th')].map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).toEqual([
      'Model',
      'Calls',
      'Tokens',
      'Est. cost',
      'Outcomes',
    ]);
    expect(target.textContent).toContain('openai:gpt-mini');
    expect(target.textContent).toContain('(unattributed)');
    expect(target.textContent).toContain('1 uncosted');
  });

  it('regroups by model, tier and prompt key', () => {
    const onUsageGroupBy = vi.fn();
    const target = render({
      usage: { by: ['model'], buckets: [] },
      onUsageGroupBy,
    });
    (
      [...target.querySelectorAll('[role="tab"]')].find(
        (tab) => tab.textContent?.trim() === 'Usage',
      ) as HTMLButtonElement
    ).click();
    flushSync();
    const tier = target.querySelector<HTMLInputElement>(
      'input[name="by"][value="tier"]',
    );
    if (!tier) throw new Error('no tier checkbox');
    tier.checked = true;
    tier.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onUsageGroupBy).toHaveBeenCalledWith(['model', 'tier']);
  });
});

describe('InferenceSettingsPanel transcripts (#4781)', () => {
  const SETTINGS = {
    enabled: true,
    sample: 0.25,
    maxBytes: 8192,
    supplyingLevel: 'app' as const,
    appValue: { enabled: true, sample: 0.25, maxBytes: 8192 },
    appRevert: { enabled: false, sample: 0.1, maxBytes: 65_536 },
    envEnabled: null,
    retentionDays: 30,
  };

  function usageTab(target: HTMLElement): void {
    (
      [...target.querySelectorAll('[role="tab"]')].find(
        (tab) => tab.textContent?.trim() === 'Usage',
      ) as HTMLButtonElement
    ).click();
    flushSync();
  }

  it('shows the setting read-only without appEditable, even with a callback', () => {
    for (const scope of ['tenant', 'app']) {
      const target = render({
        advancedOpen: true,
        scope,
        transcripts: SETTINGS,
        onSaveTranscripts: vi.fn(),
      });
      const section = target.querySelector(
        '[data-testid="inference-transcripts"]',
      );
      expect(section).not.toBeNull();
      expect(
        target.querySelector('[data-testid="inference-transcripts-form"]'),
      ).toBeNull();
      expect(section?.querySelector('input, select, button')).toBeNull();
      expect(
        target.querySelector('[data-testid="inference-transcripts-enabled"]')
          ?.textContent,
      ).toBe('On');
      expect(section?.textContent).toContain('25%');
      expect(section?.textContent).toContain('30 days');
    }
  });

  it('renders no transcript section when the host passes none', () => {
    const target = render({ advancedOpen: true });
    expect(
      target.querySelector('[data-testid="inference-transcripts"]'),
    ).toBeNull();
  });

  it('round-trips an edit for appEditable hosts, retention stays read-only', () => {
    const onSaveTranscripts = vi.fn();
    const target = render({
      advancedOpen: true,
      scope: 'tenant',
      appEditable: true,
      transcripts: SETTINGS,
      onSaveTranscripts,
    });
    const form = target.querySelector<HTMLFormElement>(
      '[data-testid="inference-transcripts-form"]',
    );
    if (!form) throw new Error('no transcript form');
    const enabled = form.querySelector<HTMLInputElement>('[name="enabled"]');
    const sample = form.querySelector<HTMLInputElement>('[name="sample"]');
    const maxBytes = form.querySelector<HTMLInputElement>('[name="maxBytes"]');
    if (!enabled || !sample || !maxBytes) throw new Error('missing inputs');
    expect(enabled.checked).toBe(true);
    expect(sample.value).toBe('0.25');
    expect(maxBytes.value).toBe('8192');
    expect(form.querySelector('[name="retentionDays"]')).toBeNull();

    enabled.checked = false;
    sample.value = '0.5';
    maxBytes.value = '4096';
    form.requestSubmit();
    expect(onSaveTranscripts).toHaveBeenCalledWith({
      settings: { enabled: false, sample: 0.5, maxBytes: 4096 },
    });

    const revert = [...form.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Revert'),
    );
    if (!revert) throw new Error('no revert button');
    revert.click();
    expect(onSaveTranscripts).toHaveBeenLastCalledWith({ settings: null });
  });

  it('says when transcripts are off, in one line, in the Usage tab', () => {
    const target = render({
      usage: { by: ['model'], buckets: [] },
      transcripts: { ...SETTINGS, enabled: false },
    });
    usageTab(target);
    const line = target.querySelector(
      '[data-testid="inference-transcripts-off"]',
    );
    expect(line?.textContent).toContain('inference.transcripts.enabled');
    const on = render({
      usage: { by: ['model'], buckets: [] },
      transcripts: SETTINGS,
    });
    usageTab(on);
    expect(
      on.querySelector('[data-testid="inference-transcripts-off"]'),
    ).toBeNull();
  });

  it('renders counts and host links from the report, never transcript text', () => {
    const transcriptHref = vi.fn(
      (filters: Record<string, string>) =>
        `/transcripts?${new URLSearchParams(filters).toString()}`,
    );
    const target = render({
      transcripts: SETTINGS,
      transcriptHref,
      usage: {
        by: ['prompt', 'template'],
        since: new Date('2026-11-01T00:00:00.000Z'),
        until: null,
        buckets: [
          {
            key: { prompt: 'p.one', template: 'h1' },
            calls: 4,
            totalTokens: 40,
            estimatedCost: 0,
            outcomes: { bad: 2 },
            transcripts: 3,
          },
          {
            key: { prompt: 'p.two', template: null },
            calls: 1,
            totalTokens: 10,
            estimatedCost: 0,
            outcomes: { good: 1 },
            transcripts: 0,
          },
        ],
      },
    });
    usageTab(target);
    const headers = [...target.querySelectorAll('th')].map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).toContain('Transcripts');
    expect(headers).toContain('Template');
    const counts = [
      ...target.querySelectorAll('[data-testid="inference-transcript-count"]'),
    ].map((cell) => cell.textContent?.trim());
    expect(counts).toEqual(['3', '0']);
    const links = target.querySelectorAll<HTMLAnchorElement>(
      '[data-testid="inference-transcript-link"]',
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(
      '/transcripts?promptKey=p.one&templateHash=h1&since=2026-11-01T00%3A00%3A00.000Z',
    );
    const outcomes = target.querySelectorAll<HTMLAnchorElement>(
      '[data-testid="inference-transcript-outcome-link"]',
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.getAttribute('href')).toContain('outcome=bad');
    expect(transcriptHref).not.toHaveBeenCalledWith(
      expect.objectContaining({ promptKey: 'p.two' }),
    );
    expect(target.innerHTML).not.toMatch(/messages|request|response/i);
  });

  it('shows plain counts without a host route', () => {
    const target = render({
      usage: {
        by: ['fusion'],
        buckets: [
          {
            key: { fusion: 'duo' },
            calls: 2,
            totalTokens: 2,
            estimatedCost: 0,
            transcripts: 2,
          },
        ],
      },
    });
    usageTab(target);
    expect(target.querySelector('a')).toBeNull();
    expect(
      target.querySelector('[data-testid="inference-transcript-count"]')
        ?.textContent,
    ).toContain('2');
    expect(target.textContent).toContain('duo');
  });
});
