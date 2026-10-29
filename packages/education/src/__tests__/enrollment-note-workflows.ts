import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { EnrollmentNoteService } from '../enrollment-note-service.js';
import {
  ENROLLMENT_NOTE_MAX_LENGTH,
  EnrollmentParentNoteCollection,
} from '../enrollment-notes.js';
import { LearnerAuthorizationError } from '../learner-service.js';
import type { learnerFixture } from './learner-workflows.js';

type Fixture = Awaited<ReturnType<typeof learnerFixture>>;

function noteFixture(f: Fixture) {
  const calls: Parameters<
    ConstructorParameters<typeof EnrollmentNoteService>[1]
  >[0][] = [];
  let allowed = true;
  const service = new EnrollmentNoteService(
    f.db,
    (request) => {
      calls.push(request);
      return allowed && request.relationshipTypeId === f.guardianType.id;
    },
    () => true,
  );
  const request = {
    ...f.parent,
    enrollmentId: String(f.enrollment.id),
    text: 'Read chapter two together.\nTry again tomorrow.',
    requestKey: 'parent-note-1',
  };
  return {
    service,
    calls,
    request,
    revoke: () => {
      allowed = false;
    },
  };
}

export async function assertEnrollmentNoteAuthority(f: Fixture) {
  const { service, request, revoke } = noteFixture(f);
  const add = () => service.addEnrollmentNote(request);
  await expect(add()).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await f.as(f.parent, add);
  const own = { ...request, ...f.own };
  // Even a permissive host cannot grant a learner their own guardian action.
  const permissive = new EnrollmentNoteService(
    f.db,
    () => true,
    () => true,
  );
  for (const input of [
    own,
    { ...request, learnerId: String(f.sibling.id) },
    { ...request, learnerId: String(f.foreign.id) },
    { ...request, tenantId: f.foreign.tenantId },
    { ...request, enrollmentId: String(f.curriculum.id) },
    { ...request, guardianRelationshipId: undefined },
    { ...request, actorUserId: String(f.bob.user.id) },
  ]) {
    await f.as(input, async () => {
      await expect(
        permissive.listEnrollmentNotes(input),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      await expect(permissive.addEnrollmentNote(input)).rejects.toBeInstanceOf(
        LearnerAuthorizationError,
      );
    });
  }
  await f.as(f.own, async () => {
    await expect(service.listEnrollmentNotes(request)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
  });
  await withTenant(
    {
      tenantId: request.tenantId,
      userId: request.actorUserId,
      superAdminBypass: true,
    },
    async () => {
      await expect(service.listEnrollmentNotes(request)).rejects.toBeInstanceOf(
        LearnerAuthorizationError,
      );
    },
  );
  revoke();
  await f.as(f.parent, async () => {
    await expect(service.listEnrollmentNotes(request)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    await expect(service.addEnrollmentNote(request)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
  });
  // Relationship revocation is independently enforced before host authorization.
  await f.db.delete('profile_relationships', { id: f.relationship.id });
  await f.as(f.parent, async () => {
    await expect(
      permissive.listEnrollmentNotes(request),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  });
}

export async function assertEnrollmentNotePersistence(f: Fixture) {
  const { service, request } = noteFixture(f);
  await f.as(f.own, () =>
    f.service.startLesson({
      ...f.own,
      enrollmentId: request.enrollmentId,
      lessonId: String(f.lesson.id),
    }),
  );
  await f.as(f.parent, async () => {
    const before = await f.service.listProgress(request);
    const started = new Date();
    const note = await service.addEnrollmentNote({
      ...request,
      authorUserId: String(f.bob.user.id),
      authorLabel: 'Browser spoof',
      createdAt: new Date(0),
      recordedAt: new Date(0),
      id: String(f.learner.id),
    } as typeof request);
    expect(note.authorUserId).toBe(f.parent.actorUserId);
    expect(note.authorLabel).toBe(f.guardian.profile.name);
    await f.db.update(
      'profiles',
      { id: f.guardian.profile.id },
      { name: 'Renamed parent' },
    );
    expect(note.createdAt.getTime()).toBeGreaterThanOrEqual(started.getTime());
    expect(Object.keys(note).sort()).toEqual(
      [
        'id',
        'enrollmentId',
        'learnerId',
        'text',
        'authorUserId',
        'authorLabel',
        'createdAt',
      ].sort(),
    );
    expect(await service.addEnrollmentNote(request)).toEqual(note);
    await expect(
      service.addEnrollmentNote({ ...request, text: 'Changed' }),
    ).rejects.toThrow('retry changed');
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.addEnrollmentNote({ ...request, requestKey: 'concurrent' }),
      ),
    );
    expect(new Set(concurrent.map((row) => row.id)).size).toBe(1);
    await service.withTransaction(async (tx) => {
      const same = await Promise.all(
        Array.from({ length: 3 }, () =>
          tx.addEnrollmentNote({ ...request, requestKey: 'in-transaction' }),
        ),
      );
      expect(new Set(same.map((row) => row.id)).size).toBe(1);
    });
    const notes = await service.listEnrollmentNotes(request);
    expect(notes).toHaveLength(3);
    expect(notes).toEqual(
      [...notes].sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      ),
    );
    expect(await f.service.listProgress(request)).toEqual(before);
    const collection = await EnrollmentParentNoteCollection.create({
      db: f.db,
    });
    const model = await collection.get({ id: note.id }, { cache: false });
    if (!model) throw new Error('Created note is missing');
    model.text = 'tampered';
    model.authorUserId = String(f.bob.user.id);
    model.authorLabel = 'tampered';
    model.recordedAt = new Date(0);
    await expect(model.save()).rejects.toThrow('immutable');
    await expect(model.delete()).rejects.toThrow('immutable');
    await expect(
      collection.create({
        tenantId: request.tenantId,
        enrollmentId: request.enrollmentId,
        learnerId: request.learnerId,
        text: 'replacement',
        requestKey: request.requestKey,
        authorUserId: request.actorUserId,
      }),
    ).rejects.toThrow();
    expect((await service.listEnrollmentNotes(request))[0]).toEqual(note);
  });
}

export async function assertEnrollmentNoteValidation(f: Fixture) {
  const { service, request } = noteFixture(f);
  await f.as(f.parent, async () => {
    for (const patch of [
      { text: '' },
      { text: '   ' },
      { text: 'x'.repeat(ENROLLMENT_NOTE_MAX_LENGTH + 1) },
      { text: 'bad\u0000text' },
      { text: null },
      { requestKey: '' },
      { requestKey: '   ' },
      { requestKey: 'x'.repeat(201) },
      { requestKey: null },
    ]) {
      await expect(
        service.addEnrollmentNote({ ...request, ...patch } as typeof request),
      ).rejects.toThrow();
    }
    expect(await service.listEnrollmentNotes(request)).toEqual([]);
    const prefix = '<b>Plain text, never markup</b>';
    const text =
      prefix + 'x'.repeat(ENROLLMENT_NOTE_MAX_LENGTH - prefix.length);
    expect((await service.addEnrollmentNote({ ...request, text })).text).toBe(
      text,
    );
    await f.db.update(
      'profiles',
      { id: f.guardian.profile.id },
      { name: 'x'.repeat(250) },
    );
    expect(
      (
        await service.addEnrollmentNote({
          ...request,
          requestKey: 'bounded-label',
        })
      ).authorLabel,
    ).toBe('x'.repeat(200));
    await f.db.update(
      'profiles',
      { id: f.guardian.profile.id },
      { name: '   ' },
    );
    expect(
      (
        await service.addEnrollmentNote({
          ...request,
          requestKey: 'fallback-label',
        })
      ).authorLabel,
    ).toBe('Parent');
  });
}

export async function assertEnrollmentNoteTransactions(f: Fixture) {
  const { service, calls, request } = noteFixture(f);
  await f.as(f.parent, async () => {
    await expect(
      service.withTransaction(async (tx) => {
        await tx.addEnrollmentNote(request);
        throw new Error('rollback notes');
      }),
    ).rejects.toThrow('rollback notes');
    expect(await service.listEnrollmentNotes(request)).toEqual([]);
    await expect(
      service.withTransaction(async (tx) => {
        await tx.addEnrollmentNote(request);
        try {
          await tx.addEnrollmentNote({ ...request, text: 'changed' });
        } catch {
          /* poison must survive a caller catch */
        }
      }),
    ).rejects.toThrow('retry changed');
    expect(await service.listEnrollmentNotes(request)).toEqual([]);
    if (!f.db.transaction)
      throw new Error('Database transactions are required');
    await f.db.transaction(async (executor) => {
      await service.withExecutor(executor, async (tx) => {
        const start = calls.length;
        await tx.addEnrollmentNote(request);
        await tx.listEnrollmentNotes(request);
        const observed = calls.slice(start);
        expect(observed.map((call) => call.action)).toEqual([
          'education.learner.notes.add',
          'education.learner.notes.read',
        ]);
        expect(observed.every((call) => call.executor === executor)).toBe(true);
      });
    });
    expect(await service.listEnrollmentNotes(request)).toHaveLength(1);
  });
}
