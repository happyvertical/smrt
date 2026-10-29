import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tlsMarker, tlsAnnotation, tlsDocument, validateTlsPlan, validateTlsCurrent } from './tls.mjs';
import { inspectTlsSecret, retainedTlsIdentity, servedTlsIdentity } from './tls-native.mjs';
import { createAdoptionMethods, verifyKnownLegacyWorkloads } from './live-adoption.mjs';
import {
  DeploymentError,
  demand,
  hash,
  identity,
  effectiveWorkloadSelectors,
  readOnlyConfigBindings,
  normalizedIngressRecords,
  isContinuousStatic,
  phaseRenderedRuntime,
  phases,
  validate,
  validateRepairEvidence,
} from './release.mjs';
const safeReference = (value) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9./:_-]*$/i.test(value)
    ? value
    : '<invalid-reference>';
const ready = (object) =>
  object.status?.conditions?.some(
    (c) =>
      c.type === 'Ready' &&
      c.status === 'True' &&
      c.observedGeneration === object.metadata.generation,
  );
export function isCorrelatedMigrationFailure(hr, document, options = {}) {
  const condition = hr.status?.conditions?.find((c) => c.type === 'Ready');
  return (
    options.allowFailedMigration === true &&
    document.spec.values.release.phase === 'migrate' &&
    condition?.status === 'False' &&
    condition.observedGeneration === hr.metadata.generation &&
    hr.status.observedGeneration === hr.metadata.generation &&
    ['UpgradeFailed', 'InstallFailed'].includes(condition.reason) &&
    /(?:job[^\n]*failed|failed[^\n]*job|backofflimitexceeded)/i.test(
      condition.message ?? '',
    ) &&
    !/(?:forbidden|unauthorized|admission|conflict|access denied|rbac)/i.test(
      condition.message ?? '',
    )
  );
}
const items = (value) => value.items ?? [value];
export function parseObjects(output) {
  const result = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    if (c === '{') {
      if (!depth) start = i;
      depth++;
    }
    if (c === '}') {
      depth--;
      if (!depth) result.push(...items(JSON.parse(output.slice(start, i + 1))));
    }
  }
  demand(
    depth === 0 && !quoted && result.length > 0,
    'Invalid kubectl JSON stream',
  );
  return result;
}
export function containsDesired(actual, desired) {
  if (desired === undefined) return true;
  if (Array.isArray(desired))
    return (
      (desired.length === 0 && actual === undefined) ||
      (Array.isArray(actual) &&
        actual.length === desired.length &&
        desired.every((v, i) => containsDesired(actual[i], v)))
    );
  if (desired && typeof desired === 'object')
    return (
      actual &&
      Object.entries(desired).every(([key, value]) =>
        containsDesired(actual[key], value),
      )
    );
  return actual === desired;
}
// Admission may add defaults, but must not add host access, API credentials or
// privilege escapes to the rendered single-container identity.
export function verifyPodEnvelope(actual, desired) {
  demand(
    actual &&
      desired &&
      containsDesired(
        {
          ...actual,
          serviceAccountName: actual.serviceAccountName ?? 'default',
          hostUsers: actual.hostUsers ?? true,
        },
        {
          ...desired,
          serviceAccountName: desired.serviceAccountName ?? 'default',
          hostUsers: desired.hostUsers ?? true,
        },
      ) &&
      actual.automountServiceAccountToken === false &&
      (actual.serviceAccountName ?? 'default') ===
        (desired.serviceAccountName ?? 'default') &&
      (actual.hostUsers ?? true) === (desired.hostUsers ?? true) &&
      !actual.shareProcessNamespace &&
      !actual.securityContext?.seLinuxOptions &&
      !actual.securityContext?.windowsOptions?.hostProcess &&
      [
        actual.securityContext?.seccompProfile,
        actual.securityContext?.appArmorProfile,
      ].every(
        (profile) => profile === undefined || profile.type === 'RuntimeDefault',
      ) &&
      !actual.hostNetwork &&
      !actual.hostPID &&
      !actual.hostIPC &&
      !actual.securityContext?.sysctls?.length &&
      (actual.securityContext?.supplementalGroups ?? []).every(
        (id) => id > 0,
      ) &&
      !actual.initContainers?.length &&
      !actual.ephemeralContainers?.length &&
      actual.containers?.length === 1 &&
      (actual.volumes ?? []).length === (desired.volumes ?? []).length &&
      actual.containers.every((container, index) => {
        const security = container.securityContext ?? {};
        return (
          !security.privileged &&
          !security.seLinuxOptions &&
          !container.ports?.some((port) => port.hostPort || port.hostIP) &&
          (container.volumeMounts ?? []).length ===
            (desired.containers[index].volumeMounts ?? []).length &&
          (security.appArmorProfile === undefined ||
            security.appArmorProfile.type === 'RuntimeDefault') &&
          security.allowPrivilegeEscalation !== true &&
          security.procMount !== 'Unmasked' &&
          !security.windowsOptions?.hostProcess &&
          !security.capabilities?.add?.length &&
          (security.seccompProfile === undefined ||
            security.seccompProfile.type === 'RuntimeDefault') &&
          (desired.securityContext?.runAsNonRoot !== true ||
            ((security.runAsUser === undefined ||
              security.runAsUser === desired.securityContext.runAsUser) &&
              (security.runAsGroup === undefined ||
                security.runAsGroup === desired.securityContext.runAsGroup) &&
              security.runAsNonRoot !== false))
        );
      }),
    'Pod security or credential envelope differs from rendered template',
  );
}
const podTemplate = (resource) =>
  resource.kind === 'CronJob'
    ? resource.spec?.jobTemplate?.spec?.template
    : resource.spec?.template;
