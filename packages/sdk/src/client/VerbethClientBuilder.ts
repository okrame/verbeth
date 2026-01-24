// packages/sdk/src/client/VerbethClientBuilder.ts

/**
 * Builder pattern and factory function for VerbethClient.
 *
 * Provides a fluent API for client setup, reducing boilerplate
 * and making the initialization order explicit.
 */

import type { Signer } from 'ethers';
import type { IExecutor } from '../executor.js';
import type { IdentityKeyPair, IdentityProof } from '../types.js';
import type { SessionStore, PendingStore, VerbethClientCallbacks } from './types.js';
import { VerbethClient } from './VerbethClient.js';

/**
 * Options for createVerbethClient factory function.
 */
export interface CreateVerbethClientOptions {
  address: string;
  signer: Signer;
  identityKeyPair: IdentityKeyPair;
  identityProof: IdentityProof;
  executor: IExecutor;
  sessionStore?: SessionStore;
  pendingStore?: PendingStore;
  callbacks?: VerbethClientCallbacks;
}

/**
 * Factory function for one-liner client creation.
 *
 * @example
 * ```typescript
 * const client = createVerbethClient({
 *   address,
 *   signer,
 *   identityKeyPair,
 *   identityProof,
 *   executor,
 *   sessionStore,
 *   pendingStore,
 * });
 * ```
 */
export function createVerbethClient(options: CreateVerbethClientOptions): VerbethClient {
  const client = new VerbethClient({
    address: options.address,
    signer: options.signer,
    identityKeyPair: options.identityKeyPair,
    identityProof: options.identityProof,
    executor: options.executor,
    callbacks: options.callbacks,
  });

  if (options.sessionStore) {
    client.setSessionStore(options.sessionStore);
  }

  if (options.pendingStore) {
    client.setPendingStore(options.pendingStore);
  }

  return client;
}

/**
 * Builder for fluent VerbethClient construction.
 *
 * @example
 * ```typescript
 * const client = new VerbethClientBuilder()
 *   .withAddress(address)
 *   .withSigner(signer)
 *   .withIdentity(keyPair, proof)
 *   .withExecutor(executor)
 *   .withStorage(sessionStore, pendingStore)
 *   .build();
 * ```
 */
export class VerbethClientBuilder {
  private address?: string;
  private signer?: Signer;
  private identityKeyPair?: IdentityKeyPair;
  private identityProof?: IdentityProof;
  private executor?: IExecutor;
  private sessionStore?: SessionStore;
  private pendingStore?: PendingStore;
  private callbacks?: VerbethClientCallbacks;

  /**
   * Set the user's blockchain address.
   */
  withAddress(address: string): this {
    this.address = address;
    return this;
  }

  /**
   * Set the ethers Signer for transaction signing.
   */
  withSigner(signer: Signer): this {
    this.signer = signer;
    return this;
  }

  /**
   * Set the identity keypair and proof.
   */
  withIdentity(keyPair: IdentityKeyPair, proof: IdentityProof): this {
    this.identityKeyPair = keyPair;
    this.identityProof = proof;
    return this;
  }

  /**
   * Set the contract executor.
   */
  withExecutor(executor: IExecutor): this {
    this.executor = executor;
    return this;
  }

  /**
   * Set storage adapters for sessions and pending messages.
   * Both are optional - only set what you need.
   */
  withStorage(sessionStore?: SessionStore, pendingStore?: PendingStore): this {
    if (sessionStore) {
      this.sessionStore = sessionStore;
    }
    if (pendingStore) {
      this.pendingStore = pendingStore;
    }
    return this;
  }

  /**
   * Set the session store adapter.
   */
  withSessionStore(store: SessionStore): this {
    this.sessionStore = store;
    return this;
  }

  /**
   * Set the pending message store adapter.
   */
  withPendingStore(store: PendingStore): this {
    this.pendingStore = store;
    return this;
  }

  /**
   * Set optional callbacks for events.
   */
  withCallbacks(callbacks: VerbethClientCallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  /**
   * Build the VerbethClient instance.
   *
   * @throws Error if required fields are missing
   */
  build(): VerbethClient {
    if (!this.address) {
      throw new Error('VerbethClientBuilder: address is required. Call withAddress().');
    }
    if (!this.signer) {
      throw new Error('VerbethClientBuilder: signer is required. Call withSigner().');
    }
    if (!this.identityKeyPair) {
      throw new Error('VerbethClientBuilder: identityKeyPair is required. Call withIdentity().');
    }
    if (!this.identityProof) {
      throw new Error('VerbethClientBuilder: identityProof is required. Call withIdentity().');
    }
    if (!this.executor) {
      throw new Error('VerbethClientBuilder: executor is required. Call withExecutor().');
    }

    return createVerbethClient({
      address: this.address,
      signer: this.signer,
      identityKeyPair: this.identityKeyPair,
      identityProof: this.identityProof,
      executor: this.executor,
      sessionStore: this.sessionStore,
      pendingStore: this.pendingStore,
      callbacks: this.callbacks,
    });
  }
}
