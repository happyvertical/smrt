import type { IntakeEvidenceDTO, IntakeFailure } from './dto.js';

export interface ExtractionLimits {
  maxBytes: number;
  maxPages: number;
  maxPixels: number;
  maxOutputBytes: number;
  timeoutMs: number;
  maxTokens: number;
  workerHeapMb: number;
}
export interface ProviderIdentity {
  provider: string;
  model: string;
  version: string;
}
export type EvidenceLocation =
  | { kind: 'source' }
  | { kind: 'page'; page: number }
  | { kind: 'pages'; startPage: number; endPage: number }
  | { kind: 'time'; startMs: number; endMs: number };
export interface ExtractionSegment {
  text: string;
  location: EvidenceLocation;
  confidence: { value: number; scale: '0-1'; calibration: 'unknown' } | null;
  boxes: Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> | null;
  provenance: ProviderIdentity;
  kind: 'text' | 'transcript' | 'observation';
}
export interface ExtractionResult {
  status: 'complete' | 'partial' | 'failed' | 'unsupported';
  evidence: IntakeEvidenceDTO;
  configurationRevision: string;
  options: {
    imageMode: 'ocr' | 'vision';
    pdfOCRFallback: 'empty-page';
    ocrOutputFormat: 'json';
  };
  limits: ExtractionLimits;
  segments: ExtractionSegment[];
  /** Full provider transcript when timed segments are also returned. */
  transcriptText?: string;
  capabilities: Array<
    ProviderIdentity & {
      confidence: boolean;
      boxes: boolean;
      location: 'source' | 'page' | 'time';
      /** Whether the SDK exposed upstream completion/usage metadata. */
      truncation: 'unknown' | 'reported';
      usage: 'unknown' | 'reported';
    }
  >;
  errors: Array<{ category: IntakeFailure; location: EvidenceLocation }>;
  omitted: EvidenceLocation[];
  truncated: boolean;
  usage: Record<string, number>;
  /** Extraction is evidence, never an approval or automatic-action grant. */
  automaticActionEligible: false;
}
export interface ExtractionRequest {
  evidence: IntakeEvidenceDTO;
  bytes: Uint8Array;
  limits: ExtractionLimits;
  configurationRevision: string;
  signal?: AbortSignal;
  /** Trusted parent authorization; adapters must await before every provider call. */
  beforeProviderCall?: () => Promise<void>;
}
export interface ExtractionAdapter {
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
}
export function validLimits(limits: ExtractionLimits): boolean {
  return (
    [
      'maxBytes',
      'maxPages',
      'maxPixels',
      'maxOutputBytes',
      'timeoutMs',
      'maxTokens',
      'workerHeapMb',
    ].every(
      (key) =>
        Number.isSafeInteger(limits[key as keyof ExtractionLimits]) &&
        limits[key as keyof ExtractionLimits] > 0,
    ) &&
    limits.workerHeapMb >= 16 &&
    limits.workerHeapMb <= 4096 &&
    limits.timeoutMs <= 2_147_483_647
  );
}
