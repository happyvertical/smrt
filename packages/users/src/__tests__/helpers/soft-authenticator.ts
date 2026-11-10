/**
 * A software WebAuthn authenticator for tests (#3275): real P-256 keys, real
 * 'none'-attestation registrations and real ES256 assertions, so the service
 * and `@simplewebauthn/server` verify genuine cryptography. Nothing here is
 * mocked; the knobs produce the specific malformed ceremonies the service
 * must refuse.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

/** Minimal CBOR encoder: ints, byte strings, text strings, arrays, maps. */
export function cbor(value: Cbor): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  }
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

const b64u = (value: Uint8Array | string): string =>
  Buffer.from(value).toString('base64url');
const sha256 = (value: Uint8Array | string): Buffer =>
  createHash('sha256').update(value).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface SoftCeremonyKnobs {
  /** Origin written into clientDataJSON. Default: the authenticator's. */
  origin?: string;
  /** RP id hashed into authenticatorData. Default: the authenticator's. */
  rpId?: string;
  /** Set the user-verified flag. Default true. */
  userVerified?: boolean;
  /** Set the user-present flag. Default true. */
  userPresent?: boolean;
  /** Challenge written into clientDataJSON. Default: the options' challenge. */
  challenge?: string;
}

export interface SoftAssertionKnobs extends SoftCeremonyKnobs {
  /** Counter in authenticatorData. Default: increments by one per assertion. */
  counter?: number;
  /**
   * `userHandle` in the response: a string is sent verbatim (base64url),
   * `null` omits it. Default: the user handle from registration.
   */
  userHandle?: string | null;
  /** Corrupt the signature. */
  badSignature?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId: Buffer;
  /** WebAuthn `user.id` seen at registration (base64url), the default userHandle. */
  userHandle: string | null = null;
  counter: number;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly origin: string;
  private readonly rpId: string;
  private readonly backedUp: boolean;

  constructor(config: {
    origin: string;
    rpId: string;
    /** Starting counter (the value the first assertion increments from). */
    counter?: number;
    backedUp?: boolean;
    credentialId?: Buffer;
  }) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = createPrivateKey(
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    this.publicKey = createPublicKey(
      pair.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    this.credentialId = config.credentialId ?? randomBytes(32);
    this.origin = config.origin;
    this.rpId = config.rpId;
    this.counter = config.counter ?? 0;
    this.backedUp = config.backedUp ?? false;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: 'jwk' });
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]),
    );
  }

  private flags(knobs: SoftCeremonyKnobs, extra = 0): number {
    return (
      ((knobs.userPresent ?? true) ? FLAG_UP : 0) |
      ((knobs.userVerified ?? true) ? FLAG_UV : 0) |
      (this.backedUp ? FLAG_BE | FLAG_BS : 0) |
      extra
    );
  }

  private clientData(
    type: 'webauthn.create' | 'webauthn.get',
    challenge: string,
    knobs: SoftCeremonyKnobs,
  ): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge: knobs.challenge ?? challenge,
        origin: knobs.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
  }

  /** Answer `navigator.credentials.create` with a 'none' attestation. */
  register(
    options: {
      challenge: string;
      user: { id: string };
    },
    knobs: SoftCeremonyKnobs = {},
  ) {
    this.userHandle = options.user.id;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(knobs.rpId ?? this.rpId),
      Buffer.from([this.flags(knobs, FLAG_AT)]),
      counter,
      Buffer.alloc(16), // AAGUID: all zero = "none"
      credentialIdLength,
      this.credentialId,
      this.coseKey(),
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map<Cbor, Cbor>()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(
          this.clientData('webauthn.create', options.challenge, knobs),
        ),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Answer `navigator.credentials.get` with a real ES256 assertion. */
  assert(options: { challenge: string }, knobs: SoftAssertionKnobs = {}) {
    this.counter = knobs.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(knobs.rpId ?? this.rpId),
      Buffer.from([this.flags(knobs)]),
      counter,
    ]);
    const clientDataJSON = this.clientData(
      'webauthn.get',
      options.challenge,
      knobs,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      { key: this.privateKey, dsaEncoding: 'der' },
    );
    if (knobs.badSignature) signature[signature.length - 1] ^= 0xff;
    const userHandle =
      knobs.userHandle === undefined ? this.userHandle : knobs.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle ? { userHandle } : {}),
      },
    };
  }
}
