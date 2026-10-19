import { SmrtCollection, SmrtJunction } from '@happyvertical/smrt-core';
import {
  AuthoredCourse,
  Course,
  CourseSection,
  Exercise,
  ExternalCourse,
  Lesson,
  Reading,
  Video,
  Worksheet,
} from './catalog.js';
import { Curriculum, Enrollment, Learner, LessonProgress } from './learners.js';
import { LessonAsset } from './lesson-assets.js';

export class CourseCollection extends SmrtCollection<Course> {
  static readonly _itemClass = Course;
}
export class ExternalCourseCollection extends SmrtCollection<ExternalCourse> {
  static readonly _itemClass = ExternalCourse;
}
export class AuthoredCourseCollection extends SmrtCollection<AuthoredCourse> {
  static readonly _itemClass = AuthoredCourse;
}
export class CourseSectionCollection extends SmrtCollection<CourseSection> {
  static readonly _itemClass = CourseSection;
}
export class LessonCollection extends SmrtCollection<Lesson> {
  static readonly _itemClass = Lesson;
}
export class ReadingCollection extends SmrtCollection<Reading> {
  static readonly _itemClass = Reading;
}
export class VideoCollection extends SmrtCollection<Video> {
  static readonly _itemClass = Video;
}
export class WorksheetCollection extends SmrtCollection<Worksheet> {
  static readonly _itemClass = Worksheet;
}
export class ExerciseCollection extends SmrtCollection<Exercise> {
  static readonly _itemClass = Exercise;
}
export class LessonAssetCollection extends SmrtJunction<LessonAsset> {
  static readonly _itemClass = LessonAsset;
  protected leftField = 'lessonId';
  protected rightField = 'assetId';
}

export class LearnerCollection extends SmrtCollection<Learner> {
  static readonly _itemClass = Learner;
}
export class CurriculumCollection extends SmrtCollection<Curriculum> {
  static readonly _itemClass = Curriculum;
}
export class EnrollmentCollection extends SmrtCollection<Enrollment> {
  static readonly _itemClass = Enrollment;
}
export class LessonProgressCollection extends SmrtCollection<LessonProgress> {
  static readonly _itemClass = LessonProgress;
}

import {
  Attestation,
  ExternalCompletion,
  Grade,
  ScannedSubmission,
  Submission,
  SubmissionAsset,
  SubmissionIntakeBinding,
} from './submissions.js';
export class SubmissionCollection extends SmrtCollection<Submission> {
  static readonly _itemClass = Submission;
}
export class SubmissionIntakeBindingCollection extends SmrtCollection<SubmissionIntakeBinding> {
  static readonly _itemClass = SubmissionIntakeBinding;
}
export class ScannedSubmissionCollection extends SmrtCollection<ScannedSubmission> {
  static readonly _itemClass = ScannedSubmission;
}
export class ExternalCompletionCollection extends SmrtCollection<ExternalCompletion> {
  static readonly _itemClass = ExternalCompletion;
}
export class AttestationCollection extends SmrtCollection<Attestation> {
  static readonly _itemClass = Attestation;
}
export class GradeCollection extends SmrtCollection<Grade> {
  static readonly _itemClass = Grade;
}
export class SubmissionAssetCollection extends SmrtJunction<SubmissionAsset> {
  static readonly _itemClass = SubmissionAsset;
  protected leftField = 'submissionId';
  protected rightField = 'assetId';
}
