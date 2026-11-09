/**
 * Windows custody rule W6: SDDL parsing and the access-control decision.
 *
 * Node cannot read an owner or a DACL on Windows, so the security descriptor
 * of every custodied path is fetched by `windows-acl-inspector.ts` as an SDDL
 * string. Parsing it and deciding what it means are pure functions, so every
 * policy case is tested on any platform.
 *
 * Fail-closed throughout: an ACE type, flag, right, or trustee this parser
 * does not understand rejects the descriptor rather than being skipped.
 */

import { unsafeFilesystemEntry } from './local-runtime-error.js';

/** The `SYSTEM` account. */
export const SID_SYSTEM = 'S-1-5-18';
/** `BUILTIN\Administrators`. */
export const SID_ADMINISTRATORS = 'S-1-5-32-544';
/** `OWNER RIGHTS`: grants only to the object's owner (who must be trusted). */
export const SID_OWNER_RIGHTS = 'S-1-3-4';
/** `CREATOR OWNER`: a template trustee that only exists in inherit-only ACEs. */
export const SID_CREATOR_OWNER = 'S-1-3-0';
/** `NT SERVICE\TrustedInstaller`, the owner of the system directories. */
export const SID_TRUSTED_INSTALLER =
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

const SID_PATTERN = /^S-1-\d+(?:-\d+){1,15}$/;
const SID_ALIASES: Readonly<Record<string, string>> = {
  SY: SID_SYSTEM,
  BA: SID_ADMINISTRATORS,
  OW: SID_OWNER_RIGHTS,
  CO: SID_CREATOR_OWNER,
};

/** SDDL ACE rights aliases as the numeric access mask they stand for. */
const RIGHTS: Readonly<Record<string, number>> = {
  GA: 0x10000000,
  GR: 0x80000000,
  GW: 0x40000000,
  GX: 0x20000000,
  RC: 0x00020000,
  SD: 0x00010000,
  WD: 0x00040000,
  WO: 0x00080000,
  // The directory-service aliases are the same bits as the file-object rights
  // a DACL on a file or directory actually carries (CC=0x1 ... CR=0x100).
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  RP: 0x10,
  WP: 0x20,
  DT: 0x40,
  LO: 0x80,
  CR: 0x100,
  FA: 0x001f01ff,
  FR: 0x00120089,
  FW: 0x00120116,
  FX: 0x001200a0,
};

const ACE_FLAGS = new Set([
  'CI',
  'OI',
  'NP',
  'IO',
  'ID',
  'SA',
  'FA',
  'TP',
  'CR',
]);

/** One ACE of a DACL, with its trustee reduced to a canonical SID string. */
export interface WindowsAce {
  /** SDDL ACE type: `A` allow, `D` deny, anything else is policy-rejected. */
  readonly type: string;
  readonly flags: ReadonlySet<string>;
  readonly mask: number;
  /** Canonical `S-1-...`, or `ALIAS:XX` for a domain-relative alias. */
  readonly trustee: string;
}

export interface WindowsSecurityDescriptor {
  readonly owner: string | null;
  /** `null` when the descriptor has no DACL section at all. */
  readonly dacl: {
    /** `D:NO_ACCESS_CONTROL`: a NULL DACL, which grants everyone full access. */
    readonly isNull: boolean;
    readonly aces: readonly WindowsAce[];
  } | null;
}

function malformed(reason: string): never {
  throw unsafeFilesystemEntry(
    `Windows security descriptor could not be parsed safely: ${reason}`,
  );
}

function parseTrustee(token: string): string {
  if (SID_PATTERN.test(token)) return token;
  if (/^[A-Z]{2}$/.test(token)) return SID_ALIASES[token] ?? `ALIAS:${token}`;
  return malformed('unrecognised trustee');
}

function parseRights(token: string): number {
  if (token === '') return 0;
  if (/^0[xX][0-9A-Fa-f]{1,8}$/.test(token)) return Number.parseInt(token, 16);
  if (/^\d{1,10}$/.test(token)) {
    const value = Number(token);
    return value <= 0xffffffff ? value : malformed('access mask out of range');
  }
  if (token.length % 2 !== 0 || !/^[A-Z]+$/.test(token)) {
    return malformed('unrecognised access rights');
  }
  let mask = 0;
  for (let index = 0; index < token.length; index += 2) {
    const right = RIGHTS[token.slice(index, index + 2)];
    if (right === undefined) return malformed('unrecognised access right');
    mask = (mask | right) >>> 0;
  }
  return mask;
}

