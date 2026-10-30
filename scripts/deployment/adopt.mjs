import { demand, hash, validate } from './release.mjs';

export const adoptionStages = [
  'planned',
  'legacy-stopped',
  'relinquished',
  'helm-staged',
  'helm-established',
  'finalized',
];
export const adoptionAnnotation = 'smrt.happyvertical.com/adoption-';
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const revision = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const text = (v) =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(v);
const keys = (o, expected) =>
  o &&
  typeof o === 'object' &&
  !Array.isArray(o) &&
  Object.keys(o).length === expected.length &&
  expected.every((k) => Object.hasOwn(o, k));
export function adoptionPath(path) {
  demand(
    typeof path === 'string' &&
      /^[\w./-]+$/.test(path) &&
      !path.startsWith('/') &&
      !path.startsWith('-') &&
      !path.split('/').some((p) => ['', '.', '..'].includes(p)),
    'Unsafe adoption Git path',
  );
  return path;
}
function legacyRepositoryUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f-\u009f\\?#]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    if (
      !url.hostname ||
      url.pathname.length < 2 ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    if (url.protocol === 'ssh:') return url.username === 'git';
    const authority = value.match(/^[^:]+:\/\/([^/]*)/)?.[1];
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !authority?.includes('@')
    );
  } catch {
    return false;
  }
}

