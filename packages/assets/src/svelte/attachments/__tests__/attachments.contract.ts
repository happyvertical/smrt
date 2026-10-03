import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import {
  AttachmentList,
  AttachmentPanel,
  AttachmentUpload,
} from '../../index.js';
import { attachmentLink } from '../link.js';
import type { AssetAttachment, AttachmentUploadProps } from '../types.js';

const attachment: AssetAttachment = {
  id: 'asset-v2',
  name: 'Private quote.pdf',
  mimeType: 'application/pdf',
  version: 2,
  viewHref: '/authorized/view?id=v2',
  downloadHref: '/authorized/download?id=v2',
  versions: [
    {
      id: 'asset-v1',
      name: 'Original quote.pdf',
      mimeType: 'application/pdf',
      version: 1,
      note: 'Original document',
    },
  ],
};
const upload = (props: Partial<AttachmentUploadProps> = {}) =>
  render(AttachmentUpload, { props: { action: '/upload', ...props } }).body;

describe('private attachments SSR/native contract', () => {
  it('registers public surfaces', () => {
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-assets', 'attachment-panel'),
    ).toBe(AttachmentPanel);
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-assets', 'attachment-list'),
    ).toBe(AttachmentList);
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-assets', 'attachment-upload'),
    ).toBe(AttachmentUpload);
  });
  it('renders authorized URLs/history without exposing extra storage paths or deriving links', () => {
    const item = {
      ...attachment,
      sourceUri: 's3://private/secret.pdf',
      statusLabel: 'Future consumer state',
    };
    const body = render(AttachmentList, {
      props: { attachments: [item] },
    }).body;
    expect(body).toContain('href="/authorized/view?id=v2"');
    expect(body).toContain('href="/authorized/download?id=v2"');
    expect(body).toContain('Original document');
    expect(body).toContain('Version 1');
    expect(body).toContain('Future consumer state');
    expect(body).not.toContain('s3://');
    expect(body).not.toContain('secret.pdf');
    expect(body.match(/href=/g)).toHaveLength(2);
  });
  it('omits unsafe or absent links, preserves unknown/missing metadata, and supports empty/error/loading', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///private',
      'java\nscript:alert(1)',
      '',
    ])
      expect(attachmentLink(value)).toBeUndefined();
    expect(attachmentLink('?download=1')).toBe('?download=1');
    const body = render(AttachmentList, {
      props: {
        attachments: [
          {
            id: 'a',
            name: 'unknown',
            mimeType: 'application/x-future',
            viewHref: 'javascript:alert(1)',
          },
        ],
      },
    }).body;
    expect(body).not.toContain('href=');
    expect(body).toContain('application/x-future');
    expect(
      render(AttachmentList, { props: { attachments: [] } }).body,
    ).toContain('No files attached');
    const loading = render(AttachmentList, {
      props: { attachments: [], loading: true, message: 'Access revoked' },
    }).body;
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Access revoked');
  });
  it('preserves native multipart names, caller tokens, errors and lossless metadata', () => {
    const body = upload({
      fileField: 'receipt',
      descriptionField: 'note',
      intentField: 'operation',
      intent: 'attach',
      description: 'Keep <description>',
      hiddenFields: [
        { name: 'requestId', value: 'same-key' },
        { name: 'context', value: 'a' },
        { name: 'context', value: 'b' },
      ],
      fileError: 'Rejected file',
      descriptionError: 'Retain this note',
      message: 'Server denied upload',
      reselectFile: true,
    });
    expect(body).toContain('enctype="multipart/form-data"');
    expect(body).toContain('method="post"');
    expect(body).toContain('type="file" name="receipt"');
    expect(body).toContain('name="note"');
    expect(body).toContain('Keep &lt;description>');
    expect(body).toContain('value="same-key"');
    expect(body.match(/name="context"/g)).toHaveLength(2);
    expect(body).toContain('name="operation" value="attach"');
    expect(body).toContain('Rejected file');
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain('Choose the file again before retrying');
    expect(body).toContain('Server denied upload');
  });
  it('read-only hides mutation controls while in-flight and uncertain states preserve metadata', () => {
    expect(upload({ canUpload: false })).not.toContain('<form');
    const pending = upload({
      retryStatus: 'submitting',
      description: 'Keep this',
    });
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toMatch(/<button[^>]*disabled/);
    expect(pending).toContain('Keep this');
    const uncertain = upload({
      retryStatus: 'transport-error',
      description: 'Still here',
    });
    expect(uncertain).toContain('The upload outcome is uncertain');
    expect(uncertain).toContain('Still here');
  });
});
