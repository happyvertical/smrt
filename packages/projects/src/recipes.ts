/**
 * Declared recipes for smrt-projects (#3590, #3604): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Comment } from './models/Comment.js';
import { Issue } from './models/Issue.js';
import { Label } from './models/Label.js';
import { Project } from './models/Project.js';

/** Projects: Track projects and the issues, labels and comments inside them. */
export class ProjectTrackerRecipe extends SmrtRecipe {
  static id = 'projects.tracker';
  static help = './tracker.recipe.md';
  static label = 'Projects';
  static summary =
    'Track projects and the issues, labels and comments inside them.';
  static synonyms = ['issues', 'tasks', 'tickets', 'bugs', 'kanban'];
  static section = {
    id: 'projects',
    label: 'Projects',
    icon: 'briefcase',
    description: 'Projects, their issues, labels and comments.',
  };
  static models = [Project, Issue, Label, Comment];
  static nav = [
    {
      label: 'Projects',
      model: Project,
      icon: 'folder',
      description: 'Bigger jobs broken into steps you can follow.',
    },
    {
      label: 'Issues',
      model: Issue,
      icon: 'wrench',
      description: 'Problems and to-dos to track until they are done.',
    },
    {
      label: 'Labels',
      model: Label,
      icon: 'tag',
      description: 'Tags to sort your projects and issues your way.',
    },
  ];
  static options = {
    Project: {
      fields: {
        projectId: { visibility: 'hidden' },
        projectNumber: { visibility: 'hidden' },
        providerType: { visibility: 'hidden' },
        tokenConfigKey: { visibility: 'hidden' },
        statuses: { visibility: 'hidden' },
        fields: { visibility: 'hidden' },
        statusFieldId: { visibility: 'hidden' },
        statusOptions: { visibility: 'hidden' },
        lastSyncedAt: { visibility: 'hidden' },
      },
    },
    Issue: {
      fields: {
        nodeId: { visibility: 'hidden' },
        originalBody: { visibility: 'hidden' },
        synthesisCount: { visibility: 'hidden' },
        lastSyncedAt: { visibility: 'hidden' },
        commentsCount: { visibility: 'hidden' },
        repositoryId: { visibility: 'hidden' },
        number: { visibility: 'hidden' },
      },
    },
    Comment: {
      fields: {
        commentId: { visibility: 'hidden' },
        url: { visibility: 'hidden' },
      },
    },
    Label: { fields: { repositoryId: { visibility: 'hidden' } } },
  } as const;
}
