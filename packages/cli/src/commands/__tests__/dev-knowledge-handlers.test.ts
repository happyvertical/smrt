/**
 * dev:knowledge-* handler tests.
 *
 * Mocks the deterministic knowledge module (@happyvertical/smrt-dev-mcp/knowledge)
 * so we can drive every command handler in both markdown and json output modes,
 * covering renderContextMarkdown and the deprecated --json alias paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const knowledgeMocks = vi.hoisted(() => ({
  compactContextResult: vi.fn((result) => result),
  buildKnowledgeIndex: vi.fn(),
  checkKnowledgeFreshness: vi.fn(),
  diffKnowledgeIndex: vi.fn(),
  buildReviewContext: vi.fn(),
  buildArchitectureContext: vi.fn(),
  renderKnowledgeIndexMarkdown: vi.fn(() => '# Knowledge Index Markdown'),
  renderFreshnessResult: vi.fn(() => 'Freshness OK'),
  buildArchitectureContextDefault: vi.fn(),
}));

vi.mock('@happyvertical/smrt-dev-mcp/knowledge', () => ({
  compactContextResult: knowledgeMocks.compactContextResult,
  buildKnowledgeIndex: knowledgeMocks.buildKnowledgeIndex,
  checkKnowledgeFreshness: knowledgeMocks.checkKnowledgeFreshness,
  diffKnowledgeIndex: knowledgeMocks.diffKnowledgeIndex,
  buildReviewContext: knowledgeMocks.buildReviewContext,
  buildArchitectureContext: knowledgeMocks.buildArchitectureContext,
  renderKnowledgeIndexMarkdown: knowledgeMocks.renderKnowledgeIndexMarkdown,
  renderFreshnessResult: knowledgeMocks.renderFreshnessResult,
}));

import { devKnowledgeCommands } from '../dev-knowledge.js';

let logSpy: ReturnType<typeof vi.spyOn>;

const contextResult = {
  selectedPackages: [{ name: '@happyvertical/smrt-content' }],
  selectedSdkPackages: [{ name: '@happyvertical/ai' }],
  deterministicFindings: [
    {
      severity: 'warning',
      code: 'stale-doc',
      message: 'Doc is stale',
      file: 'AGENTS.md',
    },
    { severity: 'error', code: 'broken', message: 'Reference broke' },
  ],
  promptBundle: { contextMarkdown: 'Bundle body' },
};

describe('dev:knowledge-* handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    knowledgeMocks.buildKnowledgeIndex.mockResolvedValue({ index: true });
    knowledgeMocks.checkKnowledgeFreshness.mockResolvedValue({ ok: true });
    knowledgeMocks.diffKnowledgeIndex.mockResolvedValue({
      base: 'HEAD',
      changedFiles: ['a.ts', 'b.ts'],
      changedPackages: ['@happyvertical/smrt-core'],
    });
    knowledgeMocks.buildReviewContext.mockResolvedValue(contextResult);
    knowledgeMocks.buildArchitectureContext.mockResolvedValue(contextResult);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it.each([
    ['dev:knowledge-review-context', 'buildReviewContext'],
    ['dev:knowledge-architecture-context', 'buildArchitectureContext'],
  ] as const)('%s forwards explicit complete-document requests', async (command, builder) => {
    await devKnowledgeCommands[command].handler([], {
      complete: true,
      package: 'core',
    });
    expect(knowledgeMocks[builder]).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'complete',
        package: 'core',
      }),
    );
    expect(devKnowledgeCommands[command].options?.complete).toBeDefined();
  });

  it.each([
    'dev:knowledge-review-context',
    'dev:knowledge-architecture-context',
  ])('%s prints the selective projection for JSON and preserves complete opt-in', async (command) => {
    const projected = {
      promptBundle: { contextMarkdown: 'Selected prose only' },
    };
    knowledgeMocks.compactContextResult.mockReturnValueOnce(projected);
    await devKnowledgeCommands[command].handler([], { format: 'json' });
    expect(knowledgeMocks.compactContextResult).toHaveBeenLastCalledWith(
      contextResult,
      'full',
    );
    expect(logSpy).toHaveBeenLastCalledWith(JSON.stringify(projected, null, 2));
    await devKnowledgeCommands[command].handler([], {
      json: true,
      complete: true,
    });
    expect(knowledgeMocks.compactContextResult).toHaveBeenLastCalledWith(
      contextResult,
      'complete',
    );
  });

  describe('dev:knowledge-index', () => {
    it('prints JSON by default', async () => {
      await devKnowledgeCommands['dev:knowledge-index'].handler([], {
        format: 'json',
        scope: 'project',
      });
      expect(knowledgeMocks.buildKnowledgeIndex).toHaveBeenCalledWith({
        scope: 'project',
        package: undefined,
      });
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ index: true }, null, 2),
      );
    });

    it('renders markdown when format is markdown', async () => {
      await devKnowledgeCommands['dev:knowledge-index'].handler([], {
        format: 'markdown',
      });
      expect(knowledgeMocks.renderKnowledgeIndexMarkdown).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('# Knowledge Index Markdown');
    });
  });

  describe('dev:knowledge-check', () => {
    it('prints markdown freshness output by default', async () => {
      await devKnowledgeCommands['dev:knowledge-check'].handler([], {
        format: 'markdown',
        changed: true,
        strict: true,
      });
      expect(knowledgeMocks.checkKnowledgeFreshness).toHaveBeenCalledWith({
        changed: true,
        strict: true,
        scope: undefined,
        package: undefined,
      });
      expect(logSpy).toHaveBeenCalledWith('Freshness OK');
    });

    it('honors the deprecated --json alias', async () => {
      await devKnowledgeCommands['dev:knowledge-check'].handler([], {
        json: true,
      });
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ ok: true }, null, 2),
      );
    });

    it('exits non-zero when freshness fails', async () => {
      knowledgeMocks.checkKnowledgeFreshness.mockResolvedValue({ ok: false });
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as any);

      await devKnowledgeCommands['dev:knowledge-check'].handler([], {
        format: 'markdown',
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  describe('dev:knowledge-diff', () => {
    it('prints a human-readable diff by default', async () => {
      await devKnowledgeCommands['dev:knowledge-diff'].handler([], {
        format: 'markdown',
        base: 'main',
      });
      expect(knowledgeMocks.diffKnowledgeIndex).toHaveBeenCalledWith({
        base: 'main',
        scope: undefined,
        package: undefined,
      });
      const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('Base: HEAD');
      expect(printed).toContain('Changed files: 2');
      expect(printed).toContain('- a.ts');
      expect(printed).toContain('Changed packages: 1');
      expect(printed).toContain('- @happyvertical/smrt-core');
    });

    it('prints JSON via --json', async () => {
      await devKnowledgeCommands['dev:knowledge-diff'].handler([], {
        json: true,
      });
      expect(knowledgeMocks.diffKnowledgeIndex).toHaveBeenCalledWith({
        base: 'HEAD',
        scope: undefined,
        package: undefined,
      });
      const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('"changedFiles"');
    });
  });

  describe('dev:knowledge-review-context', () => {
    it('renders markdown context including deterministic findings', async () => {
      await devKnowledgeCommands['dev:knowledge-review-context'].handler(
        ['focus', 'area'],
        { format: 'markdown' },
      );
      expect(knowledgeMocks.buildReviewContext).toHaveBeenCalledWith({
        focus: 'focus area',
        scope: undefined,
        package: undefined,
        // CLI includes package prose and matched module documentation.
        detail: 'full',
      });
      const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('# SMRT Domain Context');
      expect(printed).toContain('@happyvertical/smrt-content');
      expect(printed).toContain('## Deterministic Findings');
      expect(printed).toContain(
        '[WARNING] stale-doc: Doc is stale (AGENTS.md)',
      );
      expect(printed).toContain('[ERROR] broken: Reference broke');
      expect(printed).toContain('Bundle body');
    });

    it('prints JSON via --json', async () => {
      await devKnowledgeCommands['dev:knowledge-review-context'].handler([], {
        json: true,
        focus: 'opt-focus',
      });
      expect(knowledgeMocks.buildReviewContext).toHaveBeenCalledWith({
        focus: 'opt-focus',
        scope: undefined,
        package: undefined,
        detail: 'full',
      });
      const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('"promptBundle"');
    });
  });

  describe('dev:knowledge-architecture-context', () => {
    it('renders markdown with the idea joined from args', async () => {
      await devKnowledgeCommands['dev:knowledge-architecture-context'].handler(
        ['new', 'feature'],
        { format: 'markdown', focus: 'extra' },
      );
      expect(knowledgeMocks.buildArchitectureContext).toHaveBeenCalledWith({
        idea: 'new feature',
        focus: 'extra',
        scope: undefined,
        package: undefined,
        detail: 'full',
      });
      const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('# SMRT Domain Context');
    });

    it('prints JSON via --json and falls back to options.idea', async () => {
      await devKnowledgeCommands['dev:knowledge-architecture-context'].handler(
        [],
        { json: true, idea: 'option-idea' },
      );
      expect(knowledgeMocks.buildArchitectureContext).toHaveBeenCalledWith({
        idea: 'option-idea',
        focus: undefined,
        scope: undefined,
        package: undefined,
        detail: 'full',
      });
    });

    it('renders markdown without deterministic findings when absent', async () => {
      knowledgeMocks.buildArchitectureContext.mockResolvedValue({
        selectedPackages: [],
        selectedSdkPackages: [],
        promptBundle: { contextMarkdown: 'Only bundle' },
      });
      await devKnowledgeCommands['dev:knowledge-architecture-context'].handler(
        [],
        { format: 'markdown' },
      );
      const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('(none)');
      expect(printed).not.toContain('## Deterministic Findings');
      expect(printed).toContain('Only bundle');
    });
  });
});
