import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LearnerInterestThemeChangeCollection } from '../learner-history.js';
import {
  InterestThemeError,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerHistoryUnavailableError,
  LearnerService,
  LearnerValidationError,
} from '../learner-service.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const classes = [...learnerClasses, 'LearnerInterestThemeChange'];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

async function withFixture(
  run: (
    f: Awaited<ReturnType<typeof learnerFixture>> & {
      actions: Array<{ action: string; own: boolean }>;
      tracked: LearnerService;
      /** A service whose host does NOT let a learner set their own theme. */
      guardiansOnly: LearnerService;
    },
  ) => Promise<void>,
  useClasses: string[] = classes,
) {
  const db: DatabaseInterface = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: useClasses,
  });
  try {
    const f = await learnerFixture(db);
    const actions: Array<{ action: string; own: boolean }> = [];
    const authorize: LearnerAuthorizer = ({
      action,
      own,
      relationshipTypeId,
    }) => {
      actions.push({ action, own });
      return own || relationshipTypeId === f.guardianType.id;
    };
    await run({
      ...f,
      actions,
      tracked: new LearnerService(db, authorize, () => true),
      guardiansOnly: new LearnerService(
        db,
        ({ action, own, relationshipTypeId }) =>
          action === 'education.learner.set-interest-theme'
            ? !own && relationshipTypeId === f.guardianType.id
            : own || relationshipTypeId === f.guardianType.id,
        () => true,
      ),
    });
  } finally {
    await db.close?.();
  }
}

