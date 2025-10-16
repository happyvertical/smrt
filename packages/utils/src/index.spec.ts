import { expect, it, describe } from 'vitest';
import {
  addInterval,
  createId,
  dateInString,
  formatDate,
  isCuid,
  isPlural,
  isSingular,
  isValidDate,
  makeId,
  parseAmazonDateString,
  parseDate,
  pluralizeWord,
  singularize,
  sleep,
  waitFor,
} from './index';

it('should have a test', () => {
  expect(true).toBe(true);
});

it.skip('should waitFor "it"', async () => {
  let attempts = 0;
  const result = await waitFor(
    async () => {
      attempts++;
      if (attempts >= 5) {
        return true;
      }
    },
    {
      timeout: 0, // 0 = don't timeout
      delay: 10,
    },
  );
  expect(result).toEqual(true);
});

it.skip('should waitFor "it" only so long', async () => {
  let attempts = 0;
  expect.assertions(1);
  await expect(
    waitFor(
      async () => {
        attempts++;
        await sleep(1000);
        if (attempts >= 10) {
          return true;
        }
      },
      {
        delay: 1000, // should tick 3 times
        timeout: 30000,
      },
    ),
  ).rejects.toEqual('Timed out');
});

it.skip('should be able to parse an amazon date', () => {
  const result = parseAmazonDateString('20220223T215409Z');
  expect(result).toBeDefined();
});

// CUID2 tests
it('should generate CUID2 by default', () => {
  const id = makeId();
  expect(typeof id).toBe('string');
  expect(id.length).toBeGreaterThan(0);
  expect(isCuid(id)).toBe(true);
});

