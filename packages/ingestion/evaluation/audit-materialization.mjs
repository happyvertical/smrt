import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPDFReader } from '@happyvertical/pdf';
import sharp from 'sharp';
import { verifyMaterialization } from './freeze.mjs';

const normalize = (value) => value.replace(/\s+/g, ' ').trim();

/** Real local format/byte audit, never recognition or remote model quality evidence. */
export async function auditMaterialization(indexPath, root) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const { manifest, summary } = verifyMaterialization(index, root);
  const pdf = await getPDFReader({ provider: 'unpdf', enableOCR: false });
  const counts = {
    text: 0,
    pdf: 0,
    image: 0,
    speech: 0,
    corruptPDF: 0,
    corruptImage: 0,
    corruptAudio: 0,
  };
  const media = {};
  const durationSeconds = [];
  for (const item of manifest.cases) {
    const source = item.sources[0];
    const bytes = readFileSync(join(root, source.path));
    const corrupt = item.lane === 'deterministic-fault';
    if (item.partition === 'heldout')
      media[source.mediaType] = (media[source.mediaType] ?? 0) + 1;
    if (source.mediaType === 'application/pdf') {
      if (corrupt) {
        let readable = false;
        try {
          readable = Boolean(
            (await pdf.extractText(bytes, { skipOCRFallback: true }))?.trim(),
          );
        } catch {
          /* Expected parser rejection; not a provider-quality result. */
        }
        if (readable) throw new Error(`Expected unreadable PDF: ${item.id}`);
        counts.corruptPDF++;
      } else {
        const text = await pdf.extractText(bytes, { skipOCRFallback: true });
        if (
          typeof text !== 'string' ||
          normalize(text) !== normalize(item.provenance.sourceText)
        )
          throw new Error(`PDF text differs: ${item.id}`);
        counts.pdf++;
      }
    } else if (source.mediaType === 'image/png') {
      let metadata;
      try {
        metadata = await sharp(bytes).metadata();
      } catch (error) {
        if (!corrupt) throw error;
      }
      if (corrupt) {
        if (metadata) throw new Error(`Expected corrupt image: ${item.id}`);
        counts.corruptImage++;
      } else {
        if (
          metadata.width !== 1000 ||
          metadata.height !== 1000 ||
          metadata.format !== 'png'
        )
          throw new Error('Unexpected raster format');
        counts.image++;
      }
    } else if (source.mediaType === 'audio/wav') {
      const valid =
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WAVE';
      if (corrupt) {
        if (valid) throw new Error(`Expected corrupt audio: ${item.id}`);
        counts.corruptAudio++;
      } else {
        if (
          !valid ||
          bytes.readUInt16LE(20) !== 1 ||
          bytes.readUInt16LE(34) !== 16 ||
          bytes.toString('ascii', 36, 40) !== 'data'
        )
          throw new Error('Unexpected synthesized PCM');
        const duration = bytes.readUInt32LE(40) / bytes.readUInt32LE(28);
        if (
          duration !== source.durationSeconds ||
          duration <= 0 ||
          duration > 30 ||
          bytes.subarray(44).every((value) => value === 0)
        )
          throw new Error('Invalid speech waveform');
        durationSeconds.push(duration);
        counts.speech++;
      }
    } else {
      if (
        normalize(bytes.toString('utf8')) !==
        normalize(item.provenance.sourceText)
      )
        throw new Error('Text source differs');
      counts.text++;
    }
  }
  return {
    summary,
    heldoutMedia: media,
    formats: counts,
    speechDurationRangeSeconds: [
      Math.min(...durationSeconds),
      Math.max(...durationSeconds),
    ],
    evidenceClass:
      'actual local unpdf/sharp/PCM format audit; no recognition accuracy or provider inference',
    manifestSha256: index.manifestSha256,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [index, root, report] = process.argv.slice(2);
  if (!report)
    throw new Error('Usage: audit-materialization.mjs INDEX CORPUS REPORT');
  const result = await auditMaterialization(index, root);
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result.formats)}\n`);
}
