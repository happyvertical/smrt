import { randomUUID } from 'node:crypto';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOMIZE_SHELL_PERMISSION,
  createOverviewStore,
  createPreferenceStore,
  createShellSettingsPreferences,
  listPreferenceKinds,
  PERSONALIZE_OVERVIEW_PERMISSION,
  PERSONALIZE_SHELL_PERMISSION,
  type PreferenceStore,
  registerPreferenceKind,
  SHELL_LAYOUT_PREFERENCE_KIND,
  UiPreferenceRecordCollection,
  UnknownPreferenceKindError,
} from '../index.js';
import { buildDefinition, buildRegistry } from './overview-suite.js';

const NOTE_KIND = 'test-note';
const NOTE_TENANT = 'testnotes.customize';
const NOTE_USER = 'testnotes.personalize';

/**
 * The generic store and kind registry: kinds the registry does not know,
 * the shell-layout kind, kind isolation and per-kind permission pairs.
 */
export function preferenceKindsSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
): void {
  describe(name, () => {
    let db: DatabaseInterface;
    let store: PreferenceStore;
    let tenantId: string;
    let alice: string;
    let disposeNote: (() => void) | undefined;
    let disposeNotePermissions: (() => void) | undefined;

    beforeEach(async () => {
      setupTestTenancy();
      db = await create();
      store = createPreferenceStore({ db });
      tenantId = randomUUID();
      alice = randomUUID();
      // A test kind: a payload `{ text }` of at most 20 characters.
      disposeNotePermissions = registerPermissionDefinitions([
        { slug: NOTE_TENANT, category: 'test', name: 'Customize notes' },
        { slug: NOTE_USER, category: 'test', name: 'Personalize notes' },
      ]);
      disposeNote = registerPreferenceKind({
        kind: NOTE_KIND,
        formatVersion: 1,
        permissions: { tenant: NOTE_TENANT, user: NOTE_USER },
        validate(payload) {
          if (payload === null)
            return { ok: true, canonical: null, issues: [] };
          const text = (payload as { text?: unknown })?.text;
          return typeof text === 'string' && text.length <= 20
            ? { ok: true, canonical: { text }, issues: [] }
            : {
                ok: false,
                canonical: null,
                issues: [
                  { path: 'text', code: 'invalid', message: 'bad text' },
                ],
              };
        },
      });
    });

    afterEach(async () => {
      disposeNote?.();
      disposeNotePermissions?.();
      resetTenancy();
      await cleanup();
    });

    const as = <T>(permissions: string[], fn: () => Promise<T>): Promise<T> =>
      withTenant(
        { tenantId, userId: alice, permissions: new Set(permissions) },
        fn,
      );
    const all = [
      CUSTOMIZE_SHELL_PERMISSION,
      PERSONALIZE_SHELL_PERMISSION,
      PERSONALIZE_OVERVIEW_PERMISSION,
      NOTE_TENANT,
      NOTE_USER,
    ];

    it('registers the built-in kinds', () => {
      expect(listPreferenceKinds()).toEqual(
        expect.arrayContaining(['overview', 'shell-layout']),
      );
      expect(() =>
        registerPreferenceKind({
          kind: 'Bad Kind',
          formatVersion: 1,
          permissions: { tenant: 'a.b', user: 'a.c' },
          validate: () => ({ ok: true, canonical: null, issues: [] }),
        }),
      ).toThrow();
      expect(() =>
        registerPreferenceKind({
          kind: 'overview',
          formatVersion: 1,
          permissions: { tenant: 'a.b', user: 'a.c' },
          validate: () => ({ ok: true, canonical: null, issues: [] }),
        }),
      ).toThrow(/already registered/);
    });

    it('refuses a kind that is not registered', async () => {
      await as(all, async () => {
        await expect(store.load('nope', 'admin')).rejects.toBeInstanceOf(
          UnknownPreferenceKindError,
        );
        await expect(
          store.save('nope', 'admin', {
            scope: 'user',
            payload: { a: 1 },
            revision: null,
          }),
        ).rejects.toBeInstanceOf(UnknownPreferenceKindError);
        await expect(
          store.reset('nope', 'admin', { scope: 'user' }),
        ).rejects.toBeInstanceOf(UnknownPreferenceKindError);
        // The model refuses it too, so no path writes an unvalidatable row.
        const records = await UiPreferenceRecordCollection.create({ db });
        await expect(
          records.create({
            tenantId,
            kind: 'nope',
            surfaceId: 'admin',
            scopeType: 'user',
            userId: alice,
            payloadJson: '{}',
          }),
        ).rejects.toBeInstanceOf(UnknownPreferenceKindError);
        expect(await records.list({})).toEqual([]);
      });
    });

    it('treats an explicit null reset revision as "I loaded no row"', async () => {
      await as(all, async () => {
        // A client loads while no row exists (revision null)...
        const before = await store.load(NOTE_KIND, 'admin');
        expect(before.user?.revision).toBeNull();
        // ...someone else saves in the meantime...
        const saved = await store.save(NOTE_KIND, 'admin', {
          scope: 'user',
          payload: { text: 'newer' },
          revision: null,
        });
        expect(saved.ok).toBe(true);
        // ...so the stale client's guarded reset must not delete it.
        expect(
          await store.reset(NOTE_KIND, 'admin', {
            scope: 'user',
            revision: before.user?.revision ?? null,
          }),
        ).toEqual({ ok: false, reason: 'conflict' });
        expect((await store.load(NOTE_KIND, 'admin')).user?.payload).toEqual({
          text: 'newer',
        });
        // Omitting the revision is the explicit unguarded reset.
        expect(
          await store.reset(NOTE_KIND, 'admin', { scope: 'user' }),
        ).toEqual({ ok: true });
        // With no row, a null-revision reset has nothing to conflict with.
        expect(
          await store.reset(NOTE_KIND, 'admin', {
            scope: 'user',
            revision: null,
          }),
        ).toEqual({ ok: true });
      });
    });

    it('round-trips the shell layout and validates it both ways', async () => {
      const shell = createShellSettingsPreferences(store);
      const delta = {
        panels: { left: 'collapsed' },
        sizes: { left: 320 },
        layout: { version: 1, hidden: ['reports'] },
      };
      await as(all, async () => {
        const tenant = await store.save(SHELL_LAYOUT_PREFERENCE_KIND, 'admin', {
          scope: 'tenant',
          payload: { hotkeysEnabled: false, panels: { right: 'hidden' } },
          revision: null,
        });
        expect(tenant.ok).toBe(true);
        // No revision: the adapter reads the current one (last-writer-wins).
        expect(await shell.write('admin', delta)).toMatchObject({
          ok: true,
          payload: delta,
        });
        expect(await shell.write('admin', delta)).toMatchObject({ ok: true });

        const read = await shell.read('admin');
        expect(read.delta).toEqual({
          hotkeysEnabled: false,
          panels: { right: 'hidden', left: 'collapsed' },
          sizes: { left: 320 },
          layout: { version: 1, hidden: ['reports'] },
        });
        expect(read.user).toEqual(delta);
        expect(read.issues).toEqual([]);

        // Invalid on save: refused, nothing changes.
        const refused = await shell.write('admin', {
          panels: { left: 'open' },
          sizes: { left: 320 },
          script: '<x>',
        });
        expect(refused).toMatchObject({ ok: false, reason: 'invalid' });
        expect(
          refused.ok ? [] : 'issues' in refused ? refused.issues : [],
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'panels.left' }),
            expect.objectContaining({ path: 'script' }),
          ]),
        );
        expect((await shell.read('admin')).user).toEqual(delta);

        // Invalid when stored: dropped and reported on load, row untouched.
        const records = await UiPreferenceRecordCollection.create({ db });
        const row = await records.findTier(
          tenantId,
          SHELL_LAYOUT_PREFERENCE_KIND,
          'admin',
          'user',
          alice,
        );
        if (!row) throw new Error('expected the user row');
        row.setPayload({ panels: { left: 'sideways' }, sizes: { left: 280 } });
        await row.save();
        const degraded = await store.load(
          SHELL_LAYOUT_PREFERENCE_KIND,
          'admin',
        );
        expect(degraded.user?.payload).toEqual({ sizes: { left: 280 } });
        expect(degraded.user?.issues.map((issue) => issue.path)).toEqual([
          'panels.left',
        ]);

        expect(await shell.reset('admin')).toEqual({ ok: true });
        expect((await shell.read('admin')).user).toBeNull();
        expect((await shell.read('admin')).tenant).toEqual({
          hotkeysEnabled: false,
          panels: { right: 'hidden' },
        });
      });
    });

    it('keeps kinds apart on the same surface id', async () => {
      const surface = buildDefinition().id;
      const overviews = createOverviewStore({ db, preferences: store });
      await as(all, async () => {
        expect(
          await store.save(NOTE_KIND, surface, {
            scope: 'user',
            payload: { text: 'hello' },
            revision: null,
          }),
        ).toMatchObject({ ok: true });
        expect(
          await overviews.save(buildDefinition(), buildRegistry(), {
            scope: 'user',
            override: { version: 1, removed: ['w2'] },
            revision: null,
          }),
        ).toMatchObject({ ok: true });

        const note = await store.load(NOTE_KIND, surface);
        expect(note.user?.payload).toEqual({ text: 'hello' });
        const overview = await overviews.load(
          buildDefinition(),
          buildRegistry(),
        );
        expect(overview.document.widgets.map((w) => w.id)).toEqual(['w1']);
        expect(
          (await store.load(SHELL_LAYOUT_PREFERENCE_KIND, surface)).user
            ?.payload,
        ).toBeNull();

        // Resetting one kind leaves the other alone.
        await store.reset(NOTE_KIND, surface, { scope: 'user' });
        expect((await store.load(NOTE_KIND, surface)).user?.payload).toBeNull();
        expect(
          (await overviews.load(buildDefinition(), buildRegistry())).document
            .widgets,
        ).toHaveLength(1);
        const rows = await (
          await UiPreferenceRecordCollection.create({ db })
        ).list({});
        expect(rows.map((row) => [row.kind, row.surfaceId])).toEqual([
          ['overview', surface],
        ]);
      });
    });

    it("enforces each kind's own permission pair", async () => {
      const shellOnly = [PERSONALIZE_SHELL_PERMISSION];
      await as(shellOnly, async () => {
        const shell = await store.load(SHELL_LAYOUT_PREFERENCE_KIND, 'admin');
        expect(shell.canCustomize).toEqual({ tenant: false, user: true });
        expect(
          await store.save(SHELL_LAYOUT_PREFERENCE_KIND, 'admin', {
            scope: 'user',
            payload: { hotkeysEnabled: false },
            revision: null,
          }),
        ).toMatchObject({ ok: true });
        expect(
          await store.save(SHELL_LAYOUT_PREFERENCE_KIND, 'admin', {
            scope: 'tenant',
            payload: { hotkeysEnabled: false },
            revision: null,
          }),
        ).toEqual({ ok: false, reason: 'not_allowed' });
        const overviews = createOverviewStore({ db, preferences: store });
        const overview = await overviews.load(
          buildDefinition(),
          buildRegistry(),
        );
        expect(overview.canCustomize).toEqual({ tenant: false, user: false });
        expect(
          await overviews.save(buildDefinition(), buildRegistry(), {
            scope: 'user',
            override: { version: 1, removed: ['w2'] },
            revision: null,
          }),
        ).toEqual({ ok: false, reason: 'not_allowed' });
      });
      await as([CUSTOMIZE_SHELL_PERMISSION], async () => {
        expect(
          (await store.load(SHELL_LAYOUT_PREFERENCE_KIND, 'admin'))
            .canCustomize,
        ).toEqual({ tenant: true, user: false });
        expect(
          await store.save(SHELL_LAYOUT_PREFERENCE_KIND, 'admin', {
            scope: 'tenant',
            payload: { hotkeysEnabled: true },
            revision: null,
          }),
        ).toMatchObject({ ok: true });
      });
      // The test kind's own pair: its slugs grant it and nothing else.
      await as([NOTE_USER], async () => {
        expect((await store.load(NOTE_KIND, 'admin')).canCustomize).toEqual({
          tenant: false,
          user: true,
        });
        expect(
          (await store.load(SHELL_LAYOUT_PREFERENCE_KIND, 'admin'))
            .canCustomize,
        ).toEqual({ tenant: false, user: false });
      });
      // A kind whose slugs are not in the users catalog is never writable,
      // even with the slug in the principal's set.
      const disposeGhost = registerPreferenceKind({
        kind: 'test-ghost',
        formatVersion: 1,
        permissions: { tenant: 'ghost.customize', user: 'ghost.personalize' },
        validate: (payload) => ({ ok: true, canonical: payload, issues: [] }),
      });
      try {
        await as(['ghost.customize', 'ghost.personalize'], async () => {
          expect(
            (await store.load('test-ghost', 'admin')).canCustomize,
          ).toEqual({ tenant: false, user: false });
        });
      } finally {
        disposeGhost();
      }
    });
  });
}
