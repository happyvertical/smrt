import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import {
  adoptionAnnotation,
  adoptionPath,
  adoptionStages,
  adoptionDocument,
  validateAdoptionPlan,
  validateAdoptionState,
} from './adopt.mjs';
import { demand, hash } from './release.mjs';
const bytesHash = (value) => createHash('sha256').update(value).digest('hex');
const ready = (o) =>
  o.status?.conditions?.some(
    (c) =>
      c.type === 'Ready' &&
      c.status === 'True' &&
      c.observedGeneration === o.metadata.generation,
  );
const matches = (value, rev) =>
  typeof value === 'string' && value.endsWith(`sha1:${rev}`);
const resourceKey = (o) =>
  `${o.apiVersion}/${o.kind}/${o.namespace ?? o.metadata?.namespace}/${o.name ?? o.metadata?.name}`;
export function createAdoptionMethods(config, command, helpers, options) {
  const { repository, branch, namespace } = config;
  const git = (...args) => command('git', ['-C', repository, ...args]);
  async function fileAt(revision, path) {
    adoptionPath(path);
    const tree = (await git('ls-tree', revision, '--', path)).trim();
    for (let i = 1; i < path.split('/').length; i++) {
      const ancestor = (
        await git(
          'ls-tree',
          revision,
          '--',
          path.split('/').slice(0, i).join('/'),
        )
      ).trim();
      demand(
        !ancestor || ancestor.startsWith('040000 tree '),
        'Adoption path ancestor is not a Git tree',
      );
    }
    if (!tree) return null;
    demand(
      tree.startsWith('100644 blob ') || tree.startsWith('100755 blob '),
      'Adoption path must be a regular tracked file',
    );
    return git('show', `${revision}:${path}`);
  }
  async function readAdoption(plan) {
    validateAdoptionPlan(plan);
    await git('fetch', 'origin', branch);
    const revision = (await git('rev-parse', `origin/${branch}`)).trim();
    const paths = [
      plan.canonicalFile,
      plan.stagingFile,
      plan.stateFile,
      plan.snapshot.file,
      plan.qualification.file,
      ...(config.adoption?.fenceObserver
        ? [adoptionPath(config.adoption.fenceObserver.file)]
        : []),
    ];
    demand(
      new Set(paths).size === paths.length,
      'Duplicate adoption protected paths',
    );
    const raw = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [path, await fileAt(revision, path)]),
      ),
    );
    const parse = (path) => (raw[path] === null ? null : JSON.parse(raw[path]));
    return {
      revision,
      raw,
      canonical: parse(plan.canonicalFile),
      staging: parse(plan.stagingFile),
      state: parse(plan.stateFile),
    };
  }
  async function qualifyAdoption(plan, snapshot) {
    demand(
      config.adoption?.snapshotSha256 === plan.snapshot.sha256 &&
        config.adoption?.qualificationSha256 === plan.qualification.sha256 &&
        config.chartSource?.digest === plan.chartOciDigest,
      'Adoption artifacts must be bound by protected configuration',
    );
    for (const artifact of [plan.snapshot, plan.qualification])
      demand(
        snapshot.raw[artifact.file] &&
          bytesHash(snapshot.raw[artifact.file]) === artifact.sha256,
        'Protected adoption artifact content mismatch',
      );
    demand(
      bytesHash(await readFile(config.chart)) === plan.chartArtifactSha256,
      'Adoption chart package identity mismatch',
    );
    const fluxPath = adoptionPath(config.adoption.fluxPath);
    demand(
      [plan.canonicalFile, plan.stagingFile].every(
        (path) => path.slice(0, path.lastIndexOf('/')) === fluxPath,
      ) &&
        [plan.stateFile, plan.snapshot.file, plan.qualification.file].every(
          (path) => !path.startsWith(`${fluxPath}/`),
        ),
      'Adoption proof files must stay outside the dedicated Flux resource directory',
    );
    demand(
      !config.adoption.fenceObserver?.file?.startsWith(`${fluxPath}/`),
      'Fence module must stay outside rendered Flux resources',
    );
    const renderedFiles = (
      await git(
        'ls-tree',
        '-r',
        '--name-only',
        snapshot.revision,
        '--',
        fluxPath,
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    demand(
      renderedFiles.every((path) =>
        [plan.canonicalFile, plan.stagingFile].includes(path),
      ),
      'Dedicated adoption Flux directory contains unreviewed resources',
    );
    for (const name of [
      'kustomization.yaml',
      'kustomization.yml',
      'Kustomization',
    ])
      demand(
        !(await fileAt(snapshot.revision, `${fluxPath}/${name}`)),
        'Adoption requires Flux auto-generated directory resources; explicit resource lists cannot rename atomically',
      );
    const ks = await helpers.get(
      'kustomization',
      config.kustomization.name,
      config.kustomization.namespace,
    );
    const source = await helpers.get(
      'gitrepository',
      config.source.name,
      config.source.namespace,
    );
    demand(
      ks.metadata.uid === config.adoption.kustomizationUid &&
        source.metadata.uid === config.adoption.sourceUid &&
        (ks.spec.path ?? '').replace(/^\.\//, '').replace(/\/$/, '') ===
          fluxPath &&
        ks.spec.sourceRef?.kind === 'GitRepository' &&
        ks.spec.sourceRef.name === config.source.name &&
        (ks.spec.sourceRef.namespace ?? ks.metadata.namespace) ===
          (config.source.namespace ?? ks.metadata.namespace),
      'Adoption target Flux source/Kustomization identity/path mismatch',
    );
    const qualification = JSON.parse(snapshot.raw[plan.qualification.file]);
    demand(
      qualification.apiVersion ===
        'smrt.happyvertical.com/legacy-adoption-qualification-v1' &&
        qualification.adoptionId === plan.adoptionId &&
        qualification.snapshotSha256 === plan.snapshot.sha256 &&
        qualification.normalizedCurrentIdentity ===
          plan.normalizedCurrentIdentity &&
        qualification.targetIdentity === plan.targetIdentity &&
        qualification.configurationIdentity === plan.configurationIdentity &&
        qualification.chartArtifactSha256 === plan.chartArtifactSha256 &&
        qualification.chartOciDigest === plan.chartOciDigest &&
        qualification.fenceContractIdentity === plan.fenceContract.identity &&
        ['source', 'tree', 'lock', 'toolchain'].every(
          (key) =>
            typeof qualification[key] === 'string' &&
            qualification[key].length > 0,
        ) &&
        qualification.validation?.passed === true,
      'Missing trusted CI adoption qualification association',
    );
    const saved = JSON.parse(snapshot.raw[plan.snapshot.file]);
    demand(
      saved.apiVersion === 'smrt.happyvertical.com/legacy-snapshot-v1' &&
        saved.adoptionId === plan.adoptionId &&
        hash(saved.legacy) === hash(plan.legacy) &&
        saved.normalization?.normalizedCurrentIdentity ===
          plan.normalizedCurrentIdentity &&
        typeof saved.normalization?.explanation === 'string' &&
        saved.normalization.explanation.length > 0 &&
        Array.isArray(saved.resources) &&
        saved.resources.length > 0,
      'Invalid legacy snapshot/normalization record',
    );
    const names = new Set();
    for (const r of saved.resources) {
      demand(
        r.apiVersion &&
          r.kind &&
          r.name &&
          r.namespace === namespace &&
          r.uid &&
          /^[a-f0-9]{64}$/.test(r.specIdentity) &&
          /^[a-f0-9]{64}$/.test(r.normalizedSpecIdentity) &&
          r.legacyManager &&
          r.fluxInventoryId &&
          r.spec &&
          hash(r.spec) === r.specIdentity &&
          hash(r.selector ?? {}) === hash(r.spec.selector ?? {}) &&
          !names.has(resourceKey(r)),
        'Invalid or duplicate UID-bound legacy inventory',
      );
      names.add(resourceKey(r));
      if (
        [
          'Deployment',
          'CronJob',
          'Job',
          'ReplicaSet',
          'StatefulSet',
          'DaemonSet',
          'Pod',
        ].includes(r.kind)
      )
        demand(
          r.podSpec &&
            Array.isArray(r.podSpec.containers) &&
            r.podSpec.containers.length > 0 &&
            Array.isArray(r.oldImages) &&
            hash(r.oldImages) ===
              hash(
                [
                  ...r.podSpec.containers,
                  ...(r.podSpec.initContainers ?? []),
                ].map((c) => c.image),
              ) &&
            r.selector &&
            hash(r.podSpec) ===
              hash(
                r.kind === 'Pod'
                  ? r.spec
                  : r.kind === 'CronJob'
                    ? r.spec.jobTemplate?.spec?.template?.spec
                    : r.spec.template?.spec,
              ),
          'Legacy snapshot must retain actual full PodSpec, selectors and old images',
        );
    }
    return saved;
  }
  async function observeWriterFence(plan, snapshot, stage) {
    let observer = options.adoptionFenceObserver;
    if (!observer && config.adoption?.fenceObserver) {
      const provider = config.adoption.fenceObserver;
      const source = await fileAt(
        snapshot.revision,
        adoptionPath(provider.file),
      );
      demand(
        source && bytesHash(source) === provider.sha256,
        'Protected platform fence module identity mismatch',
      );
      try {
        observer = (
          await import(
            `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
          )
        ).observeWriterFence;
      } catch {
        demand(
          false,
          'Protected platform fence module could not load',
          'ADOPTION_FENCE',
        );
      }
    }
    demand(
      typeof observer === 'function',
      'Platform adoptionFenceObserver is required; namespace/database fencing cannot be inferred',
    );
    try {
      return await observer({
        plan: structuredClone(plan),
        stage,
        revision: snapshot.revision,
        observedAt: Date.now(),
      });
    } catch {
      demand(
        false,
        'Platform writer fence observation failed',
        'ADOPTION_FENCE',
      );
    }
  }
  async function legacyFlux(plan, revision, relinquished) {
    const [source, ks] = await Promise.all([
      helpers.get(
        'gitrepository',
        plan.legacy.source.name,
        plan.legacy.source.namespace,
      ),
      helpers.get(
        'kustomization',
        plan.legacy.kustomization.name,
        plan.legacy.kustomization.namespace,
      ),
    ]);
    demand(
      source.metadata.uid === plan.legacy.source.uid &&
        ks.metadata.uid === plan.legacy.kustomization.uid &&
        source.spec.url === plan.legacy.repository &&
        ready(source) &&
        ready(ks) &&
        matches(source.status.artifact?.revision, revision) &&
        matches(ks.status.lastAppliedRevision, revision),
      'Legacy Flux UID/repository/exact reviewed revision not acknowledged',
    );
    demand(
      !ks.spec.suspend && (!relinquished || ks.spec.prune === false),
      'Legacy pruning must be disabled before relinquishment',
    );
    return ks;
  }
  function verifyKnownWorkloads(all, saved) {
    const controllers = all.filter((o) =>
      [
        'Deployment',
        'CronJob',
        'StatefulSet',
        'DaemonSet',
        'HorizontalPodAutoscaler',
        'Job',
      ].includes(o.kind),
    );
    for (const o of controllers)
      demand(
        !['StatefulSet', 'DaemonSet', 'HorizontalPodAutoscaler'].includes(
          o.kind,
        ) &&
          (saved.resources.some(
            (r) =>
              r.kind === o.kind &&
              r.name === o.metadata.name &&
              r.uid === o.metadata.uid,
          ) ||
            (o.kind === 'Job' &&
              o.metadata.ownerReferences?.some((ref) =>
                saved.resources.some(
                  (r) => r.kind === 'CronJob' && r.uid === ref.uid,
                ),
              ))),
        'Unknown or unsupported legacy writer controller',
      );
    for (const rs of all.filter((o) => o.kind === 'ReplicaSet'))
      demand(
        rs.metadata.ownerReferences?.some((ref) =>
          saved.resources.some(
            (r) => r.kind === 'Deployment' && r.uid === ref.uid,
          ),
        ),
        'Unknown legacy ReplicaSet owner',
      );
    for (const pod of all.filter((o) => o.kind === 'Pod'))
      demand(
        pod.metadata.ownerReferences?.some((ref) =>
          all.some(
            (owner) =>
              owner.metadata.uid === ref.uid &&
              ['ReplicaSet', 'Job'].includes(owner.kind),
          ),
        ),
        'Unknown standalone legacy Pod',
      );
  }
  function safeNative(
    plan,
    snapshot,
    stage,
    saved,
    all,
    legacyRevision,
    bindings,
  ) {
    const resources = saved.resources.map((r) => {
      const actual = all.find((o) => resourceKey(o) === resourceKey(r));
      return {
        apiVersion: actual.apiVersion,
        kind: actual.kind,
        namespace: actual.metadata.namespace,
        name: actual.metadata.name,
        uid: actual.metadata.uid,
        specIdentity: hash(actual.spec ?? actual.data ?? {}),
        selectorIdentity: hash(actual.spec?.selector ?? {}),
        managers: [
          ...new Set(
            (actual.metadata.managedFields ?? []).map((f) => f.manager),
          ),
        ].sort(),
      };
    });
    return {
      planIdentity: hash(plan),
      adoptionId: plan.adoptionId,
      namespace,
      stage,
      revision: snapshot.revision,
      inventoryIdentity: hash(resources),
      observedAt: Date.now(),
      bindings,
      resources,
      flux: {
        legacySourceUid: plan.legacy.source.uid,
        legacyKustomizationUid: plan.legacy.kustomization.uid,
        legacyRevision,
        targetSourceUid: config.adoption.sourceUid,
        targetKustomizationUid: config.adoption.kustomizationUid,
      },
    };
  }
  async function observeLegacy(plan, snapshot, stage) {
    const saved = await qualifyAdoption(plan, snapshot);
    const relinquished = ['relinquished', 'helm-staged'].includes(stage);
    const rev = relinquished
      ? plan.legacy.relinquishRevision
      : plan.legacy.stopRevision;
    // A stop revision must descend from the reviewed maintenance and original commits.
    for (const earlier of [
      plan.legacy.revision,
      plan.legacy.maintenanceRevision,
      plan.legacy.stopRevision,
    ])
      await git('merge-base', '--is-ancestor', earlier, rev);
    const ks = await legacyFlux(plan, rev, relinquished);
    const all = await helpers.namespaceInventory();
    verifyKnownWorkloads(all, saved);
    for (const r of saved.resources) {
      const actual = all.find((o) => resourceKey(o) === resourceKey(r));
      demand(
        actual?.metadata.uid === r.uid &&
          hash(actual.spec ?? actual.data ?? {}) === r.normalizedSpecIdentity &&
          hash(actual.spec?.selector ?? {}) === hash(r.selector ?? {}),
        'Legacy resource UID/spec/selector changed',
      );
      if (relinquished) {
        demand(
          actual.metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' &&
            actual.metadata.annotations?.['meta.helm.sh/release-name'] ===
              plan.releaseName &&
            actual.metadata.annotations?.['meta.helm.sh/release-namespace'] ===
              namespace &&
            actual.metadata.annotations?.[
              'kustomize.toolkit.fluxcd.io/prune'
            ] === 'disabled' &&
            Array.isArray(ks.status?.inventory?.entries) &&
            !ks.status.inventory.entries.some(
              (entry) => entry.id === r.fluxInventoryId,
            ),
          'Legacy inventory remains managed or reviewed Helm metadata missing',
        );
        demand(
          actual.metadata.managedFields?.some(
            (entry) => entry.manager === r.legacyManager,
          ) &&
            !actual.metadata.managedFields?.some(
              (entry) =>
                ![
                  r.legacyManager,
                  'kube-controller-manager',
                  'kube-scheduler',
                  'helm-controller',
                ].includes(entry.manager),
            ),
          'Unreviewed legacy resource field manager',
        );
      }
    }
    await helpers.verifyStopped(plan.candidate, all);
    await helpers.maintenance(plan.candidate);
    await legacyFlux(plan, rev, relinquished);
    return safeNative(
      plan,
      snapshot,
      stage,
      saved,
      all,
      rev,
      await helpers.bindings(plan.candidate),
    );
  }
  async function preflightAdoption(plan, snapshot) {
    const saved = await qualifyAdoption(plan, snapshot);
    return helpers.preflight(plan.candidate, {
      plan,
      resources: saved.resources,
    });
  }
  async function observeAdopted(plan, snapshot, stage) {
    const saved = await qualifyAdoption(plan, snapshot);
    const document = snapshot.canonical ?? snapshot.staging;
    demand(
      document &&
        hash(document.spec) === hash(plan.candidate.spec) &&
        document.metadata.annotations?.[`${adoptionAnnotation}id`] ===
          plan.adoptionId &&
        document.metadata.annotations?.[`${adoptionAnnotation}plan`] ===
          hash(plan),
      'Adopted HelmRelease annotation mismatch',
    );
    const ks = await legacyFlux(plan, plan.legacy.relinquishRevision, true);
    demand(
      Array.isArray(ks.status?.inventory?.entries) &&
        !ks.status.inventory.entries.some((entry) =>
          saved.resources.some((r) => r.fluxInventoryId === entry.id),
        ),
      'Legacy Flux inventory management returned',
    );
    await helpers.acknowledge(document, snapshot.revision);
    const evidence = await helpers.provePhase(document, snapshot.revision);
    const all = await helpers.namespaceInventory();
    for (const r of saved.resources) {
      const actual = all.find((o) => resourceKey(o) === resourceKey(r));
      demand(
        actual?.metadata.uid === r.uid &&
          hash(actual.spec?.selector ?? {}) === hash(r.selector ?? {}),
        'Adopted resource UID/selector changed',
      );
      helpers.helmOwner(actual, plan.releaseName, namespace);
    }
    await helpers.verifyStopped(document, all);
    await helpers.acknowledge(document, snapshot.revision);
    return safeNative(
      plan,
      snapshot,
      stage,
      saved,
      all,
      plan.legacy.relinquishRevision,
      evidence.bindings,
    );
  }
  async function casAdoption(snapshot, plan, state, document) {
    validateAdoptionState(plan, state);
    const latest = await readAdoption(plan);
    demand(
      hash(latest.raw) === hash(snapshot.raw),
      'Adoption CAS files changed',
    );
    await git(
      'merge-base',
      '--is-ancestor',
      snapshot.revision,
      latest.revision,
    );
    if (snapshot.revision !== latest.revision)
      demand(
        !(
          await git(
            'log',
            '--format=%H',
            `${snapshot.revision}..${latest.revision}`,
            '--',
            ...Object.keys(snapshot.raw),
          )
        ).trim(),
        'Adoption CAS superseded protected history',
      );
    if (latest.state) {
      validateAdoptionState(plan, latest.state);
      demand(
        adoptionStages.indexOf(state.stage) ===
          adoptionStages.indexOf(latest.state.stage) + 1 &&
          state.previousStateIdentity === hash(latest.state) &&
          hash(state.observations.slice(0, -1)) ===
            hash(latest.state.observations),
        'Adoption CAS journal transition mismatch',
      );
    } else
      demand(
        state.stage === 'planned' &&
          state.previousStateIdentity === null &&
          !latest.canonical &&
          !latest.staging,
        'Adoption CAS must begin with absent canonical/staging and planned journal',
      );
    if (adoptionStages.indexOf(state.stage) >= 3)
      demand(
        document &&
          hash(document) ===
            hash(
              adoptionDocument(
                plan,
                state,
                document.metadata.annotations?.[
                  'smrt.happyvertical.com/binding-versions'
                ],
              ),
            ),
        'Adoption CAS document/plan/journal mismatch',
      );
    else
      demand(
        !document,
        'HelmRelease cannot be published before relinquishment',
      );
    const index = `${repository}/.git-smrt-adoption-${randomUUID()}`;
    const local = (args, input = '') =>
      new Promise((resolve, reject) => {
        const child = execFile(
          'git',
          ['-C', repository, ...args],
          {
            env: { ...process.env, GIT_INDEX_FILE: index },
            maxBuffer: 8 * 1024 * 1024,
          },
          (error, output) =>
            error
              ? reject(new Error('Adoption Git publication failed'))
              : resolve(output.trim()),
        );
        child.stdin.end(input);
      });
    try {
      await local(['read-tree', latest.revision]);
      const changes = [[plan.stateFile, state]];
      if (document)
        changes.push([
          state.stage === 'finalized' ? plan.canonicalFile : plan.stagingFile,
          document,
        ]);
      for (const [path, value] of changes) {
        const blob = await local(
          ['hash-object', '-w', '--stdin'],
          `${JSON.stringify(value, null, 2)}\n`,
        );
        await local([
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${blob},${path}`,
        ]);
      }
      if (state.stage === 'finalized')
        await local(['update-index', '--force-remove', '--', plan.stagingFile]);
      const tree = await local(['write-tree']);
      const revision = await local(
        ['commit-tree', tree, '-p', latest.revision],
        `Adopt ${plan.releaseName}: ${state.stage}\n`,
      );
      await git('push', 'origin', `${revision}:refs/heads/${branch}`);
      return { stage: state.stage, revision };
    } finally {
      await rm(index, { force: true });
    }
  }
  async function assertAdoptionComplete(snapshot) {
    const live = JSON.parse(
      await command('kubectl', [
        '--namespace',
        namespace,
        'get',
        'helmreleases',
        '-o',
        'json',
      ]),
    );
    demand(
      Array.isArray(live.items) &&
        !live.items.some(
          (o) =>
            o.metadata.annotations?.[`${adoptionAnnotation}status`] ===
            'pending',
        ),
      'Pending live adoption blocks normal release commands',
    );
    const annotations = snapshot.document?.metadata?.annotations ?? {};
    if (config.adoption) {
      for (const path of [
        config.adoption.stateFile,
        config.adoption.stagingFile,
      ])
        adoptionPath(path);
      const staging = await fileAt(
        snapshot.revision,
        config.adoption.stagingFile,
      );
      const raw = await fileAt(snapshot.revision, config.adoption.stateFile);
      demand(!staging, 'Pending adoption blocks normal release commands');
      if (raw) {
        const state = JSON.parse(raw);
        demand(
          state.stage === 'finalized' &&
            annotations[`${adoptionAnnotation}status`] === 'complete' &&
            annotations[`${adoptionAnnotation}id`] === state.adoptionId &&
            annotations[`${adoptionAnnotation}plan`] === state.planIdentity &&
            annotations[`${adoptionAnnotation}state`] === hash(state) &&
            annotations[`${adoptionAnnotation}proof`] ===
              hash(state.observations),
          'Pending or mismatched adoption journal blocks normal release commands',
        );
      } else
        demand(
          !Object.keys(annotations).some((k) =>
            k.startsWith(adoptionAnnotation),
          ),
          'Adoption journal is missing',
        );
    } else
      demand(
        !Object.keys(annotations).some((k) => k.startsWith(adoptionAnnotation)),
        'Adoption configuration required for adopted release',
      );
  }
  return {
    readAdoption,
    qualifyAdoption,
    observeLegacy,
    observeWriterFence,
    preflightAdoption,
    observeAdopted,
    casAdoption,
    assertAdoptionComplete,
  };
}
