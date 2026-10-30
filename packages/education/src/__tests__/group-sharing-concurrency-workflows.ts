import { isPostgresDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import type { GroupSharingAuthorizer } from '../group-sharing-authorization.js';
import {
  GroupSharingAuthorizationError,
  GroupSharingConflictError,
} from '../group-sharing-contracts.js';
import { GroupSharingService } from '../group-sharing-service.js';
import {
  groupSharingLifecycleFixture,
  sharingPolicy,
} from './group-sharing-lifecycle-workflows.js';
import {
  sharingPolicy as readPolicy,
  sharingReadFixture,
} from './group-sharing-read-workflows.js';

export interface SharingDatabaseHandle {
  db: DatabaseInterface;
  cleanup: () => Promise<void>;
  /** PostgreSQL: a fresh independent connection to the SAME isolated database. */
  connect?: () => Promise<DatabaseInterface>;
}
export type SharingDatabaseFactory = () => Promise<SharingDatabaseHandle>;

/** A bounded rendezvous before row locks, never after acquiring the contested lock. */
function rendezvous() {
  let count = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    count++;
    if (count === 2) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('Independent transaction rendezvous timed out')),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function groupSharingConcurrencyContractTests(
  make: SharingDatabaseFactory,
) {
  for (const revoked of [
    'session',
    'group membership',
    'group role',
    'guardian relationship',
  ] as const) {
    it(`denies active and new requests after committed external ${revoked} revocation`, async () => {
      const handle = await make();
      let fixture: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
      let peer: DatabaseInterface | undefined;
      let release!: () => void;
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending: Promise<unknown> | undefined;
      try {
        fixture = await sharingReadFixture(handle.db);
        const f = fixture;
        const postgres = isPostgresDatabase(handle.db);
        if (postgres) {
          if (!handle.connect)
            throw new Error(
              'Missing independent PostgreSQL connection factory',
            );
          peer = await handle.connect();
          expect(peer).not.toBe(handle.db);
        }
        let armed = false;
        let reached!: () => void;
        const paused = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const authorize: GroupSharingAuthorizer = async (request) => {
          const user = await request.executor.get('users', {
            id: request.actorUserId,
            status: 'active',
          });
          const session = await request.executor.get('sessions', {
            id: request.sessionId,
            user_id: request.actorUserId,
            status: 'active',
          });
          const allowed =
            Boolean(user && session) &&
            request.actorUserId === f.parent.actorUserId &&
            (!request.guardianRelationships ||
              request.guardianRelationships.some(
                (relationship) => relationship.typeId === f.guardianType.id,
              ));
          if (armed) {
            armed = false;
            reached();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                resume,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        new Error(
                          'External revocation did not release authorizer',
                        ),
                      ),
                    10_000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          return allowed;
        };
        const service = new GroupSharingService(handle.db, authorize, {
          storage: f.storage,
        });
        const guardian = revoked === 'guardian relationship';
        const call = (): Promise<unknown> =>
          guardian
            ? f.as(f.parent, () => service.previewSharing(f.scope))
            : f.asSupervisor(() => service.getSharedWork(f.selector));
        await call();
        if (guardian) {
          expect(
            await f.as(f.parent, () => service.listLearnerMemberships(f.scope)),
          ).toHaveLength(1);
        }
        const revoke = async () => {
          const writer = peer ?? handle.db;
          // This is an independent owning writer, not an education policy mutation.
          const transaction = writer.transaction?.bind(writer);
          if (!transaction)
            throw new Error('External authority writer requires transactions');
          await transaction(async (tx) => {
            if (revoked === 'session')
              await tx.update(
                'sessions',
                { id: f.scope.sessionId },
                { status: 'revoked' },
              );
            if (revoked === 'guardian relationship')
              await tx.delete('profile_relationships', {
                id: String(f.relationship.id),
                tenant_id: f.scope.familyTenantId,
              });
            if (revoked === 'group membership' || revoked === 'group role') {
              const group = await tx.get('education_groups', {
                id: f.scope.groupId,
              });
              if (!group) throw new Error('Fixture group missing');
              const member = await tx.get('memberships', {
                tenant_id: group.tenant_id,
                user_id: f.scope.actorUserId,
              });
              if (!member) throw new Error('Fixture membership missing');
              if (revoked === 'group membership')
                await tx.update(
                  'memberships',
                  { id: member.id },
                  { status: 'inactive' },
                );
              else
                await tx.update(
                  'roles',
                  { id: member.role_id },
                  { tenant_id: f.scope.familyTenantId },
                );
            }
          });
        };
        if (postgres) {
          armed = true;
          pending = call().then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              paused,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        'External revoke request did not reach authorizer',
                      ),
                    ),
                  10_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          await revoke();
          release();
          const outcome = (await pending) as { ok: boolean; error?: unknown };
          expect(outcome.ok).toBe(false);
          expect(outcome.error).toBeInstanceOf(GroupSharingAuthorizationError);
        } else {
          // The embedded executor serializes transactions, so revoke commits first.
          await revoke();
        }
        await expect(call()).rejects.toBeInstanceOf(
          GroupSharingAuthorizationError,
        );
        if (guardian) {
          await expect(
            f.as(f.parent, () => service.listLearnerMemberships(f.scope)),
          ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
          await expect(
            f.as(f.parent, () =>
              service.setSharingPolicy({
                ...f.scope,
                expectedVersion: 1,
                policy: readPolicy(),
              }),
            ),
          ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
          expect(
            await handle.db.list('group_sharing_policies', {
              membership_id: String(f.edge.id),
            }),
          ).toHaveLength(1);
        }
      } finally {
        release();
        await pending;
        await fixture?.cleanup();
        await peer?.close?.();
        await handle.cleanup();
      }
    }, 30_000);
  }

  for (const operation of ['comment', 'media'] as const) {
    it(`denies paused ${operation} after an independently committed policy narrowing`, async () => {
      const handle = await make();
      let peer: DatabaseInterface | undefined;
      let fixture: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
      let release!: () => void;
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending: Promise<unknown> | undefined;
      try {
        fixture = await sharingReadFixture(handle.db);
        const f = fixture;
        const postgres = isPostgresDatabase(handle.db);
        if (postgres) {
          if (!handle.connect)
            throw new Error(
              'Missing independent PostgreSQL connection factory',
            );
          peer = await handle.connect();
          expect(peer).not.toBe(handle.db);
        }
        let armed = false;
        let reached!: () => void;
        const paused = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const authorize: GroupSharingAuthorizer = async (request) => {
          const user = await request.executor.get('users', {
            id: request.actorUserId,
            status: 'active',
          });
          const session = await request.executor.get('sessions', {
            id: request.sessionId,
            user_id: request.actorUserId,
          });
          const allowed =
            Boolean(user && session) &&
            request.actorUserId === f.parent.actorUserId &&
            (!request.guardianRelationships ||
              request.guardianRelationships.some(
                (relationship) => relationship.typeId === f.guardianType.id,
              ));
          if (
            armed &&
            (request.action === 'education.group.comment' ||
              request.action === 'education.group.review')
          ) {
            armed = false;
            reached();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                resume,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(new Error('Policy narrowing barrier timed out')),
                    10_000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          return allowed;
        };
        const service = new GroupSharingService(handle.db, authorize, {
          storage: f.storage,
        });
        const policyWriter = new GroupSharingService(
          peer ?? handle.db,
          authorize,
          { storage: f.storage },
        );
        const call = (): Promise<unknown> =>
          f.asSupervisor(
            (): Promise<unknown> =>
              operation === 'comment'
                ? service.addRevisionComment({
                    ...f.selector,
                    revisionId: f.revision.id,
                    body: 'Before consent changes',
                  })
                : service.readSharedMedia({
                    ...f.selector,
                    assetId: f.sources[0].assetId,
                  }),
          );
        const positive = await call();
        if (operation === 'media')
          expect((positive as { data: Buffer }).data.toString()).toBe(
            'synthetic completed child work',
          );
        else
          expect((positive as { revisionId: string }).revisionId).toBe(
            f.revision.id,
          );
        const commentsBefore = await handle.db.list('group_revision_comments', {
          tenant_id: f.scope.familyTenantId,
        });
        const narrow = () =>
          f.as(f.parent, () =>
            policyWriter.setSharingPolicy({
              ...f.scope,
              expectedVersion: 1,
              policy: { ...readPolicy(), shareWork: false, shareMedia: false },
            }),
          );
        if (postgres) {
          armed = true;
          pending = call().then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              paused,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error('Request did not reach pre-lock authorizer'),
                    ),
                  10_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          expect((await narrow()).policyVersion).toBe(2);
          release();
          const outcome = (await pending) as { ok: boolean; error?: unknown };
          expect(outcome.ok).toBe(false);
          expect(outcome.error).toBeInstanceOf(GroupSharingAuthorizationError);
        } else {
          // SQLite serializes whole transactions on one handle: commit first.
          expect((await narrow()).policyVersion).toBe(2);
          await expect(call()).rejects.toBeInstanceOf(
            GroupSharingAuthorizationError,
          );
        }
        expect(
          await handle.db.list('group_revision_comments', {
            tenant_id: f.scope.familyTenantId,
          }),
        ).toEqual(commentsBefore);
        await expect(call()).rejects.toBeInstanceOf(
          GroupSharingAuthorizationError,
        );
      } finally {
        release();
        await pending;
        await fixture?.cleanup();
        await peer?.close?.();
        await handle.cleanup();
      }
    }, 30_000);
  }

  for (const scenario of [
    'identical acceptance',
    'conflicting acceptance',
    'policy version',
    'revoke versus acceptance',
  ] as const) {
    it(`arbitrates ${scenario} with durable unique state`, async () => {
      const handle = await make();
      let peer: DatabaseInterface | undefined;
      try {
        const f = await groupSharingLifecycleFixture(handle.db);
        const invitation = await f.invite();
        if (scenario === 'policy version')
          await f.asParent(() =>
            f.sharingService.acceptInvitation({
              ...f.parentActor,
              invitationId: invitation.id,
              policy: sharingPolicy,
            }),
          );
        const postgres = isPostgresDatabase(handle.db);
        if (postgres) {
          expect(
            handle.connect,
            'PostgreSQL races require independent connections',
          ).toBeTypeOf('function');
          if (!handle.connect)
            throw new Error(
              'Missing independent PostgreSQL connection factory',
            );
          peer = await handle.connect();
          expect(peer).not.toBe(handle.db);
        }
        const meet = rendezvous();
        const services = [handle.db, peer ?? handle.db].map((db) => {
          let first = true;
          const authorize: GroupSharingAuthorizer = async (request) => {
            const allowed = await f.authorize(request);
            if (postgres && first) {
              first = false;
              await meet();
            }
            return allowed;
          };
          return new GroupSharingService(db, authorize);
        });
        const accept = (index: number, different = false) =>
          f.asParent(() =>
            services[index].acceptInvitation({
              ...f.parentActor,
              invitationId: invitation.id,
              policy: {
                ...sharingPolicy,
                shareMedia: different ? false : sharingPolicy.shareMedia,
              },
            }),
          );
        const requests =
          scenario === 'policy version'
            ? services.map((service, index) =>
                f.asParent(() =>
                  service.setSharingPolicy({
                    ...f.scope,
                    expectedVersion: 1,
                    policy: { ...sharingPolicy, shareMedia: Boolean(index) },
                  }),
                ),
              )
            : scenario === 'revoke versus acceptance'
              ? [
                  accept(0),
                  f.asSupervisor(() =>
                    services[1].revokeInvitation({
                      ...f.supervisor,
                      invitationId: invitation.id,
                    }),
                  ),
                ]
              : [accept(0), accept(1, scenario === 'conflicting acceptance')];
        const results = await Promise.allSettled(requests);
        const winners = results.filter(
          (result) => result.status === 'fulfilled',
        );
        expect(winners).toHaveLength(
          scenario === 'identical acceptance' ? 2 : 1,
        );
        for (const result of results)
          if (result.status === 'rejected')
            expect(result.reason).toBeInstanceOf(GroupSharingConflictError);
        const invitationRow = await handle.db.get('group_learner_invitations', {
          id: invitation.id,
        });
        const edges = await handle.db.list('group_learner_memberships', {
          tenant_id: f.scope.familyTenantId,
          learner_id: f.scope.learnerId,
          group_id: f.group.id,
        });
        const roster = await handle.db.list('group_learner_roster_entries', {
          group_id: f.group.id,
        });
        if (invitationRow?.status === 'revoked') {
          expect(edges).toHaveLength(0);
          expect(roster).toHaveLength(0);
        } else {
          expect(invitationRow?.status).toBe('accepted');
          expect(edges).toHaveLength(1);
          expect(roster).toHaveLength(1);
          const policies = await handle.db.list('group_sharing_policies', {
            membership_id: edges[0].id,
          });
          expect(policies).toHaveLength(scenario === 'policy version' ? 2 : 1);
          // Raw PostgreSQL BIGINT values may be strings; hydrated model versions remain numbers.
          expect(Number(edges[0].policy_version)).toBe(
            scenario === 'policy version' ? 2 : 1,
          );
          if (scenario === 'identical acceptance')
            expect(
              (winners[0] as PromiseFulfilledResult<{ id: string }>).value.id,
            ).toBe(
              (winners[1] as PromiseFulfilledResult<{ id: string }>).value.id,
            );
        }
      } finally {
        await peer?.close?.();
        await handle.cleanup();
      }
    }, 30_000);
  }

  it('rolls back edge, policy and roster after a caught final authorizer failure poisons the enclosing transaction', async () => {
    const handle = await make();
    try {
      const f = await groupSharingLifecycleFixture(handle.db);
      const invitation = await f.invite();
      const failure = new Error('injected after roster insertion');
      const service = new GroupSharingService(handle.db, async (request) => {
        const allowed = await f.authorize(request);
        if (
          (
            await request.executor.list('group_learner_roster_entries', {
              group_id: f.group.id,
            })
          ).length
        )
          throw failure;
        return allowed;
      });
      await expect(
        f.asParent(() =>
          service.withTransaction(async (tx) => {
            try {
              await tx.acceptInvitation({
                ...f.parentActor,
                invitationId: invitation.id,
                policy: sharingPolicy,
              });
            } catch (error) {
              expect(error).toBe(failure);
            }
          }),
        ),
      ).rejects.toBe(failure);
      expect(
        await handle.db.list('group_learner_memberships', {
          group_id: f.group.id,
        }),
      ).toEqual([]);
      expect(
        await handle.db.list('group_learner_roster_entries', {
          group_id: f.group.id,
        }),
      ).toEqual([]);
      expect(
        await handle.db.list('group_sharing_policies', {
          tenant_id: f.scope.familyTenantId,
        }),
      ).toEqual([]);
      expect(
        (
          await handle.db.get('group_learner_invitations', {
            id: invitation.id,
          })
        )?.status,
      ).toBe('pending');
      expect(
        (
          await f.asParent(() =>
            f.sharingService.acceptInvitation({
              ...f.parentActor,
              invitationId: invitation.id,
              policy: sharingPolicy,
            }),
          )
        ).policyVersion,
      ).toBe(1);
    } finally {
      await handle.cleanup();
    }
  });
}