describe('LearnerService.setInterestTheme', () => {
  it('sets, changes and clears a theme with an immutable audit trail', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, parent, as, db } = f;
      expect(
        (await as(parent, () => service.getLearner(parent))).interestTheme,
      ).toBeNull();
      f.actions.length = 0;
      const set = await as(parent, () =>
        service.setInterestTheme({
          ...parent,
          theme: { label: 'Minecraft', key: 'minecraft' },
          policyBasis: 'guardian',
        }),
      );
      expect(f.actions).toEqual([
        { action: 'education.learner.set-interest-theme', own: false },
      ]);
      expect(set).toEqual({
        changed: true,
        interestTheme: { label: 'Minecraft', key: 'minecraft' },
      });
      // Both the guardian and the learner read it back.
      for (const reader of [parent, own])
        expect(
          (await as(reader, () => service.getLearner(reader))).interestTheme,
        ).toEqual({ label: 'Minecraft', key: 'minecraft' });
      // Replay is a no-op and records nothing.
      const replay = await as(parent, () =>
        service.setInterestTheme({
          ...parent,
          theme: { label: 'Minecraft', key: 'minecraft' },
          policyBasis: 'guardian',
        }),
      );
      expect(replay.changed).toBe(false);
      // A family-added theme is a free label with no key; the host allows the learner.
      const free = await as(own, () =>
        service.setInterestTheme({
          ...own,
          theme: { label: '  Ancient   Egypt ' },
          policyBasis: 'learner-picks-theme',
        }),
      );
      expect(free.interestTheme).toEqual({ label: 'Ancient Egypt', key: '' });
      const cleared = await as(own, () =>
        service.setInterestTheme({
          ...own,
          theme: null,
          policyBasis: 'learner-picks-theme',
        }),
      );
      expect(cleared).toEqual({ changed: true, interestTheme: null });
      expect(
        (await as(parent, () => service.getLearner(parent))).interestTheme,
      ).toBeNull();
      const history = (
        await db.list('learner_interest_theme_changes', {
          learner_id: f.learner.id,
        })
      ).sort(
        (a, b) =>
          new Date(String(a.recorded_at)).getTime() -
          new Date(String(b.recorded_at)).getTime(),
      );
      expect(
        history.map((row) => [
          row.previous_label,
          row.new_label,
          row.new_key,
          row.actor_user_id,
          row.policy_basis,
        ]),
      ).toEqual([
        ['', 'Minecraft', 'minecraft', parent.actorUserId, 'guardian'],
        [
          'Minecraft',
          'Ancient Egypt',
          '',
          own.actorUserId,
          'learner-picks-theme',
        ],
        ['Ancient Egypt', '', '', own.actorUserId, 'learner-picks-theme'],
      ]);
      await as(parent, async () => {
        const row = await (
          await LearnerInterestThemeChangeCollection.create({ db })
        ).get(String(history[0].id));
        await expect(row?.delete()).rejects.toThrow('immutable');
        await expect(row?.save()).rejects.toThrow('immutable');
      });
    });
  });

  it('lets the host keep the theme guardian-only', async () => {
    await withFixture(async (f) => {
      const { guardiansOnly: service, own, parent, as } = f;
      await expect(
        as(own, () =>
          service.setInterestTheme({
            ...own,
            theme: { label: 'Hockey', key: 'hockey' },
            policyBasis: 'learner',
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      await as(parent, () =>
        service.setInterestTheme({
          ...parent,
          theme: { label: 'Hockey', key: 'hockey' },
          policyBasis: 'guardian',
        }),
      );
      expect(
        (await as(own, () => service.getLearner(own))).interestTheme?.key,
      ).toBe('hockey');
    });
  });

  it('refuses a sibling, a stranger, another tenant and an unrelated guardian claim', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, parent, as, db } = f;
      const theme = { label: 'Cars', key: 'cars' };
      const attempts = [
        // The learner reaching for a sibling's theme.
        { ...own, learnerId: String(f.sibling.id) },
        // The sibling reaching for the learner's.
        { ...own, actorUserId: String(f.bob.user.id) },
        { ...own, actorUserId: String(f.stranger.user.id) },
        { ...own, learnerId: String(f.foreign.id) },
        // A guardian claim that is not a relationship to this learner.
        { ...parent, learnerId: String(f.sibling.id) },
        { ...parent, guardianRelationshipId: undefined },
        { ...parent, actorUserId: String(f.bob.user.id) },
      ];
      for (const request of attempts)
        await expect(
          as(request, () =>
            service.setInterestTheme({
              ...request,
              theme,
              policyBasis: 'guardian',
            }),
          ),
        ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      // No ambient context: refused too.
      await expect(
        service.setInterestTheme({ ...own, theme, policyBasis: 'x' }),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      expect(await db.list('learner_interest_theme_changes', {})).toEqual([]);
      for (const id of [f.learner.id, f.sibling.id, f.foreign.id])
        expect(
          (await db.get('learners', { id }))?.interest_theme_label ?? '',
        ).toBe('');
    });
  });

  it('rejects malformed themes and a missing policy basis', async () => {
    await withFixture(async (f) => {
      const { tracked: service, parent, as, db } = f;
      const base = { ...parent, policyBasis: 'guardian' };
      for (const theme of [
        { label: '' },
        { label: '   ' },
        { label: 'x'.repeat(61) },
        { label: 'bad\u0007label' },
        { label: 'line\nbreak' },
        { label: 'mail me at a@b.example' },
        { label: 'https://example.test/x' },
        { label: 'Minecraft', key: 'Minecraft' },
        { label: 'Minecraft', key: 'has space' },
        { label: 'Minecraft', key: '-lead' },
        { label: 'Minecraft', key: 'k'.repeat(41) },
        { label: 5 },
        { key: 'minecraft' },
        'Minecraft',
        [],
        undefined,
      ])
        await expect(
          as(parent, () =>
            service.setInterestTheme({ ...base, theme } as never),
          ),
        ).rejects.toBeInstanceOf(InterestThemeError);
      await expect(
        as(parent, () =>
          service.setInterestTheme({
            ...parent,
            theme: { label: 'Cars' },
            policyBasis: '',
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerValidationError);
      expect(await db.list('learner_interest_theme_changes', {})).toEqual([]);
    });
  });

  it('fails closed without the history table', async () => {
    await withFixture(async (f) => {
      const { tracked: service, parent, as, db } = f;
      await db.query('DROP TABLE "learner_interest_theme_changes"');
      await expect(
        as(parent, () =>
          service.setInterestTheme({
            ...parent,
            theme: { label: 'Cars', key: 'cars' },
            policyBasis: 'guardian',
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerHistoryUnavailableError);
      expect(
        (await db.get('learners', { id: f.learner.id }))?.interest_theme_label,
      ).toBe('');
    });
  });

  it('rolls the learner row back with the history inside one transaction', async () => {
    await withFixture(async (f) => {
      const { tracked: service, parent, as, db } = f;
      await expect(
        as(parent, () =>
          service.withTransaction(async (tx) => {
            await tx.setInterestTheme({
              ...parent,
              theme: { label: 'Cars', key: 'cars' },
              policyBasis: 'guardian',
            });
            throw new Error('abort');
          }),
        ),
      ).rejects.toThrow('abort');
      expect(
        (await db.get('learners', { id: f.learner.id }))?.interest_theme_label,
      ).toBe('');
      expect(await db.list('learner_interest_theme_changes', {})).toEqual([]);
    });
  });

  it('refuses an invalid theme written straight to the model', async () => {
    await withFixture(async (f) => {
      await f.as(f.own, async () => {
        const learner = await f.learners.get({ id: String(f.learner.id) });
        if (!learner) throw new Error('missing learner');
        learner.interestThemeLabel = 'Cars';
        learner.interestThemeKey = 'NOT VALID';
        await expect(learner.save()).rejects.toThrow(
          'Invalid learner interest theme',
        );
      });
    });
  });
});
