import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DeploymentError,
  demand,
  hash,
  identity,
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
export function createLiveAdapter(config, command = run, request = fetch) {
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
    if (v.ingress.tlsSecretName) {
      const secret = await get('secret', v.ingress.tlsSecretName);
      demand(
        secret.immutable === true,
        'TLS Secret must be immutable and versioned',
      );
      proof.push([
        secret.metadata.name,
        secret.metadata.uid,
        secret.metadata.resourceVersion,
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
  async function preflight(document) {
    fluxPolicy(document);
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
          ingress: v.ingress,
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
    await get('serviceaccount', 'default');
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
    demand(
      existing.every(
        (o) =>
          o.metadata.labels?.['app.kubernetes.io/instance'] ===
            document.metadata.name &&
          !['StatefulSet', 'DaemonSet', 'HorizontalPodAutoscaler'].includes(
            o.kind,
          ),
      ),
      'Unknown or unsupported writer exists before maintenance',
    );
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
          demand(
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
          await command(
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
              '-f',
              '-',
            ],
            JSON.stringify(resource),
          );
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
  async function observe(document, revision, options = {}) {
    const v = validate(document);
    await acknowledge(document, revision, options);
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
    const ingress = all.find(
      (o) => o.kind === 'Ingress' && o.metadata.name === document.metadata.name,
    );
    const web = Object.entries(v.target.workloads).find(
      ([, w]) => w.role === 'web',
    );
    const route =
      phase === 'active'
        ? `${document.metadata.name}-${web?.[0]}`
        : `${document.metadata.name}-maintenance`;
    demand(
      ingress?.spec.rules?.length === 1 &&
        ingress.spec.rules[0].host === v.ingress.host &&
        ingress.spec.rules[0].http?.paths?.length === 1 &&
        ingress.spec.rules[0].http.paths[0].backend?.service?.name === route,
      'Ingress routing identity mismatch',
    );
    if (phase !== 'active') await http(config.maintenanceAssertions, v, true);
    if (['stopped', 'migrate'].includes(phase)) {
      for (const object of all) {
        if (object.kind === 'CronJob')
          demand(
            object.spec.suspend === true && !object.status?.active?.length,
            'Schedule is not stopped',
          );
        if (
          object.kind === 'Deployment' &&
          !object.metadata.name.endsWith('-maintenance')
        )
          demand(
            object.spec.replicas === 0 && (object.status?.replicas ?? 0) === 0,
            'Runtime deployment is not stopped',
          );
        if (
          object.kind === 'ReplicaSet' &&
          !object.metadata.name.startsWith(
            `${document.metadata.name}-maintenance-`,
          )
        )
          demand(
            (object.spec.replicas ?? 0) === 0 &&
              (object.status?.replicas ?? 0) === 0,
            'ReplicaSet remains active',
          );
        if (
          object.kind === 'Pod' &&
          !object.metadata.name.startsWith(
            `${document.metadata.name}-maintenance-`,
          )
        ) {
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
        await http(config.publicAssertions, v, false, true);
    }
    demand(
      before === (await bindings(document)),
      'Secret versions changed during observation',
    );
    await acknowledge(document, revision, options);
    return {
      ...(failedMigration ? { failedMigration } : {}),
      accepted: true,
      proven: true,
      identity: identity(document),
      revision,
      bindings: before,
    };
  }
  async function cas(snapshot, document) {
    const latest = await read();
    demand(
      latest.raw === snapshot.raw,
      'Release CAS conflict; another release changed this file',
    );
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
  return {
    read,
    preflight,
    cas,
    observe: async (document, revision, options = {}) => {
      if (options.allowFailedMigration)
        return observe(document, revision, options);
      await acknowledge(document, revision);
      try {
        return await observe(document, revision);
      } catch (error) {
        return {
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
    },
  };
}

export async function verifyRuntime(document, all) {
  const v = validate(document);
  const prefix = document.metadata.name;
  const scheduled = Object.entries(v.target.workloads).filter(
    ([, w]) => w.schedule,
  );
  const cronjobs = all.filter((o) => o.kind === 'CronJob');
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
    const container = cron.spec.jobTemplate.spec.template.spec.containers;
    demand(
      container.length === 1 &&
        container[0].image === workload.image &&
        hash(container[0].command) === hash(workload.command),
      'Scheduled runtime identity mismatch',
    );
    if (v.release.phase === 'verify')
      demand(!cron.status?.active?.length, 'Schedule started during verify');
  }
  const expected = Object.entries(v.target.workloads).filter(
    ([, w]) => !w.schedule,
  );
  const deployments = all.filter(
    (o) => o.kind === 'Deployment' && !o.metadata.name.endsWith('-maintenance'),
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
