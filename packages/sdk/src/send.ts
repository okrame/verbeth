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

export interface KemKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Initiates an on-chain handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint
 * 
 * @returns Transaction, ephemeral keypair, and KEM keypair (must be persisted for session init)
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

  const unifiedPubKeys = encodeUnifiedPubKeys(
    identityKeyPair.publicKey,        
    identityKeyPair.signingPublicKey  
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
    ephemeralKeyPair, // Caller must persist secretKey for ratchet session init
    kemKeyPair,       // Caller must also persist secretKey for KEM decapsulation
  };
}

/**
 * Responds to a handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint
 *
 * If initiator includes KEM public key, encapsulates a shared secret and includes ciphertext in response.
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
  // Responder's DH ratchet secret (must persist as dhMySecretKey in ratchet session) 
  responderEphemeralSecret: Uint8Array;
  // Responder's DH ratchet public (inside encrypted payload)
  responderEphemeralPublic: Uint8Array;
  // ML-KEM shared secret (32 bytes) (must persist for hybrid KDF, undefined if no KEM in handshake) */
  kemSharedSecret?: Uint8Array;
}> {
  if (!executor) {
    throw new Error("Executor must be provided");
  }

  // =========================================================================
  // TWO SEPARATE KEYPAIRS for unlinkability:
  //
  // 1. tagKeyPair (R, r): only for tag computation
  //    - R goes on-chain as responderEphemeralR
  //    - Used by Alice to verify the tag
  //    - not used for ratchet
  //
  // 2. ratchetKeyPair: For post-handshake encryption and first DH ratchet key
  //    - Public key goes inside encrypted payload 
  //    - Becomes dhMySecretKey/dhMyPublicKey in ratchet session
  //
  // Why this matters: With a single keypair, the on-chain R would equal the
  // first message's DH header, allowing observers to link HandshakeResponse
  // to subsequent conversation. With two keypairs, there's no on-chain link.
  // =========================================================================

  const tagKeyPair = nacl.box.keyPair();
  const ratchetKeyPair = nacl.box.keyPair();

  // Check if initiator included KEM public key (extended format: 32 + 1184 = 1216 bytes)
  const hasKem = initiatorEphemeralPubKey.length === 32 + kem.publicKeyBytes;
  const initiatorX25519Pub = hasKem
    ? initiatorEphemeralPubKey.slice(0, 32)
    : initiatorEphemeralPubKey;

  // KEM encapsulation needed for hybrid tag
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

  // Hybrid tag combines ECDH(r, viewPubA) + kemSecret
  const inResponseTo = computeHybridTagFromResponder(
    tagKeyPair.secretKey,
    initiatorX25519Pub,
    kemSharedSecret
  );
  const salt: Uint8Array = getBytes(inResponseTo);

  const responseContent = createHandshakeResponseContent(
    responderIdentityKeyPair.publicKey,        
    responderIdentityKeyPair.signingPublicKey, 
    ratchetKeyPair.publicKey, // first DH ratchet key inside payload
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

  // tagKeyPair.publicKey goes on-chain, not ratchetKeyPair
  const tx = await executor.respondToHandshake(
    inResponseTo,
    hexlify(tagKeyPair.publicKey), 
    toUtf8Bytes(payload)
  );

  return {
    tx,
    salt,
    tag: inResponseTo,
    // Return ratchet keys for session initialization
    responderEphemeralSecret: ratchetKeyPair.secretKey,
    responderEphemeralPublic: ratchetKeyPair.publicKey,
    kemSharedSecret,
  };
}