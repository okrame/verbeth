// packages/sdk/src/client/VerbethClient.ts

/**
 * High-level client for Verbeth E2EE messaging.
 * 
 * Provides a unified API for:
 * - Handshake operations (sendHandshake, acceptHandshake)
 * - Session creation for both initiator and responder
 * - Message encryption/decryption with session management
 * - Two-phase commit for message sending
 * - Transaction confirmation handling
 */

import { hexlify, getBytes, keccak256 } from 'ethers';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { initiateHandshake, respondToHandshake } from '../send.js';
import { kem } from '../pq/kem.js';
import type { IExecutor } from '../executor.js';
import type { IdentityKeyPair, IdentityProof } from '../types.js';
import type { Signer } from 'ethers';

import * as crypto from '../crypto.js';
import * as payload from '../payload.js';
import * as verify from '../verify.js';
import * as utils from '../utils.js';
import * as identity from '../identity.js';
import * as ratchet from '../ratchet/index.js';

import { ratchetEncrypt } from '../ratchet/encrypt.js';
import { ratchetDecrypt } from '../ratchet/decrypt.js';
import { packageRatchetPayload, parseRatchetPayload, isRatchetPayload } from '../ratchet/codec.js';
import { verifyMessageSignature } from '../ratchet/auth.js';
import { dh } from '../ratchet/kdf.js';
import { initSessionAsInitiator, initSessionAsResponder } from '../ratchet/session.js';
import type { RatchetSession } from '../ratchet/types.js';

import { SessionManager } from './SessionManager.js';
import { PendingManager } from './PendingManager.js';
import type {
  VerbethClientConfig,
  HandshakeResult,
  HandshakeResponseResult,
  SessionStore,
  PendingStore,
  PreparedMessage,
  DecryptedMessage,
  SendResult,
  ConfirmResult,
  SerializedSessionInfo,
  VerbethClientCallbacks,
  CreateInitiatorSessionFromHsrParams,
} from './types.js';

export interface CreateInitiatorSessionParams {
  contactAddress: string;
  initiatorEphemeralSecret: Uint8Array;
  responderEphemeralPubKey: Uint8Array;
  inResponseToTag: `0x${string}`;
  kemCiphertext?: Uint8Array;      // from handshake response (for KEM decapsulation)
  initiatorKemSecret?: Uint8Array; // stored from sendHandshake
}

export interface CreateResponderSessionParams {
  contactAddress: string;
  responderEphemeralSecret: Uint8Array;
  responderEphemeralPublic: Uint8Array;
  initiatorEphemeralPubKey: Uint8Array;
  salt: Uint8Array;
  kemSharedSecret?: Uint8Array; // from acceptHandshake (for hybrid KDF)
}

export class VerbethClient {
  private readonly executor: IExecutor;
  private readonly identityKeyPair: IdentityKeyPair;
  private readonly identityProof: IdentityProof;
  private readonly signer: Signer;
  private readonly address: string;
  private readonly callbacks?: VerbethClientCallbacks;

  // configured via setters
  private sessionManager?: SessionManager;
  private pendingManager?: PendingManager;

  constructor(config: VerbethClientConfig) {
    this.executor = config.executor;
    this.identityKeyPair = config.identityKeyPair;
    this.identityProof = config.identityProof;
    this.signer = config.signer;
    this.address = config.address;
    this.callbacks = config.callbacks;
  }

  /**
   * to be called before using prepareMessage/decryptMessage/sendMessage.
   */
  setSessionStore(store: SessionStore): void {
    this.sessionManager = new SessionManager(store);
  }

  /**
   * to be called before using sendMessage/confirmTx/revertTx.
   */
  setPendingStore(store: PendingStore): void {
    this.pendingManager = new PendingManager(store);
  }

  hasSessionStore(): boolean {
    return !!this.sessionManager;
  }

  hasPendingStore(): boolean {
    return !!this.pendingManager;
  }


  /**
   * Initiates a handshake with a recipient.
   *
   * Generates an ephemeral keypair and ML-KEM keypair for this handshake.
   * Both secretKeys must be stored for ratchet session initialization
   * when the response arrives.
   *
   * @param recipientAddress - Blockchain address of the recipient
   * @param message - Plaintext message to include in the handshake
   * @returns Transaction response, ephemeral keypair, and KEM keypair
   */
  async sendHandshake(
    recipientAddress: string,
    message: string
  ): Promise<HandshakeResult> {
    const { tx, ephemeralKeyPair, kemKeyPair } = await initiateHandshake({
      executor: this.executor,
      recipientAddress,
      identityKeyPair: this.identityKeyPair,
      plaintextPayload: message,
      identityProof: this.identityProof,
      signer: this.signer,
    });

    return { tx, ephemeralKeyPair, kemKeyPair };
  }

