/**
 * Recipe data gaps in the published smrt manifests (smrt 0.55.11) that the
 * planner's recipe checks catch. Each needs a smrt release, so the checks name
 * the exact exception here instead of weakening the rule. An entry whose gap is
 * gone fails `tests/upstream-gaps.test.ts`: delete it when smrt fixes it.
 * https://github.com/happyvertical/smrt/issues/3769
 */
export const UPSTREAM_GAPS = {
  /** `chat.rooms` writes its menu label in title case. */
  titleCaseLabel: new Set(['chat.rooms']),
  /** `Asset` is in both asset recipes' menus under one id, with two labels. */
  sharedNavId: new Set(['item:assets:Asset']),
  /** `recipeId Model`: a model the recipe lists whose shown fields have no description (`@field({ description })`), so help has no glossary for them. */
  undescribedModel: new Set([
    'assets.attachments Asset',
    'assets.attachments AssetAssociation',
    'chat.rooms ChatRoom',
    'assets.library AssetMetafield',
    'assets.library AssetStatus',
    'assets.library AssetType',
    'assets.library Folder',
    'assets.library Asset',
    'users.sign-in Session',
    'users.sign-in User',
    'users.roles-and-permissions ResourceGrant',
    'users.roles-and-permissions Membership',
    'users.roles-and-permissions Permission',
    'users.roles-and-permissions Role',
    'messages.mailbox EmailAccount',
    'messages.mailbox Email',
    'chat.rooms ChatReaction',
    'chat.rooms ChatThread',
    'chat.rooms ChatParticipant',
    'chat.rooms ChatMessage',
  ]),
  /** Help that names a field the recipe's models hide (`Membership.tenantId` is a system field). */
  helpRefsHiddenField: new Set(['users.roles-and-permissions']),
  /** Help prose that uses developer vocabulary (`users.sign-in` says API and MCP). */
  developerVocabulary: new Set(['users.sign-in']),
} as const;
