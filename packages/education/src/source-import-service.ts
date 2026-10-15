import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteQueue,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ExternalCourse } from './catalog.js';
import { CatalogAuthorizationError } from './catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  ExternalCourseCollection,
  LessonCollection,
  ReadingCollection,
  WorksheetCollection,
} from './collections.js';
import {
  type CourseSource,
  CourseSourceCollection,
  type SourceSharing,
} from './course-source.js';
import {
  parseEasyPeasyPage,
  validateEasyPeasyUrl,
} from './sources/easy-peasy-parser.js';

export interface SourceImportRequest {
  tenantId: string;
  actorUserId: string;
  sourceId: string;
  /** Host-stable identity, independent of the page's current URL. */
  courseRef: string;
  pageUrl: string;
  destination: 'private' | 'group';
}
export interface SourceImportAuthorization {
  action: 'education.source.import';
  actorTenantId: string;
  actorUserId: string;
  sourceId: string;
  sourceSharing: SourceSharing;
  destination: 'private' | 'group';
  licenseEvidence: string;
}
export type SourceImportAuthorizer = (
  request: SourceImportAuthorization,
) => boolean | Promise<boolean>;
export interface EasyPeasyRegistration {
  /** Supplied by host configuration after its operator accepts the source terms. */
  termsAccepted: true;
  /** Must honor redirect:error and bound response size/time. Never fetch PDFs. */
  fetchPage: (
    url: string,
    options: { redirect: 'error' },
  ) => Promise<{ html: string; url: string }>;
}
export interface SourceImportResult {
  courseId: string;
  lessonIds: string[];
  /** Source-hosted packet link, returned without fetching or persisting its content. */
  packetUrl?: string;
}

async function identity(...parts: string[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(['smrt.education.source.v1', ...parts]),
    ),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function requireOwnedIdentity(
  db: DatabaseInterface,
  table: string,
  id: string,
  tenantId: string,
): Promise<void> {
  // A filtered collection get cannot distinguish absence from a corrupt foreign
  // owner at our deterministic ID. Check only to deny; never return that row.
  if (
    (await db.get(table, { id })) &&
    !(await db.get(table, { id, tenant_id: tenantId }))
  )
    throw new CatalogAuthorizationError();
}

function retryable(error: unknown): boolean {
  let current = error;
  let contention = false;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === 'object';
    depth++
  ) {
    const failure = current as {
      code?: unknown;
      cause?: unknown;
      connectionInvalidated?: boolean;
    };
    if (failure.connectionInvalidated) return false;
    contention ||= [
      'SQLITE_BUSY',
      'SQLITE_BUSY_SNAPSHOT',
      '40001',
      '40P01',
    ].includes(String(failure.code));
    current = failure.cause;
  }
  return contention;
}

/** Opt-in, pointer-only import. Host authorization defines family/group roles. */
export class SourceImportService {
  private easyPeasy?: Readonly<EasyPeasyRegistration>;
  constructor(
    private readonly db: DatabaseInterface,
    private readonly authorize: SourceImportAuthorizer,
  ) {}

  registerEasyPeasy(registration: EasyPeasyRegistration): void {
    if (
      registration.termsAccepted !== true ||
      typeof registration.fetchPage !== 'function'
    )
      throw new Error(
        'Easy Peasy terms must be accepted by the host before registration.',
      );
    this.easyPeasy = Object.freeze({
      termsAccepted: true,
      fetchPage: registration.fetchPage,
    });
  }

  private actor(request: SourceImportRequest): void {
    const active = getCurrentTenant();
    if (
      !request.tenantId?.trim() ||
      !request.actorUserId?.trim() ||
      active?.tenantId !== request.tenantId ||
      active.userId !== request.actorUserId ||
      active.superAdminBypass
    )
      throw new CatalogAuthorizationError();
    if (request.destination !== 'private' && request.destination !== 'group')
      throw new Error(
        'Only private-family or licensed-group destinations are supported.',
      );
    if (
      !request.sourceId?.trim() ||
      !request.courseRef?.trim() ||
      request.courseRef.length > 256
    )
      throw new Error('A source and stable course reference are required.');
  }

  private async source(
    db: DatabaseInterface,
    request: SourceImportRequest,
  ): Promise<CourseSource> {
    this.actor(request);
    const source = await (await CourseSourceCollection.create({ db })).get(
      request.sourceId,
    );
    if (!source || source.tenantId !== request.tenantId)
      throw new CatalogAuthorizationError();
    if (
      source.kind !== 'adapter' ||
      source.adapterKey !== 'easy-peasy' ||
      !['private', 'group', 'global'].includes(source.sharing)
    )
      throw new Error('Unsupported source policy.');
    const licenseEvidence = source.getConfig().licenseEvidence?.trim() ?? '';
    if (
      request.destination === 'group' &&
      (source.sharing === 'private' || !licenseEvidence)
    )
      throw new Error(
        'Source sharing and explicit licensing evidence must permit group import.',
      );
    if (
      (await this.authorize({
        action: 'education.source.import',
        actorTenantId: request.tenantId,
        actorUserId: request.actorUserId,
        sourceId: request.sourceId,
        sourceSharing: source.sharing,
        destination: request.destination,
        licenseEvidence,
      })) !== true
    )
      throw new CatalogAuthorizationError();
    this.actor(request);
    return source;
  }

