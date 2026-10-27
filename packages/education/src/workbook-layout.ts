import type {
  WorkbookObservedLayout,
  WorkbookQuestion,
} from './workbook-contracts.js';

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 64;
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Copy only bounded observed metadata, dropping the entire layout on any error.
 * This browser-safe helper never changes questions or grants source geometry.
 */
export function normalizeWorkbookObservedLayout(
  value: unknown,
  questions: readonly WorkbookQuestion[],
  sources: readonly { assetId: string; sha256?: string; pageCount: number }[],
): { layout?: WorkbookObservedLayout; layoutOmission?: 'invalid' } {
  if (value === undefined) return {};
  const invalid = { layoutOmission: 'invalid' as const };
  if (
    !record(value) ||
    value.version !== 1 ||
    value.provenance !== 'observed' ||
    !Array.isArray(value.sections) ||
    value.sections.length > 32 ||
    !Array.isArray(value.placements) ||
    value.placements.length > 200
  )
    return invalid;
  const sections: WorkbookObservedLayout['sections'] = [];
  const sectionIds = new Set<string>();
  for (const section of value.sections) {
    if (
      !record(section) ||
      !id(section.id) ||
      sectionIds.has(section.id) ||
      !integer(section.columns, 1, 8) ||
      (section.label !== undefined &&
        (typeof section.label !== 'string' || section.label.length > 200)) ||
      (section.readingOrder !== undefined &&
        section.readingOrder !== 'rows' &&
        section.readingOrder !== 'columns') ||
      !record(section.source) ||
      typeof section.source.assetId !== 'string'
    )
      return invalid;
    const sectionSource = section.source;
    const source = sources.find((s) => s.assetId === sectionSource.assetId);
    if (
      !source ||
      (section.source.page !== null &&
        !integer(section.source.page, 1, source.pageCount))
    )
      return invalid;
    sectionIds.add(section.id);
    sections.push({
      id: section.id,
      ...(section.label !== undefined ? { label: section.label } : {}),
      columns: section.columns,
      ...(section.readingOrder !== undefined
        ? { readingOrder: section.readingOrder }
        : {}),
      source: {
        assetId: source.assetId,
        page: section.source.page as number | null,
      },
    });
  }
  const placements: WorkbookObservedLayout['placements'] = [];
  const placed = new Set<string>();
  for (const placement of value.placements) {
    if (
      !record(placement) ||
      typeof placement.questionId !== 'string' ||
      placed.has(placement.questionId) ||
      typeof placement.sectionId !== 'string' ||
      !integer(placement.row, 0, 199) ||
      (placement.part !== undefined && !integer(placement.part, 0, 31))
    )
      return invalid;
    const section = sections.find((s) => s.id === placement.sectionId);
    const question = questions.find((q) => q.id === placement.questionId);
    if (
      !section ||
      !question ||
      !integer(placement.column, 0, section.columns - 1)
    )
      return invalid;
    const source = sources.find((s) => s.assetId === section.source.assetId);
    if (
      !question.anchors.some(
        (a) =>
          a.assetId === section.source.assetId &&
          (!source?.sha256 || a.sha256 === source.sha256) &&
          (section.source.page === null ||
            a.page === null ||
            a.page === section.source.page),
      )
    )
      return invalid;
    placed.add(placement.questionId);
    placements.push({
      questionId: placement.questionId,
      sectionId: placement.sectionId,
      row: placement.row,
      column: placement.column,
      ...(placement.part !== undefined ? { part: placement.part } : {}),
    });
  }
  return {
    layout: { version: 1, provenance: 'observed', sections, placements },
  };
}
