/**
 * Plain JSON shape produced by serializing a SMRT model instance. Values are
 * intentionally `unknown` — callers spread these records into API responses and
 * narrow individual fields where they need a concrete type.
 */
type SerializedRecord = Record<string, unknown>;

/**
 * Minimal structural view of the model instances passed to the serializers.
 * Every model used here exposes `toJSON()` plus optional accessor methods for
 * its JSON-backed fields; the accessors are typed loosely because each model
 * returns a different concrete shape.
 */
interface SerializableModel {
  toJSON?: () => unknown;
  getMetadata?: () => unknown;
  getSnapshot?: () => unknown;
  getFindings?: () => unknown;
  getAllowedChannels?: () => unknown;
  getIntakeRules?: () => unknown;
  getPromotion?: () => unknown;
  getRevisions?: () => Promise<unknown[]> | unknown[];
  getAttachments?: () => Promise<unknown[]> | unknown[];
  getContributor?: () => Promise<unknown> | unknown;
  getReferences?: () => Promise<unknown[]> | unknown[];
  getAssets?: () => Promise<unknown[]> | unknown[];
  getReferenceDrift?: () => Promise<unknown> | unknown;
  metadata?: unknown;
}

function asModel(value: unknown): SerializableModel {
  return value && typeof value === 'object' ? (value as SerializableModel) : {};
}

function callMethod(
  model: SerializableModel,
  name: keyof SerializableModel,
): unknown {
  const method = model[name];
  return typeof method === 'function'
    ? (method as () => unknown).call(model)
    : undefined;
}

function toJSON(value: unknown): SerializedRecord {
  const model = asModel(value);
  if (typeof model.toJSON === 'function') {
    const serialized = model.toJSON();
    return serialized && typeof serialized === 'object'
      ? (serialized as SerializedRecord)
      : {};
  }

  return value && typeof value === 'object' ? (value as SerializedRecord) : {};
}

