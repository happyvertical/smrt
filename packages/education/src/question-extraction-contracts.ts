/**
 * Closed contracts for extracting structured questions from scanned worksheets
 * and imported course files (SMRT #4517). Pure types, limits and typed errors;
 * no I/O. See `agents/question-extraction.md`.
 */
import { CourseAuthoringError } from './course-authoring-contracts.js';
import type {
  QuestionChoice,
  QuestionResponseType,
  QuestionRubric,
} from './question-contracts.js';

export const QUESTION_EXTRACTION_VERSION = 1 as const;
export type QuestionExtractionSourceKind = 'worksheet_scan' | 'course_import';
export const QUESTION_EXTRACTION_SOURCE_KINDS: readonly QuestionExtractionSourceKind[] =
  ['worksheet_scan', 'course_import'];
/** What a source page is. Only `exercise`/`mixed` pages yield question records. */
export type ExtractedPageRole =
  | 'exercise'
  | 'example'
  | 'instructions'
  | 'cover'
  | 'answer_key'
  | 'mixed'
  | 'unknown';
export const EXTRACTED_PAGE_ROLES: readonly ExtractedPageRole[] = [
  'exercise',
  'example',
  'instructions',
  'cover',
  'answer_key',
  'mixed',
  'unknown',
];
export type ExtractedReadability =
  | 'readable'
  | 'partial'
  | 'unreadable'
  | 'unsupported';
export const EXTRACTED_READABILITY: readonly ExtractedReadability[] = [
  'readable',
  'partial',
  'unreadable',
  'unsupported',
];
/** `complete` and `partial` items carry a printed prompt; the others do not. */
export type ExtractedQuestionStatus =
  | 'complete'
  | 'partial'
  | 'unreadable'
  | 'unsupported';
export const EXTRACTED_QUESTION_STATUSES: readonly ExtractedQuestionStatus[] = [
  'complete',
  'partial',
  'unreadable',
  'unsupported',
];
/** Printed in the source, or inferred by the extractor. Never mixed up. */
export type ExtractedOrigin = 'source' | 'inferred';
export const EXTRACTED_ORIGINS: readonly ExtractedOrigin[] = [
  'source',
  'inferred',
];
export type ExtractedMediaKind =
  | 'diagram'
  | 'image'
  | 'table'
  | 'graph'
  | 'other';
export const EXTRACTED_MEDIA_KINDS: readonly ExtractedMediaKind[] = [
  'diagram',
  'image',
  'table',
  'graph',
  'other',
];
export type ExtractedLegibility = 'legible' | 'partial' | 'illegible';
export const EXTRACTED_LEGIBILITY: readonly ExtractedLegibility[] = [
  'legible',
  'partial',
  'illegible',
];
export type ExtractedOmissionReason =
  | 'unreadable'
  | 'unsupported'
  | 'out_of_scope'
  /** Ingestion did not extract it (truncated output or a failed page). */
  | 'not_extracted';
export const EXTRACTED_OMISSION_REASONS: readonly ExtractedOmissionReason[] = [
  'unreadable',
  'unsupported',
  'out_of_scope',
  'not_extracted',
];

/** Source anchor as cited by the extractor: evidence, physical page, region id. */
export interface ExtractedAnchorInput {
  evidenceId: string;
  /** Physical 1-based source page; null when unknown. Printed page numbers are not pages. */
  page: number | null;
  /** Id from the evidence's observedRegions catalog; never a coordinate. */
  regionId: string | null;
}
/** A cited anchor resolved against retained evidence. `rect` only comes from the catalog. */
export interface ExtractedAnchor extends ExtractedAnchorInput {
  sha256: string;
  /** Normalized x, y, width, height from the provider's region catalog, else null. */
  rect: [number, number, number, number] | null;
}

