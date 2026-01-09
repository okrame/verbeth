// packages/sdk/src/client/VerbethClient.ts

/**
 * High-level client for Verbeth E2EE messaging.
 * 
 * Handles handshake operations. Message encryption is done via
 * the ratchet module at the application layer.
 * 
 * NOTE: sendMessage() has been REMOVED. Use ratchet functions directly:
 *   - ratchetEncrypt() for encryption
 *   - packageRatchetPayload() for binary encoding
 *   - executor.sendMessage() for on-chain submission
 */

import nacl from 'tweetnacl';
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

// =============================================================================
// Types
// =============================================================================

export interface VerbethClientConfig {
  executor: IExecutor;
  identityKeyPair: IdentityKeyPair;
  identityProof: IdentityProof;
  signer: Signer;
  address: string;
}

export interface HandshakeResult {
  tx: any;
  /** Ephemeral keypair - MUST persist secretKey for ratchet session init */
  ephemeralKeyPair: nacl.BoxKeyPair;
}

export interface HandshakeResponseResult {
  tx: any;
  /** Derived duplex topics for the conversation */
  duplexTopics: DuplexTopics;
  /** Tag used for inResponseTo field */
  tag: `0x${string}`;
  /** Salt for topic derivation (= getBytes(tag)) */
  salt: Uint8Array;
  /** 
   * Responder's DH ratchet secret - MUST persist as dhMySecretKey in ratchet.
   * NOTE: This is DIFFERENT from the on-chain responderEphemeralR (which is the tag key).
   */
  responderEphemeralSecret: Uint8Array;
  /** 
   * Responder's DH ratchet public key (inside encrypted payload, NOT on-chain).
   * NOTE: This is DIFFERENT from responderEphemeralR for unlinkability.
   */
  responderEphemeralPublic: Uint8Array;
}

// =============================================================================
// Client
// =============================================================================

/**
 * High-level client for Verbeth E2EE messaging.
 * 
 * @example
 * ```typescript
 * const client = new VerbethClient({
 *   executor,
 *   identityKeyPair,
 *   identityProof,
 *   signer,
 *   address: '0x...'
 * });
 * 
 * // Send a handshake
 * const { tx, ephemeralKeyPair } = await client.sendHandshake(
 *   '0xBob...',
 *   'Hello Bob!'
 * );
 * // MUST persist ephemeralKeyPair.secretKey for ratchet session init
 * 
 * // Accept a handshake
 * const { duplexTopics, responderEphemeralSecret } = await client.acceptHandshake(
 *   handshake.ephemeralPubKey,
 *   handshake.identityPubKey,
 *   'Hello Alice!'
 * );
 * // Use responderEphemeralSecret with initSessionAsResponder()
 * ```
 */
export class VerbethClient {
  private readonly executor: IExecutor;
  private readonly identityKeyPair: IdentityKeyPair;
  private readonly identityProof: IdentityProof;
  private readonly signer: Signer;
  private readonly address: string;

  constructor(config: VerbethClientConfig) {
    this.executor = config.executor;
    this.identityKeyPair = config.identityKeyPair;
    this.identityProof = config.identityProof;
    this.signer = config.signer;
    this.address = config.address;
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
   * 
   * @example
   * ```typescript
   * const result = await client.acceptHandshake(
   *   handshake.ephemeralPubKey,
   *   handshake.identityPubKey,
   *   'Hello Alice!'
   * );
   * 
   * // Initialize ratchet session as responder
   * const session = initSessionAsResponder({
   *   myAddress: myAddress,
   *   contactAddress: handshake.sender,
   *   myResponderEphemeralSecret: result.responderEphemeralSecret,
   *   myResponderEphemeralPublic: result.responderEphemeralPublic,
   *   theirHandshakeEphemeralPubKey: handshake.ephemeralPubKey,
   *   topicOutbound: pickOutboundTopic(false, result.duplexTopics),
   *   topicInbound: pickOutboundTopic(true, result.duplexTopics),
   * });
   * ```
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

  // ===========================================================================
  // Low-level API access
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
}