#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  planTlsRotation,
  applyTlsRotation,
  rollbackTlsRotation,
  assertTlsSettled,
} from './tls.mjs';
import { createLiveAdapter } from './live.mjs';
import {
  planAdoption,
  adoptOrResume,
  validateAdoptionPlan,
  validateAdoptionState,
} from './adopt.mjs';
import {
  DeploymentError,
  applyOrResume,
  demand,
  planRelease,
  repair,
  validate,
} from './release.mjs';

export async function main(args, adapterFactory = createLiveAdapter) {
  const [operation, configuration, input, releaseId] = args;
  demand(
    [
      'tls-plan',
      'tls-apply-or-resume',
      'tls-rollback',
      'plan',
      'apply-or-resume',
      'status',
      'recover',
      'repair',
      'adopt-plan',
      'adopt-or-resume',
      'adopt-status',
    ].includes(operation) && configuration,
    'Usage: cli.mjs plan|apply-or-resume|status|recover|repair|adopt-plan|adopt-or-resume|adopt-status|tls-plan|tls-apply-or-resume|tls-rollback config.json [target-runtime.json|plan.json] [release-id]',
  );
  const config = JSON.parse(await readFile(configuration, 'utf8'));
  const adapter = await adapterFactory(config);
  if (operation.startsWith('adopt-')) {
    demand(input, 'Adoption commands require the reviewed plan file');
    const plan = validateAdoptionPlan(
      JSON.parse(await readFile(input, 'utf8')),
    );
    if (operation === 'adopt-plan') return planAdoption(config, adapter, plan);
    if (operation === 'adopt-or-resume')
      return adoptOrResume(config, adapter, plan);
    const snapshot = await adapter.readAdoption(plan);
    await adapter.qualifyAdoption(plan, snapshot);
    if (snapshot.state) validateAdoptionState(plan, snapshot.state);
    return {
      revision: snapshot.revision,
      state: snapshot.state,
      canonical: Boolean(snapshot.canonical),
      staging: Boolean(snapshot.staging),
    };
  }
  if (operation.startsWith('tls-')) {
    demand(input, 'TLS operation requires a reviewed input', 'TLS_TRANSITION');
    if (adapter.assertAdoptionComplete)
      await adapter.assertAdoptionComplete(await adapter.read());
    const value = JSON.parse(await readFile(input, 'utf8'));
    if (operation === 'tls-plan')
      return planTlsRotation(await adapter.read(), value, releaseId);
    return operation === 'tls-rollback'
      ? rollbackTlsRotation(config, adapter, value)
      : applyTlsRotation(config, adapter, value);
  }
  if (operation !== 'status') assertTlsSettled((await adapter.read()).document);
  if (operation !== 'status' && adapter.assertAdoptionComplete)
    await adapter.assertAdoptionComplete(await adapter.read());
  if (operation === 'plan') {
    const snapshot = await adapter.read();
    const target = JSON.parse(await readFile(input, 'utf8'));
    if (!snapshot.document) {
      demand(
        target?.spec?.values?.current === false &&
          target.spec.values.release.phase === 'maintenance' &&
          target.spec.values.release.sequence === 0,
        'Bootstrap input must be a complete maintenance HelmRelease with current:false, sequence:0',
      );
      validate(target);
      return target;
    }
    return planRelease(snapshot.document, target, releaseId);
  }
  if (operation === 'repair')
    return repair(config, adapter, JSON.parse(await readFile(input, 'utf8')));
  if (operation === 'status') {
    const snapshot = await adapter.read();
    return {
      revision: snapshot.revision,
      release: snapshot.document.spec.values.release,
      evidence: await adapter.observe(snapshot.document, snapshot.revision),
    };
  }
  return applyOrResume(config, adapter, {
    planned: input ? JSON.parse(await readFile(input, 'utf8')) : undefined,
    recovery: operation === 'recover',
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error) => {
      process.stderr.write(
        error instanceof DeploymentError
          ? `${error.code}: ${error.message}\n`
          : 'Deployment command failed; inspect protected configuration and cluster diagnostics.\n',
      );
      process.exitCode = 1;
    });
}
