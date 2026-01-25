// packages/sdk/src/send.ts

import {
  keccak256,
  toUtf8Bytes,
  hexlify,
  Signer,
  getBytes
} from "ethers";
import nacl from 'tweetnacl';
import { encryptStructuredPayload } from './crypto.js';
import {
  HandshakeContent,
  serializeHandshakeContent,
  encodeUnifiedPubKeys,
  createHandshakeResponseContent,
} from './payload.js';
import { IdentityKeyPair, IdentityProof } from './types.js';
import { IExecutor } from './executor.js';
import { computeHybridTagFromResponder } from './crypto.js';
import { kem } from './pq/kem.js';

/** ML-KEM keypair for PQ-hybrid handshake */
export interface KemKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Initiates an on-chain handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint (for tests)
 *
 * Includes ML-KEM-768 public key for post-quantum hybrid key exchange.
 *
 * @returns Transaction, ephemeral keypair, and KEM keypair (MUST be persisted for session init)
 */
export async function initiateHandshake({
  executor,
  recipientAddress,
  identityKeyPair,
  plaintextPayload,
  identityProof,
}: {
  executor: IExecutor;
  recipientAddress: string;
  identityKeyPair: IdentityKeyPair;
  plaintextPayload: string;
  identityProof: IdentityProof;
  signer?: Signer;
}): Promise<{
  tx: any;
  ephemeralKeyPair: nacl.BoxKeyPair;
  kemKeyPair: KemKeyPair;
}> {
  if (!executor) {
    throw new Error("Executor must be provided");
  }

  // Generate ephemeral keypair for this handshake
  const ephemeralKeyPair = nacl.box.keyPair();

  // Generate ML-KEM-768 keypair for PQ-hybrid key exchange
  const kemKeyPair = kem.generateKeyPair();

  const recipientHash = keccak256(
    toUtf8Bytes('contact:' + recipientAddress.toLowerCase())
  );

  const handshakeContent: HandshakeContent = {
    plaintextPayload,
    identityProof
  };

  const serializedPayload = serializeHandshakeContent(handshakeContent);

  // Create unified pubKeys (65 bytes: version + X25519 + Ed25519)
  const unifiedPubKeys = encodeUnifiedPubKeys(
    identityKeyPair.publicKey,        // X25519 for encryption
    identityKeyPair.signingPublicKey  // Ed25519 for signing
  );

  // Ephemeral public key now includes KEM public key (32 + 1184 = 1216 bytes)
  const ephemeralWithKem = new Uint8Array(32 + kem.publicKeyBytes);
  ephemeralWithKem.set(ephemeralKeyPair.publicKey, 0);
  ephemeralWithKem.set(kemKeyPair.publicKey, 32);

  const tx = await executor.initiateHandshake(
    recipientHash,
    hexlify(unifiedPubKeys),
    hexlify(ephemeralWithKem),
    toUtf8Bytes(serializedPayload)
  );

  return {
    tx,
    ephemeralKeyPair, // Caller MUST persist secretKey for ratchet session init
    kemKeyPair,       // Caller MUST also persist secretKey for KEM decapsulation
  };
}

/**
 * Responds to a handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint (for tests)
 *
 * Supports PQ-hybrid handshake: if initiator includes KEM public key,
 * encapsulates a shared secret and includes ciphertext in response.
 *
 * @returns Transaction, tag, salt, ephemeral keys, and KEM secret
 */
