// packages/sdk/src/client/VerbethClient.ts

/**
 * High-level client for Verbeth E2EE messaging.
 * 
 * Provides a unified API for:
 * - Handshake operations (sendHandshake, acceptHandshake)
 * - Message encryption/decryption with session management
 * - Two-phase commit for message sending
 * - Transaction confirmation handling
 * 
 * @example
 * ```typescript
 * // Create client
 * const client = new VerbethClient({
 *   executor,
 *   identityKeyPair,
 *   identityProof,
 *   signer,
 *   address: '0x...'
 * });
 * 
 * // Configure storage (required for messaging)
 * client.setSessionStore(sessionStore);
 * client.setPendingStore(pendingStore);
 * 
 * // Send a message
 * const result = await client.sendMessage(conversationId, 'Hello!');
 * 
 * // On confirmation event
 * const confirmed = await client.confirmTx(txHash);
 * ```
 */

import { hexlify } from 'ethers';
import { initiateHandshake, respondToHandshake } from '../send.js';
import { deriveDuplexTopics } from '../crypto.js';
import type { IExecutor } from '../executor.js';
import type { IdentityKeyPair, IdentityProof, DuplexTopics } from '../types.js';
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
} from './types.js';

export class VerbethClient {
  private readonly executor: IExecutor;
  private readonly identityKeyPair: IdentityKeyPair;
  private readonly identityProof: IdentityProof;
  private readonly signer: Signer;
  private readonly address: string;

  // configured via setters
  private sessionManager?: SessionManager;
  private pendingManager?: PendingManager;

  constructor(config: VerbethClientConfig) {
    this.executor = config.executor;
    this.identityKeyPair = config.identityKeyPair;
    this.identityProof = config.identityProof;
    this.signer = config.signer;
    this.address = config.address;
  }

  /**
   * Configure session storage.
   * Must be called before using prepareMessage/decryptMessage/sendMessage.
   */
  setSessionStore(store: SessionStore): void {
    this.sessionManager = new SessionManager(store);
  }

  /**
   * Configure pending message storage.
   * Must be called before using sendMessage/confirmTx/revertTx.
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
   * Generates an ephemeral keypair for this handshake.
   * The ephemeralKeyPair.secretKey MUST be stored for ratchet session initialization
   * when the response arrives.
   * 
   * @param recipientAddress - Blockchain address of the recipient
   * @param message - Plaintext message to include in the handshake
   * @returns Transaction response and the ephemeral keypair
   */
  async sendHandshake(
    recipientAddress: string,
    message: string
  ): Promise<HandshakeResult> {
    const { tx, ephemeralKeyPair } = await initiateHandshake({
      executor: this.executor,
      recipientAddress,
      identityKeyPair: this.identityKeyPair,
      plaintextPayload: message,
      identityProof: this.identityProof,
      signer: this.signer,
    });

    return { tx, ephemeralKeyPair };
  }

  /**
   * Accepts a handshake from an initiator.
   * 
   * Derives duplex topics for the conversation and returns ephemeral keys
   * needed for ratchet session initialization.
   * 
   * @param initiatorEphemeralPubKey - Initiator's ephemeral public key from handshake event
   * @param initiatorIdentityPubKey - Initiator's long-term X25519 identity key
   * @param note - Response message to send back
   * @returns Transaction, derived duplex topics, and ephemeral keys for ratchet
   */
  async acceptHandshake(
    initiatorEphemeralPubKey: Uint8Array,
    initiatorIdentityPubKey: Uint8Array,
    note: string
  ): Promise<HandshakeResponseResult> {
    const { 
      tx, 
      salt, 
      tag,
      responderEphemeralSecret,
      responderEphemeralPublic,
    } = await respondToHandshake({
      executor: this.executor,
      initiatorEphemeralPubKey,
      responderIdentityKeyPair: this.identityKeyPair,
      note,
      identityProof: this.identityProof,
      signer: this.signer,
      initiatorIdentityPubKey,
    });

    const duplexTopics = deriveDuplexTopics(
      this.identityKeyPair.secretKey,
      initiatorIdentityPubKey,
      salt
    );

    return { 
      tx, 
      duplexTopics, 
      tag,
      salt,
      responderEphemeralSecret,
      responderEphemeralPublic,
    };
  }


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

    // Immediately persist session state
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
  // This method can be used for additional bookkeeping if needed.
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

    // verify signature before any ratchet operations
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

    await this.sessionManager.save(decryptResult.session);

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

  /** Crypto utilities */
  get crypto() {
    return crypto;
  }

  /** Payload encoding utilities */
  get payload() {
    return payload;
  }

  /** Verification utilities */
  get verify() {
    return verify;
  }

  /** General utilities */
  get utils() {
    return utils;
  }

  /** Identity derivation utilities */
  get identity() {
    return identity;
  }

  /** Double ratchet module */
  get ratchet() {
    return ratchet;
  }

  /** Executor instance for direct access */
  get executorInstance(): IExecutor {
    return this.executor;
  }

  /** Identity keypair for direct access */
  get identityKeyPairInstance(): IdentityKeyPair {
    return this.identityKeyPair;
  }

  /** User's address */
  get userAddress(): string {
    return this.address;
  }

  /** Identity proof for direct access */
  get identityProofInstance(): IdentityProof {
    return this.identityProof;
  }

  /**
   * Generate unique ID for prepared messages.
   */
  private generatePreparedId(): string {
    return `prep-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Serialize session info for storage.
   * Used in pending records for debugging/recovery.
   */
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