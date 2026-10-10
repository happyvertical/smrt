import type { ExportFile } from './types.js';

/** Hand a generated file to the browser as a download. No-op without a DOM. */
export function downloadFile(file: ExportFile): void {
  if (
    typeof document === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return;
  }
  const url = URL.createObjectURL(
    new Blob([file.content], { type: file.mimeType }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been dispatched so the download can start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
