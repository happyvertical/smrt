import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  AttachmentCollection,
  EmailCollection,
} from '@happyvertical/smrt-messages';
import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Content } from './content';
import {
  configureContentContributions,
  evaluateContributionIntake,
  getEffectiveContentContributionConfig,
  resetContentContributionConfig,
} from './content-contribution-config';
import { ContentContributionTypeCollection } from './content-contribution-types';
import { ContentContributions } from './content-contributions';
import { ContentContributorCollection } from './content-contributors';
import {
  configureContentGovernance,
  resetContentGovernanceConfig,
} from './content-governance';
import { Contents } from './contents';

const PROFILE_TYPES_SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_types (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT NOT NULL,
  _meta_data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  name TEXT NOT NULL,
  description TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_types_slug_context_idx ON profile_types (slug, context);
`;

const PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT NOT NULL,
  _meta_data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  type_id TEXT,
  email TEXT,
  name TEXT DEFAULT '',
  description TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_slug_context_idx ON profiles (slug, context);
CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles (email);
`;

const CONTENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT NOT NULL,
  _meta_data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  type TEXT,
  variant TEXT,
  file_key TEXT,
  author TEXT,
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  body TEXT,
  publish_date DATETIME,
  url TEXT,
  source TEXT,
  original_url TEXT,
  language TEXT,
  tags TEXT,
  category TEXT,
  status TEXT,
  state TEXT,
  metadata TEXT,
  thumbnail_asset_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS contents_slug_context_idx ON contents (slug, context);
`;

const CONTENT_REFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_references (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  source_id TEXT,
  target_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS content_references_source_id_target_id_idx ON content_references (source_id, target_id);
`;

const CONTENT_ASSETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_assets (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  content_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  relationship TEXT DEFAULT 'attachment',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS content_assets_unique_idx ON content_assets (content_id, asset_id, relationship);
`;

const ASSET_TYPES_SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_types (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  name TEXT NOT NULL,
  description TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_types_slug_context_idx ON asset_types (slug, context);
`;

const ASSET_STATUSES_SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_statuses (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  name TEXT NOT NULL,
  description TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_statuses_slug_context_idx ON asset_statuses (slug, context);
`;

const ASSETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT NOT NULL,
  _meta_data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  name TEXT DEFAULT '',
  source_uri TEXT DEFAULT '',
  mime_type TEXT DEFAULT '',
  description TEXT DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  primary_version_id TEXT,
  type_slug TEXT DEFAULT '',
  status_slug TEXT DEFAULT '',
  owner_profile_id TEXT,
  parent_id TEXT,
  folder_id TEXT,
  source_type TEXT DEFAULT '',
  external_id TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_slug_context_idx ON assets (slug, context);
`;

const CONTENT_CONTRIBUTION_TYPES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_contribution_types (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  key TEXT NOT NULL,
  label TEXT,
  enabled BOOLEAN,
  allowed_channels TEXT,
  allow_text BOOLEAN,
  allow_files BOOLEAN,
  allow_empty_text BOOLEAN,
  intake_rules TEXT,
  promotion_mapping TEXT,
  metadata TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS content_contribution_types_key_idx ON content_contribution_types (key);
`;

const CONTENT_CONTRIBUTORS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_contributors (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  profile_id TEXT,
  email TEXT NOT NULL,
  name TEXT,
  trust_level TEXT,
  metadata TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS content_contributors_email_idx ON content_contributors (email);
`;

const CONTENT_CONTRIBUTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_contributions (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  contributor_id TEXT NOT NULL,
  contribution_type_key TEXT NOT NULL,
  status TEXT,
  intake_decision TEXT,
  channel TEXT,
  title TEXT,
  description TEXT,
  body TEXT,
  contributor_email TEXT,
  contributor_name TEXT,
  thread_key TEXT,
  source_message_id TEXT,
  editor_notes TEXT,
  promoted_content_id TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  approved_at DATETIME,
  promoted_at DATETIME,
  rejected_at DATETIME,
  withdrawn_at DATETIME,
  requested_changes_at DATETIME,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS content_contributions_contributor_idx ON content_contributions (contributor_id);
`;

const CONTENT_CONTRIBUTION_REVISIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_contribution_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  contribution_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL DEFAULT 1,
  channel TEXT,
  title TEXT,
  description TEXT,
  body TEXT,
  source_message_id TEXT,
  source_thread_key TEXT,
  metadata TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS content_contribution_revisions_unique_idx ON content_contribution_revisions (contribution_id, revision_number);
`;

const CONTENT_CONTRIBUTION_ATTACHMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_contribution_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  contribution_id TEXT NOT NULL,
  revision_id TEXT,
  filename TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  file_key TEXT,
  source_uri TEXT,
  channel TEXT,
  promoted_asset_id TEXT,
  metadata TEXT
);
`;

const MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  _meta_type TEXT NOT NULL,
  _meta_data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  account_id TEXT,
  thread_id TEXT,
  subject TEXT,
  body TEXT,
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,
  date DATETIME,
  is_read BOOLEAN DEFAULT FALSE,
  is_flagged BOOLEAN DEFAULT FALSE,
  has_attachments BOOLEAN DEFAULT FALSE,
  size INTEGER DEFAULT 0,
  metadata TEXT,
  send_status TEXT DEFAULT 'draft',
  sent_at DATETIME,
  send_error TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  scheduled_send_at DATETIME,
  in_reply_to_message_id TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  cc_addresses TEXT,
  bcc_addresses TEXT,
  reply_to_address TEXT,
  reply_to_name TEXT,
  text_body TEXT,
  html_body TEXT,
  folder_id TEXT,
  folder_path TEXT,
  labels TEXT,
  flags TEXT,
  is_answered BOOLEAN DEFAULT FALSE,
  is_draft BOOLEAN DEFAULT FALSE,
  raw_message TEXT,
  headers TEXT
);
`;

const ATTACHMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  message_id TEXT,
  filename TEXT,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  content_disposition TEXT DEFAULT 'attachment',
  file_path TEXT,
  source_url TEXT
);
`;

describe('content contributions', () => {
  let db: DatabaseInterface;
  let contributions: ContentContributions;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await syncSchema({
      db,
      schema: [
        PROFILE_TYPES_SCHEMA,
        PROFILES_SCHEMA,
        CONTENTS_SCHEMA,
        CONTENT_REFERENCES_SCHEMA,
        CONTENT_ASSETS_SCHEMA,
        ASSET_TYPES_SCHEMA,
        ASSET_STATUSES_SCHEMA,
        ASSETS_SCHEMA,
        CONTENT_CONTRIBUTION_TYPES_SCHEMA,
        CONTENT_CONTRIBUTORS_SCHEMA,
        CONTENT_CONTRIBUTIONS_SCHEMA,
        CONTENT_CONTRIBUTION_REVISIONS_SCHEMA,
        CONTENT_CONTRIBUTION_ATTACHMENTS_SCHEMA,
        MESSAGES_SCHEMA,
        ATTACHMENTS_SCHEMA,
      ].join('\n'),
    });

    contributions = await ContentContributions.create({
      db,
      tenantId: 'tenant-1',
    });
    contents = await Contents.create({
      db,
      tenantId: 'tenant-1',
    });

    configureContentContributions({
      types: [
        {
          key: 'letter',
          label: 'Letter to the editor',
          allowedChannels: ['web', 'email'],
          allowText: true,
          allowFiles: true,
          allowEmptyText: true,
          intakeRules: {
            maxFiles: 3,
            allowedMimePatterns: ['image/*', 'application/pdf'],
            blockedTextPatterns: ['blocked phrase'],
            quarantineTextPatterns: ['lawsuit'],
          },
          promotion: {
            targetContentType: 'article',
            targetContentVariant: 'letter',
            targetContentStatus: 'draft',
            createAssets: true,
            assetRelationship: 'attachment',
          },
        },
        {
          key: 'tip',
          label: 'News tip',
          allowedChannels: ['web'],
          allowText: true,
          allowFiles: true,
          allowEmptyText: true,
          promotion: {
            targetContentType: 'article',
            targetContentVariant: 'tip',
            targetContentStatus: 'review',
            createAssets: true,
            assetRelationship: 'attachment',
            autoPromoteTrusted: true,
          },
        },
      ],
    });

    configureContentGovernance({
      assignments: [
        {
          contentType: 'article',
          contentVariant: 'letter',
          enabled: true,
          factLinkingEnabled: false,
          transparencyEnabled: false,
          publicationProfileKey: 'publication',
          correctionProfileKey: 'correction',
        },
      ],
    });
  });

  afterEach(async () => {
    resetContentContributionConfig();
    resetContentGovernanceConfig();

    if (db && typeof (db as any).close === 'function') {
      await (db as any).close();
    }
  });

  it('evaluates reject and quarantine intake rules from contribution types', () => {
    const accept = evaluateContributionIntake({
      contributionType: {
        key: 'letter',
        label: 'Letter',
        allowedChannels: ['web'],
        allowText: true,
        allowFiles: true,
        allowEmptyText: true,
        intakeRules: {
          blockedTextPatterns: ['blocked phrase'],
          quarantineTextPatterns: ['lawsuit'],
          allowedMimePatterns: ['image/*'],
        },
        promotion: { targetContentType: 'article' },
      },
      channel: 'web',
      body: 'This mentions a lawsuit.',
      attachments: [],
    });

    const reject = evaluateContributionIntake({
      contributionType: {
        key: 'letter',
        label: 'Letter',
        allowedChannels: ['web'],
        allowText: true,
        allowFiles: true,
        allowEmptyText: true,
        intakeRules: {
          blockedTextPatterns: ['blocked phrase'],
          allowedMimePatterns: ['image/*'],
        },
        promotion: { targetContentType: 'article' },
      },
      channel: 'web',
      body: 'This contains a blocked phrase.',
      attachments: [],
    });

    expect(accept.decision).toBe('quarantined');
    expect(reject.decision).toBe('rejected');
  });

  it('creates a held web contribution with revision 1 and held attachments', async () => {
    const result = await contributions.submitWebContribution({
      typeKey: 'letter',
      contributorEmail: 'reader@example.com',
      contributorName: 'Reader',
      title: 'A reader letter',
      body: 'Please consider publishing this letter.',
      attachments: [
        {
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          fileKey: 'uploads/photo.jpg',
        },
      ],
      tenantId: 'tenant-1',
    });

    expect(result.contribution.status).toBe('submitted');

    const contribution = await contributions.get({
      id: result.contribution.id,
    });
    expect(contribution?.revisionCount).toBe(1);

    const revisions = await contribution?.getRevisions();
    const attachments = await contribution?.getAttachments();

    expect(revisions).toHaveLength(1);
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0].promotedAssetId).toBeNull();
  });

  it('applies persisted type overrides on top of configured defaults', async () => {
    const types = await ContentContributionTypeCollection.create({ db });
    const record = await types.create({
      key: 'letter',
      label: 'Letters & opinions',
      allowedChannels: ['web', 'email'],
      allowText: true,
      allowFiles: true,
      allowEmptyText: true,
      promotion: {
        targetContentType: 'article',
      },
    });
    await record.save();

    const effective = await getEffectiveContentContributionConfig({ db });
    const type = effective.types.find((item) => item.key === 'letter');

    expect(type?.label).toBe('Letters & opinions');
  });

  it('deletes an unused custom contribution type cleanly', async () => {
    const types = await ContentContributionTypeCollection.create({ db });
    const record = await types.create({
      key: 'qa-delete',
      label: 'QA delete',
      allowedChannels: ['web'],
      allowText: true,
      allowFiles: false,
      allowEmptyText: true,
      promotion: {
        targetContentType: 'article',
      },
    });
    await record.save();

    await expect(record.delete()).resolves.toBeUndefined();
    await expect(types.get({ id: record.id })).resolves.toBeNull();
  });

  it('blocks deleting a custom contribution type that is already referenced', async () => {
    const types = await ContentContributionTypeCollection.create({ db });
    const record = await types.create({
      key: 'qa-delete-blocked',
      label: 'QA delete blocked',
      allowedChannels: ['web'],
      allowText: true,
      allowFiles: false,
      allowEmptyText: true,
      promotion: {
        targetContentType: 'article',
      },
    });
    await record.save();

    const contribution = await contributions.create({
      contributorId: 'contributor-1',
      contributionTypeKey: record.key,
      status: 'submitted',
      intakeDecision: 'accepted',
      channel: 'web',
    });
    await contribution.save();

    await expect(record.delete()).rejects.toThrow(
      'contributions already reference it',
    );
  });

  it('auto-promotes trusted contributors when the type allows it', async () => {
    const contributors = await ContentContributorCollection.create({ db });
    const trusted = await contributors.findOrCreateByEmail({
      email: 'trusted@example.com',
      name: 'Trusted Source',
      tenantId: 'tenant-1',
    });
    trusted.trustLevel = 'trusted';
    await trusted.save();

    const result = await contributions.submitWebContribution({
      typeKey: 'tip',
      contributorEmail: 'trusted@example.com',
      contributorName: 'Trusted Source',
      title: 'Fast-moving tip',
      body: 'There is an incident downtown.',
      attachments: [
        {
          filename: 'tip.jpg',
          mimeType: 'image/jpeg',
          size: 2048,
          sourceUri: '/tmp/tip.jpg',
        },
      ],
      tenantId: 'tenant-1',
    });

    expect(result.contribution.status).toBe('promoted');
    expect(result.content.status).toBe('review');

    const promoted = await contents.get({ id: result.content.id });
    expect(promoted).toBeInstanceOf(Content);
    expect(promoted?.metadata?.contribution?.contributionId).toBe(
      result.contribution.id,
    );
  });

  it('approves a held contribution into draft content and draft assets via content_assets', async () => {
    const submitted = await contributions.submitWebContribution({
      typeKey: 'letter',
      contributorEmail: 'editorial@example.com',
      contributorName: 'Editorial Source',
      title: 'Slow letter',
      body: 'A thoughtful contribution.',
      attachments: [
        {
          filename: 'scan.pdf',
          mimeType: 'application/pdf',
          size: 4096,
          sourceUri: '/tmp/scan.pdf',
        },
      ],
      tenantId: 'tenant-1',
    });

    const contribution = await contributions.get({
      id: submitted.contribution.id,
    });

    const promoted = await contribution?.approveAction({
      editorNote: 'Looks good.',
    });

    expect(promoted?.contribution.status).toBe('promoted');
    expect(promoted?.content.status).toBe('draft');
    expect(promoted?.assets).toHaveLength(1);

    const savedContent = await contents.get({ id: promoted?.content.id });
    expect(savedContent?.metadata?.contribution?.contributionId).toBe(
      contribution?.id,
    );
    expect(await savedContent?.getAssets('attachment')).toHaveLength(1);
    expect(await savedContent?.isGoverned()).toBe(true);
  });

  it('normalizes inbound email into a contribution and appends replies as revisions', async () => {
    const emails = await EmailCollection.create({ db, tenantId: 'tenant-1' });
    const attachments = await AttachmentCollection.create({
      db,
      tenantId: 'tenant-1',
    });

    const firstEmail = await emails.create({
      tenantId: 'tenant-1',
      fromAddress: 'mail@example.com',
      fromName: 'Mail Source',
      subject: 'Letter by email',
      textBody: 'Initial email body.',
      threadId: 'thread-1',
      messageId: '<msg-1@example.com>',
      hasAttachments: true,
    });
    await firstEmail.save();

    const firstAttachment = await attachments.create({
      tenantId: 'tenant-1',
      messageId: firstEmail.id || '',
      filename: 'evidence.jpg',
      contentType: 'image/jpeg',
      size: 1234,
      filePath: '/tmp/evidence.jpg',
    });
    await firstAttachment.save();

    const created = await contributions.ingestEmailContribution({
      emailId: firstEmail.id || '',
      typeKey: 'letter',
      tenantId: 'tenant-1',
    });

    expect(created.contribution.status).toBe('submitted');

    const secondEmail = await emails.create({
      tenantId: 'tenant-1',
      fromAddress: 'mail@example.com',
      fromName: 'Mail Source',
      subject: 'Re: Letter by email',
      textBody: 'Follow-up details.',
      threadId: 'thread-1',
      messageId: '<msg-2@example.com>',
      inReplyTo: '<msg-1@example.com>',
    });
    await secondEmail.save();

    const reply = await contributions.ingestEmailContribution({
      emailId: secondEmail.id || '',
      typeKey: 'letter',
      tenantId: 'tenant-1',
    });

    expect(reply.contribution.revisionCount).toBe(2);

    const updated = await contributions.get({ id: created.contribution.id });
    const revisions = await updated?.getRevisions();

    expect(revisions).toHaveLength(2);
    expect(revisions?.[1].body).toContain('Follow-up details.');
  });

  it('reapplies intake rules to email-thread follow-up revisions', async () => {
    const emails = await EmailCollection.create({ db, tenantId: 'tenant-1' });

    const firstEmail = await emails.create({
      tenantId: 'tenant-1',
      fromAddress: 'mail@example.com',
      fromName: 'Mail Source',
      subject: 'Letter by email',
      textBody: 'Initial email body.',
      threadId: 'thread-2',
      messageId: '<msg-10@example.com>',
    });
    await firstEmail.save();

    const created = await contributions.ingestEmailContribution({
      emailId: firstEmail.id || '',
      typeKey: 'letter',
      tenantId: 'tenant-1',
    });

    const blockedReply = await emails.create({
      tenantId: 'tenant-1',
      fromAddress: 'mail@example.com',
      fromName: 'Mail Source',
      subject: 'Re: Letter by email',
      textBody: 'This reply includes a blocked phrase.',
      threadId: 'thread-2',
      messageId: '<msg-11@example.com>',
      inReplyTo: '<msg-10@example.com>',
    });
    await blockedReply.save();

    const rejected = await contributions.ingestEmailContribution({
      emailId: blockedReply.id || '',
      typeKey: 'letter',
      tenantId: 'tenant-1',
    });

    expect(rejected.intake.decision).toBe('rejected');
    expect(rejected.revision).toBeNull();

    const updated = await contributions.get({ id: created.contribution.id });
    expect(updated?.status).toBe('rejected');
    expect(updated?.revisionCount).toBe(1);

    const revisions = await updated?.getRevisions();
    expect(revisions).toHaveLength(1);
  });
});
