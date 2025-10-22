// packages/sdk/src/crypto.ts

import nacl from 'tweetnacl';
import { keccak256, toUtf8Bytes, dataSlice } from 'ethers';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { 
  encodePayload, 
  decodePayload, 
  encodeStructuredContent,
  decodeStructuredContent,
  MessagePayload,
  HandshakeResponseContent,
  extractKeysFromHandshakeResponse
} from './payload.js';
import { IdentityProof } from './types.js'; 

/**
 * Encrypts a structured payload (JSON-serializable objects)
 */
export function encryptStructuredPayload<T>(
  payload: T,
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  staticSigningSecretKey?: Uint8Array,
  staticSigningPublicKey?: Uint8Array
): string {
  // encode payload as binary JSON
  const plaintext = encodeStructuredContent(payload);
  
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(plaintext, nonce, recipientPublicKey, ephemeralSecretKey);

  let sig;
  if (staticSigningSecretKey && staticSigningPublicKey) {
    const dataToSign = Buffer.concat([ephemeralPublicKey, nonce, box]);
    sig = nacl.sign.detached(dataToSign, staticSigningSecretKey);
  }

  return encodePayload(ephemeralPublicKey, nonce, box, sig);
}

/**
 * Decrypts a structured payload with converter function
 */
export function decryptStructuredPayload<T>(
  payloadJson: string,
  recipientSecretKey: Uint8Array,
  converter: (obj: any) => T,
  staticSigningPublicKey?: Uint8Array
): T | null {
  const { epk, nonce, ciphertext, sig } = decodePayload(payloadJson);

  if (sig && staticSigningPublicKey) {
    const dataToVerify = Buffer.concat([epk, nonce, ciphertext]);
    const valid = nacl.sign.detached.verify(dataToVerify, sig, staticSigningPublicKey);
    if (!valid) return null;
  }

  const box = nacl.box.open(ciphertext, nonce, epk, recipientSecretKey);
  if (!box) return null;
  
  return decodeStructuredContent(box, converter);
}

//  wrappers for encrypting and decrypting messages
export function encryptMessage(
  message: string,
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  staticSigningSecretKey?: Uint8Array,
  staticSigningPublicKey?: Uint8Array
): string {
  const payload: MessagePayload = { content: message };
  return encryptStructuredPayload(
    payload,
    recipientPublicKey,
    ephemeralSecretKey,
    ephemeralPublicKey,
    staticSigningSecretKey,
    staticSigningPublicKey
  );
}

export function decryptMessage(
  payloadJson: string,
  recipientSecretKey: Uint8Array,
  staticSigningPublicKey?: Uint8Array
): string | null {
  const result = decryptStructuredPayload(
    payloadJson,
    recipientSecretKey,
    (obj) => obj as MessagePayload,
    staticSigningPublicKey
  );
  return result ? result.content : null;
}

/**
 * Decrypts handshake response and extracts individual keys from unified format
 */
export function decryptHandshakeResponse(
  payloadJson: string,
  initiatorEphemeralSecretKey: Uint8Array
): HandshakeResponseContent | null {
  return decryptStructuredPayload(
    payloadJson,
    initiatorEphemeralSecretKey,
    (obj) => {
      if (!obj.identityProof) {
        throw new Error("Invalid handshake response: missing identityProof");
      }
      return {
        unifiedPubKeys: Uint8Array.from(Buffer.from(obj.unifiedPubKeys, 'base64')),
        ephemeralPubKey: Uint8Array.from(Buffer.from(obj.ephemeralPubKey, 'base64')),
        note: obj.note,
        identityProof: obj.identityProof
      };
    }
  );
}

/**
 * helper to decrypt handshake response and extract individual keys
 */
