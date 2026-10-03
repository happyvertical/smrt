import { render } from 'svelte/server';
import AttachmentUpload from '../../src/svelte/components/AttachmentUpload.svelte';
import type { AttachmentUploadProps } from '../../src/svelte/attachments/types.js';
export function page(props: Partial<AttachmentUploadProps> = {}): string {
  const { body } = render(AttachmentUpload, { props: { action: '/upload', fileField: 'receipt', description: 'Retained description', hiddenFields: [{ name: 'requestId', value: 'keep-request' }, { name: 'tenantId', value: 'keep-tenant' }], ...props } });
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native attachment proof</title></head><body>${body}</body></html>`;
}