export function serializeFact(fact: unknown) {
  const model = asModel(fact);
  const data = toJSON(fact);
  return {
    ...data,
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeFactLink(link: unknown) {
  const model = asModel(link);
  const data = toJSON(link);
  return {
    ...data,
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentVersion(version: unknown) {
  const model = asModel(version);
  const data = toJSON(version);
  return {
    ...data,
    snapshot:
      typeof model.getSnapshot === 'function'
        ? model.getSnapshot()
        : data.snapshot || {},
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentReview(review: unknown) {
  const model = asModel(review);
  const data = toJSON(review);
  return {
    ...data,
    findings:
      typeof model.getFindings === 'function'
        ? model.getFindings()
        : data.findings || [],
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentCorrection(correction: unknown) {
  const model = asModel(correction);
  const data = toJSON(correction);
  return {
    ...data,
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributor(contributor: unknown) {
  const model = asModel(contributor);
  const data = toJSON(contributor);
  return {
    ...data,
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributionType(contributionType: unknown) {
  const model = asModel(contributionType);
  const data = toJSON(contributionType);
  return {
    ...data,
    allowedChannels:
      typeof model.getAllowedChannels === 'function'
        ? model.getAllowedChannels()
        : data.allowedChannels || [],
    intakeRules:
      typeof model.getIntakeRules === 'function'
        ? model.getIntakeRules()
        : data.intakeRules || {},
    promotion:
      typeof model.getPromotion === 'function'
        ? model.getPromotion()
        : data.promotion || {},
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributionRevision(revision: unknown) {
  const model = asModel(revision);
  const data = toJSON(revision);
  return {
    ...data,
    sourceMessageId: data.sourceMessageId || null,
    sourceThreadKey: data.sourceThreadKey || null,
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributionAttachment(attachment: unknown) {
  const model = asModel(attachment);
  const data = toJSON(attachment);
  return {
    ...data,
    revisionId: data.revisionId || null,
    fileKey: data.fileKey || null,
    sourceUri: data.sourceUri || null,
    promotedAssetId: data.promotedAssetId || null,
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export async function serializeContentContribution(contribution: unknown) {
  const model = asModel(contribution);
  const [revisions, attachments, contributor] = await Promise.all([
    typeof model.getRevisions === 'function' ? model.getRevisions() : [],
    typeof model.getAttachments === 'function' ? model.getAttachments() : [],
    typeof model.getContributor === 'function' ? model.getContributor() : null,
  ]);

  return {
    ...toJSON(contribution),
    contributor: contributor ? serializeContentContributor(contributor) : null,
    revisions: revisions.map(serializeContentContributionRevision),
    attachments: attachments.map(serializeContentContributionAttachment),
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : model.metadata || {},
  };
}

export function serializeContentReviewProfileEvaluation(profile: unknown) {
  const data = toJSON(profile);
  return {
    ...data,
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
  };
}

export function serializeContentReviewPolicy(policy: unknown) {
  return {
    ...toJSON(policy),
  };
}

export function serializeContentGovernanceProfile(profile: unknown) {
  const model = asModel(profile);
  const data = toJSON(profile);
  return {
    ...data,
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentGovernanceAssignment(assignment: unknown) {
  const model = asModel(assignment);
  const data = toJSON(assignment);
  return {
    ...data,
    metadata:
      typeof model.getMetadata === 'function'
        ? model.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentGovernanceState(state: unknown) {
  const data = toJSON(state);
  return {
    ...data,
    reviewPolicies: Array.isArray(data.reviewPolicies)
      ? data.reviewPolicies.map(serializeContentReviewPolicy)
      : [],
    availableProfiles: Array.isArray(data.availableProfiles)
      ? data.availableProfiles.map(serializeContentGovernanceProfile)
      : [],
    reviewProfiles: Array.isArray(data.reviewProfiles)
      ? data.reviewProfiles.map(serializeContentReviewProfileEvaluation)
      : [],
  };
}

/**
 * Reference-drift edge keyed by target content id. Mirrors the shape returned
 * by `Content.getReferenceDrift()`.
 */
interface ReferenceDriftEdge {
  citedVersion: number | null;
  currentVersion: number | null;
  isDrifted: boolean;
}

export async function serializeContent(content: unknown) {
  const model = asModel(content);
  const [references, assets] = await Promise.all([
    typeof model.getReferences === 'function' ? model.getReferences() : [],
    typeof model.getAssets === 'function' ? model.getAssets() : [],
  ]);

  // Only resolve drift when there are references to drift against — list
  // endpoints serializing many ref-less items shouldn't pay the version
  // lookup cost.
  const drift =
    references.length > 0 && typeof model.getReferenceDrift === 'function'
      ? await model.getReferenceDrift()
      : [];

  const driftByTargetId = new Map<string, ReferenceDriftEdge>(
    Array.isArray(drift)
      ? drift
          .map((entry) => asModel(entry))
          .filter(
            (entry): entry is SerializableModel & { targetId: string } =>
              typeof (entry as { targetId?: unknown }).targetId === 'string',
          )
          .map((entry) => {
            const edge = entry as {
              targetId: string;
              citedVersion?: unknown;
              currentVersion?: unknown;
              isDrifted?: unknown;
            };
            return [
              edge.targetId,
              {
                citedVersion: (edge.citedVersion as number | null) ?? null,
                currentVersion: (edge.currentVersion as number | null) ?? null,
                isDrifted: Boolean(edge.isDrifted),
              },
            ] satisfies [string, ReferenceDriftEdge];
          })
      : [],
  );

  return {
    ...toJSON(content),
    referenceIds: references
      .map((reference) => asModel(reference) as { id?: unknown })
      .map((reference) => reference.id)
      .filter(Boolean),
    references: references.map((reference) => {
      const base = toJSON(reference);
      const edge =
        typeof base.id === 'string' ? driftByTargetId.get(base.id) : null;
      return edge
        ? {
            ...base,
            citedVersion: edge.citedVersion,
            currentVersion: edge.currentVersion,
            isDrifted: edge.isDrifted,
          }
        : base;
    }),
    assetIds: assets
      .map((asset) => (asModel(asset) as { id?: unknown }).id)
      .filter(Boolean),
    assets: assets.map((asset) => toJSON(asset)),
  };
}
