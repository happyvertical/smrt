import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { CourseAuthoringValidationError } from './course-authoring-contracts.js';
import {
  type GuardianQuestionItem,
  type GuardianWorksheetBundle,
  type LearnerQuestionItem,
  type LearnerWorksheetBundle,
  MAX_PRINTABLE_ITEMS,
  MAX_PRINTABLE_PAGES,
  MAX_PRINTABLE_TEXT_LENGTH,
  MAX_PRINTABLE_TOTAL_TEXT,
  type QuestionAnswerAtom,
  type QuestionChoice,
} from './question-contracts.js';

/**
 * Fixed document dates keep the bytes of one render reproducible. The version of
 * the render is carried by the worksheet version id, not by a timestamp.
 */
const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const FOOTER_Y = 30;
const BODY_SIZE = 11;
const LEADING = 14;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Lines of writing space under a learner question, by response type. */
const ANSWER_LINES: Record<string, number> = {
  'short-answer': 1,
  numeric: 1,
  extended: 8,
};

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  supported: ReadonlySet<number>;
}

/**
 * Standard fonts only cover WinAnsi. A character outside it is replaced by `?`
 * (never thrown on, never dropped silently into another word); control
 * characters other than line breaks become spaces. Documented limitation.
 */
function clean(text: string, supported: ReadonlySet<number>): string {
  let out = '';
  for (const char of Array.from(text.normalize('NFC'))) {
    const code = char.codePointAt(0) as number;
    if (char === '\n') out += '\n';
    else if (char === '\r') continue;
    else if (code < 0x20 || code === 0x7f) out += ' ';
    else out += supported.has(code) ? char : '?';
  }
  return out;
}

class Budget {
  private total = 0;
  take(text: string): string {
    if (text.length > MAX_PRINTABLE_TEXT_LENGTH)
      throw new CourseAuthoringValidationError(
        'A printable text value is too long',
      );
    this.total += text.length;
    if (this.total > MAX_PRINTABLE_TOTAL_TEXT)
      throw new CourseAuthoringValidationError(
        'The printable worksheet is too large',
      );
    return text;
  }
}

class Writer {
  private page: PDFPage;
  private y = 0;
  readonly pages: PDFPage[] = [];
  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
    private readonly budget: Budget,
  ) {
    this.page = this.newPage();
  }
  private newPage(): PDFPage {
    if (this.pages.length >= MAX_PRINTABLE_PAGES)
      throw new CourseAuthoringValidationError(
        'The printable worksheet has too many pages',
      );
    const page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    this.page = page;
    this.y = PAGE_HEIGHT - MARGIN;
    return page;
  }
  private ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }
  gap(points: number) {
    this.y -= points;
  }
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of clean(
      this.budget.take(text),
      this.fonts.supported,
    ).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/ +/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = '';
        let rest = word;
        // A word wider than the line is split by character.
        while (font.widthOfTextAtSize(rest, size) > width) {
          let cut = rest.length - 1;
          while (
            cut > 1 &&
            font.widthOfTextAtSize(rest.slice(0, cut), size) > width
          )
            cut--;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }
  /** Wrapped paragraph at an indent; a page break may fall between its lines. */
  text(
    text: string,
    options: { bold?: boolean; size?: number; indent?: number } = {},
  ) {
    const size = options.size ?? BODY_SIZE;
    const indent = options.indent ?? 0;
    const font = options.bold ? this.fonts.bold : this.fonts.regular;
    for (const line of this.wrap(text, font, size, CONTENT_WIDTH - indent)) {
      this.ensure(size + 3);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y - size,
        size,
        font,
        color: rgb(0, 0, 0),
      });
      this.y -= size + 3;
    }
  }
  /** One blank writing line, used for learner answers. */
  line(indent = 0) {
    this.ensure(LEADING + 6);
    this.y -= LEADING + 4;
    this.page.drawLine({
      start: { x: MARGIN + indent, y: this.y },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
      thickness: 0.5,
      color: rgb(0.45, 0.45, 0.45),
    });
    this.y -= 2;
  }
  /** Keeps a heading with the first lines of what follows it. */
  keepWithNext(height: number) {
    this.ensure(height);
  }
  footers(footer: string) {
    const font = this.fonts.regular;
    const total = this.pages.length;
    for (const [index, page] of this.pages.entries()) {
      const text = `${footer}  -  page ${index + 1} of ${total}`;
      page.drawText(text, {
        x: MARGIN,
        y: FOOTER_Y,
        size: 8,
        font,
        color: rgb(0.35, 0.35, 0.35),
      });
    }
  }
}

function label(index: number): string {
  return `${String.fromCharCode(65 + (index % 26))}.`;
}

function mediaPlaceholder(item: LearnerQuestionItem): string[] {
  return item.media.map((m) => {
    const role = m.role ?? 'media';
    const alt = m.alt ? `: ${m.alt.slice(0, 120)}` : '';
    return `[${role} not reproduced in this print${alt}]`;
  });
}

function choiceLabels(
  choices: readonly QuestionChoice[],
  ids: readonly string[] | undefined,
): string {
  return (ids ?? [])
    .map((id) => {
      const index = choices.findIndex((c) => c.id === id);
      return index < 0
        ? 'unknown choice'
        : `${label(index)} ${choices[index].label}`;
    })
    .join('; ');
}

