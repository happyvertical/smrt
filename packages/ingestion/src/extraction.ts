import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GetAIOptions } from '@happyvertical/ai';
import type { PDFReaderOptions } from '@happyvertical/pdf';
import type { GetTranscriberOptions } from '@happyvertical/speech';
import type { AnalysisOutput } from './dto.js';
import {
  ExtractionFailure,
  emptyExtraction,
  validateExtractionRequest,
} from './extraction-providers.js';
import type {
  ExtractionAdapter,
  ExtractionRequest,
  ExtractionResult,
  ProviderIdentity,
} from './extraction-types.js';
import { providerIdentity } from './extraction-types.js';
import type { AnalysisLease, IngestionService } from './server.js';

export type * from './extraction-types.js';

/** Trusted server configuration. Credentials never enter analysis provenance. */
export interface ExtractionSDKConfiguration {
  pdf?: {
    provider: NonNullable<PDFReaderOptions['provider']>;
    identity: ProviderIdentity;
  };
  ocr?: { identity: ProviderIdentity; options?: Record<string, unknown> };
  speech?: { identity: ProviderIdentity; options: GetTranscriberOptions };
  vision?: { identity: ProviderIdentity; options: GetAIOptions };
  imageMode?: 'ocr' | 'vision';
  /** Maximum concurrent child processes for this adapter instance (default 1). */
  maxConcurrentProcesses?: number;
  /** The deployment enforces a native-memory ceiling outside Node (e.g. container).
   * Required for native decoders: Node's heap cap does not bound native allocation. */
  nativeMemoryIsolation: 'host-enforced';
}

