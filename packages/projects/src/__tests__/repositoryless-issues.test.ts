/**
 * Issues and labels no longer require a repository: a general task tracker can
 * keep native Issues under a Project with no provider at all.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommentCollection } from '../collections/Comments';
import { IssueCollection } from '../collections/Issues';
import { ProjectCollection } from '../collections/Projects';
import { RepositoryCollection } from '../collections/Repositories';
import { Label } from '../models/Label';

describe('repository-less issues and labels', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  async function seedProject() {
    const projects = await ProjectCollection.create({ db });
    const project = await projects.create({ title: 'Kitchen remodel' });
    await project.save();
    return project;
  }

  it('saves an Issue that belongs only to a Project', async () => {
    const project = await seedProject();
    const issues = await IssueCollection.create({ db });
    const issue = await issues.create({
      projectId: project.id as string,
      title: 'Pick tile',
    });
    await issue.save();

    const loaded = await issues.get({ id: issue.id as string });
    expect(loaded?.repositoryId ?? null).toBeNull();
    expect(loaded?.projectId).toBe(project.id);
    expect(loaded?.hasRepository()).toBe(false);
    expect((await issues.findByProject(project.id as string)).length).toBe(1);
  });

  it('allows several repository-less issues sharing number 0', async () => {
    const project = await seedProject();
    const issues = await IssueCollection.create({ db });
    for (const title of ['one', 'two', 'three']) {
      await (
        await issues.create({ projectId: project.id as string, title })
      ).save();
    }
    expect((await issues.findByProject(project.id as string)).length).toBe(3);
  });

  it('keeps repository-backed issues working beside project-native ones', async () => {
    const project = await seedProject();
    const repos = await RepositoryCollection.create({ db });
    const repo = await repos.create({ owner: 'acme', name: 'widgets' });
    await repo.save();
    const issues = await IssueCollection.create({ db });
    await (
      await issues.create({
        repositoryId: repo.id as string,
        projectId: project.id as string,
        number: 7,
        title: 'backed',
      })
    ).save();
    await (
      await issues.create({ projectId: project.id as string, title: 'native' })
    ).save();

    const found = await issues.findByNumber(repo.id as string, 7);
    expect(found?.title).toBe('backed');
    expect(found?.hasRepository()).toBe(true);
    expect((await issues.findByProject(project.id as string)).length).toBe(2);
  });

  it('runs lifecycle methods locally without a provider', async () => {
    const project = await seedProject();
    const issues = await IssueCollection.create({ db });
    const issue = await issues.create({
      projectId: project.id as string,
      title: 'Order cabinets',
    });
    await issue.save();

    await expect(issue.sync({ force: true })).resolves.toBe(issue);
    await expect(issue.getRepository()).rejects.toThrow(/not backed/);

    await issue.addLabels(['urgent']);
    await issue.assign(['sam']);
    const comment = await issue.addComment('Quote arrived');
    expect(comment.body).toBe('Quote arrived');
    expect(issue.commentsCount).toBe(1);
    expect((await issue.getComments()).map((c) => c.body)).toEqual([
      'Quote arrived',
    ]);
    await issue.removeLabel('urgent');
    await issue.close();

    const loaded = await issues.get({ id: issue.id as string });
    expect(loaded?.state).toBe('closed');
    expect(loaded?.labels).toEqual([]);
    expect(loaded?.assignees).toEqual(['sam']);
    const comments = await CommentCollection.create({ db });
    expect((await comments.list({})).length).toBe(1);
  });

  it('saves a Label scoped only to a Project', async () => {
    const project = await seedProject();
    const label = new Label({
      db,
      projectId: project.id as string,
      name: 'priority:high',
      color: 'ff0000',
    });
    await label.initialize();
    await label.save();
    expect(label.id).toBeTruthy();
    expect(label.repositoryId ?? null).toBeNull();
    await expect(label.createInRepository()).rejects.toThrow(/repositoryId/);
  });
});
