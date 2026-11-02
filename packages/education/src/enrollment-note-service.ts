import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type EnrollmentParentNote,
  EnrollmentParentNoteCollection,
  validateEnrollmentNote,
} from './enrollment-notes.js';
import { type LearnerRequest, LearnerService } from './learner-service.js';

export type EnrollmentParentNoteView = Readonly<{
  id: string;
  enrollmentId: string;
  learnerId: string;
  text: string;
  authorUserId: string;
  authorLabel: string;
  createdAt: Date;
}>;

function noteView(row: EnrollmentParentNote): EnrollmentParentNoteView {
  return {
    id: String(row.id),
    enrollmentId: row.enrollmentId,
    learnerId: row.learnerId,
    text: row.text,
    authorUserId: row.authorUserId,
    authorLabel: row.authorLabel,
    createdAt: new Date(row.recordedAt),
  };
}

/** Internal extension shared by the public learner Plan service. */
export class EnrollmentNoteService extends LearnerService {
  protected override createTransactionService(db: DatabaseInterface): this {
    return new EnrollmentNoteService(
      db,
      this.authorize,
      this.authorizeCatalog,
    ) as this;
  }

  async listEnrollmentNotes(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<EnrollmentParentNoteView[]> {
    await this.requireEnrollment(request, 'education.learner.notes.read');
    const rows = await (
      await EnrollmentParentNoteCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        enrollmentId: request.enrollmentId,
        learnerId: request.learnerId,
      },
    });
    return rows.map(noteView).sort((a, b) => {
      const time = a.createdAt.getTime() - b.createdAt.getTime();
      return time || a.id.localeCompare(b.id);
    });
  }

  async addEnrollmentNote(
    request: LearnerRequest & {
      enrollmentId: string;
      text: string;
      requestKey: string;
    },
  ): Promise<EnrollmentParentNoteView> {
    return this.mutate(async (service) => {
      const enrollment = await service.requireEnrollment(
        request,
        'education.learner.notes.add',
      );
      validateEnrollmentNote(request.text, request.requestKey);
      await service.lock('enrollments', request.enrollmentId, request.tenantId);
      const notes = await EnrollmentParentNoteCollection.create({
        db: service.db,
      });
      const existing = await notes.get(
        {
          tenantId: request.tenantId,
          enrollmentId: String(enrollment.id),
          requestKey: request.requestKey,
        },
        { cache: false },
      );
      if (existing) {
        if (
          existing.learnerId !== enrollment.learnerId ||
          existing.text !== request.text
        )
          throw new Error('Enrollment note retry changed its content');
        return noteView(existing);
      }
      const actor = await service.db.get('users', { id: request.actorUserId });
      const profile = actor?.profile_id
        ? await service.db.get('profiles', { id: actor.profile_id })
        : null;
      const authorLabel =
        (typeof profile?.name === 'string'
          ? profile.name.trim().slice(0, 200)
          : '') || 'Parent';
      return noteView(
        await notes.create({
          tenantId: request.tenantId,
          enrollmentId: String(enrollment.id),
          learnerId: enrollment.learnerId,
          text: request.text,
          requestKey: request.requestKey,
          authorUserId: request.actorUserId,
          authorLabel,
          recordedAt: new Date(),
          _insertOnly: true,
        }),
      );
    });
  }
}
