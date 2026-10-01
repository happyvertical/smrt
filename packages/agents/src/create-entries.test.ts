import { describe, expect, it } from 'vitest';
import {
  type AgentCreateEntry,
  isAgentCreateEntryAvailable,
  resolveAgentCreateEntries,
} from './ui.js';

const meeting: AgentCreateEntry = {
  id: 'meeting-article',
  type: 'news/politics',
  format: 'text',
  label: 'Write about a meeting',
  icon: 'calendar',
  route: 'articles/new/source?for=meeting',
  order: 10,
  availability: { accessLevels: ['admin', 'editor'] },
};
const video: AgentCreateEntry = {
  id: 'recap-video',
  type: 'news/politics',
  format: 'video',
  label: 'Make a recap video',
  route: '/articles/new/video',
  order: 20,
  availability: { requires: ['video'], permission: 'manage:sources' },
};

describe('resolveAgentCreateEntries', () => {
  const praeco = {
    agentType: '@anytown/praeco:Praeco',
    agentClass: 'Praeco',
    createEntries: [meeting, video],
    permissions: { 'manage:sources': true },
  };

  it('builds links from the base path and sorts by type and order', () => {
    const entries = resolveAgentCreateEntries(
      [
        praeco,
        {
          agentType: '@anytown/ludis:Ludis',
          agentClass: 'Ludis',
          createEntries: [
            {
              id: 'game',
              type: 'news/sports',
              label: 'Write about a game',
              route: 'articles/new/source?for=game',
            },
          ],
        },
      ],
      {
        basePath: '/sites/bentley/',
        accessLevel: 'editor',
        capabilities: ['video'],
      },
    );
    expect(entries.map((entry) => [entry.key, entry.href])).toEqual([
      [
        '@anytown/praeco:Praeco:meeting-article',
        '/sites/bentley/articles/new/source?for=meeting',
      ],
      [
        '@anytown/praeco:Praeco:recap-video',
        '/sites/bentley/articles/new/video',
      ],
      [
        '@anytown/ludis:Ludis:game',
        '/sites/bentley/articles/new/source?for=game',
      ],
    ]);
    expect(entries[0]).not.toHaveProperty('availability');
    expect(entries[0]).not.toHaveProperty('route');
    expect(entries[0]).toMatchObject({ agentClass: 'Praeco', format: 'text' });
  });

  it('applies access level, capabilities, and agent permissions', () => {
    const viewer = resolveAgentCreateEntries([praeco], {
      basePath: '/s',
      accessLevel: 'viewer',
      capabilities: ['video'],
    });
    expect(viewer.map((entry) => entry.id)).toEqual(['recap-video']);

    const noVideo = resolveAgentCreateEntries([praeco], {
      basePath: '/s',
      accessLevel: 'admin',
    });
    expect(noVideo.map((entry) => entry.id)).toEqual(['meeting-article']);

    expect(
      isAgentCreateEntryAvailable(
        video,
        { 'manage:sources': false },
        {
          capabilities: ['video'],
        },
      ),
    ).toBe(false);
  });

  it('drops absolute and protocol-relative routes', () => {
    const entries = resolveAgentCreateEntries(
      [
        {
          agentType: 'X',
          agentClass: 'X',
          createEntries: [
            { id: 'a', type: 't', label: 'A', route: 'https://evil.example/' },
            { id: 'b', type: 't', label: 'B', route: '//evil.example/' },
            { id: 'c', type: 't', label: 'C', route: 'javascript:alert(1)' },
            { id: 'd', type: 't', label: 'D', route: 'ok' },
          ],
        },
      ],
      { basePath: '' },
    );
    expect(entries.map((entry) => entry.href)).toEqual(['/ok']);
  });
});