/** Production adapter: bounded per-evidence child, terminated on deadline/abort. */
export function createSDKExtractionAdapter(
  configuration: ExtractionSDKConfiguration,
): ExtractionAdapter {
  try {
    configuration = structuredClone(configuration);
  } catch {
    throw new Error('Serializable SDK configuration required');
  }
  const maximum = configuration.maxConcurrentProcesses ?? 1;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
    throw new Error('Invalid extraction concurrency');
  let running = 0;
  if (configuration.nativeMemoryIsolation !== 'host-enforced')
    throw new Error('Native memory isolation is required');
  for (const provider of [
    configuration.pdf,
    configuration.ocr,
    configuration.speech,
    configuration.vision,
  ]) {
    if (provider) provider.identity = providerIdentity(provider.identity);
  }
  if (
    configuration.pdf?.provider === 'auto' ||
    configuration.ocr?.identity.provider === 'auto'
  )
    throw new Error('Pin extraction providers');
  return {
    async extract(request) {
      let latest = emptyExtraction(request);
      try {
        validateExtractionRequest(request);
      } catch (caught) {
        if (!(caught instanceof ExtractionFailure)) throw caught;
        latest.errors.push({
          category: caught.category,
          location: { kind: 'source' },
        });
        return latest;
      }
      if (request.evidence.mediaType.toLowerCase().startsWith('video/')) {
        latest.status = 'unsupported';
        latest.errors.push({
          category: 'unsupported_type',
          location: { kind: 'source' },
        });
        return latest;
      }
      if (request.signal?.aborted) {
        latest.errors.push({
          category: 'cancelled',
          location: { kind: 'source' },
        });
        return latest;
      }
      if (running >= maximum) {
        latest.errors.push({ category: 'limit', location: { kind: 'source' } });
        return latest;
      }
      running++;
      return new Promise<ExtractionResult>((resolve) => {
        // A public entry can move shared code into chunks; resolve without loading it.
        const child = fork(
          join(
            dirname(
              fileURLToPath(
                import.meta.resolve('@happyvertical/smrt-ingestion/server'),
              ),
            ),
            'extraction-worker.js',
          ),
          [],
          {
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            execArgv: [`--max-old-space-size=${request.limits.workerHeapMb}`],
            detached: process.platform !== 'win32',
          },
        );
        let done = false;
        const stop = () => {
          try {
            if (process.platform !== 'win32' && child.pid)
              process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const finish = (
          category?: 'timeout' | 'cancelled' | 'unavailable' | 'limit',
        ) => {
          if (done) return;
          done = true;
          running--;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', abort);
          stop();
          if (category) {
            latest.errors.push({ category, location: { kind: 'source' } });
            latest.status = latest.segments.length ? 'partial' : 'failed';
            latest.truncated = true;
            latest.omitted.push({ kind: 'source' });
          }
          resolve(latest);
        };
        const abort = () => finish('cancelled');
        const timer = setTimeout(
          () => finish('timeout'),
          request.limits.timeoutMs,
        );
        request.signal?.addEventListener('abort', abort, { once: true });
        child.on('error', () => finish('unavailable'));
        child.on('exit', () => {
          if (!done) finish('unavailable');
        });
        child.on(
          'message',
          async (message: {
            kind: string;
            id?: number;
            result?: ExtractionResult;
          }) => {
            if (done) return;
            if (
              message.kind === 'authorize' &&
              Number.isSafeInteger(message.id)
            ) {
              try {
                await request.beforeProviderCall?.();
                if (!done) child.send({ kind: 'authorized', id: message.id });
              } catch {
                finish('cancelled');
              }
              return;
            }
            if (
              (message.kind === 'progress' || message.kind === 'result') &&
              message.result
            ) {
              // The child is our trusted normalizer; bound serialized IPC output as well.
              if (
                Buffer.byteLength(JSON.stringify(message.result)) >
                request.limits.maxOutputBytes + 65536
              )
                return finish('limit');
              latest = message.result;
              if (message.kind === 'result') finish();
            } else finish('unavailable');
          },
        );
        const {
          signal: _signal,
          beforeProviderCall: _authorize,
          ...wireRequest
        } = request;
        child.send({ request: wireRequest, configuration }, (error) => {
          if (error) finish('unavailable');
        });
        if (request.signal?.aborted) abort();
      });
    },
  };
}

function validateAndNormalizeExtractionOutput(
  result: ExtractionResult,
  request: ExtractionRequest,
): void {
  const numeric = (value: number) => Number.isFinite(value) && value >= 0;
  const location = (
    value: ExtractionResult['segments'][number]['location'],
  ) => {
    if (!value || typeof value !== 'object') return false;
    if (value.kind === 'source') return true;
    if (value.kind === 'page')
      return Number.isSafeInteger(value.page) && value.page > 0;
    if (value.kind === 'pages')
      return (
        Number.isSafeInteger(value.startPage) &&
        value.startPage > 0 &&
        Number.isSafeInteger(value.endPage) &&
        value.endPage >= value.startPage
      );
    return (
      value.kind === 'time' &&
      numeric(value.startMs) &&
      numeric(value.endMs) &&
      value.endMs >= value.startMs
    );
  };
  if (
    !result ||
    !['complete', 'partial', 'failed', 'unsupported'].includes(result.status) ||
    result.automaticActionEligible !== false ||
    result.configurationRevision !== request.configurationRevision ||
    !result.evidence ||
    Object.entries(request.evidence).some(
      ([key, value]) =>
        result.evidence[key as keyof typeof result.evidence] !== value,
    ) ||
    typeof result.truncated !== 'boolean' ||
    !Array.isArray(result.capabilities) ||
    result.capabilities.some(
      (capability) =>
        !capability ||
        typeof capability.confidence !== 'boolean' ||
        typeof capability.boxes !== 'boolean' ||
        !['source', 'page', 'time'].includes(capability.location) ||
        !['unknown', 'reported'].includes(capability.truncation) ||
        !['unknown', 'reported'].includes(capability.usage),
    ) ||
    !result.limits ||
    Object.entries(request.limits).some(
      ([key, value]) =>
        result.limits[key as keyof typeof result.limits] !== value,
    ) ||
    !Array.isArray(result.segments) ||
    !Array.isArray(result.errors) ||
    !Array.isArray(result.omitted) ||
    (result.status === 'complete' &&
      (result.truncated ||
        result.errors.length > 0 ||
        result.omitted.length > 0)) ||
    result.omitted.some((value) => !location(value)) ||
    result.segments.some(
      (segment) =>
        typeof segment.text !== 'string' ||
        !location(segment.location) ||
        segment.location.kind === 'pages' ||
        (segment.provenance?.provider === 'unlimited-ocr' &&
          (segment.confidence !== null || segment.boxes !== null)) ||
        !segment.provenance ||
        [
          segment.provenance.provider,
          segment.provenance.model,
          segment.provenance.version,
        ].some((value) => typeof value !== 'string' || !value) ||
        (segment.confidence !== null &&
          (!segment.confidence ||
            !numeric(segment.confidence.value) ||
            segment.confidence.value > 1 ||
            segment.confidence.scale !== '0-1' ||
            segment.confidence.calibration !== 'unknown')) ||
        (segment.boxes !== null &&
          (!Array.isArray(segment.boxes) ||
            segment.boxes.some(
              (box) =>
                typeof box.text !== 'string' ||
                ![box.x, box.y, box.width, box.height].every(numeric),
            ))),
    ) ||
    result.errors.some(
      (error) =>
        ![
          'unsupported_type',
          'malformed_output',
          'limit',
          'timeout',
          'unavailable',
          'authentication',
          'cancelled',
          'integrity',
        ].includes(error.category) || !location(error.location),
    ) ||
    !result.usage ||
    Object.values(result.usage).some((value) => !numeric(value))
  )
    throw new Error('Invalid extraction output');
  // Structural typing permits extra host fields. Never persist them as identity.
  for (const segment of result.segments)
    segment.provenance = providerIdentity(segment.provenance);
  result.capabilities = result.capabilities.map((capability) => ({
    ...providerIdentity(capability),
    confidence: capability.confidence,
    boxes: capability.boxes,
    location: capability.location,
    truncation: capability.truncation,
    usage: capability.usage,
  }));
}

/** Current access is rechecked on read and fenced publication by the foundation.
 * The host already allocated the immutable input/config revision and lease. */
export async function extractAnalysis(
  service: IngestionService,
  lease: AnalysisLease,
  adapter: ExtractionAdapter,
  options: Pick<
    ExtractionRequest,
    'limits' | 'configurationRevision' | 'signal'
  >,
): Promise<boolean> {
  const snapshot = await service.getAnalysisInput(lease);
  const persisted = snapshot.configuration.extraction as
    | { configurationRevision?: unknown; limits?: Record<string, unknown> }
    | undefined;
  if (
    !persisted ||
    persisted.configurationRevision !== options.configurationRevision ||
    !persisted.limits ||
    Object.keys(options.limits).some(
      (key) =>
        persisted.limits?.[key] !==
        options.limits[key as keyof typeof options.limits],
    ) ||
    Object.keys(persisted.limits).length !== Object.keys(options.limits).length
  )
    throw new Error('Extraction configuration mismatch');
  const evidence = snapshot.evidence;
  const boundOptions = { ...options, limits: structuredClone(options.limits) };
  const results: ExtractionResult[] = [];
  let limited = false;
  const publication = (reserve = false): AnalysisOutput => {
    const allComplete =
      !limited &&
      results.length === evidence.length &&
      results.every((result) => result.status === 'complete');
    const firstError =
      limited || reserve
        ? 'limit'
        : results.flatMap((result) => result.errors)[0]?.category;
    return {
      status: reserve
        ? 'needs_attention'
        : allComplete
          ? 'completed'
          : results.some((result) => result.segments.length)
            ? 'partial'
            : 'needs_attention',
      provider: 'smrt-ingestion-extraction',
      model: 'none',
      version: '1',
      output: {
        configurationRevision: options.configurationRevision,
        results,
        ...(limited || reserve
          ? {
              truncated: true,
              omittedEvidenceCount: evidence.length - results.length,
            }
          : {}),
      },
      usage: {},
      ...(firstError ? { error: firstError } : {}),
    };
  };
  // Canonical persistence sorts keys but uses identical JSON value encoding/size.
  const fits = (output: AnalysisOutput) =>
    Buffer.byteLength(JSON.stringify(output)) <= snapshot.maxOutputBytes;
  const minimum: AnalysisOutput = {
    status: 'needs_attention',
    provider: 'smrt-ingestion-extraction',
    model: 'none',
    version: '1',
    output: {},
    usage: {},
    error: 'limit',
  };
  if (!fits(minimum)) return service.failAnalysis(lease, 'limit');
  if (!fits(publication(true))) return service.completeAnalysis(lease, minimum);
  for (const part of evidence) {
    await service.getAnalysisInput(lease);
    const bytes = await service.readEvidence(lease.itemId, part.id);
    await service.getAnalysisInput(lease);
    const request = { ...boundOptions, evidence: part, bytes };
    const result = await adapter.extract({
      ...request,
      evidence: { ...part },
      limits: { ...request.limits },
      bytes: bytes.slice(),
      beforeProviderCall: async () => {
        await service.getAnalysisInput(lease);
      },
    });
    validateAndNormalizeExtractionOutput(result, request);
    results.push(result);
    if (!fits(publication(true))) {
      limited = true;
      // Preserve earlier parts and the largest prefix of complete segments that fits.
      result.status = 'partial';
      result.truncated = true;
      result.errors.push({ category: 'limit', location: { kind: 'source' } });
      while (result.segments.length && !fits(publication(true))) {
        const removed = result.segments.pop();
        if (removed) result.omitted.push(removed.location);
      }
      // Diagnostics are indivisible: omit this result rather than erase known gaps.
      if (!fits(publication(true))) results.pop();
    }
    // Revalidation after an external call prevents returning/publishing revoked evidence.
    await service.getAnalysisInput(lease);
    if (limited || options.signal?.aborted) break;
  }
  return service.completeAnalysis(lease, publication());
}

/** Side-effect-free, versioned split proposal. Original evidence is not replaced. */
export function proposeDocumentSplits(
  result: ExtractionResult,
  revision: number,
  groups: number[][],
) {
  if (!Number.isSafeInteger(revision) || revision < 1 || !groups.length)
    throw new Error('Invalid split revision');
  const available = new Set(
    result.segments.flatMap((segment) =>
      segment.location.kind === 'page' ? [segment.location.page] : [],
    ),
  );
  const seen = new Set<number>();
  for (const group of groups) {
    if (!group.length) throw new Error('Empty split');
    for (const page of group) {
      if (!Number.isSafeInteger(page) || !available.has(page) || seen.has(page))
        throw new Error('Invalid split page');
      seen.add(page);
    }
    if (group.some((page, index) => index > 0 && page <= group[index - 1]))
      throw new Error('Unordered split');
  }
  const proposal = {
    revision,
    evidenceId: result.evidence.id,
    inputHash: result.evidence.contentHash,
    configurationRevision: result.configurationRevision,
    groups: groups.map((pages) => ({ pages: [...pages] })),
    status: 'proposed' as const,
  };
  return {
    ...proposal,
    digest: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),
  };
}
