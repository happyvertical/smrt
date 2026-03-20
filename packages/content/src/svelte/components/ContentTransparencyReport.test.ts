// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContentTransparencyData } from '../../content-transparency';
import ContentTransparencyReport from './ContentTransparencyReport.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderReport(
  props: {
    transparency?: ContentTransparencyData | null;
    title?: string;
    emptyCopy?: string;
  } = {},
) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentTransparencyReport, {
    target,
    props,
  });

  mountedComponents.push(component);
  flushSync();

  return target;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }
  document.body.innerHTML = '';
});

describe('ContentTransparencyReport component', () => {
  it('renders the empty state when no snapshot is available', () => {
    const target = renderReport({
      title: 'Public transparency',
      emptyCopy: 'Nothing published yet.',
    });

    expect(target.textContent).toContain('Public transparency');
    expect(target.textContent).toContain('Nothing published yet.');
  });

  it('renders the published transparency snapshot sections', () => {
    const transparency: ContentTransparencyData = {
      generatedAt: '2026-03-20T10:00:00.000Z',
      snapshotKind: 'published',
      contentId: 'content-1',
      currentContentStatus: 'published',
      publicationProfileKey: 'publication',
      publicationVersion: {
        id: 'version-1',
        version: 3,
        kind: 'publication',
        summary: 'Published after review',
        createdAt: '2026-03-20T09:55:00.000Z',
      },
      generation: {
        aiAssisted: true,
        publicPrompt: 'Write a transparent summary using the verified facts.',
        model: 'gpt-5.4',
      },
      factsUsed: [
        {
          id: 'fact-1',
          textRefined: 'The city approved the project in February.',
          relationship: 'supports',
          usedInArticle: true,
          sources: [
            {
              id: 'source-1',
              sourceType: 'reference',
              sourceUrl: 'https://example.com/source-1',
              sourceTitle: 'City council minutes',
              credibility: 0.9,
              extractedAt: '2026-03-19T08:00:00.000Z',
              metadata: {},
            },
          ],
        },
      ],
      linkedFacts: [
        {
          id: 'fact-1',
          textRefined: 'The city approved the project in February.',
          relationship: 'supports',
          usedInArticle: true,
          sources: [],
        },
      ],
      otherExtractedFacts: [
        {
          id: 'fact-2',
          textRefined: 'The contractor expects work to begin in April.',
          relationship: 'context',
          usedInArticle: false,
          sources: [],
        },
      ],
      references: [
        {
          id: 'ref-1',
          title: 'City council minutes',
          url: 'https://example.com/source-1',
          originalUrl: null,
          type: 'document',
          source: 'manual',
          usedFactIds: ['fact-1'],
          extractedFacts: [
            {
              id: 'fact-1',
              textRefined: 'The city approved the project in February.',
              relationship: 'supports',
              usedInArticle: true,
              sources: [],
            },
            {
              id: 'fact-2',
              textRefined: 'The contractor expects work to begin in April.',
              relationship: 'context',
              usedInArticle: false,
              sources: [],
            },
          ],
        },
      ],
      reviews: [
        {
          id: 'review-1',
          policyKey: 'facts',
          kind: 'facts',
          status: 'passed',
          summary: 'All linked facts were reflected accurately.',
        },
      ],
      reviewProfiles: [],
      corrections: [
        {
          id: 'correction-1',
          summary:
            'Updated the start date after the city amended the schedule.',
          publicNote: 'The project now begins in May.',
          publishedAt: '2026-03-21T10:00:00.000Z',
        },
      ],
      versionHistory: [
        {
          id: 'version-1',
          version: 3,
          kind: 'publication',
          summary: 'Published after review',
          createdAt: '2026-03-20T09:55:00.000Z',
          provenance: {},
        },
      ],
    };

    const target = renderReport({ transparency });

    expect(target.textContent).toContain('published snapshot');
    expect(target.textContent).toContain('1 facts used');
    expect(target.textContent).toContain('City council minutes');
    expect(target.textContent).toContain(
      'The city approved the project in February.',
    );
    expect(target.textContent).toContain(
      'Updated the start date after the city amended the schedule.',
    );
    expect(target.textContent).toContain('Write a transparent summary');

    const highlightedFact = target.querySelector('.pill-list .used');
    expect(highlightedFact?.textContent).toContain(
      'The city approved the project in February.',
    );
  });
});
