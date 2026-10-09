import { createHash } from 'node:crypto';
import type {
  ExtractionAdapter,
  ExtractionLimits,
  ExtractionRequest,
} from '../src/extraction-types.js';
import { type BudgetLedger, tokenChargeBound } from './budget.mjs';

export const EXTRACTION_CHARGE_BOUNDS = Object.freeze({
  ocr: tokenChargeBound({
    inputTokens: 4096 + 512 + 1230,
    outputTokens: 4096,
    inputNanoUSD: 750,
    outputNanoUSD: 4500,
  }),
  speech: tokenChargeBound({
    inputTokens: 16000,
    outputTokens: 2000,
    inputNanoUSD: 1250,
    outputNanoUSD: 5000,
  }),
});

export interface FrozenExtractionCall {
  callId: string;
  runHash: string;
  profileDigest: string;
  source: {
    sha256: string;
    mediaType: string;
    byteLength: number;
    durationSeconds?: number;
  };
  configurationRevision: string;
  limits: ExtractionLimits;
}
const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
function verifySource(
  request: ExtractionRequest,
  frozen: FrozenExtractionCall,
): 'ocr' | 'speech' | 'pdf' | 'text' {
  const bytes = Buffer.from(request.bytes);
  const source = frozen.source;
  if (
    !/^[a-f0-9]{64}$/.test(frozen.profileDigest) ||
    bytes.length > 1000000 ||
    bytes.length !== source.byteLength ||
    request.evidence.byteLength !== source.byteLength ||
    hash(bytes) !== source.sha256 ||
    request.evidence.contentHash !== source.sha256 ||
    request.evidence.mediaType !== source.mediaType ||
    request.configurationRevision !== frozen.configurationRevision ||
    JSON.stringify(request.limits) !== JSON.stringify(frozen.limits)
  )
    throw Error('Frozen extraction profile mismatch');
  if (source.mediaType === 'image/png') {
    if (
      bytes.length < 33 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== 1000 ||
      bytes.readUInt32BE(20) !== 1000
    )
      throw Error('Image outside frozen token bound');
    return 'ocr';
  }
  if (source.mediaType === 'audio/wav') {
    if (
      bytes.length < 44 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
      bytes.readUInt32LE(16) !== 16 ||
      bytes.readUInt16LE(20) !== 1 ||
      bytes.readUInt16LE(22) !== 1 ||
      bytes.readUInt32LE(4) !== bytes.length - 8 ||
      bytes.readUInt32LE(24) < 1 ||
      bytes.readUInt32LE(24) > 48000 ||
      bytes.readUInt32LE(28) !== bytes.readUInt32LE(24) * 2 ||
      bytes.readUInt16LE(32) !== 2 ||
      bytes.readUInt16LE(34) !== 16 ||
      bytes.toString('ascii', 36, 40) !== 'data' ||
      bytes.readUInt32LE(40) !== bytes.length - 44
    )
      throw Error('Audio outside frozen PCM profile');
    const duration = bytes.readUInt32LE(40) / bytes.readUInt32LE(28);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 30 ||
      duration !== source.durationSeconds
    )
      throw Error('Audio outside frozen duration bound');
    return 'speech';
  }
  if (source.mediaType === 'application/pdf') return 'pdf';
  if (
    source.mediaType === 'text/plain' ||
    source.mediaType === 'application/json'
  )
    return 'text';
  throw Error('Unbudgeted extraction media');
}
/** Wrap only the frozen owning SDK configuration: PNG pinned single OCR, WAV
 * pinned single JSON transcription/retry:false, PDF unpdf-only (no OCR fallback).
 * Host isolation/configuration proof remains required; this wrapper grants none.
 */
export function budgetExtractionAdapter(
  adapter: ExtractionAdapter,
  ledger: BudgetLedger,
  configuration: FrozenExtractionCall,
): ExtractionAdapter {
  const frozen = structuredClone(configuration);
  return {
    async extract(input) {
      const request = {
        ...input,
        bytes: Uint8Array.from(input.bytes),
        evidence: structuredClone(input.evidence),
        limits: structuredClone(input.limits),
      };
      const route = verifySource(request, frozen);
      if (!request.beforeProviderCall)
        throw Error('Live owning authority callback required');
      const authority = request.beforeProviderCall;
      let handshakes = 0,
        reserved = false,
        active = true;
      const maximum =
        route === 'ocr'
          ? 2
          : route === 'pdf'
            ? 2 + 2 * frozen.limits.maxPages
            : 1;
      try {
        return await adapter.extract({
          ...request,
          beforeProviderCall: async () => {
            // Count before awaiting to deny concurrent/repeated handshakes as well.
            const boundary = ++handshakes;
            if (!active || boundary > maximum || route === 'text')
              throw Error('Repeated or unbudgeted provider invocation');
            await authority();
            if (!active) throw Error('Extraction invocation already ended');
            if (route === 'pdf') return; // Pinned local unpdf only; never a paid fallback.
            if (boundary > 1) {
              if (!reserved) throw Error('Provider reservation is not ready');
              return;
            }
            ledger.reserve({
              id: frozen.callId,
              runHash: frozen.runHash,
              stage: route,
              requestHash: hash(
                JSON.stringify({
                  source: frozen.source,
                  profile: frozen.profileDigest,
                  limits: frozen.limits,
                  configurationRevision: frozen.configurationRevision,
                }),
              ),
              maximumCharge: EXTRACTION_CHARGE_BOUNDS[route],
            });
            reserved = true;
          },
        });
      } finally {
        active = false;
        if (reserved) ledger.unknown(frozen.callId);
      }
    },
  };
}