function parseAce(text: string): WindowsAce {
  const fields = text.split(';');
  const type = fields[0];
  if (fields.length < 6 || !/^[A-Z]{1,2}$/.test(type)) {
    return malformed('malformed access control entry');
  }
  if (type !== 'A' && type !== 'D') {
    // Object, conditional, callback, audit and resource ACE types are not part
    // of any accepted custody shape; the policy rejects them by type, and the
    // fields we cannot interpret are not interpreted.
    return {
      type,
      flags: new Set<string>(),
      mask: 0,
      trustee: `ALIAS:${type}`,
    };
  }
  if (fields.length !== 6 || fields[3] !== '' || fields[4] !== '') {
    return malformed('unexpected access control entry fields');
  }
  const flagText = fields[1];
  if (flagText.length % 2 !== 0) return malformed('malformed ACE flags');
  const flags = new Set<string>();
  for (let index = 0; index < flagText.length; index += 2) {
    const flag = flagText.slice(index, index + 2);
    if (!ACE_FLAGS.has(flag)) return malformed('unrecognised ACE flag');
    flags.add(flag);
  }
  return {
    type,
    flags,
    mask: parseRights(fields[2]),
    trustee: parseTrustee(fields[5]),
  };
}

/** Read the parenthesised groups starting at `start`; returns the ACE texts. */
function readAces(
  sddl: string,
  start: number,
): { aces: string[]; next: number } {
  const aces: string[] = [];
  let index = start;
  while (sddl[index] === '(') {
    let depth = 0;
    let end = index;
    for (; end < sddl.length; end += 1) {
      if (sddl[end] === '(') depth += 1;
      else if (sddl[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return malformed('unbalanced access control entry');
    aces.push(sddl.slice(index + 1, end));
    index = end + 1;
  }
  return { aces, next: index };
}

/**
 * Strict SDDL parser for the `O:`, `G:`, `D:` (and ignorable `S:`) sections.
 * Whitespace and non-printable characters are rejected outright.
 */
export function parseSddl(sddl: string): WindowsSecurityDescriptor {
  if (typeof sddl !== 'string' || sddl.length === 0 || sddl.length > 16_384) {
    return malformed('missing or oversized descriptor');
  }
  if (!/^[\x21-\x7e]+$/.test(sddl)) {
    return malformed('unexpected characters');
  }
  let owner: string | null = null;
  let dacl: WindowsSecurityDescriptor['dacl'] = null;
  const seen = new Set<string>();
  let index = 0;
  while (index < sddl.length) {
    const section = sddl[index];
    if (sddl[index + 1] !== ':' || !'OGDS'.includes(section)) {
      return malformed('unrecognised section');
    }
    if (seen.has(section)) return malformed('repeated section');
    seen.add(section);
    index += 2;
    if (section === 'O' || section === 'G') {
      const token = /^(?:S-1-\d+(?:-\d+){1,15}|[A-Z]{2})/.exec(
        sddl.slice(index),
      );
      if (!token) return malformed('unrecognised principal');
      index += token[0].length;
      if (section === 'O') owner = parseTrustee(token[0]);
    } else if (section === 'D') {
      if (sddl.startsWith('NO_ACCESS_CONTROL', index)) {
        index += 'NO_ACCESS_CONTROL'.length;
        dacl = { isNull: true, aces: [] };
        continue;
      }
      const flags = /^(?:P|AR|AI)*/.exec(sddl.slice(index)) as RegExpExecArray;
      index += flags[0].length;
      const { aces, next } = readAces(sddl, index);
      index = next;
      dacl = { isNull: false, aces: aces.map(parseAce) };
    } else {
      // The SACL (audit and mandatory-label entries) takes no part in the
      // access decision; it is only required to be structurally sound.
      const flags = /^(?:P|AR|AI)*/.exec(sddl.slice(index)) as RegExpExecArray;
      index += flags[0].length;
      index = readAces(sddl, index).next;
    }
  }
  return { owner, dacl };
}

/**
 * A machine-account SID whose RID is 500: the built-in `Administrator`. SDDL
 * writes that one account as the alias `LA` (never as its SID) whenever the
 * descriptor is rendered on its own machine, so the current user's SID and
 * the trustee `ALIAS:LA` can name the same principal.
 */
const MACHINE_ADMINISTRATOR_SID = /^S-1-5-21-\d+-\d+-\d+-500$/;

/** The SDDL alias for the machine's built-in Administrator (RID 500). */
export const SDDL_ALIAS_LOCAL_ADMINISTRATOR = 'ALIAS:LA';

/**
 * The principals whose access is part of custody on Windows.
 *
 * When the current user's SID is a RID-500 machine-account SID (a runner's
 * `runneradmin`, or a renamed built-in Administrator), `LA` in a descriptor is
 * that very user, so `ALIAS:LA` is trusted too. For any other user `LA` stays
 * untrusted: the built-in Administrator is then a different principal.
 */
export function trustedPrincipals(userSid: string): ReadonlySet<string> {
  if (!SID_PATTERN.test(userSid)) {
    return malformed('current-user identity is not a SID');
  }
  const trusted = new Set([userSid, SID_SYSTEM, SID_ADMINISTRATORS]);
  if (MACHINE_ADMINISTRATOR_SID.test(userSid)) {
    trusted.add(SDDL_ALIAS_LOCAL_ADMINISTRATOR);
  }
  return trusted;
}

/**
 * Rights that let a principal remove or replace an existing child of a
 * directory, or rewrite the directory's own security: `DELETE`, `WRITE_DAC`,
 * `WRITE_OWNER`, `FILE_DELETE_CHILD`, `GENERIC_ALL`, `GENERIC_WRITE`. Creating
 * new siblings (`FILE_ADD_FILE`/`FILE_ADD_SUBDIRECTORY`) is deliberately not
 * in the set: it is the Windows analogue of a sticky `/tmp`.
 */
const ANCESTOR_REPLACEMENT_RIGHTS =
  (0x00010000 | 0x00040000 | 0x00080000 | 0x40 | 0x10000000 | 0x40000000) >>> 0;

export type WindowsCustodyRole =
  /** At or beneath the custody root: nobody but trusted principals. */
  | 'custodied'
  /** Above the custody root: others may not replace what is beneath. */
  | 'ancestor';

/**
 * The W6 decision. Throws a {@link LocalRuntimeError} naming `label` and the
 * first violation.
 */
export function assertWindowsSecurityPolicy(
  descriptor: WindowsSecurityDescriptor,
  role: WindowsCustodyRole,
  userSid: string,
  label: string,
): void {
  const reject = (reason: string): never => {
    throw unsafeFilesystemEntry(
      `Local runtime path lacks Windows custody (${role}): ${label}: ${reason}`,
    );
  };
  const trusted = trustedPrincipals(userSid);
  const trustedOwners =
    role === 'ancestor'
      ? new Set([...trusted, SID_TRUSTED_INSTALLER])
      : trusted;
  if (descriptor.owner === null || !trustedOwners.has(descriptor.owner)) {
    reject(
      `owner is not a trusted principal (${descriptor.owner ?? 'absent'})`,
    );
  }
  const dacl = descriptor.dacl;
  if (dacl === null) reject('no DACL section');
  if ((dacl as NonNullable<typeof dacl>).isNull) {
    reject('NULL DACL grants everyone full access');
  }
  for (const ace of (dacl as NonNullable<typeof dacl>).aces) {
    if (ace.type === 'D') continue;
    if (ace.type !== 'A') reject(`unsupported ACE type (${ace.type})`);
    const inheritOnly = ace.flags.has('IO');
    if (role === 'custodied') {
      const allowed =
        trusted.has(ace.trustee) ||
        ace.trustee === SID_OWNER_RIGHTS ||
        (inheritOnly && ace.trustee === SID_CREATOR_OWNER);
      if (!allowed) {
        reject(
          `${inheritOnly ? 'inheritable ' : ''}access is granted to ${ace.trustee}`,
        );
      }
      continue;
    }
    // Ancestor: inherit-only ACEs apply to children, which are inspected
    // themselves; effective ACEs must not let a stranger replace our child.
    if (inheritOnly) continue;
    const trustedTrustee =
      trusted.has(ace.trustee) ||
      ace.trustee === SID_TRUSTED_INSTALLER ||
      ace.trustee === SID_OWNER_RIGHTS ||
      ace.trustee === SID_CREATOR_OWNER;
    if (
      !trustedTrustee &&
      (ace.mask & ANCESTOR_REPLACEMENT_RIGHTS) >>> 0 !== 0
    ) {
      reject(`${ace.trustee} may delete or re-secure what is beneath it`);
    }
  }
}
