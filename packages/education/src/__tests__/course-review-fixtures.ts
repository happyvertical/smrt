import type { ReviewFixtureCase } from '../course-review-evaluation.js';

/**
 * Evaluation fixtures for educational review: seeded flaws and suitable
 * material. Only a supplied reviewer function ever sees them; nothing here
 * calls a model.
 */
export const REVIEW_FIXTURE_CASES: readonly ReviewFixtureCase[] = [
  {
    id: 'factual-error',
    levelMin: 5,
    levelMax: 6,
    materials: [
      {
        ref: 'lesson:photosynthesis',
        kind: 'lesson',
        title: 'Photosynthesis',
        text: 'Plants absorb oxygen and release carbon dioxide while they make food from sunlight.',
      },
    ],
    seeded: [
      {
        ref: 'lesson:photosynthesis',
        concern: 'factual-error',
        note: 'Gases are reversed: plants absorb carbon dioxide and release oxygen.',
      },
    ],
  },
  {
    id: 'wrong-answer-key',
    levelMin: 3,
    levelMax: 4,
    materials: [
      {
        ref: 'question:half-plus-quarter',
        kind: 'question',
        title: 'Add fractions',
        text: 'What is 1/2 + 1/4?',
        answerKey: '2/6',
      },
      {
        ref: 'question:quarter-plus-quarter',
        kind: 'question',
        title: 'Add fractions',
        text: 'What is 1/4 + 1/4?',
        answerKey: '1/2',
      },
    ],
    seeded: [
      {
        ref: 'question:half-plus-quarter',
        concern: 'answer-key',
        note: 'The sum is 3/4.',
      },
    ],
  },
  {
    id: 'missing-prerequisite',
    levelMin: 5,
    levelMax: 6,
    materials: [
      {
        ref: 'lesson:percent-of-quantity',
        kind: 'lesson',
        title: 'Percent of a quantity',
        text: 'Convert the decimal to a percentage, then take that percentage of the quantity.',
        prerequisites: ['decimals-to-percent'],
      },
      {
        ref: 'lesson:place-value',
        kind: 'lesson',
        title: 'Place value',
        text: 'Digits have a value that depends on their position.',
      },
    ],
    seeded: [
      {
        ref: 'lesson:percent-of-quantity',
        concern: 'missing-prerequisite',
        note: 'Nothing earlier in the course teaches decimals-to-percent.',
      },
    ],
  },
  {
    id: 'level-mismatch',
    levelMin: 2,
    levelMax: 3,
    materials: [
      {
        ref: 'lesson:derivatives',
        kind: 'lesson',
        title: 'Derivatives',
        text: 'Find the derivative of x squared using the limit definition.',
      },
    ],
    seeded: [
      {
        ref: 'lesson:derivatives',
        concern: 'level-mismatch',
        note: 'Calculus is far above a level 2 to 3 learner.',
      },
    ],
  },
  {
    id: 'several-flaws',
    levelMin: 5,
    levelMax: 6,
    materials: [
      {
        ref: 'lesson:water-cycle',
        kind: 'lesson',
        title: 'The water cycle',
        text: 'Water evaporates, condenses into clouds and falls as precipitation.',
      },
      {
        ref: 'lesson:states-of-matter',
        kind: 'lesson',
        title: 'States of matter',
        text: 'Heating a solid always turns it directly into a gas.',
      },
      {
        ref: 'question:boiling-point',
        kind: 'question',
        title: 'Boiling point',
        text: 'At what temperature in Celsius does water boil at sea level?',
        answerKey: '90',
      },
    ],
    seeded: [
      {
        ref: 'lesson:states-of-matter',
        concern: 'factual-error',
        note: 'Most solids melt first; "always directly" is false.',
      },
      {
        ref: 'question:boiling-point',
        concern: 'answer-key',
        note: 'Water boils at 100 degrees Celsius.',
      },
    ],
  },
  {
    id: 'suitable-fractions',
    levelMin: 3,
    levelMax: 4,
    materials: [
      {
        ref: 'lesson:fractions-intro',
        kind: 'lesson',
        title: 'Fractions of a whole',
        text: 'A fraction names equal parts of a whole, such as 1/2 or 3/4.',
      },
      {
        ref: 'question:three-quarters',
        kind: 'question',
        title: 'Read a fraction',
        text: 'What fraction of a pizza is left if 1 of 4 equal slices is eaten?',
        answerKey: '3/4',
      },
    ],
    seeded: [],
  },
  {
    id: 'suitable-science',
    levelMin: 5,
    levelMax: 6,
    materials: [
      {
        ref: 'lesson:photosynthesis-correct',
        kind: 'lesson',
        title: 'Photosynthesis',
        text: 'Plants absorb carbon dioxide and release oxygen while making food from sunlight.',
      },
    ],
    seeded: [],
  },
  {
    id: 'suitable-reading',
    levelMin: 1,
    levelMax: 2,
    materials: [
      {
        ref: 'lesson:letter-sounds',
        kind: 'lesson',
        title: 'Letter sounds',
        text: 'Say the sound each letter makes: a, b, c.',
      },
    ],
    seeded: [],
  },
];
