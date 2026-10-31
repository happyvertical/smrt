import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { Course, Lesson } from './catalog.js';
import {
  type CatalogAuthorizer,
  type CatalogProjection,
  CatalogService,
} from './catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  CurriculumCollection,
  EnrollmentCollection,
  LearnerCollection,
  LessonAssetCollection,
  LessonCollection,
  LessonProgressCollection,
} from './collections.js';
import { CourseAuthoringAuthorizationError } from './course-authoring-contracts.js';
import { EnrollmentAssignmentRecordCollection } from './course-authoring-models.js';
import { type CourseDelegation, readDelegation } from './course-delegation.js';
import {
  orderEffectiveLessons,
  resolveEnrollmentLessons,
} from './course-release-scope.js';
import type {
  Curriculum,
  Enrollment,
  Learner,
  LessonProgress,
} from './learners.js';
import { readWorkbookCompletion } from './workbook-completion.js';
import { WorkbookActivityCollection } from './workbook-models.js';

/** One lesson row an enrollment may work on, with the course row it belongs to. */
export type EnrollmentLessonEntry = Readonly<{
  lesson: Lesson;
  course: Course;
}>;
/** Course display row plus every lesson that applies to an enrollment, in order. */
export type EnrollmentLessonScope = Readonly<{
  course: Course;
  entries: ReadonlyArray<EnrollmentLessonEntry>;
}>;

/** Inputs are identifiers, never an authority claim or model patch. */
export interface LearnerRequest {
  tenantId: string;
  actorUserId: string;
  learnerId: string;
  guardianRelationshipId?: string;
}

/**
 * Delegated-agent claim for assignment (`enroll` only). The actor is the agent;
 * the guardian relationship and membership checked are the DELEGATING guardian's,
 * never the agent's. Both members are required together and the guardian cannot
 * be the agent. The host authorizer still decides whether the agent may act.
 */
export type LearnerDelegationRequest = Partial<CourseDelegation>;

/** A host-owned onboarding probe; it exposes no learner or relationship data. */
export interface LearnerSetupStatusRequest {
  tenantId: string;
  actorUserId: string;
  learnerUserId: string;
}
export type LearnerSetupStatus = Readonly<{ needsSetup: boolean }>;

/** Result of the host delegation check; a bare boolean is accepted as well. */
export type LearnerDelegationDecision =
  | boolean
  | { allowed: boolean; reason?: string; code?: string };

/**
 * Host port proving that this agent may assign for this guardian under this
 * delegation id. Required for delegated `enroll`: without it, or when it denies
 * or throws, the request is refused before the learner authorizer is consulted.
 */
export type LearnerDelegationVerifier = (
  executor: DatabaseInterface,
  request: {
    tenantId: string;
    actorUserId: string;
    delegatingGuardianUserId: string;
    delegationId: string;
    learnerId: string;
    courseId?: string;
  },
) => LearnerDelegationDecision | Promise<LearnerDelegationDecision>;

export interface LearnerServiceOptions {
  verifyDelegation?: LearnerDelegationVerifier;
}

/** The host validates relationship type/terms and its own permission policy. */
export type LearnerAuthorizer = (
  request: LearnerRequest & {
    /** The active service executor; host policy reads must share its transaction. */
    executor: DatabaseInterface;
    action:
      | 'education.learner.read'
      | 'education.learner.plan'
      | 'education.learner.start'
      | 'education.learner.submit'
      | 'education.learner.grade'
      | 'education.learner.packet'
      | 'education.learner.notes.read'
      | 'education.learner.notes.add'
      | 'education.learner.complete'
      | 'education.learner.respond'
      | 'education.learner.review-response'
      | 'education.learner.setup';
    own: boolean;
    relationshipTypeId?: string;
    /** True only for a delegated assignment; `relationshipTypeId` is then undefined. */
    delegated?: boolean;
    /** Delegated assignment only: the DELEGATING guardian's verified relationship type. */
    delegatingRelationshipTypeId?: string;
    /** Delegated assignment only: the guardian whose live relationship was verified. */
    delegatingGuardianUserId?: string;
    /** Delegated assignment only: the host's opaque delegation id. */
    delegationId?: string;
    /** Present only for the setup-status probe; it is not a relationship grant. */
    learnerUserId?: string;
  },
) => boolean | Promise<boolean>;

export class LearnerAuthorizationError extends Error {
  constructor() {
    super('Education learner access is not authorized.');
    this.name = 'LearnerAuthorizationError';
  }
}

