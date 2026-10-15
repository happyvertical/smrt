import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  Curriculum,
  EducationLearnerRecipe,
  Enrollment,
  Learner,
  LessonProgress,
} from '../index.js';

describe('learner generated contract', () => {
  it.each([
    Learner,
    Curriculum,
    Enrollment,
    LessonProgress,
  ])('closes generated CRUD and custom methods for %s', (Model) => {
    const registered = ObjectRegistry.getClassInPackage(
      '@happyvertical/smrt-education',
      Model.name,
    );
    expect(registered).toBeDefined();
    expect(registered?.config).toMatchObject({
      api: false,
      cli: false,
      mcp: false,
    });
  });
  it('declares the learner recipe using the actual closed models', () => {
    expect(EducationLearnerRecipe.id).toBe('education.learner');
    expect(EducationLearnerRecipe.models).toEqual([
      Learner,
      Curriculum,
      Enrollment,
      LessonProgress,
    ]);
    expect('parentId' in new Learner()).toBe(false);
    expect(new LessonProgress().bestScore).toBeNull();
  });
});