export async function respondToHandshake({
  executor,
  initiatorEphemeralPubKey,
  responderIdentityKeyPair,
  note,
  identityProof,
}: {
  executor: IExecutor;
  /** Initiator's ephemeral key (32 bytes X25519) OR extended key (1216 bytes: X25519 + ML-KEM) */
  initiatorEphemeralPubKey: Uint8Array;
  responderIdentityKeyPair: IdentityKeyPair;
  note?: string;
  identityProof: IdentityProof;
  signer?: Signer;
}): Promise<{
  tx: any;
  salt: Uint8Array;
  tag: `0x${string}`;
  /** Responder's DH ratchet secret - must persist as dhMySecretKey in ratchet session */
  responderEphemeralSecret: Uint8Array;
  /** Responder's DH ratchet public - inside encrypted payload, not on-chain */
  responderEphemeralPublic: Uint8Array;
  /** ML-KEM shared secret (32 bytes) - MUST persist for hybrid KDF, undefined if no KEM in handshake */
  kemSharedSecret?: Uint8Array;
}> {
  if (!executor) {
    throw new Error("Executor must be provided");
  }

  // =========================================================================
  // TWO SEPARATE KEYPAIRS for unlinkability:
  //
  // 1. tagKeyPair (R, r): ONLY for tag computation
  //    - R goes on-chain as responderEphemeralR
  //    - Used by Alice to verify the tag
  //    - NOT used for ratchet
  //
  // 2. ratchetKeyPair: For post-handshake encryption and first DH ratchet key
  //    - Public key goes INSIDE encrypted payload (not on-chain)
  //    - Becomes dhMySecretKey/dhMyPublicKey in ratchet session
  //
  // Why this matters: With a single keypair, the on-chain R would equal the
  // first message's DH header, allowing observers to link HandshakeResponse
  // to subsequent conversation. With two keypairs, there's no on-chain link.
  // =========================================================================

  // Keypair for tag computation - R goes on-chain
  const tagKeyPair = nacl.box.keyPair();

  // Keypair for ratchet - public key is HIDDEN inside encrypted payload
  const ratchetKeyPair = nacl.box.keyPair();

  // Check if initiator included KEM public key (extended format: 32 + 1184 = 1216 bytes)
  const hasKem = initiatorEphemeralPubKey.length === 32 + kem.publicKeyBytes;

  // Extract X25519 ephemeral key (first 32 bytes)
  const initiatorX25519Pub = hasKem
    ? initiatorEphemeralPubKey.slice(0, 32)
    : initiatorEphemeralPubKey;

  // KEM encapsulation FIRST (needed for hybrid tag)
  let kemCiphertext: Uint8Array | undefined;
  let kemSharedSecret: Uint8Array | undefined;

  if (hasKem) {
    const initiatorKemPub = initiatorEphemeralPubKey.slice(32, 32 + kem.publicKeyBytes);
    const { ciphertext, sharedSecret } = kem.encapsulate(initiatorKemPub);
    kemCiphertext = ciphertext;
    kemSharedSecret = sharedSecret;
  }

  if (!kemSharedSecret) {
    throw new Error("KEM is required for PQ-secure handshake");
  }

  // Hybrid tag: combines ECDH(r, viewPubA) + kemSecret
  const inResponseTo = computeHybridTagFromResponder(
    tagKeyPair.secretKey,
    initiatorX25519Pub,
    kemSharedSecret
  );
  const salt: Uint8Array = getBytes(inResponseTo);

  // Response content includes ratchetKeyPair.publicKey (hidden inside encrypted payload)
  // and includes kemCiphertext for PQ-hybrid handshake
  const responseContent = createHandshakeResponseContent(
    responderIdentityKeyPair.publicKey,        // X25519 identity
    responderIdentityKeyPair.signingPublicKey, // Ed25519 signing
    ratchetKeyPair.publicKey,                  // First DH ratchet key (INSIDE payload)
    note,
    identityProof,
    kemCiphertext
  );

  // Encrypt using ratchetKeyPair (the epk in encrypted payload = ratchetKeyPair.publicKey)
  const payload = encryptStructuredPayload(
    responseContent,
    initiatorX25519Pub,
    ratchetKeyPair.secretKey,
    ratchetKeyPair.publicKey
  );

  // Execute transaction - tagKeyPair.publicKey goes on-chain (NOT ratchetKeyPair)
  const tx = await executor.respondToHandshake(
    inResponseTo,
    hexlify(tagKeyPair.publicKey),  // Tag key on-chain for tag verification
    toUtf8Bytes(payload)
  );

  return {
    tx,
    salt,
    tag: inResponseTo,
    // Return RATCHET keys (not tag keys) for session initialization
    // These are DIFFERENT from the on-chain responderEphemeralR
    responderEphemeralSecret: ratchetKeyPair.secretKey,
    responderEphemeralPublic: ratchetKeyPair.publicKey,
    kemSharedSecret,
  };
}