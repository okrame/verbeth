// packages/sdk/src/ratchet/codec.ts

/**
 * Binary Codec for Ratchet Messages.
 * 
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Offset │ Size │ Field                                       │
 * ├────────┼──────┼─────────────────────────────────────────────┤
 * │ 0      │ 1    │ Version (0x01)                              │
 * │ 1      │ 64   │ Ed25519 signature                           │
 * │ 65     │ 32   │ DH ratchet public key                       │
 * │ 97     │ 4    │ pn (uint32 BE) - previous chain length      │
 * │ 101    │ 4    │ n (uint32 BE) - message number              │
 * │ 105    │ var  │ Ciphertext (nonce + AEAD output)            │
 * └─────────────────────────────────────────────────────────────┘
 */

import { MessageHeader, ParsedRatchetPayload, RATCHET_VERSION_V1 } from './types.js';

const MIN_PAYLOAD_LENGTH = 1 + 64 + 32 + 4 + 4; // 105 bytes

/**
 * @param signature - Ed25519 signature (64 bytes)
 * @param header - Message header (dh, pn, n)
 * @param ciphertext - Encrypted payload (nonce + secretbox output)
 * @returns Binary payload ready for on-chain submission
 */
export function packageRatchetPayload(
  signature: Uint8Array,
  header: MessageHeader,
  ciphertext: Uint8Array
): Uint8Array {
  if (signature.length !== 64) {
    throw new Error(`Invalid signature length: ${signature.length}, expected 64`);
  }
  if (header.dh.length !== 32) {
    throw new Error(`Invalid DH key length: ${header.dh.length}, expected 32`);
  }

  // Total: 1 + 64 + 32 + 4 + 4 + ciphertext.length = 105 + ciphertext.length
  const payload = new Uint8Array(MIN_PAYLOAD_LENGTH + ciphertext.length);
  const view = new DataView(payload.buffer);

  let offset = 0;

  payload[offset++] = RATCHET_VERSION_V1;

  payload.set(signature, offset);
  offset += 64;

  payload.set(header.dh, offset);
  offset += 32;

  // pn (uint32 big-endian)
  view.setUint32(offset, header.pn, false);
  offset += 4;

  // n (uint32 big-endian)
  view.setUint32(offset, header.n, false);
  offset += 4;

  payload.set(ciphertext, offset);

  return payload;
}

/**
 * Parse a binary ratchet payload.
 * 
 * @param payload - Raw binary payload
 * @returns Parsed components, or null if invalid format
 */
export function parseRatchetPayload(payload: Uint8Array): ParsedRatchetPayload | null {
  if (payload.length < MIN_PAYLOAD_LENGTH) {
    return null; 
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;

  const version = payload[offset++];
  if (version !== RATCHET_VERSION_V1) {
    return null;
  }

  const signature = payload.slice(offset, offset + 64);
  offset += 64;

  const dh = payload.slice(offset, offset + 32);
  offset += 32;

  // pn (uint32 big-endian)
  const pn = view.getUint32(offset, false);
  offset += 4;

  // n (uint32 big-endian)
  const n = view.getUint32(offset, false);
  offset += 4;

  const ciphertext = payload.slice(offset);

  return {
    version,
    signature,
    header: { dh, pn, n },
    ciphertext,
  };
}

/**
 * Used to distinguish ratchet messages from legacy JSON format.
 * 
 * @param payload - Raw payload bytes
 * @returns true if payload starts with ratchet version byte
 */
export function isRatchetPayload(payload: Uint8Array): boolean {
  return payload.length >= MIN_PAYLOAD_LENGTH && payload[0] === RATCHET_VERSION_V1;
}

/**
 * Check if hex string represents a ratchet payload.
 * 
 * @param hexPayload - Hex string (with or without 0x prefix)
 * @returns true if payload is ratchet format
 */
export function isRatchetPayloadHex(hexPayload: string): boolean {
  const hex = hexPayload.startsWith('0x') ? hexPayload.slice(2) : hexPayload;
  if (hex.length < MIN_PAYLOAD_LENGTH * 2) {
    return false;
  }
  // Check first byte is version
  const firstByte = parseInt(hex.slice(0, 2), 16);
  return firstByte === RATCHET_VERSION_V1;
}


export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array, prefix: boolean = true): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `0x${hex}` : hex;
}