  async importCourse(input: SourceImportRequest): Promise<SourceImportResult> {
    // Snapshot caller input before any host callback can mutate it.
    const request = Object.freeze({ ...input });
    this.actor(request);
    const adapter = this.easyPeasy;
    if (!adapter) throw new Error('Easy Peasy is not registered by this host.');
    const registeredSource = await this.source(this.db, request);
    const pageUrl = validateEasyPeasyUrl(request.pageUrl);
    const response = await adapter.fetchPage(pageUrl, { redirect: 'error' });
    if (validateEasyPeasyUrl(response.url) !== pageUrl)
      throw new Error('Unexpected source redirect.');
    if (typeof response.html !== 'string' || response.html.length > 2_000_000)
      throw new Error('Invalid or oversized source page.');
    const parsed = parseEasyPeasyPage(response.html, pageUrl);
    const courseId = await identity(
      request.tenantId,
      String(registeredSource.id),
      request.courseRef,
    );
    return withEmbeddedWriteQueue(
      this.db,
      isEmbeddedDatabase(this.db),
      async () => {
        if (!this.db.transaction)
          throw new Error('Source imports require real transactions.');
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.db.transaction(async (tx) => {
              if (isPostgresDatabase(this.db))
                await tx.query(
                  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                  courseId,
                );
              const source = await this.source(tx, request);
              const courses = await ExternalCourseCollection.create({ db: tx });
              const sections = await CourseSectionCollection.create({ db: tx });
              const lessons = await LessonCollection.create({ db: tx });
              const readings = await ReadingCollection.create({ db: tx });
              const worksheets = await WorksheetCollection.create({ db: tx });
              await requireOwnedIdentity(
                tx,
                'courses',
                courseId,
                request.tenantId,
              );
              const licenseKind =
                request.destination === 'private'
                  ? 'personal-use-copy'
                  : 'licensed-for-sharing';
              const existing = await (
                await CourseCollection.create({ db: tx })
              ).get(courseId);
              if (
                existing &&
                (!(existing instanceof ExternalCourse) ||
                  existing.tenantId !== request.tenantId ||
                  existing.sourceKey !== source.key ||
                  existing.sourceRef !== request.courseRef ||
                  existing.licenseKind !== licenseKind)
              )
                throw new Error(
                  'Existing course ownership, source, or license cannot be changed by import.',
                );
              if (existing) {
                existing.title = parsed.title;
                existing.sourceUrl = pageUrl;
                await existing.save();
              } else {
                await courses.create({
                  id: courseId,
                  tenantId: request.tenantId,
                  title: parsed.title,
                  sourceKey: source.key,
                  sourceRef: request.courseRef,
                  sourceUrl: pageUrl,
                  licenseKind,
                  licenseNote: source.getConfig().licenseEvidence ?? '',
                  status: 'draft',
                });
              }
              const sectionId = await identity(courseId, 'lessons');
              await requireOwnedIdentity(
                tx,
                'course_sections',
                sectionId,
                request.tenantId,
              );
              const section = await sections.get(sectionId);
              if (section) {
                if (
                  section.tenantId !== request.tenantId ||
                  section.courseId !== courseId
                )
                  throw new Error(
                    'Existing section ownership cannot be changed by import.',
                  );
              } else {
                await sections.create({
                  id: sectionId,
                  tenantId: request.tenantId,
                  courseId,
                  title: 'Lessons',
                  sortOrder: 0,
                });
              }
              const lessonIds: string[] = [];
              for (const item of parsed.lessons) {
                const id = await identity(courseId, item.externalRef);
                await requireOwnedIdentity(tx, 'lessons', id, request.tenantId);
                const lesson = await lessons.get(id);
                if (lesson) {
                  if (
                    lesson.tenantId !== request.tenantId ||
                    lesson.sectionId !== sectionId ||
                    lesson.externalRef !== item.externalRef ||
                    'printableUrl' in lesson !== item.worksheet
                  )
                    throw new Error(
                      'Existing lesson ownership or kind cannot be changed by import.',
                    );
                  lesson.title = item.title;
                  lesson.externalUrl = item.externalUrl;
                  if ('printableUrl' in lesson)
                    lesson.printableUrl = item.printableUrl ?? '';
                  await lesson.save();
                } else {
                  await (item.worksheet ? worksheets : readings).create({
                    id,
                    tenantId: request.tenantId,
                    sectionId,
                    title: item.title,
                    externalRef: item.externalRef,
                    externalUrl: item.externalUrl,
                    sortOrder: item.day,
                    ...(item.worksheet
                      ? { printableUrl: item.printableUrl ?? '' }
                      : {}),
                  });
                }
                lessonIds.push(id);
              }
              return {
                courseId,
                lessonIds,
                ...(parsed.packetUrl ? { packetUrl: parsed.packetUrl } : {}),
              };
            });
          } catch (error) {
            if (attempt >= 3 || !retryable(error)) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, 5 * 2 ** attempt),
            );
          }
        }
      },
    );
  }
}