function atomText(
  atom: QuestionAnswerAtom,
  choices: readonly QuestionChoice[],
): string {
  const parts: string[] = [];
  if (atom.correctChoiceIds?.length)
    parts.push(choiceLabels(choices, atom.correctChoiceIds));
  if (atom.acceptedAnswers?.length) parts.push(atom.acceptedAnswers.join('; '));
  if (atom.numeric)
    parts.push(
      atom.numeric.tolerance
        ? `${atom.numeric.value} (tolerance ${atom.numeric.tolerance})`
        : String(atom.numeric.value),
    );
  return parts.join('; ');
}

function renderItem(
  w: Writer,
  item: LearnerQuestionItem,
  guardian: GuardianQuestionItem | null,
) {
  w.gap(8);
  w.keepWithNext(LEADING * 4);
  const points =
    item.pointsPossible === null ? '' : ` (${item.pointsPossible} pts)`;
  w.text(`${item.ordinal}. ${item.prompt}${points}`, { bold: true });
  for (const placeholder of mediaPlaceholder(item))
    w.text(placeholder, { indent: 16, size: 9 });
  if (item.choices.length)
    for (const [index, choice] of item.choices.entries())
      w.text(`${label(index)}  ${choice.label}`, { indent: 16 });
  else if (item.responseType === 'true-false')
    w.text('True        False', { indent: 16 });
  if (item.subparts.length) {
    for (const part of item.subparts) {
      w.text(`(${part.partKey}) ${part.prompt}`, { indent: 16 });
      if (!guardian)
        for (let i = 0; i < (ANSWER_LINES[part.responseType ?? ''] ?? 1); i++)
          w.line(32);
    }
  } else if (!guardian) {
    for (let i = 0; i < (ANSWER_LINES[item.responseType] ?? 0); i++) w.line(16);
  }
  if (guardian) {
    const key = guardian.answerKey;
    if (!key) w.text('Key: not provided', { indent: 16, bold: true });
    else {
      const main = atomText(key, item.choices);
      if (main) w.text(`Key: ${main}`, { indent: 16, bold: true });
      for (const [partKey, atom] of Object.entries(key.parts ?? {}))
        w.text(`Key (${partKey}): ${atomText(atom, [])}`, {
          indent: 16,
          bold: true,
        });
      if (key.explanation)
        w.text(`Explanation: ${key.explanation}`, { indent: 16 });
    }
    if (guardian.rubric)
      w.text(
        `Rubric: ${guardian.rubric.criteria
          .map((c) => `${c.label} (${c.maxPoints})`)
          .join('; ')}`,
        { indent: 16, size: 9 },
      );
  }
}

async function render(
  bundle: LearnerWorksheetBundle | GuardianWorksheetBundle,
  title: string,
  subtitle: string,
): Promise<Uint8Array> {
  if (bundle.items.length > MAX_PRINTABLE_ITEMS)
    throw new CourseAuthoringValidationError(
      `A printable carries at most ${MAX_PRINTABLE_ITEMS} questions`,
    );
  const doc = await PDFDocument.create({ updateMetadata: false });
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regularSet = new Set(regular.getCharacterSet());
  const fonts: Fonts = {
    regular,
    bold,
    supported: new Set(bold.getCharacterSet().filter((c) => regularSet.has(c))),
  };
  const budget = new Budget();
  const safeTitle = clean(budget.take(title), fonts.supported).replace(
    /\n/g,
    ' ',
  );
  doc.setTitle(`${safeTitle} (${bundle.audience})`);
  doc.setSubject(`Worksheet ${bundle.worksheetVersionId}`);
  doc.setKeywords([bundle.worksheetVersionId, bundle.audience]);
  doc.setCreator('smrt-education');
  doc.setProducer('smrt-education');
  doc.setAuthor('');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const w = new Writer(doc, fonts, budget);
  w.text(safeTitle, { bold: true, size: 16 });
  w.text(subtitle, { size: 9 });
  let section: string | null = null;
  for (const item of bundle.items as Array<
    LearnerQuestionItem | GuardianQuestionItem
  >) {
    if (item.section && item.section !== section) {
      section = item.section;
      w.gap(10);
      w.keepWithNext(LEADING * 5);
      w.text(item.section, { bold: true, size: 13 });
    }
    renderItem(
      w,
      item,
      bundle.audience === 'guardian' ? (item as GuardianQuestionItem) : null,
    );
  }
  w.footers(`${bundle.worksheetVersionId}  -  ${bundle.audience} copy`);
  return doc.save();
}

/**
 * Learner copy. It takes the keyless learner bundle, whose type has no key,
 * rubric or provenance members, so a key cannot reach the PDF.
 */
export function renderLearnerWorksheetPdf(
  bundle: LearnerWorksheetBundle,
  title: string,
): Promise<Uint8Array> {
  return render(
    bundle,
    title,
    'Name: ____________________    Date: ____________',
  );
}

/** Guardian copy: the same layout plus answer keys, explanations and rubric summaries. */
export function renderGuardianWorksheetPdf(
  bundle: GuardianWorksheetBundle,
  title: string,
): Promise<Uint8Array> {
  return render(
    bundle,
    title,
    'Answer key - guardian copy. Do not hand to the learner.',
  );
}