function verifyControllerEnvelope(actual, desired) {
  const template = podTemplate(desired);
  if (template) verifyPodEnvelope(podTemplate(actual)?.spec, template.spec);
}
// Historical ReplicaSets are not relabelled when Helm adopts their Deployment.
// Only proven dormant native history may lack the ordinary instance label.
function retainedDormantReplicaSet(object, all, rendered, release, namespace) {
  const instance = 'app.kubernetes.io/instance';
  if (
    object.kind !== 'ReplicaSet' ||
    object.apiVersion !== 'apps/v1' ||
    typeof object.metadata.uid !== 'string' ||
    !object.metadata.uid ||
    Object.hasOwn(object.metadata.labels ?? {}, instance) ||
    object.metadata.namespace !== namespace ||
    object.metadata.deletionTimestamp ||
    object.spec?.replicas !== 0 ||
    [
      'replicas',
      'readyReplicas',
      'availableReplicas',
      'fullyLabeledReplicas',
      'terminatingReplicas',
    ].some((key) => (object.status?.[key] ?? 0) !== 0)
  )
    return false;
  const owners = object.metadata.ownerReferences;
  if (!Array.isArray(owners) || owners.length !== 1) return false;
  const owner = owners[0];
  if (
    owner.controller !== true ||
    owner.apiVersion !== 'apps/v1' ||
    owner.kind !== 'Deployment' ||
    typeof owner.uid !== 'string' ||
    !owner.uid
  )
    return false;
  const parent = all.find(
    (o) =>
      o.kind === 'Deployment' &&
      o.apiVersion === 'apps/v1' &&
      o.metadata.namespace === namespace &&
      o.metadata.name === owner.name &&
      o.metadata.uid === owner.uid,
  );
  const expected = rendered.find(
    (o) =>
      o.kind === 'Deployment' &&
      o.apiVersion === 'apps/v1' &&
      o.metadata.name === owner.name,
  );
  return Boolean(
    parent &&
      expected &&
      !parent.metadata.deletionTimestamp &&
      parent.metadata.labels?.[instance] === release &&
      parent.spec?.selector &&
      expected.spec?.selector &&
      hash(parent.spec?.selector) === hash(expected.spec?.selector) &&
      Object.entries(parent.spec?.selector?.matchLabels ?? {}).every(
        ([key, value]) => object.spec?.selector?.matchLabels?.[key] === value,
      ) &&
      !all.some(
        (o) =>
          o.kind === 'Pod' &&
          o.metadata.ownerReferences?.some(
            (ref) => ref.uid === object.metadata.uid,
          ),
      ),
  );
}
// Standalone runtime proofs also bind security/account/volume fields directly to
// declared values. The full rendered object is independently checked by provePhase.
function declaredPodEnvelope(workload) {
  const mounts = (workload.scratch ?? []).map(({ name, mountPath }) => ({
    name,
    mountPath,
  }));
  const volumes = (workload.scratch ?? []).map(
    ({ name, mountPath, ...emptyDir }) => ({ name, emptyDir }),
  );
  for (const binding of workload.readOnlyConfigMaps ?? []) {
    mounts.push({
      name: binding.volumeName,
      mountPath: binding.mountPath,
      readOnly: true,
    });
    volumes.push({
      name: binding.volumeName,
      configMap: { name: binding.configMapName, items: binding.items },
    });
  }
  if (workload.observerAccess) {
    mounts.push({
      name: 'smrt-observer',
      mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
      readOnly: true,
    });
    volumes.push({
      name: 'smrt-observer',
      projected: {
        defaultMode: 420,
        sources: [
          { serviceAccountToken: { path: 'token', expirationSeconds: 600 } },
          {
            configMap: {
              name: 'kube-root-ca.crt',
              items: [{ key: 'ca.crt', path: 'ca.crt' }],
            },
          },
          {
            downwardAPI: {
              items: [
                ['namespace', 'metadata.namespace'],
                ['pod-name', 'metadata.name'],
                ['pod-uid', 'metadata.uid'],
              ].map(([path, fieldPath]) => ({ path, fieldRef: { fieldPath } })),
            },
          },
        ],
      },
    });
  }
  return {
    automountServiceAccountToken: false,
    ...(workload.serviceAccountName
      ? { serviceAccountName: workload.serviceAccountName }
      : {}),
    ...(workload.podSecurityContext
      ? { securityContext: workload.podSecurityContext }
      : {}),
    containers: [
      {
        ...(workload.securityContext
          ? { securityContext: workload.securityContext }
          : {}),
        ...(mounts.length ? { volumeMounts: mounts } : {}),
      },
    ],
    ...(volumes.length ? { volumes } : {}),
  };
}
const digest = (image) => image?.match(/sha256:[a-f0-9]{64}/)?.[0];
export async function run(command, args, input) {
  try {
    const child = execFile(
      command,
      args,
      { maxBuffer: 32 * 1024 * 1024 },
      () => {},
    );
    if (input !== undefined) child.stdin.end(input);
    return await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(output) : reject(new Error('failed')),
      );
    });
  } catch {
    // Tool stderr may contain admission payloads or credentials. Never propagate it.
    throw new DeploymentError(
      `Deployment operation failed: ${['git', 'helm', 'kubectl'].includes(command) ? command : 'tool'}`,
      'OPERATION_FAILED',
    );
  }
}
export function createLiveAdapter(
  config,
  command = run,
  request = fetch,
  options = {},
) {
  const { repository, branch, file, namespace, source, kustomization, chart } =
    config;
  demand(
    repository &&
      /^[\w./-]+$/.test(branch) &&
      file &&
      /^[\w./-]+$/.test(file) &&
      !file.startsWith('-') &&
      !file.split('/').includes('..'),
    'Invalid Git configuration',
  );
  demand(
    namespace && source?.name && kustomization?.name && chart,
    'Missing Flux/chart configuration',
  );
  const git = (...args) => command('git', ['-C', repository, ...args]);
  const kube = (...args) =>
    command('kubectl', ['--namespace', namespace, ...args]);
  const json = async (...args) => JSON.parse(await kube(...args, '-o', 'json'));
  const get = async (kind, name, ns = namespace) => {
    try {
      return JSON.parse(
        await command('kubectl', [
          '--namespace',
          ns,
          'get',
          kind,
          name,
          '-o',
          'json',
        ]),
      );
    } catch {
      throw new DeploymentError(
        `Kubernetes read failed: get ${safeReference(kind)}/${safeReference(name)} namespace ${safeReference(ns)}`,
        'RESOURCE_READ',
      );
    }
  };
  async function read() {
    await git('fetch', 'origin', branch);
    const revision = (await git('rev-parse', `origin/${branch}`)).trim();
    if (!(await git('ls-tree', '--name-only', revision, '--', file)).trim())
      return { revision, document: null, raw: undefined };
    const raw = await git('show', `${revision}:${file}`);
    return { revision, document: JSON.parse(raw), raw };
  }
  // Parsing YAML uses kubectl's supported decoder. Rendering never runs shell commands.
  async function inventory(document) {
    const output = await command(
      'helm',
      [
        'template',
        document.metadata.name,
        chart,
        '--namespace',
        namespace,
        '--values',
        '-',
      ],
      JSON.stringify(document.spec.values),
    );
    return parseObjects(
      await command(
        'kubectl',
        [
          '--namespace',
          namespace,
          'create',
          '--dry-run=client',
          '-f',
          '-',
          '-o',
          'json',
        ],
        output,
      ),
    );
  }
  function bindingReferences(document) {
    const v = validate(document);
    const references = new Map();
    for (const runtime of [v.current, v.target].filter(Boolean)) {
      for (const workload of [
        ...Object.values(runtime.workloads),
        runtime.migration,
      ].filter(Boolean)) {
        for (const env of workload.env ?? []) {
          const ref = env.valueFrom?.secretKeyRef;
          if (ref) references.set(`${ref.name}/${ref.key}`, ref);
        }
      }
    }
    const b = v.bindings;
    for (const ref of [b?.database, ...(b?.privateBuckets ?? [])].filter(
      Boolean,
    ))
      references.set(`${ref.secretName}/${ref.secretKey}`, {
        name: ref.secretName,
        key: ref.secretKey,
      });
    for (const ref of JSON.parse(
      document.metadata.annotations?.[
        'smrt.happyvertical.com/binding-reference-set'
      ] ?? '[]',
    ))
      references.set(`${ref.name}/${ref.key}`, ref);
    return [...references.values()];
  }
  async function tlsBindings(
    document,
    minimumValiditySeconds = 0,
    changedNames,
  ) {
    const groups = new Map();
    for (const route of normalizedIngressRecords(
      document.spec.values,
      document.metadata.name,
    ))
      if (route.tlsSecretName) {
        const hosts = groups.get(route.tlsSecretName) ?? [];
        hosts.push(route.host);
        groups.set(route.tlsSecretName, hosts);
      }
    const result = [];
    for (const [name, hosts] of groups)
      result.push(
        await inspectTlsSecret(await get('secret', name), hosts, {
          trustedCa: options.tls?.trustedCa,
          minimumValiditySeconds:
            changedNames && !changedNames.has(name)
              ? 0
              : minimumValiditySeconds,
        }),
      );
    const marker = tlsMarker(document);
    if (marker) {
      demand(
        Array.isArray(marker.retained) && marker.retained.length <= 18,
        'Invalid retained TLS bindings',
        'TLS_TRANSITION',
      );
      const retained = marker.retained.filter(r =>
        !['complete', 'rolled-back'].includes(marker.status) ||
        result.some(actual => actual.name === r.name));
      for (const old of retained) {
        demand(
          old &&
            typeof old.name === 'string' &&
            /^[a-z][a-z0-9-]{0,62}$/.test(old.name),
          'Invalid retained TLS binding name',
          'TLS_TRANSITION',
        );
        const actual =
          result.find((r) => r.name === old.name) ??
          retainedTlsIdentity(await get('secret', old.name));
        demand(
          hash(actual) === hash(old),
          'Retained TLS immutable binding changed',
          'TLS_BINDING',
        );
        if (!result.some((r) => r.name === old.name)) result.push(actual);
      }
    }
    return result;
  }
  async function bindings(document) {
    const v = validate(document);
    const proof = [];
    for (const ref of bindingReferences(document)) {
      const secret = await get('secret', ref.name);
      demand(
        secret.immutable === true && Object.hasOwn(secret.data ?? {}, ref.key),
        'Missing immutable versioned Secret/key',
      );
      proof.push([
        ref.name,
        ref.key,
        secret.metadata.uid,
        secret.metadata.resourceVersion,
      ]);
    }
    const tlsNames = normalizedIngressRecords(v, document.metadata.name)
      .map(r => r.tlsSecretName).filter(Boolean);
    for (const name of new Set(tlsNames)) {
      const secret = await get('secret', name);
      demand(secret.immutable === true, 'TLS Secret must be immutable and versioned');
      proof.push([secret.metadata.name, secret.metadata.uid, secret.metadata.resourceVersion]);
    }
    for (const binding of [v.current, v.target]
      .filter(Boolean)
      .flatMap(readOnlyConfigBindings)) {
      const cm = await get('configmap', binding.configMapName);
      demand(
        cm.immutable === true &&
          hash({ data: cm.data ?? {}, binaryData: cm.binaryData ?? {} }) ===
            binding.hash &&
          binding.items.every(
            (item) =>
              Object.hasOwn(cm.data ?? {}, item.key) ||
              Object.hasOwn(cm.binaryData ?? {}, item.key),
          ),
        'Read-only ConfigMap immutable content/key mismatch',
      );
      proof.push([
        cm.metadata.name,
        cm.metadata.uid,
        cm.metadata.resourceVersion,
        binding.hash,
      ]);
    }
    return hash(proof.sort());
  }
  function fluxPolicy(document) {
    for (const [action, field] of [
      ['install', 'replace'],
      ['upgrade', 'force'],
      ['upgrade', 'cleanupOnFail'],
    ])
      demand(
        !document.spec[action]?.[field],
        `Unsafe HelmRelease setting: ${action}.${field} must be disabled`,
        'FLUX_POLICY',
      );
    demand(
      document.spec.driftDetection?.mode === 'enabled' &&
        !document.spec.driftDetection.ignore?.length,
      'HelmRelease driftDetection.mode must be enabled without ignored resources',
      'FLUX_POLICY',
    );
    demand(
      !document.spec.valuesFrom &&
        !document.spec.kubeConfig &&
        !document.spec.storageNamespace &&
        !document.spec.suspend &&
        !document.spec.install?.createNamespace,
      'Unsupported HelmRelease indirection/provisioning/suspension',
    );
    demand(
      document.spec.releaseName === document.metadata.name,
      'HelmRelease must explicitly use its metadata.name as releaseName',
    );
    for (const action of ['install', 'upgrade'])
      demand(
        document.spec[action]?.strategy?.name === 'RetryOnFailure' &&
          !document.spec[action].remediation,
        'Flux install/upgrade must explicitly RetryOnFailure without rollback remediation',
      );
  }
  async function chartSource(document) {
    const ref = document.spec.chartRef;
    demand(
      ref?.kind === 'OCIRepository' &&
        config.chartSource?.name === ref.name &&
        /^[a-f0-9]{64}$/.test(
          config.chartSource?.digest?.replace('sha256:', ''),
        ),
      'Require protected digest-pinned OCI chart source',
    );
    demand(
      (ref.namespace ?? namespace) ===
        (config.chartSource.namespace ?? namespace),
      'Chart source namespace mismatch',
    );
    const object = await get(
      'ocirepository',
      ref.name,
      config.chartSource.namespace,
    );
    demand(
      ready(object) && object.spec.ref?.digest === config.chartSource.digest,
      'OCI chart source has not acknowledged immutable digest',
    );
    return object;
  }
  async function preflight(document, adoptionContext, tlsContext) {
    demand(
      adoptionContext ||
        document.metadata.annotations?.[
          'smrt.happyvertical.com/adoption-status'
        ] !== 'pending',
      'Pending adoption blocks normal release preflight',
    );
    fluxPolicy(document);
    if(tlsContext){validateTlsPlan(tlsContext);validateTlsCurrent(tlsContext,document);}
    if (!adoptionContext && Object.values(document.spec.values.current?.workloads ?? {}).some(isContinuousStatic))
      await adoption.prepareReleaseWriterFence();
    const bindingProof = await bindings(document);
    demand(
      document.spec.serviceAccountName,
      'HelmRelease must declare reconciler serviceAccountName',
    );
    demand(
      !document.spec.targetNamespace ||
        document.spec.targetNamespace === namespace,
      'HelmRelease target namespace mismatch',
    );
    const impersonate = [
      `--as=system:serviceaccount:${namespace}:${document.spec.serviceAccountName}`,
      '--as-group=system:serviceaccounts',
      `--as-group=system:serviceaccounts:${namespace}`,
      '--as-group=system:authenticated',
    ];
    demand(
      config.validationEvidence?.file && config.validationEvidence.sha256,
      'Missing protected app validation evidence association',
    );
    const rawEvidence = await readFile(config.validationEvidence.file, 'utf8');
    demand(
      createHash('sha256').update(rawEvidence).digest('hex') ===
        config.validationEvidence.sha256,
      'Validation evidence content identity mismatch',
    );
    const receipt = JSON.parse(rawEvidence);
    validateRepairEvidence(document, receipt);
    const v = validate(document);
    const oci = await chartSource(document);
    demand(
      receipt.chartSourceIdentity === hash(oci.spec) &&
        receipt.chartOciDigest === config.chartSource.digest,
      'OCI chart source validation identity mismatch',
    );
    demand(
      chart.endsWith('.tgz') &&
        receipt.chartArtifactSha256 ===
          createHash('sha256')
            .update(await readFile(chart))
            .digest('hex') &&
        receipt.chartReferenceIdentity ===
          hash(document.spec.chartRef ?? document.spec.chart),
      'Packaged chart/reference validation identity mismatch',
    );
    demand(
      receipt.configurationIdentity ===
        hash({
          maintenance: v.maintenance,
          bindings: v.bindings,
          ingress: tlsContext ? tlsContext.predecessor.document.spec.values.ingress : v.ingress,
        }),
      'Application configuration validation identity mismatch',
    );
    demand(
      receipt.runtimeIdentity === hash(v.target) &&
        receipt.migrationImage === v.target.migration.image &&
        receipt.migrationCommandIdentity === hash(v.target.migration.command),
      'Validation evidence does not bind target runtime and migration command',
    );
    demand(
      receipt.migrationProtocol === 'smrt-release-v1' &&
        receipt.validation?.passed === true &&
        ['source', 'tree', 'lock', 'toolchain'].every(
          (key) => typeof receipt[key] === 'string' && receipt[key].length > 0,
        ),
      'Missing source/tree/lock/toolchain or guarded migration validation proof',
    );
    await get('ingressclass', v.ingress.className);
    const accounts = new Set(['default']);
    for (const runtime of [v.current, v.target].filter(Boolean)) {
      for (const workload of [
        ...Object.values(runtime.workloads),
        runtime.migration,
      ])
        accounts.add(workload.serviceAccountName ?? 'default');
      if (runtime.migration.observerAccess) {
        demand(
          (
            await kube(
              ...impersonate,
              'auth',
              'can-i',
              'get',
              'configmap/kube-root-ca.crt',
            )
          ).trim() === 'yes',
          'Permission denied: get observer root CA',
          'RBAC_DENIED',
        );
        const ca = await get('configmap', 'kube-root-ca.crt');
        demand(
          ca.data?.['ca.crt']?.includes('-----BEGIN CERTIFICATE-----'),
          'Missing observer root CA',
        );
        const observer = [
          `--as=system:serviceaccount:${namespace}:${runtime.migration.serviceAccountName}`,
        ];
        demand(
          (
            await kube(
              ...observer,
              'auth',
              'can-i',
              'get',
              `configmap/${document.metadata.name}-maintenance`,
            )
          ).trim() === 'yes',
          'Observer permission denied: get named maintenance ConfigMap',
          'RBAC_DENIED',
        );
        for (const resource of [
          'pods',
          'deployments.apps',
          'replicasets.apps',
          'jobs.batch',
          'cronjobs.batch',
          'statefulsets.apps',
          'daemonsets.apps',
          'horizontalpodautoscalers.autoscaling',
        ])
          for (const verb of ['get', 'list'])
            demand(
              (
                await kube(...observer, 'auth', 'can-i', verb, resource)
              ).trim() === 'yes',
              `Observer permission denied: ${verb} ${resource}`,
              'RBAC_DENIED',
            );
      }
    }
    for (const account of accounts) {
      demand(
        (
          await kube(
            ...impersonate,
            'auth',
            'can-i',
            'get',
            `serviceaccount/${account}`,
          )
        ).trim() === 'yes',
        `Permission denied: get serviceaccount/${account}`,
        'RBAC_DENIED',
      );
      const sa = await get('serviceaccount', account);
      for (const secret of sa.imagePullSecrets ?? []) {
        demand(
          (
            await kube(
              ...impersonate,
              'auth',
              'can-i',
              'get',
              `secret/${secret.name}`,
            )
          ).trim() === 'yes',
          'Permission denied: get inherited image-pull Secret',
          'RBAC_DENIED',
        );
        await get('secret', secret.name);
      }
    }
    await get('serviceaccount', document.spec.serviceAccountName);
    for (const verb of [
      'get',
      'list',
      'watch',
      'create',
      'update',
      'patch',
      'delete',
    ])
      demand(
        (
          await kube(...impersonate, 'auth', 'can-i', verb, 'secrets')
        ).trim() === 'yes',
        `Permission denied: ${verb} secrets namespace ${safeReference(namespace)} (Helm release storage)`,
        'RBAC_DENIED',
      );
    const existing = items(
      await json(
        'get',
        'pods,deployments,replicasets,jobs,cronjobs,statefulsets,daemonsets,horizontalpodautoscalers',
      ),
    );
    if (adoptionContext) {
      verifyKnownLegacyWorkloads(existing,
        { resources: adoptionContext.resources }, verifyPodEnvelope);
    } else {
      const historicalSelectors = existing.some(o => o.kind === 'ReplicaSet' &&
        !Object.hasOwn(o.metadata.labels ?? {}, 'app.kubernetes.io/instance'))
        ? await inventory(document) : [];
      demand(
        existing.every(
          (o) =>
            (o.metadata.labels?.['app.kubernetes.io/instance'] ===
              document.metadata.name || retainedDormantReplicaSet(o, existing,
                historicalSelectors, document.metadata.name, namespace)) &&
            !['StatefulSet', 'DaemonSet', 'HorizontalPodAutoscaler'].includes(
              o.kind,
            ),
        ),
        'Unknown or unsupported writer exists before maintenance',
      );
    }
    for (const phase of phases) {
      const candidate = structuredClone(document);
      candidate.spec.values.release.phase = phase;
      const resources = await inventory(candidate);
      const declaration = resources.find(
        (o) =>
          o.kind === 'ConfigMap' &&
          o.metadata.name === `${document.metadata.name}-inventory`,
      );
      demand(
        declaration?.data?.['inventory.json'],
        'Missing chart inventory declaration',
      );
      for (const secret of JSON.parse(declaration.data['inventory.json'])
        .secrets)
        demand(
          (
            await kube(
              ...impersonate,
              'auth',
              'can-i',
              'get',
              `secret/${secret.name}`,
            )
          ).trim() === 'yes',
          `Permission denied: get secret/${safeReference(secret.name)} namespace ${safeReference(namespace)}`,
          'RBAC_DENIED',
        );
      for (const resource of resources) {
        const template =
          resource.kind === 'CronJob'
            ? resource.spec?.jobTemplate?.spec?.template
            : resource.spec?.template;
        if (template) {
          demand(
            (
              await kube(...impersonate, 'auth', 'can-i', 'create', 'pods')
            ).trim() === 'yes',
            'Permission denied: create pods for admission dry-run',
            'RBAC_DENIED',
          );
          const pod = {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
              ...template.metadata,
              name: `smrt-preflight-${randomUUID()}`,
              namespace,
            },
            spec: template.spec,
          };
          try {
            const admitted = JSON.parse(
              await command(
                'kubectl',
                [
                  '--namespace',
                  namespace,
                  ...impersonate,
                  'create',
                  '--dry-run=server',
                  '-f',
                  '-',
                  '-o',
                  'json',
                ],
                JSON.stringify(pod),
              ),
            );
            demand(
              admitted.metadata?.name === pod.metadata.name &&
                containsDesired(admitted.metadata?.labels, pod.metadata.labels),
              'Pod admission changed template identity',
            );
            verifyPodEnvelope(admitted.spec, pod.spec);
          } catch {
            throw new DeploymentError(
              `Pod admission preflight failed: phase ${phase} ${safeReference(resource.kind)}/${safeReference(resource.metadata.name)}`,
              'ADMISSION_DENIED',
            );
          }
        }
        demand(
          ![
            'Secret',
            'PersistentVolumeClaim',
            'Namespace',
            'CustomResourceDefinition',
          ].includes(resource.kind),
          'Chart must not provision shared infrastructure',
        );
        const resourceName = `${resource.kind.toLowerCase()}/${resource.metadata.name}`;
        const existingResource = await command('kubectl', [
          '--namespace',
          namespace,
          ...impersonate,
          'get',
          resourceName,
          '--ignore-not-found',
          '--show-managed-fields=true',
          '-o',
          'json',
        ]);
        if (existingResource.trim()) {
          const metadata = JSON.parse(existingResource).metadata;
          demand(
            metadata?.labels?.['app.kubernetes.io/managed-by'] === 'Helm' &&
              metadata.annotations?.['meta.helm.sh/release-name'] ===
                document.metadata.name &&
              metadata.annotations?.['meta.helm.sh/release-namespace'] ===
                namespace,
            `Helm ownership conflict: ${safeReference(resourceName)} namespace ${safeReference(namespace)}; reviewed ownership transfer required`,
            'OWNERSHIP_CONFLICT',
          );
          const legacy = adoptionContext?.resources.find(
            (r) =>
              r.kind === resource.kind &&
              r.name === resource.metadata.name &&
              r.namespace === namespace,
          );
          demand(
            (legacy &&
              metadata.uid === legacy.uid &&
              metadata.annotations?.['kustomize.toolkit.fluxcd.io/prune'] ===
                'disabled' &&
              metadata.managedFields?.some(
                (entry) => entry.manager === legacy.legacyManager,
              )) ||
              metadata.managedFields?.some(
                (entry) =>
                  entry.manager === 'helm-controller' &&
                  ['Apply', 'Update'].includes(entry.operation) &&
                  entry.fieldsType === 'FieldsV1' &&
                  entry.fieldsV1 &&
                  Object.keys(entry.fieldsV1).length > 0,
              ),
            `Helm manager not established: ${safeReference(resourceName)} namespace ${safeReference(namespace)}`,
            'OWNERSHIP_CONFLICT',
          );
        }
        for (const verb of ['get', 'create', 'patch', 'delete']) {
          demand(
            (
              await kube(...impersonate, 'auth', 'can-i', verb, resourceName)
            ).trim() === 'yes',
            `Permission denied: ${verb} ${safeReference(resourceName)} namespace ${safeReference(namespace)}`,
            'RBAC_DENIED',
          );
        }
        try {
          const admitted = await command(
            'kubectl',
            [
              '--namespace',
              namespace,
              ...impersonate,
              'apply',
              '--server-side',
              '--dry-run=server',
              // Same established reconciler manager, dry run only; never force field ownership.
              '--field-manager=helm-controller',
              '-o',
              'json',
              '-f',
              '-',
            ],
            JSON.stringify(resource),
          );
          if (template)
            verifyControllerEnvelope(JSON.parse(admitted), resource);
        } catch {
          throw new DeploymentError(
            `Admission preflight failed: phase ${phase} ${safeReference(resourceName)} namespace ${safeReference(namespace)}`,
            'ADMISSION_DENIED',
          );
        }
      }
    }
    for (const kind of [
      'pods',
      'deployments',
      'replicasets',
      'jobs',
      'cronjobs',
      'endpointslices',
      'horizontalpodautoscalers',
      'statefulsets',
      'daemonsets',
      'ingresses',
      'services',
      'configmaps',
      'secrets',
    ]) {
      demand(
        (await kube('auth', 'can-i', 'list', kind)).trim() === 'yes',
        `Permission denied: list ${kind} namespace ${safeReference(namespace)} (runner)`,
        'RBAC_DENIED',
      );
    }
    for (const [kind, name, ns] of [
      ['gitrepository', source.name, source.namespace],
      ['kustomization', kustomization.name, kustomization.namespace],
      ['helmrelease', document.metadata.name, namespace],
    ])
      demand(
        (
          await command('kubectl', [
            '--namespace',
            ns ?? namespace,
            'auth',
            'can-i',
            'get',
            `${kind}/${name}`,
          ])
        ).trim() === 'yes',
        `Permission denied: get ${kind}/${safeReference(name)} namespace ${safeReference(ns ?? namespace)} (runner)`,
        'RBAC_DENIED',
      );
    return {
      bindings: bindingProof,
      bindingReferences: bindingReferences(document),
    };
  }
  async function acknowledge(document, revision, options = {}) {
    const [src, ks, hr] = await Promise.all([
      get('gitrepository', source.name, source.namespace),
      get('kustomization', kustomization.name, kustomization.namespace),
      get('helmrelease', document.metadata.name),
    ]);
    const matches = (value) =>
      typeof value === 'string' && value.endsWith(`sha1:${revision}`);
    demand(
      ready(src) && matches(src.status.artifact?.revision),
      'Flux source has not acknowledged exact Git revision',
    );
    demand(
      ready(ks) && matches(ks.status.lastAppliedRevision),
      'Flux Kustomization has not applied exact Git revision',
    );
    fluxPolicy(hr);
    await chartSource(document);
    demand(
      hash(hr.spec) === hash(document.spec),
      'Live HelmRelease spec differs from protected document',
    );
    const failedMigrationReadiness = isCorrelatedMigrationFailure(
      hr,
      document,
      options,
    );
    demand(
      (ready(hr) || failedMigrationReadiness) &&
        identity(hr) === identity(document),
      'HelmRelease has not acknowledged exact values/generation or a correlated Job failure',
      'FLUX_ACK',
    );
    const installed = JSON.parse(
      await command('helm', [
        'get',
        'values',
        document.spec.releaseName ?? document.metadata.name,
        '--namespace',
        namespace,
        '--output',
        'json',
      ]),
    );
    demand(
      hash(installed) === hash(document.spec.values),
      'Installed Helm values do not match release',
    );
  }
  async function http(
    assertions,
    v,
    maintenance,
    publicRoute = false,
    releaseName = config.helmReleaseName ?? v.app.name,
    tlsFailures = new Set(),
  ) {
    demand(assertions?.length > 0, 'Missing HTTP assertions');
    for (const assertion of assertions) {
      const url = new URL(assertion.url);
      if (maintenance || publicRoute)
        demand(
          url.hostname === v.ingress.host &&
            ['http:', 'https:'].includes(url.protocol),
          'Public HTTP assertion does not target ingress host',
        );
      else {
        const names = Object.entries(v.target.workloads)
          .filter(([, w]) => w.service)
          .map(
            ([name]) => `${releaseName}-${name}.${namespace}.svc.cluster.local`,
          );
        demand(
          names.includes(url.hostname) && url.protocol === 'http:',
          'Private HTTP assertion must use the exact runtime Service DNS',
        );
      }
      if(url.protocol==='https:'&&tlsFailures.has(url.hostname))continue;
      const response = await request(assertion.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      demand(
        (response.status === assertion.status && response.status < 500) ||
          (maintenance && response.status === 503 && assertion.status === 503),
        `HTTP status assertion failed: expected ${Number.isInteger(assertion.status) ? assertion.status : 'invalid'}, received ${Number.isInteger(response.status) ? response.status : 'invalid'}`,
        'HTTP_STATUS',
      );
      if (assertion.bodyIncludes)
        demand(
          (await response.text()).includes(assertion.bodyIncludes),
          'HTTP response assertion failed',
        );
      for (const [name, value] of Object.entries(assertion.headers ?? {}))
        demand(
          response.headers.get(name) === value,
          'HTTP header assertion failed',
        );
      if (maintenance)
        demand(
          response.headers.get('x-smrt-release') === v.release.id &&
            response.headers.get('x-smrt-sequence') ===
              String(v.release.sequence),
          'Maintenance HTTP identity mismatch',
        );
    }
  }
  async function verifyStopped(document, all, strictMaintenance = false) {
    const v = validate(document);
    const staticNames = new Set(
      Object.entries(phaseRenderedRuntime(v)?.workloads ?? {})
        .filter(([, w]) => isContinuousStatic(w))
        .map(([name]) => `${document.metadata.name}-${name}`),
    );
    const staticDeployments = all.filter(
      (o) => o.kind === 'Deployment' && staticNames.has(o.metadata.name),
    );
    const staticRS = all.filter(
      (o) =>
        o.kind === 'ReplicaSet' &&
        o.metadata.ownerReferences?.some((r) =>
          staticDeployments.some((d) => d.metadata.uid === r.uid),
        ),
    );
    const isStatic = (o) =>
      staticNames.has(o.metadata.name) ||
      (o.kind === 'ReplicaSet' && staticRS.includes(o)) ||
      (o.kind === 'Pod' &&
        o.metadata.ownerReferences?.some((r) =>
          staticRS.some((rs) => rs.metadata.uid === r.uid),
        ));
    if (staticNames.size)
      await verifyRuntime(document, all, { staticOnly: true });
    let isMaintenance = (o) =>
      o.kind === 'Deployment'
        ? o.metadata.name.endsWith('-maintenance')
        : o.metadata.name.startsWith(`${document.metadata.name}-maintenance-`);
    if (strictMaintenance) {
      const expectedMaintenance = (await inventory(document)).find(
        (o) =>
          o.kind === 'Deployment' &&
          o.metadata.name === `${document.metadata.name}-maintenance`,
      );
      const maintenanceDeployment = all.find(
        (o) =>
          o.kind === 'Deployment' &&
          o.metadata.name === `${document.metadata.name}-maintenance`,
      );
      demand(
        expectedMaintenance &&
          maintenanceDeployment &&
          containsDesired(maintenanceDeployment.spec, expectedMaintenance.spec),
        'Stopped maintenance controller differs from rendered template',
      );
      verifyControllerEnvelope(maintenanceDeployment, expectedMaintenance);
      const maintenanceRS = all.filter(
        (o) =>
          o.kind === 'ReplicaSet' &&
          o.metadata.ownerReferences?.some(
            (r) => r.uid === maintenanceDeployment.metadata.uid,
          ),
      );
      const maintenancePods = all.filter(
        (o) =>
          o.kind === 'Pod' &&
          o.metadata.ownerReferences?.some((r) =>
            maintenanceRS.some((rs) => rs.metadata.uid === r.uid),
          ),
      );
      demand(
        maintenancePods.length === expectedMaintenance.spec.replicas &&
          maintenanceDeployment.status?.observedGeneration ===
            maintenanceDeployment.metadata.generation &&
          maintenanceDeployment.status?.readyReplicas ===
            expectedMaintenance.spec.replicas,
        'Stopped maintenance runtime is not ready',
      );
      for (const pod of maintenancePods) {
        verifyPodEnvelope(pod.spec, expectedMaintenance.spec.template.spec);
        demand(
          !pod.metadata.deletionTimestamp &&
            pod.status?.conditions?.some(
              (c) => c.type === 'Ready' && c.status === 'True',
            ) &&
            digest(pod.status?.containerStatuses?.[0]?.imageID) ===
              digest(
                expectedMaintenance.spec.template.spec.containers[0].image,
              ),
          'Stopped maintenance Pod/image differs from rendered runtime',
        );
      }
      isMaintenance = (o) =>
        o === maintenanceDeployment ||
        maintenanceRS.includes(o) ||
        maintenancePods.includes(o);
    }
    for (const object of all) {
      if (isStatic(object) || isMaintenance(object)) continue;
      if (object.kind === 'CronJob')
        demand(
          object.spec.suspend === true && !object.status?.active?.length,
          'Schedule is not stopped',
        );
      if (object.kind === 'Deployment')
        demand(
          object.spec.replicas === 0 && (object.status?.replicas ?? 0) === 0,
          'Runtime deployment is not stopped',
        );
      if (object.kind === 'ReplicaSet')
        demand(
          (object.spec.replicas ?? 0) === 0 &&
            (object.status?.replicas ?? 0) === 0,
          'ReplicaSet remains active',
        );
      if (object.kind === 'Pod') {
        const ownerJob = all.find(
          (o) =>
            o.kind === 'Job' &&
            object.metadata.ownerReferences?.some(
              (r) => r.uid === o.metadata.uid,
            ),
        );
        demand(
          ownerJob &&
            ['Succeeded', 'Failed'].includes(object.status.phase) &&
            !object.metadata.deletionTimestamp,
          'Actual runtime Pod remains, including terminating Pods',
        );
      }
      if (object.kind === 'Job')
        demand((object.status?.active ?? 0) === 0, 'Job remains active');
    }
  }

  // Only the private adoption helper can select the separately fenced adoption
  // path. Public observe options cannot suppress the ordinary writer fence.
  async function provePhase(document, revision, options = {}, adoptionProof = false, tlsFailures = new Set()) {
    const v = validate(document);
    let failedMigration;
    const before = await bindings(document);
    demand(
      document.metadata.annotations?.[
        'smrt.happyvertical.com/binding-versions'
      ] === before,
      'Missing or changed pinned Secret versions',
    );
    const snapshot = await json(
      'get',
      'pods,deployments,replicasets,jobs,cronjobs,endpointslices,horizontalpodautoscalers,statefulsets,daemonsets,ingresses,services,configmaps',
    );
    const all = items(snapshot);
    for (const desired of await inventory(document)) {
      const actual = all.find(
        (o) =>
          o.kind === desired.kind && o.metadata.name === desired.metadata.name,
      );
      demand(
        actual &&
          containsDesired(actual.spec, desired.spec) &&
          containsDesired(actual.data, desired.data) &&
          containsDesired(actual.metadata.labels, desired.metadata.labels),
        'Live rendered resource/configuration differs from exact phase',
      );
      verifyControllerEnvelope(actual, desired);
    }
    const owned = (object) =>
      object.metadata.labels?.['app.kubernetes.io/instance'] ===
      document.metadata.name;
    // v1 requires a dedicated app namespace. Unknown workloads cannot silently keep writing.
    for (const object of all.filter((o) =>
      [
        'Pod',
        'Deployment',
        'ReplicaSet',
        'Job',
        'CronJob',
        'StatefulSet',
        'DaemonSet',
        'HorizontalPodAutoscaler',
      ].includes(o.kind),
    )) {
      demand(
        owned(object),
        'Unknown workload in release namespace; writer fencing uncertain',
      );
      demand(
        !['StatefulSet', 'DaemonSet', 'HorizontalPodAutoscaler'].includes(
          object.kind,
        ),
        'Unsupported writer controller',
      );
    }
    const phase = v.release.phase;
    const retained = JSON.parse(
      document.metadata.annotations?.[
        'smrt.happyvertical.com/failed-migration'
      ] ?? 'null',
    );
    if (retained) {
      const prior = all.find(
        (o) => o.kind === 'Job' && o.metadata.name === retained.name,
      );
      demand(
        prior?.metadata.uid === retained.jobUid &&
          hash(prior.spec) === retained.jobSpecIdentity &&
          prior.status?.failed > 0 &&
          !(prior.status.active > 0),
        'Retained failed migration Job identity changed or disappeared',
        'MIGRATION_RECOVERY',
      );
    }
    const knownSchedules = new Set(
      [v.current, v.target].filter(Boolean).flatMap((runtime) =>
        Object.entries(runtime.workloads)
          .filter(([, w]) => w.schedule)
          .map(([name]) => `${document.metadata.name}-${name}`),
      ),
    );
    for (const job of all.filter((o) => o.kind === 'Job')) {
      const scheduled = job.metadata.ownerReferences?.some((r) =>
        all.some(
          (o) =>
            o.kind === 'CronJob' &&
            knownSchedules.has(o.metadata.name) &&
            o.metadata.uid === r.uid,
        ),
      );
      demand(
        scheduled ||
          job.metadata.name.startsWith(`${document.metadata.name}-migration-`),
        'Unknown Job writer/drain policy',
      );
    }
    for (const object of all.filter((o) =>
      ['Deployment', 'CronJob'].includes(o.kind),
    )) {
      const labels = object.metadata.labels;
      demand(
        labels?.['smrt.happyvertical.com/release'] === v.release.id &&
          labels?.['smrt.happyvertical.com/phase'] === phase &&
          labels?.['smrt.happyvertical.com/sequence'] ===
            String(v.release.sequence),
        'Stale controller phase identity',
      );
    }
    const routes = normalizedIngressRecords(v, document.metadata.name);
    demand(
      all.filter((o) => o.kind === 'Ingress').length === routes.length,
      'Unexpected or missing ingress route',
    );
    for (const route of routes) {
      const ingress = all.find(
        (o) => o.kind === 'Ingress' && o.metadata.name === route.name,
      );
      const backend =
        phase === 'active' || route.continuousStatic
          ? `${document.metadata.name}-${route.workload}`
          : `${document.metadata.name}-maintenance`;
      demand(
        ingress?.spec.rules?.length === 1 &&
          ingress.spec.rules[0].host === route.host &&
          ingress.spec.rules[0].http?.paths?.length === 1 &&
          ingress.spec.rules[0].http.paths[0].backend?.service?.name ===
            backend,
        'Ingress routing identity mismatch',
      );
      if (route.continuousStatic && phaseRenderedRuntime(v)) {
        demand(
          config.staticAssertions?.every((a) => a.status === 200),
          'Static assertions must require HTTP 200',
        );
        await http(
          config.staticAssertions?.filter(
            (a) => new URL(a.url).hostname === route.host,
          ),
          { ...v, ingress: { ...v.ingress, host: route.host } },
          false,
          true,
          document.metadata.name,
          tlsFailures,
        );
      }
    }
    if (phase !== 'active') {
      demand(
        config.maintenanceAssertions?.every((a) => a.status === 503),
        'Maintenance assertions must require HTTP 503',
      );
      await http(config.maintenanceAssertions, v, true);
    }
    if (['stopped', 'migrate'].includes(phase)) {
      if (!adoptionProof && Object.values(phaseRenderedRuntime(v)?.workloads ?? {}).some(isContinuousStatic))
        await adoption.observeReleaseWriterFence(document, revision);
      await verifyStopped(document, all);
    }
    if (phase === 'migrate') {
      const name = `${document.metadata.name}-migration-${v.release.id}-${v.release.attempt}`;
      const job = all.find((o) => o.kind === 'Job' && o.metadata.name === name);
      demand(
        job &&
          job.spec.backoffLimit === 0 &&
          job.spec.template.spec.restartPolicy === 'Never' &&
          job.spec.ttlSecondsAfterFinished === undefined,
        'Migration attempt is missing or retryable',
      );
      if (!options.allowFailedMigration)
        demand(
          !(job.status?.failed > 0) && job.status?.succeeded === 1,
          'Migration failed or incomplete; explicit repair required',
        );
      demand(
        job.spec.template.spec.containers.length === 1 &&
          job.spec.template.spec.containers[0].image ===
            v.target.migration.image,
        'Migration Job image mismatch',
      );
      verifyPodEnvelope(
        job.spec.template.spec,
        declaredPodEnvelope(v.target.migration),
      );
      const migrationPods = all.filter(
        (o) =>
          o.kind === 'Pod' &&
          o.metadata.ownerReferences?.some((r) => r.uid === job.metadata.uid),
      );
      demand(
        migrationPods.length === 1 &&
          containsDesired(migrationPods[0].spec, job.spec.template.spec) &&
          migrationPods[0].status.containerStatuses?.length === 1 &&
          digest(migrationPods[0].status.containerStatuses[0].imageID) ===
            digest(v.target.migration.image),
        'Migration Pod imageID mismatch',
        'IMAGE_IDENTITY',
      );
      demand(
        containsDesired(
          migrationPods[0].metadata.labels,
          job.spec.template.metadata?.labels,
        ),
        'Migration Pod labels differ from Job template',
      );
      verifyPodEnvelope(migrationPods[0].spec, job.spec.template.spec);
      if (options.allowFailedMigration) {
        const pod = migrationPods[0];
        const terminated = pod.status.containerStatuses[0].state?.terminated;
        demand(
          job.metadata.uid &&
            job.status.failed > 0 &&
            !(job.status.active > 0) &&
            !job.status.succeeded &&
            job.status.conditions?.some(
              (c) => c.type === 'Failed' && c.status === 'True',
            ) &&
            pod.status.phase === 'Failed' &&
            terminated &&
            Number.isInteger(terminated.exitCode) &&
            terminated.exitCode !== 0 &&
            terminated.finishedAt,
          'Recovery requires the terminal failed migration attempt and no active writer Pods',
          'MIGRATION_RECOVERY',
        );
        failedMigration = {
          name,
          jobUid: job.metadata.uid,
          jobSpecIdentity: hash(job.spec),
          podUid: pod.metadata.uid,
          releaseId: v.release.id,
          attempt: v.release.attempt,
          targetIdentity: hash(v.target),
          image: v.target.migration.image,
        };
      }
    }
    if (['verify', 'active'].includes(phase)) {
      await verifyRuntime(document, all);
      await http(
        config.privateAssertions,
        v,
        false,
        false,
        document.metadata.name,
      );
      if (phase === 'active')
        await http(config.publicAssertions, v, false, true, document.metadata.name, tlsFailures);
    }
    demand(
      before === (await bindings(document)),
      'Secret versions changed during observation',
    );
    return {
      ...(failedMigration ? { failedMigration } : {}),
      accepted: true,
      proven: true,
      identity: identity(document),
      revision,
      bindings: before,
    };
  }
  async function cas(snapshot, document, exactPredecessor = false) {
    const latest = await read();
    demand(
      latest.raw === snapshot.raw,
      'Release CAS conflict; another release changed this file',
    );
    if(exactPredecessor)demand(latest.revision===snapshot.revision&&hash(latest.document)===hash(snapshot.document),'TLS transition predecessor CAS changed','TLS_TRANSITION');
    if (latest.revision !== snapshot.revision) {
      await git(
        'merge-base',
        '--is-ancestor',
        snapshot.revision,
        latest.revision,
      );
      demand(
        !(
          await git(
            'log',
            '--format=%H',
            `${snapshot.revision}..${latest.revision}`,
            '--',
            file,
          )
        ).trim(),
        'Release CAS conflict; superseded file history',
      );
    }
    const actual = latest.document?.spec?.values;
    if (actual && ['stopped', 'migrate'].includes(actual.release.phase) &&
        Object.values(phaseRenderedRuntime(actual)?.workloads ?? {}).some(isContinuousStatic)) {
      demand(latest.revision === snapshot.revision && hash(latest.document) === hash(snapshot.document),
        'Static writer fence CAS source snapshot changed; reobserve exact revision', 'WRITER_FENCE');
      // Candidate preflight can outlive a native observation. Refresh only the
      // published current document, before any private-index or Git publication.
      await adoption.observeReleaseWriterFence(snapshot.document, snapshot.revision);
    }
    // Build a tree from the remote parent in a private index; no shared checkout/index mutation.
    const index = `${repository}/.git-smrt-release-index-${randomUUID()}`;
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const local = async (args, input) => {
      try {
        const child = execFile('git', ['-C', repository, ...args], {
          env,
          maxBuffer: 8 * 1024 * 1024,
        });
        child.stdin.end(input);
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        return await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0
              ? resolve(output.trim())
              : reject(new Error('Git phase publication failed')),
          );
        });
      } catch {
        throw new DeploymentError(
          'Git phase publication failed',
          'GIT_PUBLICATION',
        );
      }
    };
    try {
      await local(['read-tree', latest.revision]);
      const content = `${JSON.stringify(document, null, 2)}\n`;
      const object = await local(['hash-object', '-w', '--stdin'], content);
      await local([
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${object},${file}`,
      ]);
      const tree = await local(['write-tree']);
      const revision = await local(
        ['commit-tree', tree, '-p', latest.revision],
        `Deploy ${document.spec.values.app.name} ${document.spec.values.release.id}: ${document.spec.values.release.phase}\n\nPublication: ${randomUUID()}\n`,
      );
      await git('push', 'origin', `${revision}:refs/heads/${branch}`);
      return { revision, phase: document.spec.values.release.phase };
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(index, { force: true });
    }
  }
  const tlsRuntimeTemplates = (all) =>
    all
      .filter((o) => ['Deployment', 'CronJob'].includes(o.kind))
      .map((o) => ({
        kind: o.kind,
        name: o.metadata.name,
        uid: o.metadata.uid,
        templateSha256: hash(
          o.kind === 'CronJob'
            ? o.spec.jobTemplate.spec.template
            : o.spec.template,
        ),
      }))
      .sort((a, b) =>
        `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`),
      );
  async function prepareTls(
    plan,
    status,
    rollback,
    retained,
    runtimeTemplates,
  ) {
    validateTlsPlan(plan);
    runtimeTemplates ??= tlsRuntimeTemplates(await namespaceInventory());
    if (!retained) {
      const old = await tlsBindings(plan.predecessor.document);
      const candidate = tlsDocument(
        plan,
        old,
        'pending',
        null,
        runtimeTemplates,
      );
      // Validate every new referenced leaf/chain/key/host before publication.
      const changedNames = new Set(
        plan.after
          .filter((r, i) => r.tlsSecretName !== plan.before[i].tlsSecretName)
          .map((r) => r.tlsSecretName),
      );
      const fresh = await tlsBindings(
        {
          ...candidate,
          metadata: {
            ...candidate.metadata,
            annotations: {
              ...candidate.metadata.annotations,
              [tlsAnnotation]: undefined,
            },
          },
        },
        3600,
        changedNames,
      );
      const map = new Map([...old, ...fresh].map((r) => [r.name, r]));
      retained = [...map.values()];
      const expectedNames = new Set(
        [...plan.before, ...plan.after]
          .map((r) => r.tlsSecretName)
          .filter(Boolean),
      );
      retained = retained.filter((r) => expectedNames.has(r.name));
    }
    const candidate = tlsDocument(
      plan,
      retained,
      status,
      rollback,
      runtimeTemplates,
    );
    validateTlsCurrent(plan, candidate);
    // Explicit rollback must revalidate its selected old target, independently
    // of the ordinary identity-only binding contract.
    await tlsBindings(candidate);
    await preflight(candidate, undefined, plan);
    candidate.metadata.annotations['smrt.happyvertical.com/binding-versions'] =
      await bindings(candidate);
    return candidate;
  }
  async function observeTls(document, revision) {
    demand(
      document.spec.values.release.phase === 'active',
      'TLS observation requires active runtime',
      'TLS_TRANSITION',
    );
    await acknowledge(document, revision);
    const live = await get('helmrelease', document.metadata.name);
    demand(
      live.metadata.annotations?.[tlsAnnotation] ===
        document.metadata.annotations?.[tlsAnnotation],
      'Native TLS transition marker differs from protected Git',
      'TLS_TRANSITION',
    );
    const marker = tlsMarker(document);
    const runtimeTemplates = tlsRuntimeTemplates(await namespaceInventory());
    if (marker)
      demand(
        hash(runtimeTemplates) === hash(marker.runtimeTemplates),
        'Runtime Pod templates changed during TLS transition',
        'TLS_TRANSITION',
      );
    const expected = await tlsBindings(document);
    const before = await bindings(document);
    const observations = [];
    for (const route of normalizedIngressRecords(
      document.spec.values,
      document.metadata.name,
    ).filter((r) => r.tlsSecretName)) {
      const assertions = [
        ...(config.publicAssertions ?? []),
        ...(config.staticAssertions ?? []),
      ];
      const url = assertions
        .map((a) => new URL(a.url))
        .find((u) => u.hostname === route.host && u.protocol === 'https:');
      demand(
        url,
        'HTTPS assertion required for each TLS route',
        'TLS_TRANSITION',
      );
      const service = `${document.metadata.name}-${route.workload}.${namespace}.svc.cluster.local`;
      const publicChecks = assertions.filter((a) => {
        const u = new URL(a.url);
        return u.hostname === route.host && u.protocol === 'https:';
      });
      demand(
        publicChecks.every((a) =>
          config.privateAssertions?.some((p) => {
            const u = new URL(p.url),
              target = new URL(a.url);
            return (
              u.protocol === 'http:' &&
              u.hostname === service &&
              u.pathname === target.pathname &&
              u.search === target.search &&
              Number(u.port || 80) ===
                document.spec.values.target.workloads[route.workload].service
                  .port &&
              p.status === a.status &&
              (a.bodyIncludes === undefined ||
                p.bodyIncludes === a.bodyIncludes)
            );
          }),
        ),
        'TLS routes require matching private Service HTTP assertions',
        'TLS_TRANSITION',
      );
      try {
        observations.push(
          await servedTlsIdentity(
            route.host,
            Number(url.port || 443),
            expected.find((r) => r.name === route.tlsSecretName).leafSha256,
            options.tls,
          ),
        );
      } catch {
        demand(
          false,
          'Native TLS transport unavailable; failure is not correlated',
          'TLS_TRANSPORT',
        );
      }
    }
    const failed = observations.filter((o) => o.code);
    const phaseProof = await provePhase(
      document,
      revision,
      {},
      false,
      new Set(
        failed.filter((o) => o.code !== 'TLS_CERTIFICATE').map((o) => o.host),
      ),
    );
    demand(
      before === (await bindings(document)),
      'TLS bindings changed during observation',
      'TLS_BINDING',
    );
    await acknowledge(document, revision);
    demand(
      observations.every(
        (o) => o.observedAt >= Date.now() - 30000 && o.observedAt <= Date.now(),
      ),
      'TLS observations expired during native phase proof',
      'TLS_TRANSPORT',
    );
    demand(
      hash(runtimeTemplates) ===
        hash(tlsRuntimeTemplates(await namespaceInventory())),
      'Runtime Pod templates changed during TLS observation',
      'TLS_TRANSITION',
    );
    if (!failed.length)
      return {
        ...phaseProof,
        accepted: true,
        proven: true,
        revision,
        documentSha256: hash(document),
        observedAt: Date.now(),
        observations,
        runtimeTemplates,
      };
    demand(
      marker?.identity,
      'Uncorrelated predecessor TLS identity failure',
      'TLS_TRANSPORT',
    );
    const changed = new Set(
      marker.after
        .filter((r, i) => r.tlsSecretName !== marker.before[i]?.tlsSecretName)
        .map((r) => r.host),
    );
    demand(
      failed.every((r) => changed.has(r.host)),
      'TLS failure affects an unchanged route; rollback is unrelated',
      'TLS_TRANSPORT',
    );
    return {
      accepted: true,
      proven: false,
      identity: identity(document),
      revision,
      bindings: before,
      failureCode: 'TLS_CORRELATED_FAILURE',
      tlsFailure: {
        transitionIdentity: marker.identity,
        documentSha256: hash(document),
        revision,
        bindings: before,
        hosts: failed,
        observedAt: Date.now(),
      },
    };
  }
  const namespaceInventory = async () =>
    items(
      await json(
        'get',
        'pods,deployments,replicasets,jobs,cronjobs,endpointslices,horizontalpodautoscalers,statefulsets,daemonsets,ingresses,services,configmaps',
      ),
    );
  const adoption = createAdoptionMethods(
    config,
    command,
    {
      get,
      bindings,
      inventory,
      preflight,
      acknowledge,
      provePhase: (document, revision) => provePhase(document, revision, {}, true),
      namespaceInventory,
      verifyPodEnvelope,
      verifyStopped: (d, all) => verifyStopped(d, all, true),
      maintenance: async (d) => {
        const v = validate(d);
        demand(
          config.maintenanceAssertions?.every((a) => a.status === 503),
          'Maintenance assertions must require HTTP 503',
        );
        await http(config.maintenanceAssertions, v, true);
        demand(
          !normalizedIngressRecords(v, d.metadata.name).some(
            (r) => r.continuousStatic,
          ) || !phaseRenderedRuntime(v) || config.staticAssertions?.every((a) => a.status === 200),
          'Static assertions must require HTTP 200',
        );
        for (const route of normalizedIngressRecords(v, d.metadata.name).filter(
          (r) => r.continuousStatic && phaseRenderedRuntime(v),
        ))
          await http(
            config.staticAssertions?.filter(
              (a) => new URL(a.url).hostname === route.host,
            ),
            { ...v, ingress: { ...v.ingress, host: route.host } },
            false,
            true,
          );
      },
      helmOwner: (o, name, ns) =>
        demand(
          o.metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' &&
            o.metadata.annotations?.['meta.helm.sh/release-name'] === name &&
            o.metadata.annotations?.['meta.helm.sh/release-namespace'] === ns &&
            o.metadata.managedFields?.some(
              (entry) =>
                entry.manager === 'helm-controller' &&
                entry.fieldsType === 'FieldsV1' &&
                Object.keys(entry.fieldsV1 ?? {}).length > 0,
            ),
          'Adopted Helm ownership/manager not established',
        ),
    },
    options,
  );
  return {
    ...adoption,
    read,
    preflight,
    cas,
    prepareTls,
    observeTls,
    casTls:(snapshot,document)=>cas(snapshot,document,true),
    observe: async (document, revision, options = {}) => {
      await acknowledge(document, revision, options);
      let result;
      try {
        const marker = tlsMarker(document);
        result = document.spec.values.release.phase === 'active' && marker &&
          !['complete', 'rolled-back'].includes(marker.status)
          ? await observeTls(document,revision)
          : await provePhase(document, revision, options);
      } catch (error) {
        if (options.allowFailedMigration) throw error;
        result = {
          accepted: true,
          proven: false,
          identity: identity(document),
          revision,
          failure:
            error instanceof DeploymentError
              ? error.message
              : 'Live phase proof failed; inspect cluster using privileged diagnostics',
          failureCode:
            error instanceof DeploymentError
              ? error.code
              : 'UNKNOWN_PROOF_FAILURE',
        };
      }
      // Health failures can authorize recovery only while this exact phase is accepted.
      await acknowledge(document, revision, options);
      return result;
    },
  };
}

export async function verifyRuntime(document, all, options = {}) {
  const v = validate(document);
  const runtime = options.staticOnly ? phaseRenderedRuntime(v) : v.target;
  const prefix = document.metadata.name;
  const scheduled = Object.entries(runtime?.workloads ?? {}).filter(
    ([, w]) => w.schedule && !options.staticOnly,
  );
  const cronjobs = all.filter(
    (o) => o.kind === 'CronJob' && !options.staticOnly,
  );
  demand(
    cronjobs.length === scheduled.length,
    'Unexpected or missing scheduled workload',
  );
  for (const [name, workload] of scheduled) {
    const cron = cronjobs.find((o) => o.metadata.name === `${prefix}-${name}`);
    demand(
      cron &&
        cron.spec.schedule === workload.schedule &&
        cron.spec.suspend === (v.release.phase !== 'active') &&
        cron.spec.concurrencyPolicy === 'Forbid',
      'Schedule state mismatch',
    );
    verifyPodEnvelope(
      cron.spec.jobTemplate.spec.template.spec,
      declaredPodEnvelope(workload),
    );
    const container = cron.spec.jobTemplate.spec.template.spec.containers;
    demand(
      container.length === 1 &&
        container[0].image === workload.image &&
        hash(container[0].command) === hash(workload.command),
      'Scheduled runtime identity mismatch',
    );
    const activeJobs = all.filter(
      (o) =>
        o.kind === 'Job' &&
        o.status?.active > 0 &&
        o.metadata.ownerReferences?.some(
          (owner) => owner.uid === cron.metadata.uid,
        ),
    );
    for (const job of activeJobs) {
      demand(
        containsDesired(
          job.spec?.template?.spec,
          cron.spec.jobTemplate.spec.template.spec,
        ),
        'Active scheduled Job differs from CronJob template',
      );
      verifyPodEnvelope(
        job.spec.template.spec,
        cron.spec.jobTemplate.spec.template.spec,
      );
      for (const pod of all.filter(
        (o) =>
          o.kind === 'Pod' &&
          o.metadata.ownerReferences?.some(
            (owner) => owner.uid === job.metadata.uid,
          ),
      ))
        verifyPodEnvelope(pod.spec, job.spec.template.spec);
    }
    if (v.release.phase === 'verify')
      demand(
        !cron.status?.active?.length && !activeJobs.length,
        'Schedule started during verify',
      );
  }
  const expected = Object.entries(runtime?.workloads ?? {}).filter(
    ([, w]) => !w.schedule && (!options.staticOnly || isContinuousStatic(w)),
  );
  const deployments = all.filter(
    (o) =>
      o.kind === 'Deployment' &&
      !o.metadata.name.endsWith('-maintenance') &&
      (!options.staticOnly ||
        expected.some(([name]) => o.metadata.name === `${prefix}-${name}`)),
  );
  demand(
    deployments.length === expected.length,
    'Unexpected or missing runtime deployment',
  );
  for (const [name, workload] of expected) {
    const deployment = deployments.find(
      (o) => o.metadata.name === `${prefix}-${name}`,
    );
    demand(
      deployment &&
        deployment.status?.observedGeneration ===
          deployment.metadata.generation &&
        deployment.status?.updatedReplicas === workload.replicas &&
        deployment.status?.readyReplicas === workload.replicas &&
        deployment.status?.replicas === workload.replicas,
      'Runtime generation is not ready',
      'READINESS',
    );
    verifyPodEnvelope(
      deployment.spec?.template?.spec,
      declaredPodEnvelope(workload),
    );
    demand(
      hash(deployment.spec?.selector?.matchLabels ?? {}) ===
        hash(effectiveWorkloadSelectors(prefix, name, workload)),
      'Runtime selector identity mismatch',
    );
    const rs = all.filter(
      (o) =>
        o.kind === 'ReplicaSet' &&
        o.metadata.ownerReferences?.some(
          (r) => r.uid === deployment.metadata.uid,
        ),
    );
    const pods = all.filter(
      (o) =>
        o.kind === 'Pod' &&
        o.metadata.ownerReferences?.some((r) =>
          rs.some((rset) => rset.metadata.uid === r.uid),
        ),
    );
    demand(pods.length === workload.replicas, 'Wrong runtime Pod set');
    for (const pod of pods) {
      demand(
        deployment.spec?.template?.spec &&
          containsDesired(pod.spec, deployment.spec.template.spec),
        'Pod configuration differs from current Deployment template',
      );
      verifyPodEnvelope(pod.spec, deployment.spec.template.spec);
      demand(
        !pod.metadata.deletionTimestamp &&
          pod.status?.conditions?.some(
            (c) => c.type === 'Ready' && c.status === 'True',
          ),
        'Pod is not ready',
        'READINESS',
      );
      demand(
        pod.spec.containers.length === 1 &&
          pod.spec.containers[0].image === workload.image &&
          pod.status.containerStatuses?.length === 1 &&
          digest(pod.status.containerStatuses[0].imageID) ===
            digest(workload.image),
        'Runtime imageID mismatch',
        'IMAGE_IDENTITY',
      );
    }
    if (workload.service) {
      const endpoints = all
        .filter(
          (o) =>
            o.kind === 'EndpointSlice' &&
            o.metadata.labels?.['kubernetes.io/service-name'] ===
              `${prefix}-${name}`,
        )
        .flatMap((o) => o.endpoints ?? []);
      demand(
        endpoints.length === pods.length &&
          new Set(endpoints.map((e) => e.targetRef?.uid)).size ===
            pods.length &&
          endpoints.every(
            (e) =>
              e.conditions?.ready === true &&
              e.conditions?.terminating !== true &&
              pods.some((p) => p.metadata.uid === e.targetRef?.uid),
          ),
        'Ready EndpointSlice Pod UID mismatch',
      );
    }
  }
}
