import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, generateKeyPairSync,
  KeyObject, randomBytes, sign,
} from 'node:crypto';
import { canonicalPayload } from '../emr-contract/signature';
import { freeze, object, refuse, string } from '../emr-contract/validation';
import type { ServerPublicKey, ServerSignedEnvelope, ServerSigningContent, WrappedServerPrivateKey } from './server-contract';

function privateP256(key: KeyObject): void {
  if (!(key instanceof KeyObject) || key.type !== 'private' || key.asymmetricKeyType !== 'ec' ||
      key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') refuse('ServerSigningKeyRequired');
}

/** In-memory generation only. The registry must bind a new kid to its verified doctor before any clinical use. */
export function generateServerKeyPair(): { privateKey: KeyObject; publicKey: ServerPublicKey['publicKey'] } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { privateKey: pair.privateKey, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
}

/**
 * Crypto primitive, not an approval port. The online transaction must check current doctor/key authority and
 * durably admit key use first; only its committed outcome may be returned as clinical approval.
 */
export function signServerPayload(content: ServerSigningContent, kid: string, privateKey: KeyObject): Readonly<ServerSignedEnvelope> {
  privateP256(privateKey);
  const keyId = string(kid);
  if (Object.prototype.hasOwnProperty.call(content, 'serverTime')) refuse('ServerSigningTimeIsObserved');
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'emr-signature+jws' }), 'utf8').toString('base64url');
  const signedAt = new Date().toISOString();
  const bytes = canonicalPayload({ ...content, serverTime: signedAt });
  const payload = bytes.toString('base64url');
  const signature = sign('sha256', Buffer.from(header + '.' + payload, 'ascii'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return freeze({ envelope: { protected: header, payload, signature },
    versionSha256: createHash('sha256').update(bytes).digest('hex'), signedAt });
}

function wrappingKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) refuse('ServerWrappingKeyRequired');
}

function wrappingContext(kid: string, wrappingKeyId: string): Buffer {
  // Detect an accidentally paired encrypted row or credential reference during restore.
  return Buffer.from(JSON.stringify({ kid: string(kid), wrappingKeyId: string(wrappingKeyId) }), 'utf8');
}

/** Wrapping credentials come from deployment custody, never the registry row or its routine database export. */
export function wrapServerPrivateKey(privateKey: KeyObject, kid: string, wrappingKeyId: string,
  secret: Buffer): Readonly<WrappedServerPrivateKey> {
  privateP256(privateKey);
  wrappingKey(secret);
  const aad = wrappingContext(kid, wrappingKeyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const plain = privateKey.export({ type: 'pkcs8', format: 'der' });
  try {
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return freeze({ algorithm: 'aes-256-gcm', kid, wrappingKeyId, iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
  } finally {
    plain.fill(0);
  }
}

function encodedBytes(input: unknown): Buffer {
  const text = string(input);
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) refuse('ServerWrappedKeyInvalid');
  return bytes;
}

/** Decryption alone grants no signing authority; restored membership/status must be checked by the online adapter. */
export function unwrapServerPrivateKey(input: unknown, kid: string, wrappingKeyId: string, secret: Buffer): KeyObject {
  wrappingKey(secret);
  const row = object(input, ['algorithm', 'wrappingKeyId', 'kid', 'iv', 'ciphertext', 'tag']);
  if (row.algorithm !== 'aes-256-gcm' || row.kid !== kid || row.wrappingKeyId !== wrappingKeyId) refuse('ServerWrappedKeyMismatch');
  const aad = wrappingContext(kid, wrappingKeyId);
  const iv = encodedBytes(row.iv), tag = encodedBytes(row.tag), ciphertext = encodedBytes(row.ciphertext);
  if (iv.length !== 12 || tag.length !== 16) refuse('ServerWrappedKeyInvalid');
  const decipher = createDecipheriv('aes-256-gcm', secret, iv, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  let plain: Buffer | undefined;
  let pending: Buffer | undefined;
  try {
    pending = decipher.update(ciphertext);
    plain = Buffer.concat([pending, decipher.final()]);
    const key = createPrivateKey({ key: plain, format: 'der', type: 'pkcs8' });
    privateP256(key);
    return key;
  } finally {
    pending?.fill(0);
    plain?.fill(0);
  }
}
