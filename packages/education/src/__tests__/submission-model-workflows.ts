import { AssetCollection } from '@happyvertical/smrt-assets';
import { expect } from 'vitest';
import {
  AttestationCollection,
  ExternalCompletionCollection,
  GradeCollection,
  ScannedSubmissionCollection,
  SubmissionAssetCollection,
  SubmissionIntakeBindingCollection,
} from '../collections.js';
import {
  Attestation,
  ExternalCompletion,
  Grade,
  ScannedSubmission,
  SubmissionIntakeBinding,
} from '../submissions.js';
import type { learnerFixture } from './learner-workflows.js';

type Fixture = Awaited<ReturnType<typeof learnerFixture>>;

export async function assertSubmissionModels(f: Fixture): Promise<void> {
  const { as, own, service, enrollment, lesson, secondLesson } = f;
  const progress = await as(own, () =>
    service.startLesson({
      ...own,
      enrollmentId: String(enrollment.id),
      lessonId: String(lesson.id),
    }),
  );
  const input = {
    tenantId: own.tenantId,
    learnerId: own.learnerId,
    lessonId: String(lesson.id),
    progressId: String(progress.id),
  };
  const scans = await ScannedSubmissionCollection.create({ db: f.db });
  const externals = await ExternalCompletionCollection.create({ db: f.db });
  const attestations = await AttestationCollection.create({ db: f.db });
  const scanned = await as(own, () =>
    scans.create({
      ...input,
      pageCount: 2,
      captureKey: 'capture-1',
      captureDigest: 'a'.repeat(64),
    }),
  );
  const external = await as(own, () =>
    externals.create({
      ...input,
      reportedBy: 'source',
      reportedScore: 0.0,
    }),
  );
  const attestation = await as(own, () => attestations.create(input));
  expect(scanned).toBeInstanceOf(ScannedSubmission);
  expect(external).toBeInstanceOf(ExternalCompletion);
  expect(attestation).toBeInstanceOf(Attestation);
  expect(scanned.captureKey).toBe('capture-1');
  expect(new ScannedSubmission().captureKey).toBe('');
  expect(new ScannedSubmission().captureDigest).toBe('');

  const bindings = await SubmissionIntakeBindingCollection.create({ db: f.db });
  scanned.intakeItemId = 'receipt-one';
  await as(own, () => scanned.save());
  const binding = await as(own, () =>
    bindings.create({
      tenantId: own.tenantId,
      intakeItemId: 'receipt-one',
      submissionId: String(scanned.id),
      _insertOnly: true,
    }),
  );
  expect(binding).toBeInstanceOf(SubmissionIntakeBinding);
  const duplicate = await as(own, () =>
    scans.create({
      ...input,
      pageCount: 1,
      captureKey: 'capture-duplicate-intake',
      captureDigest: 'b'.repeat(64),
      intakeItemId: 'receipt-one',
    }),
  );
  await expect(
    as(own, () =>
      bindings.create({
        tenantId: own.tenantId,
        intakeItemId: 'receipt-one',
        submissionId: String(duplicate.id),
        _insertOnly: true,
      }),
    ),
  ).rejects.toThrow();

  scanned.setExtracted({ answer: { value: '7', confidence: 0.9 } });
  expect(scanned.getExtracted()).toMatchObject({ answer: { value: '7' } });
  scanned.extracted = '[]';
  expect(scanned.getExtracted()).toEqual({});
  expect(() =>
    scanned.setExtracted([] as unknown as Record<string, unknown>),
  ).toThrow('Extracted answers must be an object');
  scanned.pageCount = -1;
  await expect(as(own, () => scanned.save())).rejects.toThrow('Page count');
  scanned.pageCount = 2;
  scanned.status = 'unknown' as never;
  await expect(as(own, () => scanned.save())).rejects.toThrow(
    'Invalid education',
  );
  scanned.status = 'captured';
  const secondProgress = await as(own, () =>
    service.startLesson({
      ...own,
      enrollmentId: String(enrollment.id),
      lessonId: String(secondLesson.id),
    }),
  );
  scanned.lessonId = String(secondLesson.id);
  scanned.progressId = String(secondProgress.id);
  await expect(as(own, () => scanned.save())).rejects.toThrow(
    'identity cannot change',
  );
  scanned.lessonId = input.lessonId;
  scanned.progressId = input.progressId;

  external.reportedBy = 'invalid' as never;
  await expect(as(own, () => external.save())).rejects.toThrow(
    'Invalid education',
  );
  external.reportedBy = 'source';
  external.reportedScore = Number.NaN;
  await expect(as(own, () => external.save())).rejects.toThrow(
    'Reported score',
  );

  const assets = await AssetCollection.create({ db: f.db });
  const files = await as(own, () =>
    Promise.all([
      assets.create({
        tenantId: own.tenantId,
        name: 'owned scan',
        sourceUri: 'file:///owned-scan.jpg',
        ownerProfileId: String(f.alice.profile.id),
      }),
      assets.create({
        tenantId: own.tenantId,
        name: 'sibling scan',
        sourceUri: 'file:///sibling-scan.jpg',
        ownerProfileId: String(f.bob.profile.id),
      }),
    ]),
  );
  const links = await SubmissionAssetCollection.create({ db: f.db });
  const link = await as(own, () =>
    links.create({
      tenantId: own.tenantId,
      submissionId: String(scanned.id),
      assetId: String(files[0].id),
      relationship: 'page',
    }),
  );
  expect(link.relationship).toBe('page');
  await expect(
    as(own, () =>
      links.create({
        tenantId: own.tenantId,
        submissionId: String(scanned.id),
        assetId: String(files[1].id),
        relationship: 'attachment',
      }),
    ),
  ).rejects.toThrow('learner profile');
  const invalidAsset = await as(own, () =>
    assets.create({
      tenantId: own.tenantId,
      name: 'invalid scan link',
      sourceUri: 'file:///invalid-scan-link.jpg',
      ownerProfileId: String(f.alice.profile.id),
    }),
  );
  await expect(
    as(own, () =>
      links.create({
        tenantId: own.tenantId,
        submissionId: String(scanned.id),
        assetId: String(invalidAsset.id),
        relationship: 'invalid' as never,
      }),
    ),
  ).rejects.toThrow('Invalid education');

  const grades = await GradeCollection.create({ db: f.db });
  const auto = await as(own, () =>
    grades.create({ ...input, submissionId: String(scanned.id), score: null }),
  );
  const ai = await as(own, () =>
    grades.create({
      tenantId: own.tenantId,
      submissionId: String(scanned.id),
      graderKind: 'ai',
      score: 0.0,
    }),
  );
  const guardian = await as(own, () =>
    grades.create({
      tenantId: own.tenantId,
      submissionId: String(scanned.id),
      graderKind: 'guardian',
      score: 1,
    }),
  );
  const instructor = await as(own, () =>
    grades.create({
      tenantId: own.tenantId,
      submissionId: String(scanned.id),
      graderKind: 'instructor',
      pointsEarned: 3,
      pointsPossible: 3,
    }),
  );
  for (const grade of [auto, ai, guardian, instructor])
    expect(grade).toBeInstanceOf(Grade);
  expect(auto.score).toBeNull();
  expect(ai.score).toBe(0);
  guardian.setRubricResults({ accuracy: { earned: 1 } });
  expect(guardian.getRubricResults()).toMatchObject({
    accuracy: { earned: 1 },
  });
  guardian.rubricResults = '[]';
  expect(guardian.getRubricResults()).toEqual({});
  expect(() =>
    guardian.setRubricResults([] as unknown as Record<string, unknown>),
  ).toThrow('Rubric results must be an object');
  ai.score = 1.1;
  await expect(as(own, () => ai.save())).rejects.toThrow('Score');
  instructor.pointsEarned = 1.5;
  await expect(as(own, () => instructor.save())).rejects.toThrow(
    'Points earned',
  );
  instructor.pointsEarned = 4;
  await expect(as(own, () => instructor.save())).rejects.toThrow(
    'cannot exceed',
  );
}
