/**
 * Declared recipes for smrt-human-resources (#4409, #4437): user-facing units
 * of functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Employment, EmploymentTerm } from './employment/models.js';
import { HeldQualification, Qualification } from './qualifications/models.js';

/**
 * Employees: who works for you, in what role. UI-only (#4440): employment
 * records are the most sensitive data in the box, so every model stays closed
 * to the generated API, MCP and CLI and agents cannot read them.
 */
export class HumanResourcesPeopleRecipe extends SmrtRecipe {
  static id = 'human-resources.people';
  static help = './people.recipe.md';
  static label = 'Employees';
  static summary =
    'Keep a record of who works for you and in what role. Only people can see it; agents cannot read it.';
  static synonyms = [
    'hr',
    'human resources',
    'staff',
    'people',
    'team',
    'workers',
  ];
  static exposure = 'ui-only' as const;
  static section = {
    id: 'staff',
    label: 'Staff',
    icon: 'users',
    description: 'The people who work for you.',
  };
  static models = [Employment, EmploymentTerm];
  static nav = [
    {
      label: 'Employees',
      model: Employment,
      icon: 'users',
      description: 'Everyone who works for you, with their role and status.',
      noun: 'employee',
    },
  ];
  static options = {
    Employment: {
      fields: {
        profileId: { label: 'Person', order: 1 },
        employeeNumber: { order: 2 },
        position: { order: 3 },
        workerType: { order: 4 },
        status: { order: 5 },
        tenantId: { visibility: 'hidden' },
        userId: { visibility: 'advanced' },
        employerProfileId: { visibility: 'advanced' },
      },
    },
    EmploymentTerm: {
      fields: {
        employmentId: { label: 'Person', order: 1 },
        startedOn: { label: 'First day', order: 2 },
        endedOn: { label: 'Last day', order: 3 },
        endReason: { order: 4 },
        tenantId: { visibility: 'hidden' },
      },
    },
  } as const;
}

/**
 * Qualifications: the certificates your people hold. UI-only for the same
 * reason as Employees (#4440).
 */
export class HumanResourcesQualificationsRecipe extends SmrtRecipe {
  static id = 'human-resources.qualifications';
  static help = './qualifications.recipe.md';
  static label = 'Qualifications';
  static summary =
    'Track the certificates and training your people hold, and when they run out. Only people can see it; agents cannot read it.';
  static synonyms = [
    'certifications',
    'certificates',
    'licences',
    'training',
    'first aid',
  ];
  static exposure = 'ui-only' as const;
  static requires = ['human-resources.people'];
  static section = {
    id: 'staff',
    label: 'Staff',
    icon: 'users',
    description: 'The people who work for you.',
  };
  static models = [Qualification, HeldQualification];
  static nav = [
    {
      label: 'Qualifications',
      model: Qualification,
      icon: 'book',
      description:
        'The certificates, licences and training your people can hold.',
      noun: 'qualification',
    },
    {
      label: 'Held qualifications',
      model: HeldQualification,
      icon: 'fileText',
      description: 'Who holds which qualification, and when it runs out.',
      noun: 'held qualification',
    },
  ];
  static options = {
    Qualification: {
      fields: {
        name: { order: 1 },
        kind: { order: 2 },
        issuingBody: { order: 3 },
        expires: { order: 4 },
        validityMonths: { order: 5 },
        key: { visibility: 'advanced' },
        scope: { visibility: 'advanced' },
        isActive: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
      },
    },
    HeldQualification: {
      fields: {
        qualificationId: { label: 'Qualification', order: 1 },
        profileId: { label: 'Person', order: 2 },
        issuedOn: { order: 3 },
        expiresOn: { order: 4 },
        certificateNumber: { order: 5 },
        status: { order: 6 },
        tenantId: { visibility: 'hidden' },
        employmentId: { visibility: 'advanced' },
        verifiedByProfileId: { visibility: 'advanced' },
        verifiedAt: { visibility: 'advanced' },
        documentAssetId: { visibility: 'advanced' },
        renewalOfId: { visibility: 'hidden' },
      },
    },
  } as const;
}
