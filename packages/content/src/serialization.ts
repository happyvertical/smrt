function toJSON<T extends Record<string, any>>(value: any): T {
  if (value && typeof value.toJSON === 'function') {
    const serialized = value.toJSON();
    return serialized && typeof serialized === 'object'
      ? serialized
      : ({} as T);
  }

  return value && typeof value === 'object' ? value : ({} as T);
}

export function serializeFact(fact: any) {
  const data = toJSON<Record<string, any>>(fact);
  return {
    ...data,
    metadata:
      typeof fact?.getMetadata === 'function'
        ? fact.getMetadata()
        : data.metadata || {},
  };
}

export function serializeFactLink(link: any) {
  const data = toJSON<Record<string, any>>(link);
  return {
    ...data,
    metadata:
      typeof link?.getMetadata === 'function'
        ? link.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentVersion(version: any) {
  const data = toJSON<Record<string, any>>(version);
  return {
    ...data,
    snapshot:
      typeof version?.getSnapshot === 'function'
        ? version.getSnapshot()
        : data.snapshot || {},
    metadata:
      typeof version?.getMetadata === 'function'
        ? version.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentReview(review: any) {
  const data = toJSON<Record<string, any>>(review);
  return {
    ...data,
    findings:
      typeof review?.getFindings === 'function'
        ? review.getFindings()
        : data.findings || [],
    metadata:
      typeof review?.getMetadata === 'function'
        ? review.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentCorrection(correction: any) {
  const data = toJSON<Record<string, any>>(correction);
  return {
    ...data,
    metadata:
      typeof correction?.getMetadata === 'function'
        ? correction.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributor(contributor: any) {
  const data = toJSON<Record<string, any>>(contributor);
  return {
    ...data,
    metadata:
      typeof contributor?.getMetadata === 'function'
        ? contributor.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributionType(contributionType: any) {
  const data = toJSON<Record<string, any>>(contributionType);
  return {
    ...data,
    allowedChannels:
      typeof contributionType?.getAllowedChannels === 'function'
        ? contributionType.getAllowedChannels()
        : data.allowedChannels || [],
    intakeRules:
      typeof contributionType?.getIntakeRules === 'function'
        ? contributionType.getIntakeRules()
        : data.intakeRules || {},
    promotion:
      typeof contributionType?.getPromotion === 'function'
        ? contributionType.getPromotion()
        : data.promotion || {},
    metadata:
      typeof contributionType?.getMetadata === 'function'
        ? contributionType.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributionRevision(revision: any) {
  const data = toJSON<Record<string, any>>(revision);
  return {
    ...data,
    sourceMessageId: data.sourceMessageId || null,
    sourceThreadKey: data.sourceThreadKey || null,
    metadata:
      typeof revision?.getMetadata === 'function'
        ? revision.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentContributionAttachment(attachment: any) {
  const data = toJSON<Record<string, any>>(attachment);
  return {
    ...data,
    revisionId: data.revisionId || null,
    fileKey: data.fileKey || null,
    sourceUri: data.sourceUri || null,
    promotedAssetId: data.promotedAssetId || null,
    metadata:
      typeof attachment?.getMetadata === 'function'
        ? attachment.getMetadata()
        : data.metadata || {},
  };
}

export async function serializeContentContribution(contribution: any) {
  const [revisions, attachments, contributor] = await Promise.all([
    typeof contribution?.getRevisions === 'function'
      ? contribution.getRevisions()
      : [],
    typeof contribution?.getAttachments === 'function'
      ? contribution.getAttachments()
      : [],
    typeof contribution?.getContributor === 'function'
      ? contribution.getContributor()
      : null,
  ]);

  return {
    ...toJSON<Record<string, any>>(contribution),
    contributor: contributor ? serializeContentContributor(contributor) : null,
    revisions: revisions.map(serializeContentContributionRevision),
    attachments: attachments.map(serializeContentContributionAttachment),
    metadata:
      typeof contribution?.getMetadata === 'function'
        ? contribution.getMetadata()
        : contribution?.metadata || {},
  };
}

export function serializeContentReviewProfileEvaluation(profile: any) {
  const data = toJSON<Record<string, any>>(profile);
  return {
    ...data,
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
  };
}

export function serializeContentReviewPolicy(policy: any) {
  return {
    ...toJSON<Record<string, any>>(policy),
  };
}

export function serializeContentGovernanceProfile(profile: any) {
  const data = toJSON<Record<string, any>>(profile);
  return {
    ...data,
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
    metadata:
      typeof profile?.getMetadata === 'function'
        ? profile.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentGovernanceAssignment(assignment: any) {
  const data = toJSON<Record<string, any>>(assignment);
  return {
    ...data,
    metadata:
      typeof assignment?.getMetadata === 'function'
        ? assignment.getMetadata()
        : data.metadata || {},
  };
}

export function serializeContentGovernanceState(state: any) {
  const data = toJSON<Record<string, any>>(state);
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

export async function serializeContent(content: any) {
  const [references, assets] = await Promise.all([
    typeof content?.getReferences === 'function' ? content.getReferences() : [],
    typeof content?.getAssets === 'function' ? content.getAssets() : [],
  ]);

  return {
    ...toJSON<Record<string, any>>(content),
    referenceIds: references
      .map((reference: any) => reference?.id)
      .filter(Boolean),
    assetIds: assets.map((asset: any) => asset?.id).filter(Boolean),
    assets: assets.map((asset: any) => toJSON<Record<string, any>>(asset)),
  };
}
