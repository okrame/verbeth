// packages/sdk/src/types.ts

export interface LogMessage {
  sender: string;
  ciphertext: string; // JSON string of EncryptedPayload
  timestamp: number;
  topic: string; // hex string (bytes32)
  nonce: bigint;
}

export interface HandshakeLog {
  recipientHash: string;
  sender: string;
  pubKeys: string; // Unified field (hex string of 65 bytes: version + X25519 + Ed25519)
  ephemeralPubKey: string;
  plaintextPayload: string; // always contains JSON with identityProof
}

export interface HandshakeResponseLog {
  inResponseTo: string;
  responder: string;
  responderEphemeralR: string;
  ciphertext: string; // Contains unified pubKeys + identityProof encrypted
}

// Duplex topics calcolati per una conversazione a partire da un handshake
export interface DuplexTopics {
  /** Initiator → Responder */
  topicOut: `0x${string}`;
  /** Responder → Initiator */
  topicIn: `0x${string}`;
}

/** Formato compatto per invio via HSR cifrata */
export interface TopicInfoWire {
  out: `0x${string}`;
  in: `0x${string}`;
  /** checksum corto per conferma (8 byte, hex) */
  chk: `0x${string}`;
}

// Identity key pair structure (from identity.ts)
export interface IdentityKeyPair {
  // X25519 keys per encryption/decryption
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  // Ed25519 keys per signing/verification
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
}

// Identity proof structure
export interface IdentityProof {
  message: string;
  signature: string;
  messageRawHex?: `0x${string}`;
}

export type PackedUserOperation = typeof DEFAULT_AA_VERSION extends "v0.6"
  ? UserOpV06
  : UserOpV07;

export interface BaseUserOp {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  preVerificationGas: bigint;
  paymasterAndData: string;
  signature: string;
}

export interface UserOpV06 extends BaseUserOp {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface UserOpV07 extends BaseUserOp {
  /**
   * = (verificationGasLimit << 128) \| callGasLimit
   */
  accountGasLimits: bigint;
  /**
   * = (maxFeePerGas << 128) \| maxPriorityFeePerGas
   */
  gasFees: bigint;
}

export type AASpecVersion = "v0.6" | "v0.7";
export const DEFAULT_AA_VERSION: AASpecVersion = "v0.7";
