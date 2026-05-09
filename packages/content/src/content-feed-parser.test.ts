import { describe, expect, it } from 'vitest';
import { parseContentFeed } from './content-feed-parser';

describe('parseContentFeed', () => {
  it('parses RSS items and removes duplicate GUIDs', () => {
    const feed = parseContentFeed(
      `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Blindman Regional Wire</title>
          <link>https://blindman.net/</link>
          <item>
            <title>Council approves budget</title>
            <link>/stories/budget</link>
            <guid>story-1</guid>
            <author>editor@example.com</author>
            <pubDate>Tue, 24 Mar 2026 12:00:00 GMT</pubDate>
            <category>Municipal</category>
            <description><![CDATA[<p>Budget passes &amp; work starts.</p>]]></description>
          </item>
          <item>
            <title>Council approves budget duplicate</title>
            <link>https://blindman.net/stories/budget-copy</link>
            <guid>story-1</guid>
          </item>
        </channel>
      </rss>`,
      'https://blindman.net/feed.xml',
    );

    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Blindman Regional Wire');
    expect(feed.homepageUrl).toBe('https://blindman.net/');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      title: 'Council approves budget',
      url: 'https://blindman.net/stories/budget',
      guid: 'story-1',
      author: 'editor@example.com',
      summary: 'Budget passes & work starts.',
      categories: ['Municipal'],
    });
    expect(feed.items[0]?.publishedAt?.toISOString()).toBe(
      '2026-03-24T12:00:00.000Z',
    );
  });

  it('parses Atom entries with alternate links and category terms', () => {
    const feed = parseContentFeed(
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Regional Updates</title>
        <link rel="alternate" href="https://example.test/" />
        <entry>
          <title>School board releases calendar</title>
          <id>tag:example.test,2026:calendar</id>
          <link rel="alternate" href="/updates/calendar" />
          <author><name>Jane Reporter</name></author>
          <published>2026-04-02T18:30:00Z</published>
          <updated>2026-04-03T10:15:00Z</updated>
          <category term="Schools" />
          <summary>Calendar details for families.</summary>
        </entry>
      </feed>`,
      'https://example.test/feed.atom',
    );

    expect(feed.format).toBe('atom');
    expect(feed.homepageUrl).toBe('https://example.test/');
    expect(feed.items).toEqual([
      expect.objectContaining({
        title: 'School board releases calendar',
        url: 'https://example.test/updates/calendar',
        guid: 'tag:example.test,2026:calendar',
        author: 'Jane Reporter',
        summary: 'Calendar details for families.',
        categories: ['Schools'],
      }),
    ]);
    expect(feed.items[0]?.updatedAt?.toISOString()).toBe(
      '2026-04-03T10:15:00.000Z',
    );
  });

  it('rejects unsupported XML documents', () => {
    expect(() => parseContentFeed('<document />')).toThrow(
      'Unsupported feed format',
    );
  });
});