export function decryptAndExtractHandshakeKeys(
  payloadJson: string,
  initiatorEphemeralSecretKey: Uint8Array
): {
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
  note?: string;
  identityProof: IdentityProof; 
} | null {
  const decrypted = decryptHandshakeResponse(payloadJson, initiatorEphemeralSecretKey);
  if (!decrypted) return null;
  
  const extracted = extractKeysFromHandshakeResponse(decrypted);
  if (!extracted) return null;
  
  return {
    identityPubKey: extracted.identityPubKey,
    signingPubKey: extracted.signingPubKey,
    ephemeralPubKey: extracted.ephemeralPubKey,
    note: decrypted.note,
    identityProof: decrypted.identityProof
  };
}


/**
 * HKDF(sha256) on shared secret, info="verbeth:hsr", then Keccak-256 -> bytes32 (0x...)
 */
function finalizeHsrTag(shared: Uint8Array): `0x${string}` {
  const okm = hkdf(sha256, shared, new Uint8Array(0), toUtf8Bytes("verbeth:hsr"), 32);
  return keccak256(okm) as `0x${string}`;
}

/**
 * Responder: tag = H( KDF( ECDH(r, viewPubA), "verbeth:hsr"))
 */
export function computeTagFromResponder(
  rSecretKey: Uint8Array,
  viewPubA: Uint8Array
): `0x${string}` {
  const shared = nacl.scalarMult(rSecretKey, viewPubA);
  return finalizeHsrTag(shared);
}

/**
 * Initiator: tag = H( KDF( ECDH(viewPrivA, R), "verbeth:hsr"))
 */
export function computeTagFromInitiator(
  viewPrivA: Uint8Array,
  R: Uint8Array
): `0x${string}` {
  const shared = nacl.scalarMult(viewPrivA, R);
  return finalizeHsrTag(shared);
}


/**
 * Derives a bytes32 topic from the shared secret via HKDF(SHA256) + Keccak-256.
 * - info: domain separation (e.g., "verbeth:topic-out:v1")
 * - salt: recommended to use a tag as salt (stable and shareable)
 */
function deriveTopic(
  shared: Uint8Array,
  info: string,
  salt?: Uint8Array
): `0x${string}` {
  const okm = hkdf(sha256, shared, salt ?? new Uint8Array(0), new TextEncoder().encode(info), 32);
  return keccak256(okm) as `0x${string}`;
}


export function deriveLongTermShared(
  myIdentitySecretKey: Uint8Array,
  theirIdentityPublicKey: Uint8Array
): Uint8Array {
  return nacl.scalarMult(myIdentitySecretKey, theirIdentityPublicKey);
}

/**
 * Directional duplex topics (Initiator-Responder, Responder-Initiator).
 * Recommended salt: tag (bytes)
 */
export function deriveDuplexTopics(
  myIdentitySecretKey: Uint8Array,
  theirIdentityPublicKey: Uint8Array,
  salt?: Uint8Array
): { topicOut: `0x${string}`; topicIn: `0x${string}`; checksum: `0x${string}` } {
  const shared = deriveLongTermShared(myIdentitySecretKey, theirIdentityPublicKey);
  const topicOut = deriveTopic(shared, "verbeth:topic-out:v1", salt);
  const topicIn  = deriveTopic(shared, "verbeth:topic-in:v1",  salt);
  const chkFull = keccak256(Buffer.concat([
    toUtf8Bytes("verbeth:topic-chk:v1"),
    Buffer.from(topicOut.slice(2), 'hex'),
    Buffer.from(topicIn.slice(2),  'hex'),
  ]));
  const checksum = dataSlice(chkFull as `0x${string}`, 8) as `0x${string}`;
  return { topicOut, topicIn, checksum };
}

export function verifyDuplexTopicsChecksum(
  topicOut: `0x${string}`,
  topicIn: `0x${string}`,
  checksum: `0x${string}`
): boolean {
  const chkFull = keccak256(Buffer.concat([
    toUtf8Bytes("verbeth:topic-chk:v1"),
    Buffer.from(topicOut.slice(2), 'hex'),
    Buffer.from(topicIn.slice(2),  'hex'),
  ]));
  return dataSlice(chkFull as `0x${string}`, 8) === checksum;
}
