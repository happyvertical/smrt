import {
  crossPackageRef,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export const ENROLLMENT_NOTE_MAX_LENGTH = 4000;

function hasControlCharacters(
  value: string,
  allowWhitespace: boolean,
): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code < 32 || code === 127) &&
      !(allowWhitespace && [9, 10, 13].includes(code))
    );
  });
}

/** Notes are plain text; consumers render text, never HTML or markdown. */
export function validateEnrollmentNote(text: string, requestKey: string): void {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > ENROLLMENT_NOTE_MAX_LENGTH ||
    hasControlCharacters(text, true)
  )
    throw new Error('Enrollment note requires bounded plain text');
  if (
    typeof requestKey !== 'string' ||
    !requestKey.trim() ||
    requestKey.length > 200 ||
    hasControlCharacters(requestKey, false)
  )
    throw new Error('Enrollment note requires a bounded request key');
}

/** Private guardian annotations, separate from learning and assessment history. */
@TenantScoped({ mode: 'required' })
@smrt({
  api: false,
  mcp: false,
  cli: false,
  tableName: 'enrollment_parent_notes',
  conflictColumns: ['tenant_id', 'enrollment_id', 'request_key'],
})
export class EnrollmentParentNote extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  authorUserId = '';
  authorLabel = 'Parent';
  text = '';
  requestKey = '';
  recordedAt = new Date();

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options)) {
      if (Object.hasOwn(this, key))
        (this as unknown as Record<string, unknown>)[key] = value;
    }
  }

  override async delete(): Promise<void> {
    throw new Error('Enrollment parent notes are immutable');
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Enrollment parent notes are immutable');
    validateEnrollmentNote(this.text, this.requestKey);
    if (
      !this.tenantId ||
      !this.authorUserId ||
      typeof this.authorLabel !== 'string' ||
      !this.authorLabel.trim() ||
      this.authorLabel.length > 200 ||
      !(this.recordedAt instanceof Date) ||
      !Number.isFinite(this.recordedAt.getTime()) ||
      !(await this.db.get('enrollments', {
        id: this.enrollmentId,
        learner_id: this.learnerId,
        tenant_id: this.tenantId,
      })) ||
      !(await this.db.get('memberships', {
        user_id: this.authorUserId,
        tenant_id: this.tenantId,
        status: 'active',
      }))
    )
      throw new Error('Enrollment note ownership mismatch');
    // Conflict keys must never turn a second creation into a history rewrite.
    this.requireInsertOnSave();
    return super.save(options);
  }
}

export class EnrollmentParentNoteCollection extends SmrtCollection<EnrollmentParentNote> {
  static readonly _itemClass = EnrollmentParentNote;
}
