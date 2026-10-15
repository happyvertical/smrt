import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Course, CourseSection, Lesson } from './catalog.js';
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
