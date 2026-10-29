import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Course, CourseSection, Lesson } from './catalog.js';
import {
  EducationGroup,
  GroupLearnerInvitation,
  GroupLearnerMembership,
  GroupLearnerRosterEntry,
  GroupRevisionComment,
  GroupSharingPolicy,
} from './group-sharing-models.js';
import { Curriculum, Enrollment, Learner, LessonProgress } from './learners.js';
import { LessonAsset } from './lesson-assets.js';

export class EducationCatalogRecipe extends SmrtRecipe {
  static id = 'education.catalog';
  static help = './education-catalog.recipe.md';
  static label = 'Course catalog';
  static summary =
    'Organize courses, sections, lessons, and their authorized learning materials.';
  static synonyms = ['courses', 'lessons', 'curriculum catalog'];
  static section = {
    id: 'education',
    label: 'Education',
    icon: 'folder',
    description: 'Courses and lessons for learning.',
  };
  static models = [Course, CourseSection, Lesson, LessonAsset];
  static runtime = 'both' as const;
  static nav = [
    {
      label: 'Courses',
      model: Course,
      icon: 'folder',
      description: 'Courses available to this family.',
      noun: 'course',
    },
  ];
}

/** Metadata for host composition; never grants generated CRUD authority. */
export class EducationLearnerRecipe extends SmrtRecipe {
  static id = 'education.learner';
  static help = './education-learner.recipe.md';
  static label = 'Learners';
  static summary =
    'Plan learner curricula and retain enrollment-scoped progress.';
  static synonyms = ['learners', 'enrollments', 'learning progress'];
  static section = {
    id: 'education',
    label: 'Education',
    icon: 'folder',
    description: 'Courses and lessons for learning.',
  };
  static models = [Learner, Curriculum, Enrollment, LessonProgress];
  static runtime = 'both' as const;
  static nav = [
    {
      label: 'Learners',
      model: Learner,
      icon: 'users',
      description: 'Authorized learners in this family.',
      noun: 'learner',
    },
  ];
}

/** Group composition metadata; hosts retain all session and route authority. */
export class EducationSupervisorRecipe extends SmrtRecipe {
  static id = 'education.supervisor';
  static help = './education-supervisor.recipe.md';
  static label = 'Homeschool groups';
  static summary =
    'Review parent-authorized learning work and retain revision-bound comments.';
  static synonyms = ['homeschool groups', 'supervisor review'];
  static section = {
    id: 'education',
    label: 'Education',
    icon: 'users',
    description: 'Courses and lessons for learning.',
  };
  static models = [
    EducationGroup,
    GroupLearnerInvitation,
    GroupLearnerMembership,
    GroupLearnerRosterEntry,
    GroupSharingPolicy,
    GroupRevisionComment,
  ];
  static runtime = 'both' as const;
  static nav = [
    {
      label: 'Groups',
      model: EducationGroup,
      icon: 'users',
      description: 'Groups and currently authorized shared learning work.',
      noun: 'group',
    },
  ];
}