export interface ExtractedPage {
  evidenceId: string;
  page: number | null;
  role: ExtractedPageRole;
  readability: ExtractedReadability;
}
export interface ExtractedSection {
  id: string;
  label: string | null;
  evidenceId: string;
  page: number | null;
}
export interface ExtractedMediaRef<A = ExtractedAnchor> {
  kind: ExtractedMediaKind;
  description: string;
  anchor: A | null;
}
export interface ExtractedAnswerKey {
  acceptedAnswers?: string[];
  correctChoiceIds?: string[];
  numeric?: number;
  origin: ExtractedOrigin;
}
export interface ExtractedQuestion<A = ExtractedAnchor> {
  /** Stable per-source key: printed numbering path, or `u:<slug>:<occurrence>`. */
  key: string;
  /** Numbering exactly as printed (`3`, `3b`, `Q4`); null when unnumbered. */
  numbering: string | null;
  /** Worked examples are kept as extracted items but never become question records. */
  role: 'exercise' | 'example';
  sectionId: string | null;
  status: ExtractedQuestionStatus;
  /** Printed task text only; never learner handwriting. Null when unreadable. */
  prompt: string | null;
  responseType: QuestionResponseType | null;
  responseTypeOrigin: ExtractedOrigin;
  choices: QuestionChoice[];
  subparts: Array<{ partKey: string; prompt: string }>;
  media: ExtractedMediaRef<A>[];
  answerKey: ExtractedAnswerKey | null;
  rubric: (QuestionRubric & { origin: ExtractedOrigin }) | null;
  pointsPossible: number | null;
  pointsOrigin: ExtractedOrigin | null;
  anchors: A[];
}
/** Observed learner work, kept apart from printed questions. */
export interface ExtractedStudentWork<A = ExtractedAnchor> {
  /** The printed question this work answers, when visibly associated. */
  questionKey: string | null;
  /** Transcribed response; null when illegible. Never a solved or expected answer. */
  observed: string | null;
  legibility: ExtractedLegibility;
  anchors: A[];
}
export interface ExtractedOmission {
  evidenceId: string;
  page: number | null;
  reason: ExtractedOmissionReason;
  description: string;
}

/** The handler arguments a proposal generator fills (closed; see the schema). */
export interface QuestionExtractionInput {
  version: 1;
  sourceKind: QuestionExtractionSourceKind;
  /** Worksheet version id printed on the page (generated printables print it); else null. */
  worksheetVersionId: string | null;
  pages: ExtractedPage[];
  sections: ExtractedSection[];
  questions: ExtractedQuestion<ExtractedAnchorInput>[];
  studentWork: ExtractedStudentWork<ExtractedAnchorInput>[];
  omissions: ExtractedOmission[];
}
/** Validated extraction with anchors resolved against retained evidence. */
export interface QuestionExtraction
  extends Omit<QuestionExtractionInput, 'questions' | 'studentWork'> {
  questions: ExtractedQuestion[];
  studentWork: ExtractedStudentWork[];
  /**
   * Source completeness codes from ingestion (for example `source_incomplete`).
   * Non-empty means the extraction was made from partial input: review it as such.
   */
  sourceWarnings: string[];
}

/** Retained evidence an extraction may cite, from one completed ingestion analysis. */
export interface QuestionExtractionGrounding {
  version: 1;
  extractionAttemptId: string;
  /** Bounded ingestion warning codes (`^[a-z][a-z0-9_.-]{0,47}$`), carried to the review. */
  warnings?: string[];
  sources: Array<{
    evidenceId: string;
    sha256: string;
    mediaType: string;
    /** Known physical pages (extracted and omitted); empty for single images and page-less sources. */
    pages: number[];
    /** Pages ingestion reported but did not extract (truncated or failed). */
    omittedPages?: number[];
    /** False when ingestion produced no result for this original at all. */
    extracted?: boolean;
    /** True when ingestion reported truncation or errors for this original. */
    incomplete?: boolean;
    observedRegions?: {
      version: 1;
      coordinateSpace: 'display-oriented';
      regions: Array<{
        id: string;
        text: string;
        rect: [number, number, number, number];
      }>;
    };
  }>;
}

