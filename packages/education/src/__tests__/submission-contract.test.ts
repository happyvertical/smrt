import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  Attestation,
  ExternalCompletion,
  Grade,
  ScannedSubmission,
  Submission,
  SubmissionAsset,
  SubmissionService,
} from '../index.js';

describe('submission public contract', () => {
  it.each([
    Submission,
    ScannedSubmission,
    ExternalCompletion,
    Attestation,
    SubmissionAsset,
    Grade,
  ])('closes generated operations for %s', (Model) => {
    expect(
      ObjectRegistry.getClassInPackage(
        '@happyvertical/smrt-education',
        Model.name,
      )?.config,
    ).toMatchObject({ api: false, cli: false, mcp: false });
  });
  it('exports the owning service and nullable grading default', () => {
    expect(SubmissionService).toBeTypeOf('function');
    expect(new Grade().score).toBeNull();
  });
});