  /**
   * Accepts a handshake from an initiator.
   *
   * Derives topics from ephemeral DH shared secret (same approach
   * as post-handshake topic ratcheting). Returns topicOutbound/topicInbound
   * directly instead of duplexTopics structure.
   *
   * Supports PQ-hybrid: if initiator includes ML-KEM public key (1216 bytes),
   * performs KEM encapsulation and returns kemSharedSecret.
   *
   * @param initiatorEphemeralPubKey - Initiator's ephemeral key (32 bytes X25519 or 1216 bytes with KEM)
   * @param initiatorIdentityPubKey - Initiator's long-term X25519 identity key (kept for future use)
   * @param note - Response message to send back
   * @returns Transaction, derived topics, ephemeral keys for ratchet, and KEM shared secret
   */
  async acceptHandshake(
    initiatorEphemeralPubKey: Uint8Array,
    initiatorIdentityPubKey: Uint8Array,  // Kept for potential future use
    note: string
  ): Promise<HandshakeResponseResult> {
    const {
      tx,
      salt,
      tag,
      responderEphemeralSecret,
      responderEphemeralPublic,
      kemSharedSecret,
    } = await respondToHandshake({
      executor: this.executor,
      initiatorEphemeralPubKey,
      responderIdentityKeyPair: this.identityKeyPair,
      note,
      identityProof: this.identityProof,
      signer: this.signer,
    });

    // Extract X25519 part for topic derivation (first 32 bytes if extended)
    const x25519Pub = initiatorEphemeralPubKey.length > 32
      ? initiatorEphemeralPubKey.slice(0, 32)
      : initiatorEphemeralPubKey;

    const { topicOutbound, topicInbound } = this.deriveTopicsFromDH(
      responderEphemeralSecret,
      x25519Pub,
      salt,
      false // responder swaps labels
    );

    return {
      tx,
      topicOutbound,
      topicInbound,
      tag,
      salt,
      responderEphemeralSecret,
      responderEphemeralPublic,
      kemSharedSecret,
    };
  }

  // ===========================================================================
  // Session Creation - Encapsulates DH and topic derivation
  // ===========================================================================

  /**
   * Create a ratchet session as the handshake initiator.
   *
   * Call this after receiving and validating a handshake response.
   * Handles topic derivation from ephemeral DH internally.
   *
   * If KEM ciphertext and secret are provided (PQ-hybrid), decapsulates
   * to derive hybrid shared secret for post-quantum security.
   *
   * @param params - Session creation parameters
   * @returns Ready-to-save RatchetSession
   */
  createInitiatorSession(params: CreateInitiatorSessionParams): RatchetSession {
    const {
      contactAddress,
      initiatorEphemeralSecret,
      responderEphemeralPubKey,
      inResponseToTag,
      kemCiphertext,
      initiatorKemSecret,
    } = params;

    // Decapsulate KEM if present
    let kemSecret: Uint8Array | undefined;
    if (kemCiphertext && initiatorKemSecret) {
      kemSecret = kem.decapsulate(kemCiphertext, initiatorKemSecret);
    }

    const salt = getBytes(inResponseToTag);
    const { topicOutbound, topicInbound } = this.deriveTopicsFromDH(
      initiatorEphemeralSecret,
      responderEphemeralPubKey,
      salt,
      true // initiator: no swap
    );

    return initSessionAsInitiator({
      myAddress: this.address,
      contactAddress,
      myHandshakeEphemeralSecret: initiatorEphemeralSecret,
      theirResponderEphemeralPubKey: responderEphemeralPubKey,
      topicOutbound,
      topicInbound,
      kemSecret,
    });
  }

