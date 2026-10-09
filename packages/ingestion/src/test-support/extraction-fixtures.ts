import { createHash } from 'node:crypto';
import type { PDFReader } from '@happyvertical/pdf';
import type {
  ExtractionLimits,
  ExtractionRequest,
} from '../extraction-types.js';
export const extractionLimits: ExtractionLimits = {
  maxBytes: 1024 * 1024,
  maxPages: 8,
  maxPixels: 1_000_000,
  maxOutputBytes: 65536,
  timeoutMs: 10000,
  maxTokens: 256,
  workerHeapMb: 256,
};
export const fixtureIdentity = {
  provider: 'fixture',
  model: 'deterministic',
  version: '1',
};
export function extractionRequest(
  bytes: Uint8Array = Buffer.from('message with attachment'),
  mediaType = 'text/plain',
): ExtractionRequest {
  return {
    bytes,
    evidence: {
      id: 'evidence-1',
      partId: 'attachment-1',
      parentEvidenceId: 'message-1',
      mediaType,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    },
    limits: { ...extractionLimits },
    configurationRevision: 'fixture-v1',
  };
}
/** Explicit injected SDK boundary, never a real PDF integration claim. */
export function pdfFixture(
  pages: Array<string | null>,
  png: Uint8Array,
): Pick<
  PDFReader,
  'checkCapabilities' | 'extractMetadata' | 'extractText' | 'renderPages'
> {
  return {
    checkCapabilities: async () => ({
      canExtractText: true,
      canExtractMetadata: true,
      canExtractImages: true,
      canPerformOCR: true,
      supportedFormats: ['pdf'],
    }),
    extractMetadata: async () => ({ pageCount: pages.length }),
    extractText: async (_source, options) =>
      pages[(options?.pages?.[0] ?? 1) - 1],
    renderPages: async (_source, options) => [
      { data: png, pageNumber: options?.pages?.[0], format: 'png' },
    ],
  };
}
/** Small valid PDF generated locally, with one embedded-text page. */
export function embeddedPDF(value = 'Retained invoice 42'): Buffer {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 20 100 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let valuePDF = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(valuePDF));
    valuePDF += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(valuePDF);
  valuePDF += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(valuePDF);
}
/** Two-page uncompressed TIFF. Both IFDs map to an original page; no PNG masquerade. */
export function multipageTIFF(): Buffer {
  const entries = 9,
    ifdSize = 2 + entries * 12 + 4,
    pixelStart = 8 + 2 * ifdSize;
  const bytes = Buffer.alloc(pixelStart + 8);
  bytes.write('II');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  for (let page = 0; page < 2; page++) {
    const offset = 8 + page * ifdSize;
    bytes.writeUInt16LE(entries, offset);
    const tags = [
      [256, 4, 2],
      [257, 4, 2],
      [258, 3, 8],
      [259, 3, 1],
      [262, 3, 1],
      [273, 4, pixelStart + page * 4],
      [277, 3, 1],
      [278, 4, 2],
      [279, 4, 4],
    ];
    for (const [index, [tag, type, value]] of tags.entries()) {
      const entry = offset + 2 + index * 12;
      bytes.writeUInt16LE(tag, entry);
      bytes.writeUInt16LE(type, entry + 2);
      bytes.writeUInt32LE(1, entry + 4);
      bytes.writeUInt32LE(value, entry + 8);
    }
    bytes.writeUInt32LE(
      page === 0 ? 8 + ifdSize : 0,
      offset + 2 + entries * 12,
    );
    bytes.fill(
      page === 0 ? 255 : 0,
      pixelStart + page * 4,
      pixelStart + (page + 1) * 4,
    );
  }
  return bytes;
}

/** Valid PCM recording of a generated 440Hz tone; not human speech. */
export function recordedToneWAV(): Buffer {
  const rate = 8000,
    samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16000),
      44 + i * 2,
    );
  return bytes;
}

/** Actual PDF raster page, optionally preceded by an embedded-text page. */
export function scannedPDF(mixed = false, allRaster = false): Buffer {
  const raster = 'q 100 0 0 100 20 20 cm /Im1 Do Q';
  const embedded = 'BT /F1 12 Tf 20 100 Td (Embedded first page) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R${mixed ? ' 7 0 R' : ''}] /Count ${mixed ? 2 : 1} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 160] /Resources << /XObject << /Im1 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${(mixed && !allRaster ? embedded : raster).length} >>\nstream\n${mixed && !allRaster ? embedded : raster}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 9 >>\nstream\nff0000ff>\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (mixed)
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 160] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 8 0 R >>',
      `<< /Length ${raster.length} >>\nstream\n${raster}\nendstream`,
    );
  let value = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