it('should generate UUID when requested', () => {
  const id = makeId('uuid');
  expect(typeof id).toBe('string');
  expect(id.length).toBe(36);
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

it('should create CUID2 with createId', () => {
  const id = createId();
  expect(typeof id).toBe('string');
  expect(isCuid(id)).toBe(true);
});

// Pluralize tests
it('should pluralize words', () => {
  expect(pluralizeWord('cat')).toBe('cats');
  expect(pluralizeWord('mouse')).toBe('mice');
  expect(singularize('cats')).toBe('cat');
  expect(singularize('mice')).toBe('mouse');
});

it('should check plural/singular status', () => {
  expect(isPlural('cats')).toBe(true);
  expect(isSingular('cat')).toBe(true);
  expect(isPlural('cat')).toBe(false);
  expect(isSingular('cats')).toBe(false);
});

// Date-fns tests
it('should format dates', () => {
  const date = new Date('2023-01-15T12:00:00Z');
  expect(formatDate(date)).toBe('2023-01-15');
  expect(formatDate(date, 'MM/dd/yyyy')).toBe('01/15/2023');
});

it('should parse dates', () => {
  const date = parseDate('2023-01-15');
  expect(date).toBeInstanceOf(Date);
  expect(isValidDate(date)).toBe(true);
});

it('should handle date intervals', () => {
  const date = new Date('2023-01-15T00:00:00.000Z');
  const newDate = addInterval(date, { days: 7 });
  const expectedDate = new Date('2023-01-22T00:00:00.000Z');
  expect(newDate.toISOString()).toBe(expectedDate.toISOString());
});

// dateInString tests
describe('dateInString', () => {
  describe('ISO date patterns', () => {
    it('should extract ISO dates with hyphens (YYYY-MM-DD)', () => {
      const date = dateInString('2023-01-15');
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0); // January (0-based)
      expect(date?.getDate()).toBe(15);
    });

    it('should extract ISO dates with slashes (YYYY/MM/DD)', () => {
      const date = dateInString('2023/01/15');
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should extract ISO dates from text', () => {
      const date = dateInString('Report for 2023-01-15 quarterly results');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });
  });

  describe('US date patterns', () => {
    it('should extract US dates with slashes (MM/DD/YYYY)', () => {
      const date = dateInString('01/15/2023');
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should extract US dates with hyphens (MM-DD-YYYY)', () => {
      const date = dateInString('01-15-2023');
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should extract US dates from text', () => {
      const date = dateInString('Meeting scheduled for 01/15/2023');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });
  });

  describe('Natural language dates', () => {
    it('should extract from user example: Council meeting title', () => {
      const date = dateInString(
        'Regular Council Meeting October 14, 2025, Agenda Package',
      );
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(9); // October (0-based)
      expect(date?.getDate()).toBe(14);
    });

    it('should extract full month names with day and year', () => {
      const date = dateInString('Report_January_15_2023.pdf');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0); // January
      expect(date?.getDate()).toBe(15);
    });

    it('should extract month abbreviations with day and year', () => {
      const date = dateInString('Meeting sept 5 2025');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(8); // September
      expect(date?.getDate()).toBe(5);
    });

    it('should extract dates with day before month', () => {
      const date = dateInString('15 January 2023 report');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should extract dates with day after month', () => {
      const date = dateInString('January 15, 2023');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should extract dates with day before year', () => {
      const date = dateInString('January 15 2023');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should extract dates with day after year', () => {
      const date = dateInString('2023 15 January');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should default to 1st when no day found', () => {
      const date = dateInString('financial-report-dec-2023.pdf');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(11); // December
      expect(date?.getDate()).toBe(1); // Defaults to 1st
    });

    it('should handle all month abbreviations', () => {
      const months = [
        { str: 'jan-2023', month: 0 },
        { str: 'feb-2023', month: 1 },
        { str: 'mar-2023', month: 2 },
        { str: 'apr-2023', month: 3 },
        { str: 'may-2023', month: 4 },
        { str: 'jun-2023', month: 5 },
        { str: 'jul-2023', month: 6 },
        { str: 'aug-2023', month: 7 },
        { str: 'sep-2023', month: 8 },
        { str: 'sept-2023', month: 8 },
        { str: 'oct-2023', month: 9 },
        { str: 'nov-2023', month: 10 },
        { str: 'dec-2023', month: 11 },
      ];

      for (const { str, month } of months) {
        const date = dateInString(str);
        expect(date?.getMonth()).toBe(month);
        expect(date?.getFullYear()).toBe(2023);
      }
    });

    it('should handle all full month names', () => {
      const months = [
        { str: 'january 2023', month: 0 },
        { str: 'february 2023', month: 1 },
        { str: 'march 2023', month: 2 },
        { str: 'april 2023', month: 3 },
        { str: 'may 2023', month: 4 },
        { str: 'june 2023', month: 5 },
        { str: 'july 2023', month: 6 },
        { str: 'august 2023', month: 7 },
        { str: 'september 2023', month: 8 },
        { str: 'october 2023', month: 9 },
        { str: 'november 2023', month: 10 },
        { str: 'december 2023', month: 11 },
      ];

      for (const { str, month } of months) {
        const date = dateInString(str);
        expect(date?.getMonth()).toBe(month);
        expect(date?.getFullYear()).toBe(2023);
      }
    });
  });

  describe('DocuShare and CivicWeb formats', () => {
    it('should extract underscore-separated dates (YYYY_MM_DD)', () => {
      const date = dateInString('Minutes_2025_01_16.pdf');
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(0); // January (0-based)
      expect(date?.getDate()).toBe(16);
    });

    it('should extract underscore dates from complex filenames', () => {
      const date = dateInString('Council_Meeting_Minutes_2025_10_13.pdf');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(9); // October (0-based)
      expect(date?.getDate()).toBe(13);
    });

    it('should extract US dot format dates (MM.DD.YYYY)', () => {
      const date = dateInString('02.13.2025.pdf');
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(1); // February (0-based)
      expect(date?.getDate()).toBe(13);
    });

    it('should extract US dot dates from complex filenames', () => {
      const date = dateInString('Agenda_Meeting_10.14.2025.pdf');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(9); // October (0-based)
      expect(date?.getDate()).toBe(14);
    });

    it('should handle single-digit months in underscore format', () => {
      const date = dateInString('Report_2025_3_5.pdf');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(2); // March (0-based)
      expect(date?.getDate()).toBe(5);
    });

    it('should handle single-digit days in dot format', () => {
      const date = dateInString('Summary_1.5.2025.pdf');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(0); // January (0-based)
      expect(date?.getDate()).toBe(5);
    });

    it('should prioritize underscore dates over natural language', () => {
      // Should extract 2025_01_16, not "December 2024"
      const date = dateInString('December_2024_Minutes_2025_01_16.pdf');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(0); // January
      expect(date?.getDate()).toBe(16);
    });

    it('should prioritize dot dates over natural language', () => {
      // Should extract 02.13.2025, not "January 2024"
      const date = dateInString('January_2024_Report_02.13.2025.pdf');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(1); // February
      expect(date?.getDate()).toBe(13);
    });
  });

  describe('Edge cases', () => {
    it('should return null for strings with no date', () => {
      const date = dateInString('no-date-here.pdf');
      expect(date).toBeNull();
    });

    it('should return null for strings with year but no month', () => {
      const date = dateInString('report-2023.pdf');
      expect(date).toBeNull();
    });

    it('should return null for strings with month but no year', () => {
      const date = dateInString('january-report.pdf');
      expect(date).toBeNull();
    });

    it('should handle dates with extra whitespace', () => {
      const date = dateInString('Meeting   October   14,   2025');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(9);
      expect(date?.getDate()).toBe(14);
    });

    it('should be case-insensitive', () => {
      const date = dateInString('MEETING OCTOBER 14, 2025');
      expect(date?.getFullYear()).toBe(2025);
      expect(date?.getMonth()).toBe(9);
      expect(date?.getDate()).toBe(14);
    });

    it('should return null for invalid day numbers', () => {
      const date = dateInString('october 99 2025');
      expect(date).toBeNull();
    });

    it('should prefer ISO dates over natural language', () => {
      // Should extract 2023-01-15, not "January 2022"
      const date = dateInString('January 2022 report from 2023-01-15');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    it('should prefer US dates over natural language', () => {
      // Should extract 01/15/2023, not "January 2022"
      const date = dateInString('January 2022 report dated 01/15/2023');
      expect(date?.getFullYear()).toBe(2023);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });
  });
});