  /**
   * Create a ratchet session as the handshake responder.
   *
   * Call this after sending a handshake response.
   * Handles topic derivation from ephemeral DH internally.
   *
   * If kemSharedSecret is provided (PQ-hybrid), uses hybrid KDF
   * for post-quantum security.
   *
   * @param params - Session creation parameters
   * @returns Ready-to-save RatchetSession
   */
  createResponderSession(params: CreateResponderSessionParams): RatchetSession {
    const {
      contactAddress,
      responderEphemeralSecret,
      responderEphemeralPublic,
      initiatorEphemeralPubKey,
      salt,
      kemSharedSecret,
    } = params;

    // Extract X25519 part for topic derivation (first 32 bytes if extended)
    const x25519Pub = initiatorEphemeralPubKey.length > 32
      ? initiatorEphemeralPubKey.slice(0, 32)
      : initiatorEphemeralPubKey;

    const { topicOutbound, topicInbound } = this.deriveTopicsFromDH(
      responderEphemeralSecret,
      x25519Pub,
      salt,
      false // responder swaps labels
    );

    return initSessionAsResponder({
      myAddress: this.address,
      contactAddress,
      myResponderEphemeralSecret: responderEphemeralSecret,
      myResponderEphemeralPublic: responderEphemeralPublic,
      theirHandshakeEphemeralPubKey: x25519Pub,
      topicOutbound,
      topicInbound,
      kemSecret: kemSharedSecret,
    });
  }

  /**
   * Accepting a structured HSR event object instead of individual parameters scattered across variables.
   */
  createInitiatorSessionFromHsr(params: CreateInitiatorSessionFromHsrParams): RatchetSession {
    return this.createInitiatorSession({
      contactAddress: params.contactAddress,
      initiatorEphemeralSecret: params.myEphemeralSecret,
      responderEphemeralPubKey: params.hsrEvent.responderEphemeralPubKey,
      inResponseToTag: params.hsrEvent.inResponseToTag,
      kemCiphertext: params.hsrEvent.kemCiphertext,
      initiatorKemSecret: params.myKemSecret,
    });
  }

  /**
   * Derive epoch 0 topics from DH shared secret (handshake topics).
   *
   * NOTE: This uses the v2 scheme (DH + salt) for backward compatibility
   * with epoch 0 topics. Post-handshake topics (epoch 1+) use the v3 scheme
   * (DH + rootKey) via deriveTopic() for quantum-resistant unlinkability.
   *
   * @param mySecret - My ephemeral secret key
   * @param theirPublic - Their ephemeral public key
   * @param salt - Salt for topic derivation (typically the tag bytes)
   * @param isInitiator - Whether this party is the initiator (affects label swap)
   * @returns Derived outbound and inbound topics
   */
  private deriveTopicsFromDH(
    mySecret: Uint8Array,
    theirPublic: Uint8Array,
    salt: Uint8Array,
    isInitiator: boolean
  ): { topicOutbound: `0x${string}`; topicInbound: `0x${string}` } {
    const ephemeralShared = dh(mySecret, theirPublic);

    // Inline epoch 0 topic derivation (v2 scheme: DH + salt)
    // This keeps epoch 0 topics compatible while epoch 1+ use PQ-secure derivation
    const deriveEpoch0Topic = (direction: 'outbound' | 'inbound'): `0x${string}` => {
      const info = `verbeth:topic-${direction}:v2`;
      const okm = hkdf(sha256, ephemeralShared, salt, info, 32);
      return keccak256(okm) as `0x${string}`;
    };

    // Labels are from initiator's perspective
    // Initiator: outbound='outbound', inbound='inbound'
    // Responder: outbound='inbound', inbound='outbound' (swapped)
    if (isInitiator) {
      return {
        topicOutbound: deriveEpoch0Topic('outbound'),
        topicInbound: deriveEpoch0Topic('inbound'),
      };
    } else {
      return {
        topicOutbound: deriveEpoch0Topic('inbound'),
        topicInbound: deriveEpoch0Topic('outbound'),
      };
    }
  }

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  /**
   * Prepare a message for sending (encrypt without submitting).
   * 
   * Two-phase commit pattern:
   * 1. prepareMessage() - encrypts and persists session state immediately
   * 2. Submit transaction using prepared.payload and prepared.topic
   * 3. On confirmation, call confirmTx() to clean up pending record
   * 
   * Session state is committed immediately for forward secrecy.
   * If tx fails, the ratchet slot is "burned" (receiver handles via skip keys).
   * 
   * @param conversationId - The conversation to send in
   * @param plaintext - Message text to encrypt
   * @returns PreparedMessage with payload ready for on-chain submission
   */
  async prepareMessage(
    conversationId: string,
    plaintext: string
  ): Promise<PreparedMessage> {
    if (!this.sessionManager) {
      throw new Error('SessionStore not configured. Call setSessionStore() first.');
    }

    const session = await this.sessionManager.getByConversationId(conversationId);
    if (!session) {
      throw new Error(`No session found for conversation: ${conversationId}`);
    }

    const plaintextBytes = new TextEncoder().encode(plaintext);
    
    const encryptResult = ratchetEncrypt(
      session,
      plaintextBytes,
      this.identityKeyPair.signingSecretKey
    );

    const packedPayload = packageRatchetPayload(
      encryptResult.signature,
      encryptResult.header,
      encryptResult.ciphertext
    );

    await this.sessionManager.save(encryptResult.session);

    const prepared: PreparedMessage = {
      id: this.generatePreparedId(),
      conversationId,
      topic: encryptResult.topic,
      payload: packedPayload,
      plaintext,
      sessionBefore: session,
      sessionAfter: encryptResult.session,
      messageNumber: session.sendingMsgNumber,
      createdAt: Date.now(),
    };

    return prepared;
  }

