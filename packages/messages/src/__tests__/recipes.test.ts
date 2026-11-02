import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { Email } from '../models/Email.js';
import { SlackAccount } from '../models/SlackAccount.js';
import { SlackMessage } from '../models/SlackMessage.js';
import { MailboxRecipe, NotificationsRecipe, SlackRecipe } from '../recipes.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-messages';

describe('messaging recipe composition', () => {
  it('shares one card without making notifications require a mailbox', () => {
    expect(MailboxRecipe.id).not.toBe(NotificationsRecipe.id);
    expect(MailboxRecipe.group).toEqual(NotificationsRecipe.group);
    expect(MailboxRecipe.section).toEqual(NotificationsRecipe.section);
    expect(MailboxRecipe.requires).toEqual([]);
    expect(NotificationsRecipe.requires).toEqual([]);
    expect(NotificationsRecipe.nav).toEqual([]);
  });

  it('gives all-mail and failed-send views distinct stable identities over the same email model', () => {
    const keys = MailboxRecipe.nav.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MailboxRecipe.nav.every((entry) => entry.model === Email)).toBe(
      true,
    );
    const all = MailboxRecipe.nav.find((entry) => entry.key === 'mailbox');
    const failed = MailboxRecipe.nav.find(
      (entry) => entry.key === 'failed-sends',
    );
    expect(all?.filter).toBeUndefined();
    expect(failed?.filter).toEqual({ field: 'sendStatus', value: 'failed' });
    expect(new Email({ sendStatus: 'failed' }).sendStatus).toBe(
      failed?.filter?.value,
    );
    // Received mail can retain the default draft sendStatus without being a draft.
    expect(new Email().sendStatus).not.toBe(failed?.filter?.value);
    expect(new Email({ sendStatus: 'sent' }).sendStatus).not.toBe(
      failed?.filter?.value,
    );
  });
});

it('declares the supported provider boundary without wiring demo data to live mail', async () => {
  const { getMessagingProvider } = await import('../providers.js');
  for (const provider of MailboxRecipe.providers) {
    for (const option of provider.options)
      expect(getMessagingProvider(option)).toBeDefined();
  }
  expect(
    MailboxRecipe.providers.find((provider) => provider.id === 'email-inbox')
      ?.required,
  ).toBe(true);
  expect(
    MailboxRecipe.providers.find((provider) => provider.id === 'email-send')
      ?.required,
  ).toBe(false);
  expect(
    MailboxRecipe.surfaces.find((surface) => surface.kind === 'playground')
      ?.export,
  ).toContain('#MailboxDemo');
  expect(MailboxRecipe.demoSeed.data.messages[0].accountId).toBe(
    MailboxRecipe.demoSeed.data.accounts[0].id,
  );
  expect(MailboxRecipe.demoSeed.data.messages[0].body).toContain('mocked');
  expect(MailboxRecipe.runtime).toBe('both');
});

it('places the recipient-scoped bell in a supported slot with a required service provider', () => {
  expect(NotificationsRecipe.surfaces).toEqual([
    expect.objectContaining({
      kind: 'shell-widget',
      slot: 'header.end',
      export: '@happyvertical/smrt-svelte/notifications#NotificationBell',
    }),
  ]);
  expect(NotificationsRecipe.providers).toEqual([
    {
      id: 'notifications',
      kind: 'notifications',
      options: ['user-notification-service'],
      required: true,
    },
  ]);
  expect(NotificationsRecipe.nav).toEqual([]);
  expect(NotificationsRecipe.demoSeed.data.items[0].readAt).toBeNull();
  expect(NotificationsRecipe.runtime).toBe('both');
});

describe('slack recipe', () => {
  it('shares the messaging card and section with the mailbox without requiring it', () => {
    expect(SlackRecipe.id).toBe('messages.slack');
    expect(SlackRecipe.label).toBe('Slack');
    expect(SlackRecipe.group).toEqual(MailboxRecipe.group);
    expect(SlackRecipe.section).toEqual(MailboxRecipe.section);
    expect(SlackRecipe.requires).toEqual([]);
    expect(SlackRecipe.models).toEqual([SlackMessage, SlackAccount]);
    expect(SlackRecipe.exposure).toBeUndefined();
  });

  it('opens messages and workspaces as separate lists', () => {
    const models = SlackRecipe.nav.map((entry) => entry.model);
    expect(models).toEqual([SlackMessage, SlackAccount]);
    expect(
      SlackRecipe.nav.find((entry) => entry.model === SlackMessage)?.key,
    ).toBe('slack-messages');
    for (const entry of SlackRecipe.nav) expect(entry.filter).toBeUndefined();
  });

  describe('scanned and emitted', () => {
    let recipes: RecipeDefinition[];
    let manifest: ReturnType<ManifestAdapter['toManifest']>;
    let errors: string[];

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: packageRoot,
        include: ['src/**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/*.spec.ts',
          '**/__tests__/**',
          '**/*.d.ts',
        ],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      errors = results.errors
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.filePath}: ${diagnostic.message}`);
      manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: PACKAGE,
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: PACKAGE,
        packageJson: JSON.parse(
          readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
        ),
      });
      recipes = manifest.recipes ?? [];
    });

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits all three messaging recipes', () => {
      expect(recipes.map((recipe) => recipe.id).sort()).toEqual([
        'messages.mailbox',
        'messages.notifications',
        'messages.slack',
      ]);
      const slack = recipes.find((recipe) => recipe.id === 'messages.slack');
      expect(slack?.label).toBe('Slack');
      expect(slack?.help?.markdown).toContain('## Tasks');
      expect(slack?.help?.fieldRefs.length).toBeGreaterThan(0);
    });

    it('exposes every Slack nav model to the generated surface, read-only for workspaces', () => {
      const slack = recipes.find((recipe) => recipe.id === 'messages.slack');
      expect(slack?.nav?.length).toBe(2);
      for (const entry of slack?.nav ?? []) {
        const object = manifest.objects[entry.model];
        expect(object, entry.model).toBeDefined();
        expect(object.decoratorConfig?.api?.include ?? []).toContain('list');
      }
      expect(
        manifest.objects[`${PACKAGE}:SlackAccount`]?.decoratorConfig?.api
          ?.include,
      ).toEqual(['list', 'get']);
      expect(
        manifest.objects[`${PACKAGE}:SlackMessage`]?.decoratorConfig?.api
          ?.include,
      ).toEqual(['list', 'get', 'create']);
    });
  });
});