export function validateAdoptionPlan(plan) {
  demand(
    keys(plan, [
      'apiVersion',
      'adoptionId',
      'releaseId',
      'namespace',
      'releaseName',
      'canonicalFile',
      'stagingFile',
      'stateFile',
      'legacy',
      'snapshot',
      'qualification',
      'normalizedCurrentIdentity',
      'targetIdentity',
      'configurationIdentity',
      'chartArtifactSha256',
      'chartOciDigest',
      'fenceContract',
      'candidate',
    ]),
    'Invalid adoption plan fields',
  );
  demand(
    plan.apiVersion === 'smrt.happyvertical.com/legacy-adoption-v1' &&
      [plan.adoptionId, plan.releaseId, plan.namespace, plan.releaseName].every(
        text,
      ),
    'Invalid adoption identity',
  );
  const paths = [plan.canonicalFile, plan.stagingFile, plan.stateFile].map(
    adoptionPath,
  );
  demand(new Set(paths).size === paths.length, 'Duplicate adoption Git paths');
  demand(
    keys(plan.legacy, [
      'repository',
      'revision',
      'maintenanceRevision',
      'stopRevision',
      'relinquishRevision',
      'source',
      'kustomization',
    ]) &&
      legacyRepositoryUrl(plan.legacy.repository) &&
      [
        'revision',
        'maintenanceRevision',
        'stopRevision',
        'relinquishRevision',
      ].every((k) => revision(plan.legacy[k])),
    'Invalid reviewed legacy revisions',
  );
  for (const ref of [plan.legacy.source, plan.legacy.kustomization])
    demand(
      keys(ref, ['namespace', 'name', 'uid']) && Object.values(ref).every(text),
      'Invalid legacy Flux UID reference',
    );
  for (const artifact of [plan.snapshot, plan.qualification])
    demand(
      keys(artifact, ['file', 'sha256']) &&
        adoptionPath(artifact.file) &&
        sha(artifact.sha256),
      'Invalid protected adoption artifact',
    );
  demand(
    new Set([...paths, plan.snapshot.file, plan.qualification.file]).size === 5,
    'Duplicate adoption artifact paths',
  );
  demand(
    [
      'normalizedCurrentIdentity',
      'targetIdentity',
      'configurationIdentity',
      'chartArtifactSha256',
    ].every((k) => sha(plan[k])) &&
      /^sha256:[a-f0-9]{64}$/.test(plan.chartOciDigest),
    'Invalid adoption content identities',
  );
  demand(
    keys(plan.fenceContract, ['id', 'identity']) &&
      text(plan.fenceContract.id) &&
      sha(plan.fenceContract.identity),
    'Invalid adoption fence contract',
  );
  const v = validate(plan.candidate);
  demand(
    v.current !== false &&
      v.current &&
      v.release.phase === 'stopped' &&
      v.release.sequence === 1 &&
      v.release.attempt === 1 &&
      v.release.id === plan.releaseId &&
      plan.candidate.metadata.name === plan.releaseName &&
      plan.candidate.metadata.namespace === plan.namespace,
    'Adoption requires real current and stopped sequence1 attempt1 candidate',
  );
  demand(
    hash(v.current) === plan.normalizedCurrentIdentity &&
      hash(v.target) === plan.targetIdentity &&
      hash({
        maintenance: v.maintenance,
        bindings: v.bindings,
        ingress: v.ingress,
      }) === plan.configurationIdentity,
    'Adoption runtime/configuration identity mismatch',
  );
  demand(
    !Object.keys(plan.candidate.metadata.annotations ?? {}).some((k) =>
      k.startsWith(adoptionAnnotation),
    ),
    'Candidate must not supply adoption proof annotations',
  );
  return plan;
}
export async function planAdoption(config, adapter, input) {
  const plan = validateAdoptionPlan(structuredClone(input));
  demand(
    config.file === plan.canonicalFile &&
      config.namespace === plan.namespace &&
      config.adoption?.stateFile === plan.stateFile &&
      config.adoption?.stagingFile === plan.stagingFile,
    'Adoption configuration/path mismatch',
  );
  const snapshot = await adapter.readAdoption(plan);
  demand(
    !snapshot.canonical && !snapshot.staging && !snapshot.state,
    'Adoption already exists; resume the protected plan',
  );
  await adapter.qualifyAdoption(plan, snapshot);
  return plan;
}
/** Native observations shared by adoption and ordinary static exemptions. */
export function verifyNativeWriterFence(fence, contract, now = Date.now()) {
  demand(
    fence?.apiVersion === 'smrt.happyvertical.com/writer-fence-v1' &&
      text(fence.contractId) && sha(fence.contractIdentity) && text(fence.namespace) &&
      fence.contractId === contract.id &&
      fence.contractIdentity === contract.identity &&
      fence.namespace === contract.namespace &&
      text(fence.epoch) &&
      Number.isSafeInteger(fence.observedAt) &&
      Number.isSafeInteger(fence.expiresAt) &&
      fence.observedAt >= now - 30000 &&
      fence.observedAt <= now &&
      fence.expiresAt > now &&
      fence.expiresAt <= now + 30000 &&
      sha(fence.namespacePolicyIdentity) &&
      sha(fence.databasePolicyIdentity) &&
      Array.isArray(fence.observations) &&
      fence.observations.length >= 2 &&
      fence.observations.every(
        (o) =>
          keys(o, ['scope', 'identity', 'observedAt', 'activeWriters']) &&
          ['namespace', 'database'].includes(o.scope) &&
          sha(o.identity) &&
          Number.isSafeInteger(o.observedAt) &&
          o.observedAt >= now - 30000 &&
          o.observedAt <= now &&
          o.activeWriters === 0,
      ) &&
      ['namespace', 'database'].every((scope) =>
        fence.observations.some((o) => o.scope === scope),
      ),
    'Missing fresh platform namespace/database writer fence',
    'WRITER_FENCE',
  );
  return hash(fence);
}

