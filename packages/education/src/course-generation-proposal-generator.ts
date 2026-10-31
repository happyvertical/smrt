import type { ProposalGenerator } from '@happyvertical/smrt-ingestion/proposals';
import type {
  CourseGeneratorRequest,
  CourseMaterialGenerator,
} from './course-generation-contracts.js';
import { groupSharingDigest } from './group-sharing-hash.js';

export const COURSE_PROPOSAL_HANDLER =
  '@happyvertical/smrt-education:propose-course-material';

const text = (max: number) => ({
  type: 'string',
  minLength: 1,
  maxLength: max,
});
/** The closed JSON shape a model is asked to produce; validated again on receipt. */
export const COURSE_PROPOSAL_ARGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    course: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: text(20_000),
        subject: text(200),
        objectives: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: text(1000),
        },
      },
    },
    lessons: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lessonKey: text(120),
          sectionKey: text(120),
          sectionTitle: text(300),
          title: text(300),
          body: text(100_000),
          estimatedMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
          difficulty: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
    rationale: text(4000),
  },
} as const;

/**
 * Adapts an ingestion `ProposalGenerator` (the host's trusted SDK-bound
 * adapter) to the course generation port. The material is offered as one
 * evidence segment; the model's output stays untrusted and is validated by the
 * service against the closed proposal schema. No provider is chosen here.
 */
export function createProposalCourseGenerator(
  generator: ProposalGenerator,
): CourseMaterialGenerator {
  return {
    identity: generator.identity,
    async generate(request: CourseGeneratorRequest, options) {
      const serialized = JSON.stringify(request.material);
      const result = await generator.generate(
        {
          evidence: [
            {
              evidenceId: 'course-material',
              partId: 'course-material',
              parentEvidenceId: null,
              mediaType: 'application/json',
              contentHash: groupSharingDigest(serialized),
              segments: [{ text: serialized, location: { kind: 'source' } }],
            },
          ],
          offered: [
            {
              handler: {
                id: COURSE_PROPOSAL_HANDLER,
                version: '1',
                description:
                  'Propose additions and changes to the supplied course material.',
                kind: 'operation',
                capability: null,
                argsSchema: COURSE_PROPOSAL_ARGS_SCHEMA as never,
                references: {},
                operation: {
                  model: '@happyvertical/smrt-education:CourseProposal',
                  action: 'propose',
                  version: '1',
                },
              },
              candidates: [],
            },
          ],
          instructions: request.instruction,
        },
        options,
      );
      const output = result.output as {
        suggestions?: Array<{ args?: unknown }>;
      };
      return {
        ...result,
        output: Array.isArray(output?.suggestions)
          ? output.suggestions[0]?.args
          : result.output,
      };
    },
  };
}