  // Session already saved in prepareMessage for forward secrecy.
  // So this method can be used for additional bookkeeping if needed.
  async commitMessage(_prepared: PreparedMessage): Promise<void> {
  }

  /**
   * Decrypt an incoming message.
   * 
   * Handles:
   * - Topic routing (current, next, previous)
   * - Signature verification (DoS protection)
   * - Ratchet decryption
   * - Session state updates
   * - Automatic topic promotion
   * 
   * @param topic - The topic the message arrived on
   * @param payload - Raw message payload (Uint8Array)
   * @param senderSigningKey - Sender's Ed25519 signing public key
   * @param isOwnMessage - Whether this is our own outbound message (echo)
   * @returns DecryptedMessage or null if decryption fails
   */
  async decryptMessage(
    topic: string,
    payload: Uint8Array,
    senderSigningKey: Uint8Array,
    isOwnMessage: boolean = false
  ): Promise<DecryptedMessage | null> {
    if (!this.sessionManager) {
      throw new Error('SessionStore not configured. Call setSessionStore() first.');
    }

    if (isOwnMessage) {
      return null;
    }

    const result = await this.sessionManager.getByInboundTopic(topic);
    if (!result) {
      return null;
    }

    const { session, topicMatch } = result;

    if (!isRatchetPayload(payload)) {
      return null;
    }

    const parsed = parseRatchetPayload(payload);
    if (!parsed) {
      return null;
    }

    const sigValid = verifyMessageSignature(
      parsed.signature,
      parsed.header,
      parsed.ciphertext,
      senderSigningKey
    );

    if (!sigValid) {
      return null;
    }

    const decryptResult = ratchetDecrypt(session, parsed.header, parsed.ciphertext);
    if (!decryptResult) {
      return null;
    }

    // Check for topic ratchet before saving
    const topicRatcheted = decryptResult.session.topicEpoch > session.topicEpoch;
    const previousTopicInbound = topicRatcheted ? session.currentTopicInbound : null;

    await this.sessionManager.save(decryptResult.session);

    // Invoke callbacks if configured
    if (this.callbacks) {
      if (topicRatcheted && this.callbacks.onTopicRatchet) {
        this.callbacks.onTopicRatchet({
          conversationId: session.conversationId,
          previousTopicInbound,
          currentTopicInbound: decryptResult.session.currentTopicInbound,
          topicEpoch: decryptResult.session.topicEpoch,
        });
      }

      if (this.callbacks.onMessageDecrypted) {
        this.callbacks.onMessageDecrypted({
          conversationId: session.conversationId,
          topicMatch,
          topicEpoch: decryptResult.session.topicEpoch,
        });
      }
    }

    const plaintextStr = new TextDecoder().decode(decryptResult.plaintext);

    return {
      conversationId: session.conversationId,
      plaintext: plaintextStr,
      isOwnMessage: false,
      session: decryptResult.session,
      topic,
      topicMatch,
    };
  }

