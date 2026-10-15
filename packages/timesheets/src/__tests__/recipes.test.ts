import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFieldRefs } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { ServiceTimeEntry } from '../models/service-time-entry.js';
import { TimeEntriesRecipe } from '../recipes.js';

describe('timesheets recipes (#3590)', () => {
  it('declares the time entries recipe over its own model', () => {
    expect(TimeEntriesRecipe.id).toBe('timesheets.time-entries');
    expect(TimeEntriesRecipe.models).toEqual([ServiceTimeEntry]);
    expect(
      TimeEntriesRecipe.nav.map((entry) => [entry.label, entry.model]),
    ).toEqual([['Time entries', ServiceTimeEntry]]);
    expect(TimeEntriesRecipe.requires).toEqual([]);
    expect(TimeEntriesRecipe.section?.id).toBe('work');
    expect(TimeEntriesRecipe.nav[0].icon).toBeTruthy();
  });

  it('hides the plumbing and fixes a human, manual entry', () => {
    const fields = TimeEntriesRecipe.options.ServiceTimeEntry.fields;
    expect(fields.participantKind).toEqual({
      default: 'human',
      visibility: 'hidden',
    });
    expect(fields.source).toEqual({ default: 'manual', visibility: 'hidden' });
    for (const name of ['workRefType', 'evidence', 'metadata'] as const) {
      expect(fields[name].visibility).toBe('hidden');
    }
    const instance = new ServiceTimeEntry();
    for (const name of Object.keys(fields)) {
      expect(name in instance, name).toBe(true);
    }
  });

  it('keeps status and its approval trail off the form', () => {
    // Submit and approve are ServiceEvidenceService actions; save() accepts a
    // bare status change, which would skip the snapshots and audit fields.
    const fields = TimeEntriesRecipe.options.ServiceTimeEntry.fields;
    for (const name of [
      'status',
      'submittedAt',
      'submittedByProfileId',
      'approvedAt',
      'approvedByProfileId',
      'approvalPath',
      'rejectedAt',
      'rejectedByProfileId',
      'rejectionReason',
      'correctionOfId',
    ] as const) {
      expect(fields[name], name).toEqual({
        visibility: 'hidden',
        locked: true,
      });
    }
  });

  describe('user-facing help (#3591)', () => {
    const markdown = () =>
      readFileSync(
        fileURLToPath(new URL(`../${TimeEntriesRecipe.help}`, import.meta.url)),
        'utf-8',
      );

    it('points at a help file beside recipes.ts', () => {
      expect(TimeEntriesRecipe.help).toMatch(/^\.\/[a-z-]+\.recipe\.md$/);
      expect(markdown()).toContain('## Overview');
      expect(markdown()).toContain('## Tasks');
    });

    it('names only fields the model declares', () => {
      const instance = new ServiceTimeEntry();
      const refs = extractFieldRefs(markdown());
      expect(refs).toEqual(
        expect.arrayContaining(['participantProfileId', 'durationSeconds']),
      );
      for (const ref of refs) expect(ref in instance, ref).toBe(true);
    });

    it('never tells anyone to set the status by hand', () => {
      const refs = extractFieldRefs(markdown());
      for (const name of ['status', 'rejectionReason', 'approvedAt']) {
        expect(refs, name).not.toContain(name);
      }
      expect(markdown()).not.toMatch(/\bset\b[^.]*\b(status|approved)\b/i);
    });
  });
});
