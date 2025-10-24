// packages/sdk/src/client/VerbethClient.ts

import nacl from 'tweetnacl';
import { initiateHandshake, respondToHandshake, sendEncryptedMessage } from '../send.js';
import { deriveDuplexTopics } from '../crypto.js';
import type { VerbethClientConfig, HandshakeResult, HandshakeResponseResult } from './types.js';
import type { IExecutor } from '../executor.js';
import type { IdentityKeyPair, IdentityProof } from '../types.js';
import type { Signer } from 'ethers';

import * as crypto from '../crypto.js';
import * as payload from '../payload.js';
import * as verify from '../verify.js';
import * as utils from '../utils.js';
import * as identity from '../identity.js';

/**
 * High-level client for Verbeth E2EE messaging
 * 
 * VerbethClient provides a simplified API for common operations while
 * maintaining access to all low-level functions.
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
 * 
 * // Send a message
 * await client.sendMessage(
 *   contact.topicOutbound,
 *   contact.identityPubKey,
 *   'Hello again!'
 * );
 * ```
 */
export class VerbethClient {
  private readonly executor: IExecutor;
  private readonly identityKeyPair: IdentityKeyPair;
  private readonly identityProof: IdentityProof;
  private readonly signer: Signer;
  private readonly address: string;

  /**
   * creates a new VerbethClient instance
   * 
   * @param config - Client configuration with session-level parameters
   */
  constructor(config: VerbethClientConfig) {
    this.executor = config.executor;
    this.identityKeyPair = config.identityKeyPair;
    this.identityProof = config.identityProof;
    this.signer = config.signer;
    this.address = config.address;
  }

  /**
   * Initiates a handshake with a recipient
   * 
   * generates an ephemeral keypair for this handshake.
   * the ephemeralKeyPair must be stored to decrypt the response later.
   * 
   * @param recipientAddress - Blockchain address of the recipient
   * @param message - Plaintext message to include in the handshake
   * @returns Transaction response and the ephemeral keypair (must be stored!)
   * 
   * @example
   * ```typescript
   * const { tx, ephemeralKeyPair } = await client.sendHandshake(
   *   '0xBob...',
   *   'Hi Bob!'
   * );
   * 
   * // Store ephemeralKeyPair.secretKey to decrypt Bob's response
   * await storage.saveContact({
   *   address: '0xBob...',
   *   ephemeralKey: ephemeralKeyPair.secretKey,
   *   // ...
   * });
   * ```
   */
  async sendHandshake(
    recipientAddress: string,
    message: string
  ): Promise<HandshakeResult> {
    const ephemeralKeyPair = nacl.box.keyPair();

    const tx = await initiateHandshake({
      executor: this.executor,
      recipientAddress,
      identityKeyPair: this.identityKeyPair,
      ephemeralPubKey: ephemeralKeyPair.publicKey,
      plaintextPayload: message,
      identityProof: this.identityProof,
      signer: this.signer,
    });

    return { tx, ephemeralKeyPair };
  }

  /**
   * Accepts a handshake from an initiator
   * 
   * derives duplex topics for the conversation and returns them.
   * 
   * @param initiatorEphemeralPubKey - initiator's ephemeral public key from handshake event
   * @param initiatorIdentityPubKey - initiator's long-term X25519 identity key
   * @param note - response message to send back
   * @returns transaction, derived duplex topics, and response tag
   * 
   * @example
   * ```typescript
   * const { tx, duplexTopics } = await client.acceptHandshake(
   *   handshake.ephemeralPubKey,
   *   handshake.identityPubKey,
   *   'Hello Alice!'
   * );
   * 
   * // Store the topics for future messaging
   * await storage.saveContact({
   *   address: handshake.sender,
   *   topicOutbound: duplexTopics.topicIn,  // Responder writes to topicIn
   *   topicInbound: duplexTopics.topicOut,  // Responder reads from topicOut
   *   // ...
   * });
   * ```
   */
  async acceptHandshake(
    initiatorEphemeralPubKey: Uint8Array,
    initiatorIdentityPubKey: Uint8Array,
    note: string
  ): Promise<HandshakeResponseResult> {
    const { tx, salt, tag } = await respondToHandshake({
      executor: this.executor,
      initiatorPubKey: initiatorEphemeralPubKey,
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

    return { tx, duplexTopics, tag };
  }

  /**
   * Sends an encrypted message to a contact
   * 
   * handles timestamp, signing keys, and sender address.
   * 
   * @param topicOutbound - The outbound topic for this conversation
   * @param recipientPubKey - Recipient's X25519 public key (from handshake)
   * @param message - Plaintext message to encrypt and send
   * @returns Transaction response
   * 
   * @example
   * ```typescript
   * await client.sendMessage(
   *   contact.topicOutbound,
   *   contact.identityPubKey,
   *   'Hello again!'
   * );
   * ```
   */
  async sendMessage(
    topicOutbound: string,
    recipientPubKey: Uint8Array,
    message: string
  ): Promise<any> {
    const signingKeyPair = {
      publicKey: this.identityKeyPair.signingPublicKey,
      secretKey: this.identityKeyPair.signingSecretKey,
    };

    const timestamp = Math.floor(Date.now() / 1000);

    return sendEncryptedMessage({
      executor: this.executor,
      topic: topicOutbound,
      message,
      recipientPubKey,
      senderAddress: this.address,
      senderSignKeyPair: signingKeyPair,
      timestamp,
    });
  }

  // ========== low-level API ==========

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

  get executorInstance(): IExecutor {
    return this.executor;
  }


  get identityKeyPairInstance(): IdentityKeyPair {
    return this.identityKeyPair;
  }

  get userAddress(): string {
    return this.address;
  }
}