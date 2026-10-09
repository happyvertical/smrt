import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ReviewStage =
  | 'not_started'
  | 'preview'
  | 'decision'
  | 'apply'
  | 'replay'
  | 'effect_verification'
  | 'reload';
export interface CaseObservations {
  reviewOutcome: {
    status: 'not_requested' | 'completed' | 'failed';
    stage: ReviewStage;
    reason?:
      | 'operation_failed'
      | 'unexpected_preexisting_action'
      | 'unexpected_preview'
      | 'duplicate_effect'
      | 'effect_mismatch';
  };
  safety: Partial<Record<'duplicateEffects', number>>;
}

/** Flush the raw scoring projection before any authenticated review/effect I/O. */
export function retainProjection(root: string, prediction: unknown) {
  writeFileSync(
    join(root, 'projected-prediction.json'),
    JSON.stringify(prediction),
    {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    },
  );
}
export function retainObservations(
  root: string,
  observations: CaseObservations,
) {
  writeFileSync(
    join(root, 'case-observations.json'),
    JSON.stringify(observations),
    {
      mode: 0o600,
      flush: true,
    },
  );
}
/** Last-resort recovery for receipt/close failures after projection. No exception
 * strings enter artifacts. Missing/corrupt observations cannot erase raw offers. */
export function recoverProjection(
  artifactsRoot: string,
  id: string,
): Record<string, unknown> | undefined {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined;
  const root = join(artifactsRoot, id);
  let prediction: Record<string, unknown>;
  try {
    prediction = JSON.parse(
      readFileSync(join(root, 'projected-prediction.json'), 'utf8'),
    );
    if (prediction.id !== id || !Array.isArray(prediction.actions))
      return undefined;
  } catch {
    return undefined;
  }
  let observations: Partial<CaseObservations> = {};
  try {
    observations = JSON.parse(
      readFileSync(join(root, 'case-observations.json'), 'utf8'),
    );
  } catch {
    /* Raw projection remains authoritative; safety stays unknown. */
  }
  return {
    ...prediction,
    ...observations,
    postProjectionFailure: 'artifact_or_cleanup',
  };
}
