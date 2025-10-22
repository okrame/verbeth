// packages/sdk/src/send.ts

import { 
  keccak256,
  toUtf8Bytes,
  hexlify,
  Signer,
  getBytes
} from "ethers";
import nacl from 'tweetnacl';
import { getNextNonce } from './utils/nonce.js';
import { encryptMessage, encryptStructuredPayload, deriveDuplexTopics } from './crypto.js';
import { 
  HandshakeContent, 
  serializeHandshakeContent,
  encodeUnifiedPubKeys,
  createHandshakeResponseContent,
  decodeUnifiedPubKeys,
} from './payload.js';
import { IdentityKeyPair, IdentityProof, TopicInfoWire } from './types.js';  
import { IExecutor } from './executor.js';
import { computeTagFromResponder } from './crypto.js'



/**
 * Sends an encrypted message assuming recipient's keys were already obtained via handshake.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint (for tests)
 */
export async function sendEncryptedMessage({
  executor,
  topic,
  message,
  recipientPubKey,
  senderAddress,
  senderSignKeyPair,
  timestamp
}: {
  executor: IExecutor;
  topic: string;
  message: string;
  recipientPubKey: Uint8Array;          // X25519 key for encryption
  senderAddress: string;
  senderSignKeyPair: nacl.SignKeyPair;  // Ed25519 keys for signing
  timestamp: number;
}) {
  if (!executor) {
    throw new Error("Executor must be provided");
  }

  const ephemeralKeyPair = nacl.box.keyPair();

  const ciphertext = encryptMessage(
    message,
    recipientPubKey,                      // X25519 for encryption
    ephemeralKeyPair.secretKey,
    ephemeralKeyPair.publicKey,
    senderSignKeyPair.secretKey,          // Ed25519 for signing
    senderSignKeyPair.publicKey
  );

  const nonce = getNextNonce(senderAddress, topic);

  return executor.sendMessage(toUtf8Bytes(ciphertext), topic, timestamp, nonce);
}

/**
 * Initiates an on-chain handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint (for tests)
 */
export async function initiateHandshake({
  executor,
  recipientAddress,
  identityKeyPair,
  ephemeralPubKey,
  plaintextPayload,
  identityProof,
  signer
}: {
  executor: IExecutor;
  recipientAddress: string;
  identityKeyPair: IdentityKeyPair;
  ephemeralPubKey: Uint8Array;
  plaintextPayload: string;
  identityProof: IdentityProof;
  signer: Signer;
}) {
  if (!executor) {
    throw new Error("Executor must be provided");
  }

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

  return await executor.initiateHandshake(
    recipientHash,
    hexlify(unifiedPubKeys),
    hexlify(ephemeralPubKey),
    toUtf8Bytes(serializedPayload)
  );
}

/**
 * Responds to a handshake with unified keys and mandatory identity proof.
 * Executor-agnostic: works with EOA, UserOp, and Direct EntryPoint (for tests)
 */
export async function respondToHandshake({
  executor,
  initiatorPubKey, // X25519 key from initiator (ephemeral)
  responderIdentityKeyPair,
  responderEphemeralKeyPair,
  note,
  identityProof,
  signer,
  initiatorIdentityPubKey,
}: {
  executor: IExecutor;
  initiatorPubKey: Uint8Array;
  responderIdentityKeyPair: IdentityKeyPair;
  responderEphemeralKeyPair?: nacl.BoxKeyPair;
  note?: string;
  identityProof: IdentityProof;
  signer: Signer;
  initiatorIdentityPubKey?: Uint8Array;
}) {
  if (!executor) {
    throw new Error("Executor must be provided");
  }

  const ephemeralKeyPair = responderEphemeralKeyPair || nacl.box.keyPair();

  // Generate a separate ephemeral key (R,r) just for the tag
  const tagKeyPair = nacl.box.keyPair();                
  const inResponseTo = computeTagFromResponder(
    tagKeyPair.secretKey,
    initiatorPubKey
  );
  const salt: Uint8Array = getBytes(inResponseTo); // for topics HKDF

  let topicInfo: TopicInfoWire | undefined = undefined;
  if (initiatorIdentityPubKey) {
    const { topicOut, topicIn, checksum } = deriveDuplexTopics(
      responderIdentityKeyPair.secretKey,
      initiatorIdentityPubKey,
      salt
    );
    topicInfo = { out: topicOut, in: topicIn, chk: checksum };
  }

  
  const responseContent = createHandshakeResponseContent(
    responderIdentityKeyPair.publicKey,        // X25519
    responderIdentityKeyPair.signingPublicKey, // Ed25519
    ephemeralKeyPair.publicKey,
    note,
    identityProof,
    topicInfo
  );
  
  // Encrypt the response for the initiator
  const payload = encryptStructuredPayload(
    responseContent,
    initiatorPubKey,              // Encrypt to initiator's X25519 (ephemeral) key
    ephemeralKeyPair.secretKey,
    ephemeralKeyPair.publicKey
  );

  // Execute the transaction
  const tx = await executor.respondToHandshake(
    inResponseTo, 
    hexlify(tagKeyPair.publicKey), 
    toUtf8Bytes(payload)
  );
  
  return {
    tx,
    salt,
    tag: inResponseTo
  };
}