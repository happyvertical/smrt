import type {
  SourceImportRequest,
  SourceImportResult,
  SourceImportService,
} from './source-import-service.js';

export type EasyPeasyGrade4Variant =
  | 'core'
  | 'shared-theme-choice'
  | 'once-weekly';

/**
 * Official source pointers only. Theme rows represent a family choice and are
 * never automatically combined into an enrollment.
 */
export interface EasyPeasyGrade4Course {
  courseRef: string;
  title: string;
  pageUrl: string;
  subject: string;
  variant: EasyPeasyGrade4Variant;
  enrollmentMode: 'individual' | 'choose-one-theme';
}

export const easyPeasyGrade4Courses: readonly EasyPeasyGrade4Course[] = [
  {
    courseRef: 'grade-4-math',
    title: 'Math 4',
    subject: 'math',
    pageUrl: 'https://allinonehomeschool.com/ep-math-4/',
    variant: 'core',
    enrollmentMode: 'individual',
  },
  {
    courseRef: 'grade-4-reading',
    title: 'Reading 4',
    subject: 'reading',
    pageUrl: 'https://allinonehomeschool.com/reading-4/',
    variant: 'core',
    enrollmentMode: 'individual',
  },
  {
    courseRef: 'grade-4-language-arts',
    title: 'Language Arts 4',
    subject: 'language-arts',
    pageUrl: 'https://allinonehomeschool.com/language-arts-4/',
    variant: 'core',
    enrollmentMode: 'individual',
  },
  {
    courseRef: 'lower-elementary-theme-1',
    title: 'Theme 1: biology and ancient history',
    subject: 'shared-theme',
    pageUrl: 'https://allinonehomeschool.com/history-and-science-themes/',
    variant: 'shared-theme-choice',
    enrollmentMode: 'choose-one-theme',
  },
  {
    courseRef: 'lower-elementary-theme-2',
    title: 'Theme 2: zoology and early American history',
    subject: 'shared-theme',
    pageUrl: 'https://allinonehomeschool.com/history-and-science-themes/',
    variant: 'shared-theme-choice',
    enrollmentMode: 'choose-one-theme',
  },
  {
    courseRef: 'lower-elementary-theme-3',
    title: 'Theme 3: earth science and geography/cultures',
    subject: 'shared-theme',
    pageUrl: 'https://allinonehomeschool.com/history-and-science-themes/',
    variant: 'shared-theme-choice',
    enrollmentMode: 'choose-one-theme',
  },
  {
    courseRef: 'lower-elementary-theme-4',
    title: 'Theme 4: physics/chemistry and modern history',
    subject: 'shared-theme',
    pageUrl: 'https://allinonehomeschool.com/history-and-science-themes/',
    variant: 'shared-theme-choice',
    enrollmentMode: 'choose-one-theme',
  },
  {
    courseRef: 'lower-elementary-computer',
    title: 'Computer: Level 4 placement',
    subject: 'computer',
    pageUrl: 'https://allinonehomeschool.com/computer-fourth-level/',
    variant: 'once-weekly',
    enrollmentMode: 'individual',
  },
  {
    courseRef: 'lower-elementary-thinking',
    title: 'Thinking',
    subject: 'thinking',
    pageUrl: 'https://allinonehomeschool.com/thinking/',
    variant: 'once-weekly',
    enrollmentMode: 'individual',
  },
];

export function grade4Courses(
  variant?: EasyPeasyGrade4Variant,
): readonly EasyPeasyGrade4Course[] {
  return variant
    ? easyPeasyGrade4Courses.filter((course) => course.variant === variant)
    : easyPeasyGrade4Courses;
}

/** Calls the public pointer-only importer; it never fetches packets or lesson bodies. */
export async function importEasyPeasyGrade4Course(
  service: Pick<SourceImportService, 'importCourse'>,
  request: Omit<SourceImportRequest, 'courseRef' | 'pageUrl'> & {
    courseRef: string;
  },
): Promise<SourceImportResult> {
  const course = easyPeasyGrade4Courses.find(
    (candidate) => candidate.courseRef === request.courseRef,
  );
  if (!course) throw new Error('Unknown Easy Peasy Grade 4 course reference.');
  if (course.enrollmentMode === 'choose-one-theme')
    throw new Error(
      'Theme choices are catalog pointers; select an official constituent course before importing lessons.',
    );
  return service.importCourse({ ...request, pageUrl: course.pageUrl });
}
