// packages/sdk/src/send.ts
// CLEANED VERSION - topicInfo removed from handshake response

/**
 * Handshake and message sending functions.
 * 
 * NOTE: sendEncryptedMessage is REMOVED - use ratchet for established sessions.
 * Only handshake functions remain here.
 * 
 * CHANGE: respondToHandshake no longer computes or includes topicInfo.
 * Topics are now derived from ephemeral DH by the caller.
 */

import { 
  keccak256,
  toUtf8Bytes,
  hexlify,
  Signer,
  getBytes
} from "ethers";
import nacl from 'tweetnacl';
import { encryptStructuredPayload } from './crypto.js';
// REMOVED: deriveDuplexTopics import
import { 
  HandshakeContent, 
  serializeHandshakeContent,
  encodeUnifiedPubKeys,
  createHandshakeResponseContent,
} from './payload.js';
import { IdentityKeyPair, IdentityProof } from './types.js';
// REMOVED: TopicInfoWire from imports
import { IExecutor } from './executor.js';
import { computeTagFromResponder } from './crypto.js';

/**
 * Initiates an on-chain handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint (for tests)
 * 
 * @returns Transaction and ephemeral keypair (MUST be persisted for session init)
 */
export async function initiateHandshake({
  executor,
  recipientAddress,
  identityKeyPair,
  plaintextPayload,
  identityProof,
  signer
}: {
  executor: IExecutor;
  recipientAddress: string;
  identityKeyPair: IdentityKeyPair;
  plaintextPayload: string;
  identityProof: IdentityProof;
  signer: Signer;
}): Promise<{
  tx: any;
  ephemeralKeyPair: nacl.BoxKeyPair;
}> {
  if (!executor) {
    throw new Error("Executor must be provided");
  }

  // Generate ephemeral keypair for this handshake
  const ephemeralKeyPair = nacl.box.keyPair();

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

  const tx = await executor.initiateHandshake(
    recipientHash,
    hexlify(unifiedPubKeys),
    hexlify(ephemeralKeyPair.publicKey),
    toUtf8Bytes(serializedPayload)
  );

  return {
    tx,
    ephemeralKeyPair, // Caller MUST persist secretKey for ratchet session init
  };
}

/**
 * Responds to a handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint (for tests)
 * 
 * CHANGE: No longer computes or returns topicInfo. Topics are derived from
 * ephemeral DH by the caller using deriveTopicFromDH().
 * 
 * @returns Transaction, tag, salt, AND ephemeral keys (MUST be persisted for ratchet session)
 */
export async function respondToHandshake({
  executor,
  initiatorEphemeralPubKey,
  responderIdentityKeyPair,
  note,
  identityProof,
  signer,
  // REMOVED: initiatorIdentityPubKey - no longer needed for topic derivation
}: {
  executor: IExecutor;
  initiatorEphemeralPubKey: Uint8Array;
  responderIdentityKeyPair: IdentityKeyPair;
  note?: string;
  identityProof: IdentityProof;
  signer: Signer;
  // REMOVED: initiatorIdentityPubKey?: Uint8Array;
}): Promise<{
  tx: any;
  salt: Uint8Array;
  tag: `0x${string}`;
  /** Responder's DH ratchet secret - MUST persist as dhMySecretKey in ratchet session */
  responderEphemeralSecret: Uint8Array;
  /** Responder's DH ratchet public - inside encrypted payload, NOT on-chain */
  responderEphemeralPublic: Uint8Array;
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
  
  // Tag is derived from tagKeyPair, not ratchetKeyPair
  const inResponseTo = computeTagFromResponder(
    tagKeyPair.secretKey,
    initiatorEphemeralPubKey
  );
  const salt: Uint8Array = getBytes(inResponseTo);

  // REMOVED: topicInfo computation - caller will derive topics from ephemeral DH
  // let topicInfo: TopicInfoWire | undefined = undefined;
  // if (initiatorIdentityPubKey) { ... }

  // Response content includes ratchetKeyPair.publicKey (hidden inside encrypted payload)
  // UPDATED: No longer includes topicInfo
  const responseContent = createHandshakeResponseContent(
    responderIdentityKeyPair.publicKey,        // X25519 identity
    responderIdentityKeyPair.signingPublicKey, // Ed25519 signing
    ratchetKeyPair.publicKey,                  // First DH ratchet key (INSIDE payload)
    note,
    identityProof
    // REMOVED: topicInfo parameter
  );
  
  // Encrypt using ratchetKeyPair (the epk in encrypted payload = ratchetKeyPair.publicKey)
  const payload = encryptStructuredPayload(
    responseContent,
    initiatorEphemeralPubKey,
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
  };
}