  /**
   * Send a message with full lifecycle management.
   * 
   * This is the high-level API that handles:
   * 1. Encryption (with session commit)
   * 2. Pending record creation
   * 3. Transaction submission
   * 4. Status tracking
   * 
   * After calling this, wait for on-chain confirmation and call confirmTx().
   * 
   * @param conversationId - Conversation to send in
   * @param plaintext - Message text
   * @returns SendResult with txHash and metadata
   */
  async sendMessage(
    conversationId: string,
    plaintext: string
  ): Promise<SendResult> {
    if (!this.sessionManager) {
      throw new Error('SessionStore not configured. Call setSessionStore() first.');
    }
    if (!this.pendingManager) {
      throw new Error('PendingStore not configured. Call setPendingStore() first.');
    }

    // 1. Prepare message (encrypts and persists session)
    const prepared = await this.prepareMessage(conversationId, plaintext);

    // 2. Create pending record
    await this.pendingManager.create({
      id: prepared.id,
      conversationId,
      topic: prepared.topic,
      payloadHex: hexlify(prepared.payload),
      plaintext,
      sessionStateBefore: JSON.stringify(this.serializeSessionInfo(prepared.sessionBefore)),
      sessionStateAfter: JSON.stringify(this.serializeSessionInfo(prepared.sessionAfter)),
      createdAt: prepared.createdAt,
    });

    // 3. Submit transaction
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = prepared.messageNumber;

    try {
      const tx = await this.executor.sendMessage(
        prepared.payload,
        prepared.topic,
        timestamp,
        BigInt(nonce)
      );

      // 4. Update pending with txHash
      await this.pendingManager.markSubmitted(prepared.id, tx.hash);

      return {
        messageId: prepared.id,
        txHash: tx.hash,
        topic: prepared.topic,
        messageNumber: nonce,
      };
    } catch (error) {
      // Mark as failed (ratchet slot is already burned)
      await this.pendingManager.markFailed(prepared.id);
      throw error;
    }
  }

  /**
   * Confirm a transaction after on-chain confirmation.
   * Call this when you see your MessageSent event on-chain.
   * 
   * @param txHash - Transaction hash to confirm
   * @returns ConfirmResult or null if not found
   */
  async confirmTx(txHash: string): Promise<ConfirmResult | null> {
    if (!this.pendingManager) {
      throw new Error('PendingStore not configured.');
    }

    const pending = await this.pendingManager.getByTxHash(txHash);
    if (!pending || pending.status !== 'submitted') {
      return null;
    }

    // Finalize (delete pending record)
    const finalized = await this.pendingManager.finalize(pending.id);
    if (!finalized) {
      return null;
    }

    return {
      conversationId: finalized.conversationId,
      plaintext: finalized.plaintext,
      messageId: finalized.id,
    };
  }

  /**
   * Handle transaction failure/revert.
   * 
   * The ratchet slot is already burned (session was persisted in prepareMessage).
   * This just cleans up the pending record.
   * 
   * @param txHash - Transaction hash that failed
   */
  async revertTx(txHash: string): Promise<void> {
    if (!this.pendingManager) {
      throw new Error('PendingStore not configured.');
    }

    const pending = await this.pendingManager.getByTxHash(txHash);
    if (pending) {
      await this.pendingManager.delete(pending.id);
    }
  }


  invalidateSessionCache(conversationId: string): void {
    this.sessionManager?.invalidate(conversationId);
  }

  clearSessionCache(): void {
    this.sessionManager?.clearCache();
  }

  async getSession(conversationId: string): Promise<RatchetSession | null> {
    return this.sessionManager?.getByConversationId(conversationId) ?? null;
  }

  // ===========================================================================
  // Low-level API Access 
  // ===========================================================================

  get crypto() {
    return crypto;
  }

  get payload() {
    return payload;
  }

  get verify() {
    return verify;
  }

  get utils() {
    return utils;
  }

  get identity() {
    return identity;
  }

  get ratchet() {
    return ratchet;
  }

  get executorInstance(): IExecutor {
    return this.executor;
  }

  get identityKeyPairInstance(): IdentityKeyPair {
    return this.identityKeyPair;
  }

  get userAddress(): string {
    return this.address;
  }

  get identityProofInstance(): IdentityProof {
    return this.identityProof;
  }

  private generatePreparedId(): string {
    return `prep-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private serializeSessionInfo(session: RatchetSession): SerializedSessionInfo {
    return {
      conversationId: session.conversationId,
      topicEpoch: session.topicEpoch,
      sendingMsgNumber: session.sendingMsgNumber,
      receivingMsgNumber: session.receivingMsgNumber,
      currentTopicOutbound: session.currentTopicOutbound,
      currentTopicInbound: session.currentTopicInbound,
    };
  }
}