/** Extractor identity recorded with the preserved extraction. */
export interface QuestionExtractorIdentity {
  provider: string;
  model: string;
  version: string;
  /** Ingestion configuration/prompt versions that produced the proposal, when known. */
  configurationVersion?: string;
  promptVersion?: string;
}

// -- matching ---------------------------------------------------------------

export type QuestionMatchOutcome = 'matched' | 'ambiguous' | 'unmatched';
export type QuestionMatchReason =
  | 'worksheet_position'
  | 'no_worksheet_identifier'
  | 'unknown_worksheet'
  | 'worksheet_conflict'
  | 'no_layout_position'
  | 'position_not_on_worksheet'
  | 'layout_conflict'
  | 'duplicate_position'
  | 'not_an_exercise';
export interface QuestionMatch {
  key: string;
  outcome: QuestionMatchOutcome;
  reason: QuestionMatchReason;
  /** Set only for `matched`; ambiguous matches are never attached. */
  questionId: string | null;
  questionRevisionId: string | null;
  ordinal: number | null;
}
export interface QuestionExtractionMatch {
  worksheetVersionId: string | null;
  /** Where the worksheet identity came from; observed on the page or supplied by the host. */
  worksheetSource: 'observed' | 'expected' | null;
  worksheetKnown: boolean;
  questions: QuestionMatch[];
}

// -- service views ----------------------------------------------------------

export type ExtractedQuestionOutcome =
  | 'created'
  | 'replayed'
  | 'matched'
  | 'needs_review'
  | 'source_changed'
  | 'invalid_content'
  | 'unreadable'
  | 'unsupported'
  | 'not_an_exercise';
export interface ExtractedQuestionResult {
  key: string;
  outcome: ExtractedQuestionOutcome;
  questionId: string | null;
  questionRevisionId: string | null;
}
export interface StudentWorkView extends ExtractedStudentWork {
  /** The matched question revision this work belongs to; null unless matched. */
  questionRevisionId: string | null;
}
export interface QuestionExtractionView {
  extractionId: string;
  intakeItemId: string;
  analysisAttemptId: string;
  /** Digest of source kind and retained evidence hashes: the idempotency identity. */
  sourceIdentity: string;
  extractor: QuestionExtractorIdentity;
  extraction: QuestionExtraction;
  match: QuestionExtractionMatch;
  studentWork: StudentWorkView[];
  /** Set once applied: the per-question outcome. Null while pending review. */
  applied: ExtractedQuestionResult[] | null;
}

// -- limits -----------------------------------------------------------------

export const MAX_EXTRACTED_QUESTIONS = 200;
export const MAX_EXTRACTED_SECTIONS = 64;
export const MAX_EXTRACTED_PAGES = 1000;
export const MAX_EXTRACTED_STUDENT_WORK = 400;
export const MAX_EXTRACTED_OMISSIONS = 200;
export const MAX_EXTRACTED_ANCHORS = 8;
export const MAX_EXTRACTED_TEXT = 20_000;

// -- errors -----------------------------------------------------------------

/** The extraction does not fit the closed contract or its retained evidence. */
export class QuestionExtractionValidationError extends CourseAuthoringError {
  constructor(message: string) {
    super('question-extraction-invalid', message);
  }
}
/** No preserved extraction with this id in the tenant (foreign is alike). */
export class QuestionExtractionNotFoundError extends CourseAuthoringError {
  constructor() {
    super(
      'question-extraction-not-found',
      'Question extraction was not found.',
    );
  }
}
/** The ingestion analysis is not a completed question-extraction proposal yet. */
export class QuestionExtractionPendingError extends CourseAuthoringError {
  constructor(readonly reason: 'pending' | 'no_proposal' | 'ambiguous') {
    super(
      'question-extraction-pending',
      'No reviewable question extraction is available for this intake.',
    );
  }
}
