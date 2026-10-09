import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateCorpus } from './corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const familyFile = join(here, 'corpus/v1/families.json');
const families = JSON.parse(readFileSync(familyFile, 'utf8'));
const CREATE = '@happyvertical/smrt-ingestion-reference:create-draft';
const ATTACH = '@happyvertical/smrt-ingestion-reference:attach-evidence';
const numbers = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
function words(number) {
  if (number < 20) return numbers[number - 1];
  return (
    ['twenty', 'thirty', 'forty', 'fifty'][Math.floor(number / 10) - 2] +
    (number % 10 ? ` ${numbers[(number % 10) - 1]}` : '')
  );
}
const wrap = (value) =>
  value.match(/.{1,68}(?:\s|$)|\S{1,68}/g).map((line) => line.trim());
const escapePDF = (value) =>
  value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
function pdf(text) {
  const stream = `BT /F1 11 Tf 36 750 Td 15 TL\n${wrap(text)
    .map((line, index) => `${index ? 'T* ' : ''}(${escapePDF(line)}) Tj`)
    .join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
/** Materialize to an external artifact directory. No provider calls or paid synthesis. */
export function generateCorpus(output, options = {}) {
  const root = resolve(output);
  mkdirSync(root, { recursive: true });
  const speech = options.speech ?? 'espeak-ng';
  const image = options.image ?? 'magick';
  const font = options.font ?? process.env.EVALUATION_FONT_FILE;
  if (!font)
    throw new Error(
      'Explicit EVALUATION_FONT_FILE required for reproducible raster text',
    );
  const fontHash = sha256(readFileSync(font));
  const speechVersion = execFileSync(speech, ['--version'], {
    encoding: 'utf8',
  }).trim();
  const imageVersion = execFileSync(image, ['-version'], {
    encoding: 'utf8',
  }).split('\n')[0];
  const generatorHash = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const manifest = {
    version: 'synthetic-reference-v1',
    generatorHash,
    familyHash: sha256(readFileSync(familyFile)),
    tools: { speech: speechVersion, image: imageVersion, fontSha256: fontHash },
    cases: [],
  };
  for (const [category, definitions] of Object.entries(families)) {
    for (const family of definitions) {
      for (let variant = 1; variant <= 20; variant++) {
        const id = `${family.name}-${String(variant).padStart(2, '0')}`;
        const title = `${family.name.replaceAll('-', ' ')} ${words(variant)}`;
        const target = `target-${family.name}-${variant}`;
        const text =
          category === 'draft'
            ? `${family.instruction}\nTitle: ${title}\nBody: ${family.body}\nEnd of body.`
            : category === 'attachment'
              ? `${family.instruction}\nDocument reference: ${target}.\nDocument title: ${title}.\nEvidence: the complete current source.`
              : `${family.instruction}\nSource reference: ${title}.`;
        let format =
          variant <= 10
            ? ['txt', 'text/plain']
            : variant <= 16
              ? ['pdf', 'application/pdf']
              : variant <= 18
                ? ['png', 'image/png']
                : ['wav', 'audio/wav'];
        if (family.fault === 'corrupt_source' && format[0] === 'txt')
          format = ['pdf', 'application/pdf'];
        const name = `${id}.${format[0]}`;
        const path = join(root, name);
        if (family.fault === 'corrupt_source')
          writeFileSync(path, `CORRUPT ${format[0]} synthetic ${id}\n`);
        else if (format[0] === 'txt') writeFileSync(path, `${text}\n`);
        else if (format[0] === 'pdf') writeFileSync(path, pdf(text));
        else if (format[0] === 'png')
          execFileSync(image, [
            '-size',
            '1000x1000',
            'xc:#f3f0e9',
            '-font',
            font,
            '-pointsize',
            '21',
            '-fill',
            '#202020',
            '-gravity',
            'northwest',
            '-annotate',
            '+35+45',
            wrap(text).join('\n'),
            '-background',
            '#f3f0e9',
            '-rotate',
            variant % 2 ? '1' : '-1',
            '-gravity',
            'center',
            '-extent',
            '1000x1000',
            '-strip',
            '-define',
            'png:exclude-chunk=time,date',
            path,
          ]);
        else
          execFileSync(
            speech,
            ['-v', 'en-us', '-s', '155', '-w', path, '--stdin'],
            { input: text },
          );
        const bytes = readFileSync(path);
        let durationSeconds;
        if (format[0] === 'wav' && !family.fault) {
          if (
            bytes.toString('ascii', 0, 4) !== 'RIFF' ||
            bytes.toString('ascii', 36, 40) !== 'data'
          )
            throw new Error('Unexpected synthesized WAV layout');
          durationSeconds = bytes.readUInt32LE(40) / bytes.readUInt32LE(28);
          if (
            !Number.isFinite(durationSeconds) ||
            durationSeconds <= 0 ||
            durationSeconds > 30
          )
            throw new Error(
              'Synthetic audio exceeds single short-request profile',
            );
        }
        const expected =
          category === 'draft'
            ? [
                {
                  kind: 'draft',
                  handler: CREATE,
                  fields: { title, body: family.body },
                },
              ]
            : category === 'attachment'
              ? [
                  {
                    kind: 'attachment',
                    handler: ATTACH,
                    target,
                    fields: { contentId: target, evidenceId: `evidence-${id}` },
                  },
                ]
              : [];
        const ambiguousCandidates =
          family.reason === 'ambiguous_destination'
            ? [
                { id: `ambiguous-a-${id}`, title: family.candidateTitle },
                { id: `ambiguous-b-${id}`, title: family.candidateTitle },
              ]
            : [];
        const hiddenTargets = family.hiddenTargetTitle
          ? [
              {
                id: `hidden-${id}`,
                title: family.hiddenTargetTitle,
                visibility:
                  family.reason === 'tenant_denial'
                    ? 'different-tenant'
                    : 'different-confidential-scope',
              },
            ]
          : [];
        manifest.cases.push({
          id,
          group: family.name,
          partition: family.partition,
          category,
          supported: category !== 'abstain',
          coverage: family.coverage ?? [],
          lane: family.fault ? 'deterministic-fault' : 'provider-quality',
          ...(family.fault ? { systemAbstentionReason: family.fault } : {}),
          expected,
          ...(category === 'abstain' ? { abstainReason: family.reason } : {}),
          fixtureContext: {
            activeTenant: 'synthetic-tenant-a',
            activeConfidentialScope: 'synthetic-public',
            hiddenTargets,
          },
          candidates:
            category === 'attachment'
              ? [
                  { id: target, title },
                  { id: `decoy-${id}`, title: `${title} appendix` },
                ]
              : ambiguousCandidates,
          sources: [
            {
              path: name,
              mediaType: format[1],
              sha256: sha256(bytes),
              byteLength: bytes.length,
              ...(durationSeconds === undefined ? {} : { durationSeconds }),
            },
          ],
          provenance: {
            author:
              'OpenAI Codex author-created synthetic fixture; GitHub#3677',
            generator: generatorHash,
            annotation:
              'Deterministic labels from authored family specification; no model predictions used',
            adjudication:
              'Single-author mechanical label validation; independent human semantic adjudication pending',
            sourceText: text,
            domain:
              format[0] === 'wav'
                ? 'synthetic intelligible speech, not a human recording'
                : format[0] === 'png'
                  ? 'synthetic skewed raster document, not a camera photograph'
                  : 'synthetic authored document',
          },
        });
      }
    }
  }
  const summary = validateCorpus(manifest, root, {
    requireHeldoutCoverage: true,
  });
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  writeFileSync(join(root, 'manifest.json'), manifestBytes);
  const index = {
    version: manifest.version,
    generatorHash,
    familyHash: manifest.familyHash,
    tools: manifest.tools,
    manifestSha256: sha256(manifestBytes),
    summary,
    groupColumns: [
      'group',
      'partition',
      'category',
      'caseCount',
      'caseRecordsSha256',
    ],
    groups: [...new Set(manifest.cases.map((item) => item.group))].map(
      (group) => {
        const cases = manifest.cases.filter((item) => item.group === group);
        return [
          group,
          cases[0].partition,
          cases[0].category,
          cases.length,
          sha256(JSON.stringify(cases)),
        ];
      },
    ),
  };
  return index;
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [output, indexPath] = process.argv.slice(2);
  if (!output || !indexPath)
    throw new Error('Usage: generate-corpus.mjs EXTERNAL_OUTPUT INDEX_FILE');
  const index = generateCorpus(output);
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(index.summary)}\n`);
}
