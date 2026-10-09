import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFieldRefs, renderHelp } from '@happyvertical/smrt-core';
import { ManifestGenerator } from '@happyvertical/smrt-core/scanner';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssistantRecipe } from '../index.js';
import { AgentSession } from '../models/AgentSession.js';
import { ChatMessage } from '../models/ChatMessage.js';
import { ChatParticipant } from '../models/ChatParticipant.js';
import { ChatRoom } from '../models/ChatRoom.js';
import { ChatThread } from '../models/ChatThread.js';
import { AssistantRecipe as FromRecipes } from '../recipes.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('chat.assistant recipe (#3719)', () => {
  it('is exported from the package entry', () => {
    expect(AssistantRecipe).toBe(FromRecipes);
  });

  it('declares the conversation records the dock persists, with no nav', () => {
    expect(AssistantRecipe.id).toBe('chat.assistant');
    expect(AssistantRecipe.models).toEqual([
      AgentSession,
      ChatRoom,
      ChatParticipant,
      ChatThread,
      ChatMessage,
    ]);
    expect(AssistantRecipe.nav).toEqual([]);
    expect(AssistantRecipe.requires).toEqual([]);
  });

  it('exports its dock component from the real svelte entry', () => {
    const [surface] = AssistantRecipe.surfaces;
    expect(surface.kind).toBe('shell-widget');
    // The scanner rejects any slot outside RECIPE_SHELL_SLOTS (see the scan
    // below); `header.end` is where AppShell places dock toggles by default.
    expect(surface.slot).toBe('header.end');
    const [specifier, name] = surface.export.split('#');
    expect(specifier).toBe('@happyvertical/smrt-chat/svelte');
    const index = readFileSync(resolve(root, 'src/svelte/index.ts'), 'utf-8');
    expect(index).toMatch(new RegExp(`export \\{ default as ${name} \\}`));
  });

  it('names secrets, never values', () => {
    const [llm] = AssistantRecipe.providers;
    expect(llm.kind).toBe('llm');
    expect(llm.required).toBe(true);
    for (const secret of llm.secrets)
      expect(secret).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(AssistantRecipe.runtime).toBe('both');
  });

  describe('through the scanner and manifest generator', () => {
    let recipe: NonNullable<
      ReturnType<ManifestAdapter['toManifest']>['recipes']
    >[number];
    let manifest: ReturnType<ManifestAdapter['toManifest']>;
    let scanErrors: string[] = [];

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: root,
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      scanErrors = results.errors.map((error) => error.message);
      manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: '@happyvertical/smrt-chat',
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      const found = manifest.recipes?.find((r) => r.id === 'chat.assistant');
      if (!found) throw new Error('chat.assistant was not emitted');
      recipe = found;
    }, 60_000);

    it('scans without errors', () => {
      expect(scanErrors).toEqual([]);
    });

    it('emits surfaces, providers and runtime as authored', () => {
      expect(recipe.surfaces).toEqual([
        {
          kind: 'shell-widget',
          slot: 'header.end',
          export: '@happyvertical/smrt-chat/svelte#AssistantDock',
          label: 'Assistant',
          icon: 'bot',
        },
      ]);
      expect(recipe.providers).toEqual([
        {
          id: 'llm',
          kind: 'llm',
          options: ['openai', 'anthropic', 'gemini', 'webllm', 'bitgpu'],
          required: true,
          secrets: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'],
        },
      ]);
      expect(recipe.runtime).toBe('both');
      expect(recipe).not.toHaveProperty('demoSeed');
    });

    it('qualifies its models and passes the merged-manifest checks', () => {
      expect(recipe.models).toEqual([
        '@happyvertical/smrt-chat:AgentSession',
        '@happyvertical/smrt-chat:ChatRoom',
        '@happyvertical/smrt-chat:ChatParticipant',
        '@happyvertical/smrt-chat:ChatThread',
        '@happyvertical/smrt-chat:ChatMessage',
      ]);
      const generator = new ManifestGenerator();
      expect(() => generator.assertRecipeOptions(manifest)).not.toThrow();
      expect(() => generator.assertRecipeHelp(manifest)).not.toThrow();
    });

    it('emits the help file with derived field references', () => {
      expect(recipe.help?.markdown).toBe(
        readFileSync(resolve(root, 'src/assistant.recipe.md'), 'utf-8'),
      );
      expect(recipe.help?.fieldRefs).toEqual(
        extractFieldRefs(recipe.help?.markdown ?? '').sort(),
      );
    });

    it('renders help for the people using the app', () => {
      if (!recipe.help) throw new Error('missing help');
      const rendered = renderHelp(recipe.help, []);
      const text = JSON.stringify(rendered.blocks);
      expect(text).toContain('Overview');
      expect(text).toContain('Ask a question');
      expect(text).toContain('OPENAI_API_KEY');
      // The report tools are described as an opt-in capability, not wired.
      expect(text).toContain('report tools');
    });
  });
});