/** Service results contain data only, with no transaction-bound model handle. */
export type LearnerView = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  profileId: string;
  displayName: string;
  level: number;
  settings: Record<string, unknown>;
}>;
export type CurriculumView = Readonly<{
  id: string;
  learnerId: string;
  title: string;
  status: Curriculum['status'];
}>;
export type EnrollmentView = Readonly<{
  id: string;
  learnerId: string;
  curriculumId: string;
  courseId: string;
  status: Enrollment['status'];
}>;
export type LessonProgressView = Readonly<{
  id: string;
  learnerId: string;
  enrollmentId: string;
  lessonId: string;
  status: LessonProgress['status'];
  bestScore: number | null;
  attempts: number;
  timeSpentSeconds: number;
  startedAt: Date | null;
  completedAt: Date | null;
}>;
function curriculumView(row: Curriculum): CurriculumView {
  return {
    id: String(row.id),
    learnerId: row.learnerId,
    title: row.title,
    status: row.status,
  };
}
function enrollmentView(row: Enrollment): EnrollmentView {
  return {
    id: String(row.id),
    learnerId: row.learnerId,
    curriculumId: row.curriculumId,
    courseId: row.courseId,
    status: row.status,
  };
}
function progressView(row: LessonProgress): LessonProgressView {
  return {
    id: String(row.id),
    learnerId: row.learnerId,
    enrollmentId: row.enrollmentId,
    lessonId: row.lessonId,
    status: row.status,
    bestScore: row.bestScore,
    attempts: row.attempts,
    timeSpentSeconds: row.timeSpentSeconds,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

/** Closed models are exposed only through this actor-bound resource boundary. */
export class LearnerService {
  private transactionState:
    | 'active'
    | 'draining'
    | 'aborting'
    | 'closed'
    | undefined;
  private writeFailure: { error: unknown } | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private compositeTail: Promise<void> = Promise.resolve();
  private composingMutation = false;
  private postgres: boolean;
  /** A trusted host transaction; capture/storage is forbidden on this scope. */
  protected executorBorrowed = false;
  constructor(
    protected readonly db: DatabaseInterface,
    protected readonly authorize: LearnerAuthorizer,
    protected readonly authorizeCatalog: CatalogAuthorizer,
    protected readonly learnerOptions: LearnerServiceOptions = {},
  ) {
    this.postgres = isPostgresDatabase(db);
  }

  /** Compose planning/start operations atomically using the callback's service. */
  async withTransaction<T>(
    operation: (service: this) => Promise<T>,
  ): Promise<T> {
    if (this.transactionState) {
      if (this.transactionState !== 'active')
        throw new Error('Learner transaction scope is closed');
      return operation(this);
    }
    let bound: this | undefined;
    return withEmbeddedWriteTransaction(
      this.db,
      isEmbeddedDatabase(this.db),
      async (db) => {
        const service = this.createTransactionService(db);
        bound = service;
        service.transactionState = 'active';
        service.postgres = this.postgres;
        try {
          const result = await operation(service);
          // Stop accepting work, but finish already-enqueued operations before
          // committing. A swallowed mutation failure still aborts the unit.
          if (service.transactionState === 'active')
            service.transactionState = 'draining';
          await service.compositeTail;
          await service.writeTail;
          if (service.writeFailure) throw service.writeFailure.error;
          return result;
        } catch (error) {
          // Queued operations must not begin after failure; an operation already
          // running must settle before rollback can release its database handle.
          service.transactionState = 'aborting';
          await service.compositeTail;
          await service.writeTail;
          throw error;
        } finally {
          service.transactionState = 'closed';
        }
      },
    ).catch(async (error: unknown) => {
      await bound?.rollbackResources(error, this.db);
      throw error;
    });
  }

  /**
   * Compose database-only education operations with a host-owned transaction.
   * The callback service is closed when it returns and never opens a nested unit.
   */
  async withExecutor<T>(
    executor: DatabaseInterface,
    operation: (service: this) => Promise<T>,
  ): Promise<T> {
    if (this.transactionState)
      throw new Error('Learner transaction scope is already active');
    const service = this.createTransactionService(executor);
    service.transactionState = 'active';
    service.executorBorrowed = true;
    service.postgres = isPostgresDatabase(executor);
    try {
      const result = await operation(service);
      service.transactionState = 'draining';
      await service.compositeTail;
      await service.writeTail;
      if (service.writeFailure) throw service.writeFailure.error;
      return result;
    } finally {
      service.transactionState = 'closed';
    }
  }

  /** Internal subclass hook: preserve the concrete owning service in a transaction. */
  protected createTransactionService(db: DatabaseInterface): this {
    return new LearnerService(
      db,
      this.authorize,
      this.authorizeCatalog,
      this.learnerOptions,
    ) as this;
  }

  /** Internal compensation hook, invoked after in-flight work drains on abort. */
  protected async rollbackResources(
    _cause: unknown,
    _rootDb: DatabaseInterface,
  ): Promise<void> {}

  // Concurrent calls on one connection must observe earlier writes in that same
  // transaction. Cross-transaction arbitration still uses database row locks.
  /** Serialize a composite domain mutation which calls ordinary queued writes.
   * The separate queue avoids waiting on the same queue from inside itself;
   * both queues share abort/commit draining and poison-on-failure semantics.
   * Composite operations must not call other composite mutations.
   */
  protected composeMutation<T>(
    operation: (service: this) => Promise<T>,
  ): Promise<T> {
    if (!this.transactionState)
      return this.withTransaction((service) =>
        service.composeMutation(operation),
      );
    if (this.transactionState !== 'active')
      return Promise.reject(new Error('Learner transaction scope is closed'));
    const result = this.compositeTail.then(async () => {
      if (
        this.transactionState === 'aborting' ||
        this.transactionState === 'closed'
      )
        throw (
          this.writeFailure?.error ??
          new Error('Learner transaction scope is closed')
        );
      this.composingMutation = true;
      try {
        return await operation(this);
      } catch (error) {
        this.writeFailure ??= { error };
        this.transactionState = 'aborting';
        throw error;
      } finally {
        this.composingMutation = false;
      }
    });
    this.compositeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  protected mutate<T>(operation: (service: this) => Promise<T>): Promise<T> {
    if (!this.transactionState) return this.withTransaction(operation);
    if (
      this.transactionState !== 'active' &&
      !(this.transactionState === 'draining' && this.composingMutation)
    )
      return Promise.reject(new Error('Learner transaction scope is closed'));
    const result = this.writeTail.then(async () => {
      if (
        this.transactionState === 'aborting' ||
        this.transactionState === 'closed'
      )
        throw (
          this.writeFailure?.error ??
          new Error('Learner transaction scope is closed')
        );
      try {
        return await operation(this);
      } catch (error) {
        this.writeFailure ??= { error };
        this.transactionState = 'aborting';
        throw error;
      }
    });
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Prevent escaped transaction-scoped services from using a released executor. */
  protected assertServiceOpen(): void {
    if (
      this.transactionState === 'aborting' ||
      this.transactionState === 'closed'
    )
      throw new Error('Learner transaction scope is closed');
  }
  protected async requireActor(
    request: LearnerRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'],
    delegation: (CourseDelegation & { courseId?: string }) | null = null,
  ): Promise<Learner> {
    this.assertServiceOpen();
    const context = getCurrentTenant();
    if (
      !context ||
      !request.tenantId ||
      !request.actorUserId ||
      !request.learnerId ||
      context.tenantId !== request.tenantId ||
      context.userId !== request.actorUserId ||
      context.superAdminBypass
    )
      throw new LearnerAuthorizationError();
    const learners = await LearnerCollection.create({ db: this.db });
    const learner = await learners.get(
      { id: request.learnerId, tenantId: request.tenantId },
      { cache: false },
    );
    if (
      !learner ||
      !(await this.db.get('memberships', {
        tenant_id: request.tenantId,
        user_id: request.actorUserId,
        status: 'active',
      })) ||
      !(await this.db.get('memberships', {
        tenant_id: request.tenantId,
        user_id: learner.userId,
        status: 'active',
      })) ||
      !(await this.db.get('users', {
        id: learner.userId,
        profile_id: learner.profileId,
      })) ||
      !(await this.db.get('profiles', {
        id: learner.profileId,
        _meta_type: '@happyvertical/smrt-profiles:Person',
      }))
    )
      throw new LearnerAuthorizationError();
    // A delegated agent holds no learner or guardian authority of its own: the
    // relationship, membership and own-learner rules apply to the delegating
    // guardian, and the agent may not be the learner.
    const holder = delegation?.delegatingGuardianUserId ?? request.actorUserId;
    if (
      delegation &&
      (learner.userId === request.actorUserId ||
        !(await this.db.get('users', {
          id: request.actorUserId,
          status: 'active',
        })) ||
        !(await this.db.get('memberships', {
          tenant_id: request.tenantId,
          user_id: holder,
          status: 'active',
        })))
    )
      throw new LearnerAuthorizationError();
    // The host proves the delegation before any relationship lookup or the
    // learner authorizer; no port, a denial or a throw all refuse.
    if (delegation) {
      const verify = this.learnerOptions.verifyDelegation;
      let verified = false;
      if (typeof verify === 'function') {
        try {
          const decision = await verify(this.db, {
            tenantId: request.tenantId,
            actorUserId: request.actorUserId,
            delegatingGuardianUserId: delegation.delegatingGuardianUserId,
            delegationId: delegation.delegationId,
            learnerId: request.learnerId,
            ...(delegation.courseId ? { courseId: delegation.courseId } : {}),
          });
          verified =
            typeof decision === 'object' && decision !== null
              ? decision.allowed === true
              : decision === true;
        } catch {
          verified = false;
        }
      }
      if (!verified) throw new LearnerAuthorizationError();
    }
    const own = learner.userId === holder;
    let relationshipTypeId: string | undefined;
    if (!own) {
      const user = await this.db.get('users', {
        id: holder,
        ...(delegation ? { status: 'active' } : {}),
      });
      const relationship =
        user && request.guardianRelationshipId
          ? await this.db.get('profile_relationships', {
              id: request.guardianRelationshipId,
              tenant_id: request.tenantId,
              from_profile_id: user.profile_id,
              to_profile_id: learner.profileId,
            })
          : null;
      if (!relationship) throw new LearnerAuthorizationError();
      relationshipTypeId = String(relationship.type_id);
    }
    // A learner cannot turn their own grant into a planning/guardian capability.
    if (
      own &&
      [
        'education.learner.plan',
        'education.learner.grade',
        'education.learner.packet',
        'education.learner.notes.read',
        'education.learner.notes.add',
        'education.learner.complete',
        'education.learner.review-response',
      ].includes(action)
    )
      throw new LearnerAuthorizationError();
    // Authority-looking keys are always set here, after the request spread, so a
    // caller-supplied value (a host spreading request fields) can never survive.
    const {
      delegatingGuardianUserId: _guardian,
      delegationId: _id,
      relationshipTypeId: _type,
      delegated: _delegated,
      delegatingRelationshipTypeId: _delegatingType,
      own: _own,
      ...base
    } = request as LearnerRequest &
      LearnerDelegationRequest &
      Record<string, unknown>;
    const authority = delegation
      ? {
          delegated: true,
          relationshipTypeId: undefined,
          delegatingGuardianUserId: delegation.delegatingGuardianUserId,
          delegationId: delegation.delegationId,
          delegatingRelationshipTypeId: relationshipTypeId,
        }
      : {
          delegated: undefined,
          relationshipTypeId,
          delegatingGuardianUserId: undefined,
          delegationId: undefined,
          delegatingRelationshipTypeId: undefined,
        };
    if (
      (await this.authorize({
        ...base,
        ...authority,
        executor: this.db,
        action,
        own,
      })) !== true
    )
      throw new LearnerAuthorizationError();
    return learner;
  }

  async getLearner(request: LearnerRequest): Promise<LearnerView> {
    const row = await this.requireActor(request, 'education.learner.read');
    return {
      id: String(row.id),
      tenantId: row.tenantId,
      userId: row.userId,
      profileId: row.profileId,
      displayName: row.displayName,
      level: row.level,
      settings: row.getSettings(),
    };
  }

  /**
   * Checks whether an active tenant member still needs a Learner row.
   * The host authorizer decides who may run this onboarding probe; no learner
   * metadata or guardian relationship is returned or created here.
   */
  async getLearnerSetupStatus(
    request: LearnerSetupStatusRequest,
  ): Promise<LearnerSetupStatus> {
    const context = getCurrentTenant();
    if (
      !context ||
      !request.tenantId ||
      !request.actorUserId ||
      !request.learnerUserId ||
      context.tenantId !== request.tenantId ||
      context.userId !== request.actorUserId ||
      context.superAdminBypass
    )
      throw new LearnerAuthorizationError();
    if (
      (await this.authorize({
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        learnerId: '',
        learnerUserId: request.learnerUserId,
        executor: this.db,
        action: 'education.learner.setup',
        own: request.learnerUserId === request.actorUserId,
      })) !== true
    )
      throw new LearnerAuthorizationError();
    if (
      !(await this.db.get('memberships', {
        tenant_id: request.tenantId,
        user_id: request.actorUserId,
        status: 'active',
      })) ||
      !(await this.db.get('memberships', {
        tenant_id: request.tenantId,
        user_id: request.learnerUserId,
        status: 'active',
      })) ||
      !(await this.db.get('users', { id: request.learnerUserId }))
    )
      throw new LearnerAuthorizationError();
    const learner = await (await LearnerCollection.create({ db: this.db })).get(
      { tenantId: request.tenantId, userId: request.learnerUserId },
      { cache: false },
    );
    return { needsSetup: !learner };
  }

  /** Resolve the authenticated learner identity without exposing collections. */
  async getOwnLearner(
    request: Pick<LearnerRequest, 'tenantId' | 'actorUserId'>,
  ): Promise<LearnerView | null> {
    const context = getCurrentTenant();
    if (
      !context ||
      context.tenantId !== request.tenantId ||
      context.userId !== request.actorUserId ||
      context.superAdminBypass
    )
      throw new LearnerAuthorizationError();
    const row = await (await LearnerCollection.create({ db: this.db })).get(
      { tenantId: request.tenantId, userId: request.actorUserId },
      { cache: false },
    );
    return row
      ? this.getLearner({ ...request, learnerId: String(row.id) })
      : null;
  }

  /** Resolve a relationship-selected Person Profile through the normal guard. */
  async getLearnerForProfile(
    request: Pick<
      LearnerRequest,
      'tenantId' | 'actorUserId' | 'guardianRelationshipId'
    > & { learnerProfileId: string },
  ): Promise<LearnerView> {
    const row = await (await LearnerCollection.create({ db: this.db })).get(
      { tenantId: request.tenantId, profileId: request.learnerProfileId },
      { cache: false },
    );
    if (!row) throw new LearnerAuthorizationError();
    return this.getLearner({
      tenantId: request.tenantId,
      actorUserId: request.actorUserId,
      guardianRelationshipId: request.guardianRelationshipId,
      learnerId: String(row.id),
    });
  }

  /**
   * Trusted host provisioning after it has created the User, Person Profile and
   * active Membership. It never creates credentials or relationship grants.
   */
  async provisionLearner(
    request: Omit<LearnerRequest, 'learnerId'> & {
      learnerUserId: string;
      learnerProfileId: string;
      displayName: string;
      level?: number;
    },
  ): Promise<LearnerView> {
    return this.mutate(async (service) => {
      const context = getCurrentTenant();
      if (
        !context ||
        context.tenantId !== request.tenantId ||
        context.userId !== request.actorUserId ||
        context.superAdminBypass
      )
        throw new LearnerAuthorizationError();
      const actor = await service.db.get('users', { id: request.actorUserId });
      if (
        !actor ||
        !(await service.db.get('memberships', {
          tenant_id: request.tenantId,
          user_id: request.actorUserId,
          status: 'active',
        })) ||
        !(await service.db.get('memberships', {
          tenant_id: request.tenantId,
          user_id: request.learnerUserId,
          status: 'active',
        })) ||
        !(await service.db.get('users', {
          id: request.learnerUserId,
          profile_id: request.learnerProfileId,
        })) ||
        !(await service.db.get('profiles', {
          id: request.learnerProfileId,
          _meta_type: '@happyvertical/smrt-profiles:Person',
        }))
      )
        throw new LearnerAuthorizationError();
      const relationship =
        request.guardianRelationshipId && actor.profile_id
          ? await service.db.get('profile_relationships', {
              id: request.guardianRelationshipId,
              tenant_id: request.tenantId,
              from_profile_id: actor.profile_id,
              to_profile_id: request.learnerProfileId,
            })
          : null;
      if (
        !relationship ||
        (await service.authorize({
          ...request,
          learnerId: '',
          executor: service.db,
          action: 'education.learner.plan',
          own: false,
          relationshipTypeId: String(relationship.type_id),
        })) !== true
      )
        throw new LearnerAuthorizationError();
      const learners = await LearnerCollection.create({ db: service.db });
      let row = await learners.get(
        { tenantId: request.tenantId, userId: request.learnerUserId },
        { cache: false },
      );
      if (row) {
        if (row.profileId !== request.learnerProfileId)
          throw new LearnerAuthorizationError();
        return {
          id: String(row.id),
          tenantId: row.tenantId,
          userId: row.userId,
          profileId: row.profileId,
          displayName: row.displayName,
          level: row.level,
          settings: row.getSettings(),
        };
      }
      row = await learners.create({
        tenantId: request.tenantId,
        userId: request.learnerUserId,
        profileId: request.learnerProfileId,
        displayName: request.displayName,
        level: request.level ?? 0,
        _insertOnly: true,
      });
      return {
        id: String(row.id),
        tenantId: row.tenantId,
        userId: row.userId,
        profileId: row.profileId,
        displayName: row.displayName,
        level: row.level,
        settings: row.getSettings(),
      };
    });
  }

  async createCurriculum(
    request: LearnerRequest & { title: string },
  ): Promise<CurriculumView> {
    return this.mutate(async (service) => {
      const learner = await service.requireActor(
        request,
        'education.learner.plan',
      );
      if (typeof request.title !== 'string' || !request.title.trim())
        throw new Error('Curriculum title is required');
      return curriculumView(
        await (await CurriculumCollection.create({ db: service.db })).create({
          tenantId: request.tenantId,
          learnerId: String(learner.id),
          title: request.title,
        }),
      );
    });
  }

  protected async catalog(request: LearnerRequest, courseId: string) {
    const service = new CatalogService(
      await CourseCollection.create({ db: this.db }),
      await CourseSectionCollection.create({ db: this.db }),
      await LessonCollection.create({ db: this.db }),
      await LessonAssetCollection.create({ db: this.db }),
      await TenantCollection.create({ db: this.db }),
      this.authorizeCatalog,
    );
    const projection = await service.projectCourse({
      tenantId: request.tenantId,
      actorUserId: request.actorUserId,
      courseId,
      includePrivate: true,
      includeAnswerKeys: false,
    });
    if (!projection) throw new LearnerAuthorizationError();
    return projection;
  }

  /**
   * The lessons that apply to an authorized enrollment. An unpinned enrollment
   * reads its own course, exactly as before. A pinned one reads the effective
   * set shared with `CourseAuthoringService.getEnrollmentRelease`: started
   * lessons stay on their original immutable rows, the rest follow the current
   * release. Every course row is still authorized through the catalog.
   */
  protected async lessonScope(
    request: LearnerRequest,
    enrollment: Enrollment,
  ): Promise<EnrollmentLessonScope> {
    const selection = (await this.db.tableExists('enrollment_release_pins'))
      ? await resolveEnrollmentLessons(
          this.db,
          request.tenantId,
          String(enrollment.id),
        )
      : null;
    if (!selection) {
      const catalog = await this.catalog(request, enrollment.courseId);
      return {
        course: catalog.course,
        entries: catalog.sections.flatMap((section) =>
          section.lessons.map(({ lesson }) => ({
            lesson,
            course: catalog.course,
          })),
        ),
      };
    }
    // Pins always belong to the enrollment's own learner.
    if ([...selection.pinLearnerIds].some((id) => id !== enrollment.learnerId))
      throw new LearnerAuthorizationError();
    const releases = new Set([
      selection.currentReleaseId,
      ...selection.lessons.map((lesson) => lesson.releaseId),
    ]);
    const catalogs = new Map<string, CatalogProjection>();
    for (const releaseId of releases) {
      const courseId = selection.releaseCourseIds.get(releaseId);
      if (!courseId) throw new LearnerAuthorizationError();
      catalogs.set(releaseId, await this.catalog(request, courseId));
    }
    const rows = new Map<string, EnrollmentLessonEntry>();
    const order = new Map<string, string[]>();
    for (const [releaseId, catalog] of catalogs) {
      const ids: string[] = [];
      for (const section of catalog.sections)
        for (const { lesson } of section.lessons) {
          ids.push(String(lesson.id));
          rows.set(String(lesson.id), { lesson, course: catalog.course });
        }
      order.set(releaseId, ids);
    }
    const entries: EnrollmentLessonEntry[] = [];
    for (const effective of orderEffectiveLessons(
      selection,
      (releaseId) => order.get(releaseId) ?? [],
    )) {
      const entry = rows.get(effective.lessonId);
      // A row the catalog no longer exposes is not assignable.
      if (entry && order.get(effective.releaseId)?.includes(effective.lessonId))
        entries.push(entry);
    }
    return {
      course: (catalogs.get(selection.currentReleaseId) as CatalogProjection)
        .course,
      entries,
    };
  }

  protected async lessonInScope(
    request: LearnerRequest,
    enrollment: Enrollment,
    lessonId: string,
  ): Promise<boolean> {
    return (await this.lessonScope(request, enrollment)).entries.some(
      ({ lesson }) => String(lesson.id) === lessonId,
    );
  }

  protected async lock(
    table: 'curricula' | 'enrollments',
    id: string,
    tenant: string,
  ): Promise<void> {
    if (this.postgres)
      await this.db.query(
        `SELECT id FROM ${table} WHERE id = ? AND tenant_id = ? FOR UPDATE`,
        [id, tenant],
      );
  }

  /**
   * Creates (or returns) the enrollment that assigns a course to a learner. A
   * delegated agent passes `delegatingGuardianUserId` + `delegationId`; a new
   * delegated enrollment also appends an `EnrollmentAssignmentRecord`.
   */
  async enroll(
    request: LearnerRequest &
      LearnerDelegationRequest & { curriculumId: string; courseId: string },
  ): Promise<EnrollmentView> {
    let delegation: CourseDelegation | null;
    try {
      delegation = readDelegation(request);
    } catch (error) {
      // A guardian that is the agent is an authority failure, not a typo.
      if (error instanceof CourseAuthoringAuthorizationError)
        throw new LearnerAuthorizationError();
      throw error;
    }
    return this.mutate(async (service) => {
      const learner = await service.requireActor(
        request,
        'education.learner.plan',
        delegation ? { ...delegation, courseId: request.courseId } : null,
      );
      await service.lock('curricula', request.curriculumId, request.tenantId);
      const curriculum = await (
        await CurriculumCollection.create({ db: service.db })
      ).get(
        {
          id: request.curriculumId,
          learnerId: String(learner.id),
          tenantId: request.tenantId,
        },
        { cache: false },
      );
      if (!curriculum) throw new LearnerAuthorizationError();
      await service.catalog(request, request.courseId);
      const enrollments = await EnrollmentCollection.create({ db: service.db });
      const existing = await enrollments.get(
        {
          curriculumId: String(curriculum.id),
          courseId: request.courseId,
          tenantId: request.tenantId,
        },
        { cache: false },
      );
      if (existing) {
        if (existing.learnerId !== learner.id)
          throw new LearnerAuthorizationError();
        return enrollmentView(existing);
      }
      const created = await enrollments.create({
        tenantId: request.tenantId,
        curriculumId: String(curriculum.id),
        learnerId: String(learner.id),
        courseId: request.courseId,
        _insertOnly: true,
      });
      if (delegation)
        await (
          await EnrollmentAssignmentRecordCollection.create({ db: service.db })
        ).create({
          _insertOnly: true,
          tenantId: request.tenantId,
          enrollmentId: String(created.id),
          learnerId: String(learner.id),
          actorUserId: request.actorUserId,
          ...delegation,
          recordedAt: new Date(),
        });
      return enrollmentView(created);
    });
  }

  protected async requireEnrollment(
    request: LearnerRequest & { enrollmentId: string },
    action: Parameters<LearnerAuthorizer>[0]['action'],
  ): Promise<Enrollment> {
    const learner = await this.requireActor(request, action);
    const enrollment = await (
      await EnrollmentCollection.create({ db: this.db })
    ).get(
      {
        id: request.enrollmentId,
        learnerId: String(learner.id),
        tenantId: request.tenantId,
      },
      { cache: false },
    );
    if (
      !enrollment ||
      !(await this.db.get('curricula', {
        id: enrollment.curriculumId,
        learner_id: String(learner.id),
        tenant_id: request.tenantId,
      }))
    )
      throw new LearnerAuthorizationError();
    return enrollment;
  }

  /** Existing non-workbook consumers need not migrate optional workbook tables. */
  protected async findWorkbookActivity(
    request: LearnerRequest,
    selector: { enrollmentId?: string; lessonId?: string },
  ) {
    if (!(await this.db.tableExists('workbook_activities'))) return null;
    return (await WorkbookActivityCollection.create({ db: this.db })).get(
      { tenantId: request.tenantId, learnerId: request.learnerId, ...selector },
      { cache: false },
    );
  }

  /** Compatibility progress never transports a workbook learner's feedback. */
  protected async projectProgress(
    request: LearnerRequest,
    row: LessonProgress,
  ): Promise<LessonProgressView> {
    const view = progressView(row);
    const activity = await this.findWorkbookActivity(request, {
      enrollmentId: row.enrollmentId,
      lessonId: row.lessonId,
    });
    if (!activity) return view;
    const state = await readWorkbookCompletion(this.db, {
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      activityId: String(activity.id),
    });
    const learner = await this.db.get('learners', {
      id: request.learnerId,
      tenant_id: request.tenantId,
    });
    return {
      ...view,
      status:
        state.completion.status === 'complete'
          ? 'complete'
          : ['complete', 'skipped'].includes(view.status)
            ? 'in_progress'
            : view.status,
      completedAt: state.completion.completedAt,
      ...(learner?.user_id === request.actorUserId ? { bestScore: null } : {}),
    };
  }

  async listProgress(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<LessonProgressView[]> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    const scope = await this.lessonScope(request, enrollment);
    const lessons = new Set(
      scope.entries.map(({ lesson }) => String(lesson.id)),
    );
    const rows = await (
      await LessonProgressCollection.create({ db: this.db })
    ).list({
      where: {
        enrollmentId: String(enrollment.id),
        learnerId: request.learnerId,
        tenantId: request.tenantId,
      },
    });
    return Promise.all(
      rows
        .filter((progress) => lessons.has(progress.lessonId))
        .map((progress) => this.projectProgress(request, progress)),
    );
  }

  /** All exact-tenant enrollments visible to this learner or authorized guardian. */
  async listEnrollments(request: LearnerRequest): Promise<EnrollmentView[]> {
    const learner = await this.requireActor(request, 'education.learner.read');
    const rows = await (
      await EnrollmentCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, learnerId: String(learner.id) },
      orderBy: 'sortOrder',
    });
    return rows.map(enrollmentView);
  }

  /**
   * Projects the first unfinished lesson in each authorized enrollment. No
   * catalog assets, answer material, model handles, or source locators escape.
   */
  async nextLessons(
    request: LearnerRequest & { enrollmentId?: string },
  ): Promise<
    ReadonlyArray<{
      enrollment: EnrollmentView;
      progress: LessonProgressView | null;
      lesson: {
        id: string;
        title: string;
        kind: string;
        requiresOnlineResource: boolean;
      };
    }>
  > {
    const enrollments = request.enrollmentId
      ? [
          await this.requireEnrollment(
            request as LearnerRequest & { enrollmentId: string },
            'education.learner.read',
          ),
        ]
      : await (await EnrollmentCollection.create({ db: this.db })).list({
          where: { tenantId: request.tenantId, learnerId: request.learnerId },
          orderBy: 'sortOrder',
        });
    await this.requireActor(request, 'education.learner.read');
    const result: Array<{
      enrollment: EnrollmentView;
      progress: LessonProgressView | null;
      lesson: {
        id: string;
        title: string;
        kind: string;
        requiresOnlineResource: boolean;
      };
    }> = [];
    for (const enrollment of enrollments) {
      const scope = await this.lessonScope(request, enrollment);
      const progresses = await (
        await LessonProgressCollection.create({ db: this.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          enrollmentId: String(enrollment.id),
          learnerId: request.learnerId,
        },
      });
      const byLesson = new Map(
        await Promise.all(
          progresses.map(
            async (row) =>
              [row.lessonId, await this.projectProgress(request, row)] as const,
          ),
        ),
      );
      const next = scope.entries.find(({ lesson: candidate }) => {
        const progress = byLesson.get(String(candidate.id));
        return !progress || !['complete', 'skipped'].includes(progress.status);
      });
      if (!next) continue;
      const { lesson, course } = next;
      const progress = byLesson.get(String(lesson.id));
      result.push({
        enrollment: enrollmentView(enrollment),
        progress: progress ?? null,
        lesson: {
          id: String(lesson.id),
          title: lesson.title,
          kind: lesson.constructor.name,
          requiresOnlineResource:
            course.modality === 'online' || lesson.constructor.name === 'Video',
        },
      });
    }
    return result;
  }

  /** All lesson summaries for one authorized assignment/enrollment. */
  async assignmentLessons(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<
    ReadonlyArray<{
      enrollment: EnrollmentView;
      progress: LessonProgressView | null;
      lesson: {
        id: string;
        title: string;
        kind: string;
        requiresOnlineResource: boolean;
      };
    }>
  > {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    const scope = await this.lessonScope(request, enrollment);
    const progresses = await (
      await LessonProgressCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        enrollmentId: String(enrollment.id),
        learnerId: request.learnerId,
      },
    });
    const byLesson = new Map(progresses.map((row) => [row.lessonId, row]));
    return Promise.all(
      scope.entries.map(async ({ lesson, course }) => ({
        enrollment: enrollmentView(enrollment),
        progress: byLesson.get(String(lesson.id))
          ? await this.projectProgress(
              request,
              byLesson.get(String(lesson.id))!,
            )
          : null,
        lesson: {
          id: String(lesson.id),
          title: lesson.title,
          kind: lesson.constructor.name,
          requiresOnlineResource:
            course.modality === 'online' || lesson.constructor.name === 'Video',
        },
      })),
    );
  }

  /** Start once. Caller-supplied learner/status/score/counter patches are never applied. */
  async startLesson(
    request: LearnerRequest & { enrollmentId: string; lessonId: string },
  ): Promise<LessonProgressView> {
    return this.mutate(async (service) => {
      const enrollment = await service.requireEnrollment(
        request,
        'education.learner.start',
      );
      await service.lock('enrollments', request.enrollmentId, request.tenantId);
      if (!(await service.lessonInScope(request, enrollment, request.lessonId)))
        throw new LearnerAuthorizationError();
      const progress = await LessonProgressCollection.create({
        db: service.db,
      });
      const existing = await progress.get(
        {
          enrollmentId: String(enrollment.id),
          lessonId: request.lessonId,
          tenantId: request.tenantId,
        },
        { cache: false },
      );
      if (existing) {
        if (existing.learnerId !== enrollment.learnerId)
          throw new LearnerAuthorizationError();
        return service.projectProgress(request, existing);
      }
      return service.projectProgress(
        request,
        await progress.create({
          tenantId: request.tenantId,
          enrollmentId: String(enrollment.id),
          learnerId: enrollment.learnerId,
          lessonId: request.lessonId,
          status: 'in_progress',
          startedAt: new Date(),
          _insertOnly: true,
        }),
      );
    });
  }
}
