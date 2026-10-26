import type { WorkbookActivityView } from './workbook-contracts.js';
/** Activity keys identify a printed lesson, potentially spanning multiple pages. */
export interface WorkbookPhotoIdentification {
  kind: 'lesson' | 'cover' | 'reference' | 'uncertain';
  workbook?: {
    workbookKey: string;
    title: string;
    edition?: string;
    publisher?: string;
    isbn?: string;
  };
  activity?: { pageKey: string; pageLabel: string };
  workState?: 'blank' | 'completed' | 'unknown';
  notes?: string;
}
export interface WorkbookPhotoProposal {
  identification: WorkbookPhotoIdentification;
  confidence: 'confident' | 'uncertain';
  /** Exact visible printed identity quotations; absence cannot imply certainty. */
  identityEvidence: string[];
  /** A printed lesson/exercise identifier, never the page number alone. */
  lessonEvidence: string;
  /** Optional exact existing workbook candidate selected from authorized discovery. */
  workbookId?: string;
}
export interface WorkbookPhotoIntakeView {
  id: string;
  itemId: string;
  learnerId: string;
  status: 'pending' | 'resolved' | 'captured';
  identification: WorkbookPhotoIdentification | null;
  proposal: WorkbookPhotoProposal | null;
  activity: WorkbookActivityView | null;
  submissionId: string | null;
  originals: {
    assetId: string;
    name: string;
    mimeType: string;
    sha256: string;
  }[];
}
export function validateWorkbookPhotoIdentification(
  value: WorkbookPhotoIdentification,
): void {
  const text = (x: unknown, required = false, maximum = 200) =>
    typeof x === 'string' && x.length <= maximum && (!required || !!x.trim());
  if (
    !value ||
    !['lesson', 'cover', 'reference', 'uncertain'].includes(value.kind) ||
    (value.workState !== undefined &&
      !['blank', 'completed', 'unknown'].includes(value.workState)) ||
    (value.notes !== undefined && !text(value.notes, false, 2000))
  )
    throw new Error('Invalid photo identification');
  if (
    value.kind !== 'uncertain' &&
    (!value.workbook ||
      !text(value.workbook.workbookKey, true) ||
      !text(value.workbook.title, true))
  )
    throw new Error('Workbook identity required');
  if (
    value.workbook &&
    Object.values(value.workbook).some((x) => x !== undefined && !text(x))
  )
    throw new Error('Invalid workbook metadata');
  if (
    value.kind === 'lesson' &&
    (!value.activity ||
      !text(value.activity.pageKey, true) ||
      !text(value.activity.pageLabel, true))
  )
    throw new Error('Explicit lesson identity required');
  if (value.kind !== 'lesson' && value.activity)
    throw new Error('Context material cannot name an activity');
}

export interface WorkbookPhotoWorkbookView {
  id: string;
  workbookKey: string;
  title: string;
  edition: string;
  publisher?: string;
  isbn?: string;
}
