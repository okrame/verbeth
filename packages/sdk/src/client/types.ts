// packages/sdk/src/client/types.ts

import type { Signer } from 'ethers';
import type { IExecutor } from '../executor.js';
import type { IdentityKeyPair, IdentityProof, DuplexTopics } from '../types.js';
import type nacl from 'tweetnacl';

/**
 * Configuration for creating a VerbethClient instance
 */
export interface VerbethClientConfig {
  executor: IExecutor;
  identityKeyPair: IdentityKeyPair;
  identityProof: IdentityProof;
  signer: Signer;
  address: string;
}

/**
 * Result from initiating a handshake
 */
export interface HandshakeResult {
  tx: any;
  ephemeralKeyPair: nacl.BoxKeyPair; // to be stored
}

/**
 * Result from accepting a handshake
 */
export interface HandshakeResponseResult {
  tx: any;
  duplexTopics: DuplexTopics;
  tag: string;
}