export function verifyAdoptionGate(
  plan,
  stage,
  observation,
  fence,
  now = Date.now(),
) {
  demand(
    keys(observation, [
      'planIdentity',
      'adoptionId',
      'namespace',
      'stage',
      'revision',
      'inventoryIdentity',
      'observedAt',
      'bindings',
      'resources',
      'flux',
    ]) &&
      sha(observation.bindings) &&
      Number.isSafeInteger(observation.observedAt) &&
      Array.isArray(observation.resources) &&
      observation.resources.length > 0 &&
      observation.resources.length <= 256 &&
      observation.resources.every(
        (r) =>
          keys(r, [
            'apiVersion',
            'kind',
            'namespace',
            'name',
            'uid',
            'specIdentity',
            'selectorIdentity',
            'managers',
          ]) &&
          [r.apiVersion, r.kind, r.namespace, r.name, r.uid].every(text) &&
          [r.specIdentity, r.selectorIdentity].every(sha) &&
          Array.isArray(r.managers) &&
          r.managers.length <= 32 &&
          r.managers.every(text),
      ) &&
      keys(observation.flux, [
        'legacySourceUid',
        'legacyKustomizationUid',
        'legacyRevision',
        'targetSourceUid',
        'targetKustomizationUid',
      ]) &&
      [
        observation.flux.legacySourceUid,
        observation.flux.legacyKustomizationUid,
        observation.flux.targetSourceUid,
        observation.flux.targetKustomizationUid,
      ].every(text) &&
      revision(observation.flux.legacyRevision),
    'Invalid safe native adoption observation',
  );
  demand(
    observation.inventoryIdentity === hash(observation.resources) &&
      observation.flux.legacySourceUid === plan.legacy.source.uid &&
      observation.flux.legacyKustomizationUid ===
        plan.legacy.kustomization.uid &&
      observation.resources.every((r) => r.namespace === plan.namespace) &&
      adoptionStages.includes(stage) &&
      observation?.planIdentity === hash(plan) &&
      observation.stage === stage &&
      observation.namespace === plan.namespace &&
      observation.adoptionId === plan.adoptionId &&
      revision(observation.revision) &&
      sha(observation.inventoryIdentity) &&
      observation.observedAt >= now - 30000 &&
      observation.observedAt <= now,
    'Missing fresh bound native adoption observation',
  );
  demand(
    keys(fence, [
      'apiVersion',
      'contractId',
      'contractIdentity',
      'adoptionId',
      'planIdentity',
      'namespace',
      'epoch',
      'observedAt',
      'expiresAt',
      'namespacePolicyIdentity',
      'databasePolicyIdentity',
      'observations',
    ]) &&
      fence.adoptionId === plan.adoptionId && fence.planIdentity === hash(plan),
    'Missing bound adoption writer fence',
  );
  verifyNativeWriterFence(fence, {...plan.fenceContract, namespace:plan.namespace}, now);
  return {
    native: hash(observation),
    fence: hash(fence),
    revision: observation.revision,
    inventoryIdentity: observation.inventoryIdentity,
    epoch: fence.epoch,
    nativeObservation: structuredClone(observation),
    fenceObservation: structuredClone(fence),
  };
}
export function validateAdoptionState(plan, state) {
  demand(
    keys(state, [
      'apiVersion',
      'adoptionId',
      'planIdentity',
      'stage',
      'previousStateIdentity',
      'observations',
    ]) &&
      state.apiVersion === 'smrt.happyvertical.com/legacy-adoption-state-v1' &&
      state.adoptionId === plan.adoptionId &&
      state.planIdentity === hash(plan) &&
      adoptionStages.includes(state.stage) &&
      (state.stage === 'planned'
        ? state.previousStateIdentity === null
        : sha(state.previousStateIdentity)) &&
      Array.isArray(state.observations) &&
      state.observations.length === adoptionStages.indexOf(state.stage) &&
      state.observations.every(
        (o) =>
          keys(o, [
            'native',
            'fence',
            'revision',
            'inventoryIdentity',
            'epoch',
            'nativeObservation',
            'fenceObservation',
          ]) &&
          [o.native, o.fence, o.inventoryIdentity].every(sha) &&
          revision(o.revision) &&
          text(o.epoch) &&
          hash(o.nativeObservation) === o.native &&
          hash(o.fenceObservation) === o.fence,
      ),
    'Adoption journal mismatch',
  );
  state.observations.forEach((o, index) =>
    verifyAdoptionGate(
      plan,
      adoptionStages[index + 1],
      o.nativeObservation,
      o.fenceObservation,
      Math.max(o.nativeObservation.observedAt, o.fenceObservation.observedAt),
    ),
  );
  return state;
}
export function adoptionDocument(plan, state, bindings) {
  demand(sha(bindings), 'Missing actual adoption binding versions');
  const document = structuredClone(plan.candidate);
  document.metadata.annotations = {
    ...document.metadata.annotations,
    [`${adoptionAnnotation}id`]: plan.adoptionId,
    [`${adoptionAnnotation}plan`]: hash(plan),
    [`${adoptionAnnotation}status`]:
      state.stage === 'finalized' ? 'complete' : 'pending',
    [`${adoptionAnnotation}origin`]: hash(plan.legacy),
    'smrt.happyvertical.com/binding-versions': bindings,
  };
  if (state.stage === 'finalized') {
    document.metadata.annotations[`${adoptionAnnotation}proof`] = hash(
      state.observations,
    );
    document.metadata.annotations[`${adoptionAnnotation}state`] = hash(state);
  }
  return document;
}
export async function adoptOrResume(config, adapter, input) {
  const plan = validateAdoptionPlan(input);
  demand(
    config.file === plan.canonicalFile &&
      config.namespace === plan.namespace &&
      config.adoption?.stateFile === plan.stateFile &&
      config.adoption?.stagingFile === plan.stagingFile,
    'Adoption configuration/path mismatch',
  );
  const snapshot = await adapter.readAdoption(plan);
  await adapter.qualifyAdoption(plan, snapshot);
  const state = snapshot.state
    ? validateAdoptionState(plan, snapshot.state)
    : {
        apiVersion: 'smrt.happyvertical.com/legacy-adoption-state-v1',
        adoptionId: plan.adoptionId,
        planIdentity: hash(plan),
        stage: 'planned',
        previousStateIdentity: null,
        observations: [],
      };
  if (!snapshot.state) {
    demand(
      !snapshot.canonical && !snapshot.staging,
      'Adoption files exist without journal',
    );
    const observed = await adapter.observeLegacy(plan, snapshot, 'planned');
    demand(
      observed.revision === snapshot.revision,
      'Initial adoption observation revision mismatch',
    );
    verifyAdoptionGate(
      plan,
      'planned',
      observed,
      await adapter.observeWriterFence(plan, snapshot, 'planned'),
    );
    return adapter.casAdoption(snapshot, plan, state);
  }
  const i = adoptionStages.indexOf(state.stage);
  demand(
    i >= 3
      ? state.stage === 'finalized'
        ? snapshot.canonical && !snapshot.staging
        : snapshot.staging && !snapshot.canonical
      : !snapshot.canonical && !snapshot.staging,
    'Adoption staging/canonical file ambiguity',
  );
  if (i >= 3) {
    const saved = snapshot.canonical ?? snapshot.staging;
    demand(
      hash(saved) ===
        hash(
          adoptionDocument(
            plan,
            state,
            saved.metadata.annotations?.[
              'smrt.happyvertical.com/binding-versions'
            ],
          ),
        ),
      'Adoption document differs from protected plan/journal',
    );
  }
  const nextStage = adoptionStages[Math.min(i + 1, adoptionStages.length - 1)];
  const preflight =
    nextStage === 'helm-staged'
      ? await adapter.preflightAdoption(plan, snapshot)
      : undefined;
  const observation = await (i >= 3
    ? adapter.observeAdopted(plan, snapshot, nextStage)
    : adapter.observeLegacy(plan, snapshot, nextStage));
  demand(
    observation.revision === snapshot.revision,
    'Adoption observation did not bind exact Git snapshot',
  );
  const fence = await adapter.observeWriterFence(plan, snapshot, nextStage);
  const proof = verifyAdoptionGate(plan, nextStage, observation, fence);
  if (state.stage === 'finalized')
    return { stage: state.stage, revision: snapshot.revision, proof };
  const bindings = preflight?.bindings ?? observation.bindings;
  const next = {
    ...state,
    stage: nextStage,
    previousStateIdentity: hash(state),
    observations: [...state.observations, proof],
  };
  const publication = await adapter.casAdoption(
    snapshot,
    plan,
    next,
    i >= 2 ? adoptionDocument(plan, next, bindings) : undefined,
  );
  if (nextStage === 'finalized') {
    const final = await adapter.readAdoption(plan);
    demand(
      final.revision === publication.revision &&
        final.state?.stage === 'finalized' &&
        final.canonical &&
        !final.staging,
      'Final adoption commit is superseded or ambiguous',
    );
    const observed = await adapter.observeAdopted(plan, final, 'finalized');
    demand(
      observed.revision === final.revision,
      'Final adoption observation revision mismatch',
    );
    const finalProof = verifyAdoptionGate(
      plan,
      'finalized',
      observed,
      await adapter.observeWriterFence(plan, final, 'finalized'),
    );
    return { ...publication, proof: finalProof };
  }
  return publication;
}
