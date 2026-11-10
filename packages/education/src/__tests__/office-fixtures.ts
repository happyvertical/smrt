/** Minimal OOXML packages for bundle tests: only the part names matter to the importer. */
import { buildZip } from './bundle-zip-writer.js';

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

export function officeDocx(
  label: string,
  extra: Array<{ name: string; data: Uint8Array | string }> = [],
) {
  return Buffer.from(
    buildZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: 'word/document.xml', data: `<w:document>${label}</w:document>` },
      ...extra,
    ]),
  );
}

export function officePptx(label: string) {
  return Buffer.from(
    buildZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      {
        name: 'ppt/presentation.xml',
        data: `<p:presentation>${label}</p:presentation>`,
      },
      { name: 'ppt/slides/slide1.xml', data: `<p:sld>${label}</p:sld>` },
    ]),
  );
}

export function officeXlsx(label: string) {
  return Buffer.from(
    buildZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: 'xl/workbook.xml', data: `<workbook>${label}</workbook>` },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<worksheet>${label}</worksheet>`,
      },
    ]),
  );
}
