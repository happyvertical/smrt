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
export interface EasyPeasyGrade4Theme {
  themeId: 'theme-1' | 'theme-2' | 'theme-3' | 'theme-4';
  title: string;
  courses: readonly EasyPeasyGrade4Course[];
}
export interface EasyPeasyThemeImportResult {
  themeId: EasyPeasyGrade4Theme['themeId'];
  courseIds: readonly string[];
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

function themeCourse(
  themeId: EasyPeasyGrade4Theme['themeId'],
  subject: string,
  title: string,
  pageUrl: string,
): EasyPeasyGrade4Course {
  return {
    courseRef: `${themeId}-${subject}`,
    title,
    subject,
    pageUrl,
    variant: 'shared-theme-choice',
    enrollmentMode: 'individual',
  };
}

/**
 * Theme constituents are the official lower-level course pointers linked by
 * the source's themes and individual-course pages. A caller imports one theme,
 * never all four rotations.
 */
export const easyPeasyGrade4Themes: readonly EasyPeasyGrade4Theme[] = [
  {
    themeId: 'theme-1',
    title: 'Theme 1: biology and ancient history',
    courses: [
      themeCourse(
        'theme-1',
        'science',
        'Science — Biology',
        'https://allinonehomeschool.com/science-year-1/',
      ),
      themeCourse(
        'theme-1',
        'history',
        'History — Ancient',
        'https://allinonehomeschool.com/history-year-1/',
      ),
      themeCourse(
        'theme-1',
        'bible',
        'Bible — Old Testament',
        'https://allinonehomeschool.com/bible-year-1-2/',
      ),
      themeCourse(
        'theme-1',
        'art',
        'Art — Ancient',
        'https://allinonehomeschool.com/art-year-1/',
      ),
      themeCourse(
        'theme-1',
        'music',
        'Music — Ancient',
        'https://allinonehomeschool.com/1908-wright-brothers-flight-demonstration/music-year-1/',
      ),
      themeCourse(
        'theme-1',
        'pe-health',
        'PE/Health — Strong and Healthy',
        'https://allinonehomeschool.com/pehealth-odds/',
      ),
    ],
  },
  {
    themeId: 'theme-2',
    title: 'Theme 2: zoology and early American history',
    courses: [
      themeCourse(
        'theme-2',
        'science',
        'Science — Zoology',
        'https://allinonehomeschool.com/zoology/',
      ),
      themeCourse(
        'theme-2',
        'history',
        'History — Early American',
        'https://allinonehomeschool.com/early-american-history/',
      ),
      themeCourse(
        'theme-2',
        'bible',
        'Bible — New Testament',
        'https://allinonehomeschool.com/bible-newtestament/',
      ),
      themeCourse(
        'theme-2',
        'art',
        'Art — Early American',
        'https://allinonehomeschool.com/art-early-american/',
      ),
      themeCourse(
        'theme-2',
        'music',
        'Music — Early American',
        'https://allinonehomeschool.com/music-year-2/',
      ),
      themeCourse(
        'theme-2',
        'pe-health',
        'PE/Health — Exercise and Nutrition',
        'https://allinonehomeschool.com/pe-health/',
      ),
    ],
  },
  {
    themeId: 'theme-3',
    title: 'Theme 3: earth science and geography/cultures',
    courses: [
      themeCourse(
        'theme-3',
        'science',
        'Science — Earth Science',
        'https://allinonehomeschool.com/science-earth-science/',
      ),
      themeCourse(
        'theme-3',
        'history',
        'History — Geography and Cultures',
        'https://allinonehomeschool.com/geography-and-cultures/',
      ),
      themeCourse(
        'theme-3',
        'bible',
        'Bible — Poetry',
        'https://allinonehomeschool.com/bible-geography-and-cultures/',
      ),
      themeCourse(
        'theme-3',
        'art',
        'Art — Geography and Cultures',
        'https://allinonehomeschool.com/art-geography-and-cultures/',
      ),
      themeCourse(
        'theme-3',
        'music',
        'Music — Geography and Cultures',
        'https://allinonehomeschool.com/individual-courses-of-study/music-geography-and-cultures/',
      ),
      themeCourse(
        'theme-3',
        'pe-health',
        'PE/Health — Strong and Healthy',
        'https://allinonehomeschool.com/pehealth-odds/',
      ),
    ],
  },
  {
    themeId: 'theme-4',
    title: 'Theme 4: physics/chemistry and modern history',
    courses: [
      themeCourse(
        'theme-4',
        'science',
        'Science — Physics and Chemistry',
        'https://allinonehomeschool.com/science-year-4/',
      ),
      themeCourse(
        'theme-4',
        'history',
        'History — Modern',
        'https://allinonehomeschool.com/history-year-4/',
      ),
      themeCourse(
        'theme-4',
        'bible',
        'Bible — Prophets',
        'https://allinonehomeschool.com/bible/',
      ),
      themeCourse(
        'theme-4',
        'art',
        'Art — Modern',
        'https://allinonehomeschool.com/art-year-4/',
      ),
      themeCourse(
        'theme-4',
        'music',
        'Music — Modern',
        'https://allinonehomeschool.com/music/',
      ),
      themeCourse(
        'theme-4',
        'pe-health',
        'PE/Health — Exercise and Nutrition',
        'https://allinonehomeschool.com/pe-health/',
      ),
    ],
  },
];

export function grade4Theme(
  themeId: EasyPeasyGrade4Theme['themeId'],
): EasyPeasyGrade4Theme {
  const theme = easyPeasyGrade4Themes.find(
    (candidate) => candidate.themeId === themeId,
  );
  if (!theme) throw new Error('Unknown Easy Peasy Grade 4 theme.');
  return theme;
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

export async function importEasyPeasyGrade4Theme(
  service: Pick<SourceImportService, 'importCourse'>,
  request: Omit<SourceImportRequest, 'courseRef' | 'pageUrl'> & {
    themeId: EasyPeasyGrade4Theme['themeId'];
  },
): Promise<EasyPeasyThemeImportResult> {
  const theme = grade4Theme(request.themeId);
  const results = await Promise.all(
    theme.courses.map((course) =>
      service.importCourse({
        ...request,
        courseRef: course.courseRef,
        pageUrl: course.pageUrl,
      }),
    ),
  );
  return {
    themeId: theme.themeId,
    courseIds: results.map((result) => result.courseId),
  };
}
