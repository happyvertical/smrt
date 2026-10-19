import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DRIVE_CURRICULUM_SEED_ROOTS,
  type DriveFileMetadata,
  GoogleDriveCurriculumAdapter,
  type GoogleDriveFilesClient,
} from '../sources/google-drive-adapter.js';

const folder = (
  id: string,
  name: string,
  parents: string[] = [],
): DriveFileMetadata => ({
  id,
  name,
  mimeType: 'application/vnd.google-apps.folder',
  parents,
  revisionId: `revision-${id}`,
});
const file = (
  id: string,
  name: string,
  parents: string[],
): DriveFileMetadata => ({
  id,
  name,
  mimeType: 'application/pdf',
  parents,
  revisionId: `revision-${id}`,
});

function client(
  pages: Record<string, DriveFileMetadata[]>,
  options: { target?: DriveFileMetadata; bytes?: Buffer } = {},
): GoogleDriveFilesClient & { listMetadataPage: ReturnType<typeof vi.fn> } {
  return {
    listMetadataPage: vi.fn(async ({ folderId, pageToken } = {}) => ({
      entries: pages[`${folderId}:${pageToken ?? ''}`] ?? [],
      ...(folderId === 'root' && !pageToken ? { nextPageToken: 'next' } : {}),
    })),
    getMetadataById: vi.fn(async () => {
      if (!options.target) throw new Error('not found');
      return options.target;
    }),
    acquireById: vi.fn(async (id, acquisition) => {
      const bytes = options.bytes ?? Buffer.from('worksheet');
      return {
        bytes,
        metadata: {
          ...file(id, 'Worksheet.pdf', ['root']),
          revisionId: acquisition.expectedRevision,
        },
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        exportMimeType: acquisition.exportMimeType,
      };
    }),
  };
}

describe('GoogleDriveCurriculumAdapter', () => {
  it('uses the four configured seed roots exactly once', () => {
    expect(
      new Set(DRIVE_CURRICULUM_SEED_ROOTS.map((root) => root.id)).size,
    ).toBe(4);
  });

  it('resumes paged metadata traversal without downloading content', async () => {
    const drive = client({
      'root:': [
        folder('lesson', 'Lesson', ['root']),
        file('a', 'Worksheet.pdf', ['root']),
      ],
      'root:next': [file('b', 'Teacher notes.pdf', ['root'])],
      'lesson:': [file('c', 'Answer Key.pdf', ['lesson'])],
    });
    const adapter = new GoogleDriveCurriculumAdapter(drive, {
      roots: [{ id: 'root' }],
    });
    const first = await adapter.discover({
      roots: [{ id: 'root' }],
      pageSize: 1,
    });
    expect(first.complete).toBe(false);
    expect(first.records.map((record) => record.stableId)).toEqual([
      'lesson',
      'a',
    ]);
    expect(drive.acquireById).not.toHaveBeenCalled();

    const second = await adapter.discover({
      roots: [{ id: 'root' }],
      checkpoint: first.checkpoint,
    });
    expect(second.records).toMatchObject([
      { stableId: 'b', visibility: 'teacher' },
    ]);
    const third = await adapter.discover({
      roots: [{ id: 'root' }],
      checkpoint: second.checkpoint,
    });
    expect(third.records).toMatchObject([
      { stableId: 'c', visibility: 'teacher' },
    ]);
    expect(third.complete).toBe(true);
    expect(drive.acquireById).not.toHaveBeenCalled();
  });

  it('classifies common answer and teacher name variants, including inherited folders', async () => {
    const drive = client({
      'root:': [
        folder('answers', 'Answer_Key', ['root']),
        file('a', 'Answers.pdf', ['root']),
        file('b', 'TeachersGuide.pdf', ['root']),
        file('c', 'Educators.pdf', ['root']),
      ],
      'answers:': [file('d', 'worksheet.pdf', ['answers'])],
    });
    const adapter = new GoogleDriveCurriculumAdapter(drive, {
      roots: [{ id: 'root' }],
    });
    const page = await adapter.discover({
      roots: [{ id: 'root' }],
      pageSize: 100,
    });
    expect(
      page.records.every((record) => record.visibility === 'teacher'),
    ).toBe(true);
    expect(
      page.records.find((record) => record.stableId === 'answers')?.visibility,
    ).toBe('teacher');
  });

  it('deduplicates duplicate names and roots by stable Drive ID', async () => {
    const drive = client({
      'root:': [
        file('same', 'Copy.pdf', ['root']),
        file('same', 'Copy.pdf', ['root']),
      ],
    });
    const page = await new GoogleDriveCurriculumAdapter(drive).discover({
      roots: [{ id: 'root' }, { id: 'root' }],
    });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      stableId: 'same',
      licenseEvidence: { state: 'unknown' },
    });
  });

  it('reports a durable sync cursor and chooses PDF for native printable exports', async () => {
    const drive = client({
      'root:': [
        {
          ...file('sheet', 'Workbook', ['root']),
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    });
    const adapter = new GoogleDriveCurriculumAdapter(drive, {
      roots: [{ id: 'root' }],
    });
    const page = await adapter.enumerate({
      cursor: undefined,
      checkpoint: {} as never,
    });
    expect(page).toMatchObject({
      complete: false,
      records: [{ stableId: 'sheet', availableFormats: ['application/pdf'] }],
    });
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('visibly excludes metadata that lacks a source revision', async () => {
    const drive = client({
      'root:': [
        {
          id: 'unknown',
          name: 'Unversioned',
          mimeType: 'application/pdf',
          parents: ['root'],
        },
      ],
    });
    const page = await new GoogleDriveCurriculumAdapter(drive).discover({
      roots: [{ id: 'root' }],
    });
    expect(page.records).toEqual([]);
    expect(page.exclusions).toEqual([
      { stableId: 'unknown', reason: 'missing-revision' },
    ]);
  });

  it('requires target reauthorization and detects shortcut cycles', async () => {
    const target = folder('root', 'Root', ['root']);
    const drive = client(
      {
        'root:': [
          {
            ...file('shortcut', 'Loop', ['root']),
            mimeType: 'application/vnd.google-apps.shortcut',
            shortcutDetails: {
              targetId: 'root',
              targetMimeType: 'application/vnd.google-apps.folder',
            },
          },
        ],
      },
      { target },
    );
    const page = await new GoogleDriveCurriculumAdapter(drive).discover({
      roots: [{ id: 'root' }],
    });
    expect(page.exclusions).toEqual([
      { stableId: 'root', reason: 'shortcut-target-outside-boundary' },
    ]);
    expect(drive.getMetadataById).toHaveBeenCalledWith('root');
  });

  it('pins explicitly authorized acquisition bytes and rejects unknown licenses', async () => {
    const drive = client({}, { bytes: Buffer.from('printable') });
    const adapter = new GoogleDriveCurriculumAdapter(drive);
    await expect(
      adapter.acquireSelected(
        { stableId: 'worksheet', revision: 'v1', allowed: false },
        { maxBytes: 100, exportMimeType: 'application/pdf' },
      ),
    ).rejects.toThrow('not authorized');
    const acquired = await adapter.acquireSelected(
      {
        stableId: 'worksheet',
        revision: 'v1',
        allowed: true,
        exportMimeType: 'application/pdf',
      },
      { maxBytes: 100 },
    );
    expect(acquired).toMatchObject({
      stableId: 'worksheet',
      revision: 'v1',
      exportMimeType: 'application/pdf',
    });
    expect(acquired.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(drive.acquireById).toHaveBeenCalledTimes(1);
  });
});
