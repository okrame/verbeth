// packages/sdk/src/payload.ts

import { IdentityProof } from './types.js'; 

export interface EncryptedPayload {
  v: number; // version
  epk: string; // base64 of ephemeral public key
  n: string;   // base64 of nonce
  ct: string;  // base64 of ciphertext
  sig?: string; // base64 of detached signature over (epk || n || ct)
}

export interface HandshakeContent {
  plaintextPayload: string;
  identityProof: IdentityProof;  
}

export function parseHandshakePayload(plaintextPayload: string): HandshakeContent {
  try {
    const parsed = JSON.parse(plaintextPayload);
    if (typeof parsed === 'object' && parsed.plaintextPayload && parsed.identityProof) {
      return parsed as HandshakeContent;
    }
  } catch (e) {
  }
  
  throw new Error("Invalid handshake payload: missing identityProof");
}

export function serializeHandshakeContent(content: HandshakeContent): string {
  return JSON.stringify(content);
}

export function encodePayload(ephemeralPubKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, sig?: Uint8Array): string {
  const payload: EncryptedPayload = {
    v: 1,
    epk: Buffer.from(ephemeralPubKey).toString('base64'),
    n: Buffer.from(nonce).toString('base64'),
    ct: Buffer.from(ciphertext).toString('base64'),
    ...(sig && { sig: Buffer.from(sig).toString('base64') })
  };
  return JSON.stringify(payload);
}

export function decodePayload(json: string): {
  epk: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  sig?: Uint8Array
} {
  let actualJson = json;

  if (typeof json === 'string' && json.startsWith('0x')) {
    try {
      const bytes = new Uint8Array(Buffer.from(json.slice(2), 'hex'));
      actualJson = new TextDecoder().decode(bytes);
    } catch (err) {
      throw new Error(`Hex decode error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const { epk, n, ct, sig } = JSON.parse(actualJson) as EncryptedPayload;
    return {
      epk: Buffer.from(epk, 'base64'),
      nonce: Buffer.from(n, 'base64'),
      ciphertext: Buffer.from(ct, 'base64'),
      ...(sig && { sig: Buffer.from(sig, 'base64') })
    };
  } catch (parseError) {
    throw new Error(
      `JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`
    );
  }
}


// Unified function for encoding any structured content as Uint8Array
export function encodeStructuredContent<T>(content: T): Uint8Array {
  const serialized = JSON.stringify(content, (key, value) => {
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64');
    }
    return value;
  });
  return new TextEncoder().encode(serialized);
}

// Unified function for decoding structured content
export function decodeStructuredContent<T>(
  encoded: Uint8Array,
  converter: (obj: any) => T
): T {
  const decoded = JSON.parse(new TextDecoder().decode(encoded));
  return converter(decoded);
}

// ========== UNIFIED KEYS MANAGEMENT ==========

/**
 * Encodes X25519 + Ed25519 keys into a single 65-byte array with versioning
 */
export function encodeUnifiedPubKeys(
  identityPubKey: Uint8Array,  // X25519 - 32 bytes
  signingPubKey: Uint8Array    // Ed25519 - 32 bytes  
): Uint8Array {
  const version = new Uint8Array([0x01]); // v1
  return new Uint8Array([
    ...version,
    ...identityPubKey,
    ...signingPubKey
  ]); // 65 bytes total
}

/**
 * Decodes unified pubKeys back to individual X25519 and Ed25519 keys
 */
export function decodeUnifiedPubKeys(pubKeys: Uint8Array): {
  version: number;
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
} | null {
  if (pubKeys.length === 64) {
    return {
      version: 0,
      identityPubKey: pubKeys.slice(0, 32),
      signingPubKey: pubKeys.slice(32, 64)
    };
  }
  
  if (pubKeys.length === 65 && pubKeys[0] === 0x01) {
    return {
      version: 1,
      identityPubKey: pubKeys.slice(1, 33),
      signingPubKey: pubKeys.slice(33, 65)
    };
  }
  
  return null; 
}

export interface HandshakePayload {
  unifiedPubKeys: Uint8Array;   
  ephemeralPubKey: Uint8Array;
  plaintextPayload: string;
}

export interface HandshakeResponseContent {
  unifiedPubKeys: Uint8Array;    
  ephemeralPubKey: Uint8Array;
  kemCiphertext?: Uint8Array;   
  note?: string;
  identityProof: IdentityProof;
}

export function createHandshakeResponseContent(
  identityPubKey: Uint8Array,
  signingPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  note?: string,
  identityProof?: IdentityProof,
  kemCiphertext?: Uint8Array,
): HandshakeResponseContent {
  if (!identityProof) {
    throw new Error("Identity proof is now mandatory for handshake responses");
  }

  return {
    unifiedPubKeys: encodeUnifiedPubKeys(identityPubKey, signingPubKey),
    ephemeralPubKey,
    ...(kemCiphertext && { kemCiphertext }),
    note,
    identityProof,
  };
}

/**
 * Extracts individual keys from HandshakeResponseContent
 */
export function extractKeysFromHandshakeResponse(content: HandshakeResponseContent): {
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
} | null {
  const decoded = decodeUnifiedPubKeys(content.unifiedPubKeys);
  if (!decoded) return null;
  
  return {
    identityPubKey: decoded.identityPubKey,
    signingPubKey: decoded.signingPubKey,
    ephemeralPubKey: content.ephemeralPubKey
  };
}


/**
 * Parses unified pubKeys from HandshakeLog event
 */
export function parseHandshakeKeys(event: { pubKeys: string }): {
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
} | null {
  try {
    const pubKeysBytes = new Uint8Array(
      Buffer.from(event.pubKeys.slice(2), 'hex')
    );
    
    const decoded = decodeUnifiedPubKeys(pubKeysBytes);
    
    if (!decoded) return null;
    
    return {
      identityPubKey: decoded.identityPubKey,
      signingPubKey: decoded.signingPubKey
    };
  } catch (error) {
    console.error('Failed to parse handshake keys:', error);
    return null;
  }
}