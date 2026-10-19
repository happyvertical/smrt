import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CatalogAcquisitionRecord } from './catalog-acquisition-service.js';
import type { CatalogActor, CatalogSourceRecord } from './catalog-contracts.js';
import { CatalogPolicy } from './catalog-policy.js';
import {
  CourseSectionCollection,
  ExternalCourseCollection,
  LessonAssetCollection,
  ReadingCollection,
  WorksheetCollection,
} from './collections.js';
import type { LearnerRequest } from './learner-service.js';

export interface CatalogMaterializationStore {
  getResource(
    resourceId: string,
  ): Promise<(CatalogSourceRecord & { id: string }) | undefined>;
  getAcquisition(input: {
    tenantId: string;
    acquisitionId: string;
  }): Promise<CatalogAcquisitionRecord | undefined>;
}

/** Host-owned copy operation; it must retain the pinned bytes and prove a private Asset capability. */
export interface CatalogMaterializationStorage {
  ensurePrivateAsset(input: {
    tenantId: string;
    actorUserId: string;
    acquisition: CatalogAcquisitionRecord;
    name: string;
  }): Promise<{ assetId: string }>;
}

export interface CatalogEnrollmentPort {
  enroll(
    input: LearnerRequest & { curriculumId: string; courseId: string },
  ): Promise<{
    id: string;
  }>;
}

export interface CatalogMaterializationRequest {
  tenantId: string;
  actorUserId: string;
  roles: readonly string[];
  acquisitionId: string;
  /** Required when provider metadata does not classify a subject. */
  subject?: string;
  courseTitle?: string;
  lessonTitle?: string;
  curriculumId?: string;
  learnerId?: string;
  guardianRelationshipId?: string;
}

export interface CatalogMaterializationResult {
  courseId: string;
  lessonId: string;
  assetId: string;
  revision: string;
  sha256: string;
  enrollmentId?: string;
}

async function identity(...parts: string[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(['smrt.education.catalog.v1', ...parts]),
    ),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Creates a private course from an already-authorized, pinned acquisition. */
export class CatalogMaterializationService {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly store: CatalogMaterializationStore,
    private readonly storage: CatalogMaterializationStorage,
    private readonly learner?: CatalogEnrollmentPort,
    private readonly policy = new CatalogPolicy(),
  ) {}

  async materialize(
    request: CatalogMaterializationRequest,
  ): Promise<CatalogMaterializationResult> {
    const actor: CatalogActor = request;
    const active = getCurrentTenant();
    if (
      !actor.tenantId?.trim() ||
      !actor.actorUserId?.trim() ||
      active?.tenantId !== actor.tenantId ||
      active.userId !== actor.actorUserId ||
      active.superAdminBypass
    )
      throw new Error('Trusted active tenant and actor identity are required.');
    const acquisition = await this.store.getAcquisition({
      tenantId: actor.tenantId,
      acquisitionId: request.acquisitionId,
    });
    if (!acquisition || acquisition.tenantId !== actor.tenantId)
      throw new Error('Pinned tenant acquisition was not found.');
    const resource = await this.store.getResource(acquisition.resourceId);
    if (!resource || resource.revision !== acquisition.revision)
      throw new Error('Pinned catalog resource revision was not found.');
    if (!this.policy.canView(resource, actor))
      throw new Error(
        'Teacher-only material cannot be materialized for this actor.',
      );
    const subject =
      resource.subjects?.find((value) => value.trim()) ??
      request.subject?.trim();
    if (!subject)
      throw new Error('Guardian subject classification is required.');
    const courseId = await identity(
      actor.tenantId,
      resource.providerId,
      resource.stableId,
    );
    const sectionId = await identity(courseId, 'materials');
    const lessonId = await identity(
      courseId,
      acquisition.revision,
      acquisition.format,
    );
    const asset = await this.storage.ensurePrivateAsset({
      tenantId: actor.tenantId,
      actorUserId: actor.actorUserId,
      acquisition,
      name: request.lessonTitle?.trim() || resource.title,
    });
    if (!asset.assetId)
      throw new Error('Materialized private asset is required.');
    if (!this.db.transaction)
      throw new Error('Catalog materialization requires a transaction.');
    await this.db.transaction(async (tx) => {
      const courses = await ExternalCourseCollection.create({ db: tx });
      const sections = await CourseSectionCollection.create({ db: tx });
      const readings = await ReadingCollection.create({ db: tx });
      const worksheets = await WorksheetCollection.create({ db: tx });
      const assets = await LessonAssetCollection.create({ db: tx });
      const course = await courses.get(courseId);
      if (course) {
        if (
          course.tenantId !== actor.tenantId ||
          course.sourceKey !== resource.providerId ||
          course.sourceRef !== resource.stableId ||
          course.licenseKind !== 'personal-use-copy'
        )
          throw new Error(
            'Existing materialized course ownership cannot change.',
          );
      } else {
        await courses.create({
          id: courseId,
          tenantId: actor.tenantId,
          title: request.courseTitle?.trim() || resource.title,
          subject,
          sourceKey: resource.providerId,
          sourceRef: resource.stableId,
          sourceUrl: resource.canonicalUrl,
          license: resource.licenseEvidence.identifier ?? '',
          licenseKind: 'personal-use-copy',
          licenseNote: [
            resource.licenseEvidence.attribution,
            acquisition.sha256,
          ]
            .filter(Boolean)
            .join('\n'),
          status: 'draft',
        });
      }
      if (!(await sections.get(sectionId)))
        await sections.create({
          id: sectionId,
          tenantId: actor.tenantId,
          courseId,
          title: 'Materials',
          sortOrder: 0,
        });
      const printable = acquisition.format === 'pdf';
      const lessons = printable ? worksheets : readings;
      if (!(await lessons.get(lessonId)))
        await lessons.create({
          id: lessonId,
          tenantId: actor.tenantId,
          sectionId,
          title: request.lessonTitle?.trim() || resource.title,
          externalRef: `${resource.stableId}@${acquisition.revision}`,
          externalUrl: resource.canonicalUrl,
          sortOrder: 0,
        });
      if (
        !(await assets.get({
          lessonId,
          assetId: asset.assetId,
          tenantId: actor.tenantId,
        }))
      )
        await assets.create({
          tenantId: actor.tenantId,
          lessonId,
          assetId: asset.assetId,
          relationship: printable ? 'printable' : 'attachment',
        });
    });
    let enrollmentId: string | undefined;
    if (request.curriculumId || request.learnerId) {
      if (!this.learner || !request.curriculumId || !request.learnerId)
        throw new Error(
          'Learner, curriculum, and enrollment service are required.',
        );
      enrollmentId = (
        await this.learner.enroll({
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          learnerId: request.learnerId,
          ...(request.guardianRelationshipId
            ? { guardianRelationshipId: request.guardianRelationshipId }
            : {}),
          curriculumId: request.curriculumId,
          courseId,
        })
      ).id;
    }
    return {
      courseId,
      lessonId,
      assetId: asset.assetId,
      revision: acquisition.revision,
      sha256: acquisition.sha256,
      ...(enrollmentId ? { enrollmentId } : {}),
    };
  }
}
