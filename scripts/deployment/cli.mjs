#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createLiveAdapter } from './live.mjs';
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
    ['plan', 'apply-or-resume', 'status', 'recover', 'repair'].includes(
      operation,
    ) && configuration,
    'Usage: cli.mjs plan|apply-or-resume|status|recover|repair config.json [target-runtime.json|plan.json] [release-id]',
  );
  const config = JSON.parse(await readFile(configuration, 'utf8'));
  const adapter = adapterFactory(config);
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
