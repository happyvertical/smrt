function toJSON<T extends Record<string, any>>(value: any): T {
  if (value && typeof value.toJSON === 'function') {
    return value.toJSON();
  }

  return value as T;
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

export function serializeContentGovernanceState(state: any) {
  const data = toJSON<Record<string, any>>(state);
  return {
    ...data,
    reviewPolicies: Array.isArray(data.reviewPolicies)
      ? data.reviewPolicies.map(serializeContentReviewPolicy)
      : [],
    reviewProfiles: Array.isArray(data.reviewProfiles)
      ? data.reviewProfiles.map(serializeContentReviewProfileEvaluation)
      : [],
  };
}

export async function serializeContent(content: any) {
  const isFactual =
    typeof content?.isFactual === 'function' ? content.isFactual() : false;

  const [references, assets] = await Promise.all([
    typeof content?.getReferences === 'function' ? content.getReferences() : [],
    typeof content?.getAssets === 'function' ? content.getAssets() : [],
  ]);

  let factLinks: any[] = [];
  let facts: any[] = [];

  if (isFactual) {
    try {
      [factLinks, facts] = await Promise.all([
        typeof content?.getFactLinks === 'function'
          ? content.getFactLinks()
          : [],
        typeof content?.getFacts === 'function'
          ? content.getFacts({
              latestOnly: true,
              includeSuperseded: false,
            })
          : [],
      ]);
    } catch {
      factLinks = [];
      facts = [];
    }
  }

  return {
    ...toJSON<Record<string, any>>(content),
    isFactual,
    referenceIds: references
      .map((reference: any) => reference?.id)
      .filter(Boolean),
    assetIds: assets.map((asset: any) => asset?.id).filter(Boolean),
    assets: assets.map((asset: any) => toJSON<Record<string, any>>(asset)),
    factIds: facts.map((fact: any) => fact?.id).filter(Boolean),
    facts: facts.map(serializeFact),
    factLinks: factLinks.map(serializeFactLink),
  };
}
