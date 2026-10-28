/** Public family receipt bridge; transport source identity never supplies authority. */
import { createHash } from 'node:crypto';
import type {
  IngestionScope,
  IngestionService,
  ReceiveInput,
} from '@happyvertical/smrt-ingestion/server';
import {
  type FamilyIntakeRequest,
  familyIntakeScopeId,
} from './family-intake-contracts.js';
import type { FamilyIntakeService } from './family-intake-service.js';
import type { SubmissionPage } from './submission-service.js';

type Input = {
  ingestion: IngestionService;
  scope: Readonly<IngestionScope>;
  family: FamilyIntakeService;
  request: FamilyIntakeRequest;
};
function assertScope(input: Input) {
  if (
    input.scope.tenantId !== input.request.tenantId ||
    input.scope.actorId !== input.request.actorUserId ||
    input.scope.confidentialScopeId !==
      familyIntakeScopeId(input.request.tenantId)
  )
    throw new Error('Family intake scope mismatch');
}
/** Receive before learner attribution; duplicate deliveries repair interrupted retention. */
export async function receiveFamilyIntake(
  input: Input & { receive: ReceiveInput },
) {
  assertScope(input);
  await input.family.authorizeFamilyIntake(
    input.request,
    'education.family-intake.receive',
  );
  const receipt = await input.ingestion.receive(input.receive);
  if (!('itemId' in receipt) || !receipt.itemId)
    return { receipt, intake: null };
  return {
    receipt,
    intake: await retainFamilyIntakeReceipt({
      ...input,
      itemId: receipt.itemId,
    }),
  };
}
/** Copy authorized original evidence once into durable education ownership. */
export async function retainFamilyIntakeReceipt(
  input: Input & { itemId: string },
) {
  assertScope(input);
  await input.family.authorizeFamilyIntake(
    input.request,
    'education.family-intake.receive',
  );
  const identity = await input.ingestion.getReceiptSource(input.itemId);
  const evidence = await input.ingestion.getEvidence(input.itemId);
  if (evidence.length > 200)
    throw new Error('Family receipt evidence exceeds limit');
  const source = {
    ...identity,
    evidence: evidence.map((e) => ({
      evidenceId: e.id,
      partId: e.partId,
      parentEvidenceId: e.parentEvidenceId,
      mimeType: e.mediaType,
      sha256: e.contentHash,
    })),
  };
  const supported = (type: string) =>
    ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(type);
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const originals = evidence
    .filter((e) => {
      if (!supported(e.mediaType)) return false;
      // A PDF/image's child rendition is provenance, not another work page.
      // Metadata parents (for example an email envelope) do not hide attachments.
      let parentId = e.parentEvidenceId;
      const visited = new Set([e.id]);
      while (parentId) {
        if (visited.has(parentId))
          throw new Error('Invalid family evidence lineage');
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) throw new Error('Incomplete family evidence lineage');
        if (supported(parent.mediaType)) return false;
        parentId = parent.parentEvidenceId;
      }
      return true;
    })
    .sort((a, b) => a.partId.localeCompare(b.partId));
  if (
    !originals.length ||
    originals.length > 100 ||
    originals.some(
      (e) => e.byteLength < 1 || e.byteLength > 25 * 1024 * 1024,
    ) ||
    originals.reduce((n, e) => n + e.byteLength, 0) > 100 * 1024 * 1024
  )
    throw new Error('Unsupported or oversized family intake');
  const pages: SubmissionPage[] = [];
  const extensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  };
  for (const original of originals) {
    if (!Object.hasOwn(extensions, original.mediaType))
      throw new Error('Unsupported family original');
    const data = await input.ingestion.readEvidence(input.itemId, original.id);
    if (
      data.length !== original.byteLength ||
      createHash('sha256').update(data).digest('hex') !== original.contentHash
    )
      throw new Error('Family receipt integrity mismatch');
    pages.push({
      name:
        original.filename ||
        `${original.id}.${extensions[original.mediaType as keyof typeof extensions]}`,
      mimeType: original.mediaType as SubmissionPage['mimeType'],
      data: Buffer.from(data),
    });
  }
  return input.family.retainFamilyIntake({
    ...input.request,
    itemId: input.itemId,
    source,
    pages,
  });
}
