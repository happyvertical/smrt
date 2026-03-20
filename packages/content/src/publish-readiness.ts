export interface PublishReadinessRequirement {
  label: string;
  blocking: boolean;
  missing: boolean;
  stale?: boolean;
  satisfied: boolean;
  latestStatus: string | null;
}

export interface PublishReadinessProfile {
  profileKey: string;
  ready: boolean;
  complete: boolean;
  requirements: PublishReadinessRequirement[];
}

export interface ContentPublishReadinessState {
  level: 'ready' | 'advisory' | 'blocked';
  title: string;
  message: string;
  details: string[];
  disableSave: boolean;
}

export interface EvaluateContentPublishReadinessOptions {
  status?: string | null;
  contentId?: string | null;
  reviewProfileKey: string;
  reviewProfiles?: PublishReadinessProfile[] | null;
  enforce?: boolean;
}

function describeRequirement(requirement: PublishReadinessRequirement): string {
  if (requirement.missing) {
    return `${requirement.label}: not run yet`;
  }

  if (requirement.stale) {
    return `${requirement.label}: stale, rerun required`;
  }

  if (requirement.latestStatus) {
    return `${requirement.label}: ${requirement.latestStatus}`;
  }

  return `${requirement.label}: not satisfied`;
}

export function evaluateContentPublishReadiness(
  options: EvaluateContentPublishReadinessOptions,
): ContentPublishReadinessState | null {
  if (options.status !== 'published') {
    return null;
  }

  const enforce = options.enforce === true;

  if (!options.contentId || options.contentId === 'new') {
    return {
      level: enforce ? 'blocked' : 'advisory',
      title: 'Publication Needs A Saved Draft',
      message:
        'Save this factual content first so reviews can run before publication.',
      details: [],
      disableSave: enforce,
    };
  }

  const profile = (options.reviewProfiles || []).find(
    (candidate) => candidate.profileKey === options.reviewProfileKey,
  );

  if (!profile) {
    return {
      level: 'ready',
      title: 'No Publish Profile Configured',
      message:
        'No publication review profile is configured, so publish readiness is not being enforced here.',
      details: [],
      disableSave: false,
    };
  }

  const unsatisfiedBlocking = profile.requirements.filter(
    (requirement) => requirement.blocking && !requirement.satisfied,
  );
  if (unsatisfiedBlocking.length > 0) {
    return {
      level: enforce ? 'blocked' : 'advisory',
      title: enforce
        ? 'Blocking Reviews Must Pass'
        : 'Blocking Reviews Are Not Satisfied',
      message: enforce
        ? 'Resolve the blocking review requirements before publishing this content.'
        : 'This content can still be published, but blocking review requirements are not yet satisfied.',
      details: unsatisfiedBlocking.map(describeRequirement),
      disableSave: enforce,
    };
  }

  const incompleteRequirements = profile.requirements.filter(
    (requirement) => !requirement.satisfied,
  );
  if (incompleteRequirements.length > 0 || !profile.complete) {
    return {
      level: 'advisory',
      title: 'Some Reviews Are Still Pending',
      message:
        'Blocking requirements are satisfied, but some advisory reviews are still missing or need follow-up.',
      details: incompleteRequirements.map(describeRequirement),
      disableSave: false,
    };
  }

  return {
    level: 'ready',
    title: 'Ready To Publish',
    message:
      'All configured review requirements for this publication profile are satisfied.',
    details: [],
    disableSave: false,
  };
}
